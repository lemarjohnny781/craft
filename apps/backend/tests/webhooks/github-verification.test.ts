// @vitest-environment node
/**
 * GitHub Webhook Security & Processing Tests
 *
 * Covers:
 *   - Signature validation (valid / invalid / missing / tampered / wrong secret)
 *   - Raw body used for HMAC (not parsed JSON)
 *   - Event routing: push, pull_request, ping, issues, release
 *   - Unsupported events acknowledged without processing
 *   - Replay attack prevention via x-github-delivery deduplication
 *   - Idempotency / retry handling
 *   - Timestamp-based stale payload rejection
 *   - Security: secret never exposed in error responses
 *
 * Fixtures:
 *   tests/fixtures/github/push-event.json
 *   tests/fixtures/github/pr-event.json
 *   tests/fixtures/github/ping-event.json
 *   tests/fixtures/github/issues-event.json
 *   tests/fixtures/github/release-event.json
 *
 * Run: vitest run tests/webhooks/github-verification.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

// ── Fixtures ──────────────────────────────────────────────────────────────────

import pushPayload    from '../fixtures/github/push-event.json';
import prPayload      from '../fixtures/github/pr-event.json';
import pingPayload    from '../fixtures/github/ping-event.json';
import issuesPayload  from '../fixtures/github/issues-event.json';
import releasePayload from '../fixtures/github/release-event.json';

// ── Constants ─────────────────────────────────────────────────────────────────

const WEBHOOK_SECRET      = 'test-secret';
const MAX_PAYLOAD_AGE_MS  = 5 * 60 * 1000; // 5 minutes

// ── Helper: sign a raw payload string ────────────────────────────────────────

/**
 * Mirrors GitHub's signing logic exactly.
 * IMPORTANT: signature is computed over the raw body string, NOT parsed JSON.
 */
function signPayload(rawBody: string, secret: string = WEBHOOK_SECRET): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody, 'utf8');
  return `sha256=${hmac.digest('hex')}`;
}

// ── In-memory delivery store (idempotency / replay cache) ─────────────────────

const deliveryStore = new Map<string, number>(); // deliveryId → timestamp

function clearDeliveryStore() { deliveryStore.clear(); }
function hasDelivery(id: string): boolean { return deliveryStore.has(id); }
function recordDelivery(id: string, ts: number = Date.now()): void { deliveryStore.set(id, ts); }

// ── Mock event processors ─────────────────────────────────────────────────────

const mockProcessPush    = vi.fn().mockResolvedValue({ ok: true });
const mockProcessPR      = vi.fn().mockResolvedValue({ ok: true });
const mockProcessPing    = vi.fn().mockResolvedValue({ ok: true });
const mockProcessIssues  = vi.fn().mockResolvedValue({ ok: true });
const mockProcessRelease = vi.fn().mockResolvedValue({ ok: true });

// ── Webhook handler (unit under test) ─────────────────────────────────────────

interface WebhookRequest {
  body: string;
  headers: Record<string, string | undefined>;
}

interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

async function handleGitHubWebhook(request: WebhookRequest): Promise<WebhookResponse> {
  const { body, headers } = request;

  // 1. Require signature header
  const signature = headers['x-hub-signature-256'];
  if (!signature) {
    return { status: 401, body: { error: 'Missing x-hub-signature-256 header' } };
  }

  // 2. Verify HMAC over the RAW body string (not parsed JSON) — timing-safe
  const expected  = signPayload(body, WEBHOOK_SECRET);
  const sigBuffer = Buffer.from(signature);
  const expBuffer = Buffer.from(expected);

  if (sigBuffer.length !== expBuffer.length || !crypto.timingSafeEqual(sigBuffer, expBuffer)) {
    // Never include the secret or expected value in the error response
    return { status: 401, body: { error: 'Invalid signature' } };
  }

  // 3. Require event type header
  const eventType = headers['x-github-event'];
  if (!eventType) {
    return { status: 400, body: { error: 'Missing x-github-event header' } };
  }

  // 4. Timestamp validation — reject stale payloads older than MAX_PAYLOAD_AGE_MS
  const timestampHeader = headers['x-github-hook-installation-target-id'];
  const webhookTs = headers['x-webhook-timestamp'];
  if (webhookTs) {
    const age = Date.now() - parseInt(webhookTs, 10);
    if (age > MAX_PAYLOAD_AGE_MS) {
      return { status: 400, body: { error: 'Webhook payload is too old' } };
    }
  }

  // 5. Idempotency / replay-attack guard via x-github-delivery
  const deliveryId = headers['x-github-delivery'];
  if (deliveryId) {
    if (hasDelivery(deliveryId)) {
      return { status: 200, body: { received: true, duplicate: true } };
    }
    recordDelivery(deliveryId);
  }

  // 6. Parse raw body — signature already verified above
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { status: 400, body: { error: 'Invalid JSON body' } };
  }

  // 7. Route to the correct processor
  switch (eventType) {
    case 'push':         await mockProcessPush(payload);    break;
    case 'pull_request': await mockProcessPR(payload);      break;
    case 'ping':         await mockProcessPing(payload);    break;
    case 'issues':       await mockProcessIssues(payload);  break;
    case 'release':      await mockProcessRelease(payload); break;
    default:
      return { status: 200, body: { received: true, processed: false } };
  }

  return { status: 200, body: { received: true, processed: true } };
}

// ── Test helper ───────────────────────────────────────────────────────────────

function makeRequest(
  payload: object,
  overrides: {
    secret?: string;
    signature?: string | null;
    event?: string;
    deliveryId?: string;
    timestamp?: number;
  } = {}
) {
  const body = JSON.stringify(payload);
  const sig  =
    overrides.signature !== undefined
      ? overrides.signature ?? undefined
      : signPayload(body, overrides.secret ?? WEBHOOK_SECRET);

  return {
    body,
    headers: {
      'content-type': 'application/json',
      ...(sig != null              ? { 'x-hub-signature-256': sig }                              : {}),
      ...(overrides.event          ? { 'x-github-event': overrides.event }                       : {}),
      ...(overrides.deliveryId     ? { 'x-github-delivery': overrides.deliveryId }               : {}),
      ...(overrides.timestamp      ? { 'x-webhook-timestamp': String(overrides.timestamp) }      : {}),
    } as Record<string, string | undefined>,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  clearDeliveryStore();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Signature Validation
// ─────────────────────────────────────────────────────────────────────────────

describe('Signature Validation', () => {
  it('accepts a valid HMAC-SHA256 signature', async () => {
    const res = await handleGitHubWebhook(makeRequest(pushPayload, { event: 'push', deliveryId: 'sig-1' }));
    expect(res.status).toBe(200);
  });

  it('returns 401 when x-hub-signature-256 header is missing', async () => {
    const res = await handleGitHubWebhook(makeRequest(pushPayload, { signature: null, event: 'push' }));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Missing x-hub-signature-256 header');
  });

  it('returns 401 for a tampered signature value', async () => {
    const req = makeRequest(pushPayload, { event: 'push' });
    req.headers['x-hub-signature-256'] = 'sha256=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const res = await handleGitHubWebhook(req);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid signature');
  });

  it('returns 401 when signed with the wrong secret', async () => {
    const res = await handleGitHubWebhook(makeRequest(pushPayload, { secret: 'wrong-secret', event: 'push' }));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid signature');
  });

  it('returns 401 when the payload body is modified after signing', async () => {
    const req = makeRequest(pushPayload, { event: 'push' });
    // Tamper with body AFTER signature was computed
    req.body = JSON.stringify({ ...pushPayload, ref: 'refs/heads/evil' });
    const res = await handleGitHubWebhook(req);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid signature');
  });

  it('returns 401 for a signature with wrong length (timing-safe guard)', async () => {
    const req = makeRequest(pushPayload, { event: 'push' });
    req.headers['x-hub-signature-256'] = 'sha256=tooshort';
    const res = await handleGitHubWebhook(req);
    expect(res.status).toBe(401);
  });

  it('uses the raw body string for HMAC — not re-serialised JSON', async () => {
    // Produce a raw body with non-standard spacing (valid JSON, different string)
    const rawBody = '{"ref":"refs/heads/main","repository":{"id":1}}';
    const sig = signPayload(rawBody);
    const res = await handleGitHubWebhook({
      body: rawBody,
      headers: {
        'x-hub-signature-256': sig,
        'x-github-event': 'push',
        'x-github-delivery': 'raw-body-test',
      },
    });
    // Signature computed over rawBody must pass
    expect(res.status).toBe(200);
  });

  it('signPayload helper produces sha256= prefixed 64-char hex', () => {
    expect(signPayload('hello')).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it('different payloads produce different signatures', () => {
    expect(signPayload('{"a":1}')).not.toBe(signPayload('{"a":2}'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Event Type Handling
// ─────────────────────────────────────────────────────────────────────────────

describe('Event Type Handling', () => {
  it('routes push events to the push processor', async () => {
    const res = await handleGitHubWebhook(makeRequest(pushPayload, { event: 'push', deliveryId: 'ev-push' }));
    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(true);
    expect(mockProcessPush).toHaveBeenCalledOnce();
    expect(mockProcessPush).toHaveBeenCalledWith(pushPayload);
  });

  it('routes pull_request events to the PR processor', async () => {
    const res = await handleGitHubWebhook(makeRequest(prPayload, { event: 'pull_request', deliveryId: 'ev-pr' }));
    expect(res.status).toBe(200);
    expect(mockProcessPR).toHaveBeenCalledOnce();
    expect(mockProcessPR).toHaveBeenCalledWith(prPayload);
  });

  it('routes ping events to the ping processor', async () => {
    const res = await handleGitHubWebhook(makeRequest(pingPayload, { event: 'ping', deliveryId: 'ev-ping' }));
    expect(res.status).toBe(200);
    expect(mockProcessPing).toHaveBeenCalledOnce();
    expect(mockProcessPing).toHaveBeenCalledWith(pingPayload);
  });

  it('routes issues events to the issues processor', async () => {
    const res = await handleGitHubWebhook(makeRequest(issuesPayload, { event: 'issues', deliveryId: 'ev-issues' }));
    expect(res.status).toBe(200);
    expect(mockProcessIssues).toHaveBeenCalledOnce();
    expect(mockProcessIssues).toHaveBeenCalledWith(issuesPayload);
  });

  it('routes release events to the release processor', async () => {
    const res = await handleGitHubWebhook(makeRequest(releasePayload, { event: 'release', deliveryId: 'ev-release' }));
    expect(res.status).toBe(200);
    expect(mockProcessRelease).toHaveBeenCalledOnce();
    expect(mockProcessRelease).toHaveBeenCalledWith(releasePayload);
  });

  it('returns 200 with processed:false for unsupported event types', async () => {
    const res = await handleGitHubWebhook(makeRequest(pushPayload, { event: 'deployment', deliveryId: 'ev-dep' }));
    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(false);
  });

  it('does not call any processor for unsupported event types', async () => {
    await handleGitHubWebhook(makeRequest(pushPayload, { event: 'workflow_run', deliveryId: 'ev-wf' }));
    expect(mockProcessPush).not.toHaveBeenCalled();
    expect(mockProcessPR).not.toHaveBeenCalled();
    expect(mockProcessPing).not.toHaveBeenCalled();
    expect(mockProcessIssues).not.toHaveBeenCalled();
    expect(mockProcessRelease).not.toHaveBeenCalled();
  });

  it('returns 400 when x-github-event header is missing', async () => {
    const body = JSON.stringify(pushPayload);
    const res  = await handleGitHubWebhook({ body, headers: { 'x-hub-signature-256': signPayload(body) } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing x-github-event header');
  });

  it.each(['push', 'pull_request', 'ping', 'issues', 'release'])(
    'correctly identifies "%s" from the x-github-event header',
    async (eventType) => {
      const payloadMap: Record<string, object> = {
        push: pushPayload, pull_request: prPayload, ping: pingPayload,
        issues: issuesPayload, release: releasePayload,
      };
      const res = await handleGitHubWebhook(
        makeRequest(payloadMap[eventType], { event: eventType, deliveryId: `each-${eventType}` })
      );
      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Webhook Retry Logic & Idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe('Webhook Retry Logic & Idempotency', () => {
  it('processes a delivery ID the first time it is seen', async () => {
    const res = await handleGitHubWebhook(makeRequest(pushPayload, { event: 'push', deliveryId: 'first-del' }));
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBeUndefined();
    expect(mockProcessPush).toHaveBeenCalledOnce();
  });

  it('returns 200 no-op for a duplicate x-github-delivery ID (idempotency)', async () => {
    const req = makeRequest(pushPayload, { event: 'push', deliveryId: 'dup-del' });
    await handleGitHubWebhook(req);
    vi.clearAllMocks();
    const res = await handleGitHubWebhook(req);
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
    expect(mockProcessPush).not.toHaveBeenCalled();
  });

  it('simulates GitHub retry — same delivery ID processed only once', async () => {
    const req    = makeRequest(pushPayload, { event: 'push', deliveryId: 'retry-del' });
    const first  = await handleGitHubWebhook(req);
    const second = await handleGitHubWebhook(req); // GitHub retry
    const third  = await handleGitHubWebhook(req); // GitHub retry again
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
    expect(mockProcessPush).toHaveBeenCalledOnce(); // only once despite 3 deliveries
  });

  it('returns 200 on retry so GitHub stops retrying', async () => {
    const req   = makeRequest(prPayload, { event: 'pull_request', deliveryId: 'retry-pr' });
    await handleGitHubWebhook(req);
    const retry = await handleGitHubWebhook(req);
    expect(retry.status).toBe(200); // must not be 4xx/5xx
  });

  it('processes different delivery IDs independently', async () => {
    await handleGitHubWebhook(makeRequest(pushPayload, { event: 'push', deliveryId: 'del-A' }));
    await handleGitHubWebhook(makeRequest(pushPayload, { event: 'push', deliveryId: 'del-B' }));
    await handleGitHubWebhook(makeRequest(pushPayload, { event: 'push', deliveryId: 'del-C' }));
    expect(mockProcessPush).toHaveBeenCalledTimes(3);
  });

  it('processes a new event after a duplicate is detected', async () => {
    const req = makeRequest(pushPayload, { event: 'push', deliveryId: 'idem-1' });
    await handleGitHubWebhook(req);
    await handleGitHubWebhook(req); // duplicate
    const fresh = await handleGitHubWebhook(makeRequest(pushPayload, { event: 'push', deliveryId: 'idem-2' }));
    expect(fresh.status).toBe(200);
    expect(fresh.body.duplicate).toBeUndefined();
    expect(mockProcessPush).toHaveBeenCalledTimes(2);
  });

  it('does not call any processor when a duplicate is detected', async () => {
    const req = makeRequest(issuesPayload, { event: 'issues', deliveryId: 'dup-issues' });
    await handleGitHubWebhook(req);
    vi.clearAllMocks();
    await handleGitHubWebhook(req);
    expect(mockProcessPush).not.toHaveBeenCalled();
    expect(mockProcessPR).not.toHaveBeenCalled();
    expect(mockProcessIssues).not.toHaveBeenCalled();
    expect(mockProcessRelease).not.toHaveBeenCalled();
  });

  it('does not block requests that omit the delivery ID header', async () => {
    const res = await handleGitHubWebhook(makeRequest(pushPayload, { event: 'push' }));
    expect(res.status).toBe(200);
    expect(mockProcessPush).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Replay Attack Prevention
// ─────────────────────────────────────────────────────────────────────────────

describe('Replay Attack Prevention', () => {
  it('accepts a fresh payload (timestamp within window)', async () => {
    const now = Date.now();
    const res = await handleGitHubWebhook(
      makeRequest(pushPayload, { event: 'push', deliveryId: 'fresh-1', timestamp: now })
    );
    expect(res.status).toBe(200);
  });

  it('rejects a stale payload older than 5 minutes', async () => {
    const staleTs = Date.now() - (MAX_PAYLOAD_AGE_MS + 1000);
    const res = await handleGitHubWebhook(
      makeRequest(pushPayload, { event: 'push', deliveryId: 'stale-1', timestamp: staleTs })
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Webhook payload is too old');
  });

  it('rejects a payload exactly 1ms past the 5-minute window', async () => {
    const staleTs = Date.now() - MAX_PAYLOAD_AGE_MS - 1;
    const res = await handleGitHubWebhook(
      makeRequest(pushPayload, { event: 'push', deliveryId: 'stale-2', timestamp: staleTs })
    );
    expect(res.status).toBe(400);
  });

  it('accepts a payload at exactly the 5-minute boundary', async () => {
    const boundaryTs = Date.now() - MAX_PAYLOAD_AGE_MS + 500; // just inside window
    const res = await handleGitHubWebhook(
      makeRequest(pushPayload, { event: 'push', deliveryId: 'boundary-1', timestamp: boundaryTs })
    );
    expect(res.status).toBe(200);
  });

  it('delivery IDs are stored after first processing', async () => {
    const deliveryId = 'stored-del-1';
    await handleGitHubWebhook(makeRequest(pushPayload, { event: 'push', deliveryId }));
    expect(hasDelivery(deliveryId)).toBe(true);
  });

  it('delivery IDs are checked before processing', async () => {
    const deliveryId = 'checked-del-1';
    recordDelivery(deliveryId); // pre-seed as already seen
    const res = await handleGitHubWebhook(makeRequest(pushPayload, { event: 'push', deliveryId }));
    expect(res.body.duplicate).toBe(true);
    expect(mockProcessPush).not.toHaveBeenCalled();
  });

  it('replaying a valid signed request with old delivery ID is blocked', async () => {
    const deliveryId = 'replay-attack-del';
    // First delivery — legitimate
    await handleGitHubWebhook(makeRequest(pushPayload, { event: 'push', deliveryId }));
    vi.clearAllMocks();
    // Attacker replays the exact same signed request
    const res = await handleGitHubWebhook(makeRequest(pushPayload, { event: 'push', deliveryId }));
    expect(res.body.duplicate).toBe(true);
    expect(mockProcessPush).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Webhook Security
// ─────────────────────────────────────────────────────────────────────────────

describe('Webhook Security', () => {
  it('error response for missing signature does not contain the secret', async () => {
    const res = await handleGitHubWebhook(makeRequest(pushPayload, { signature: null, event: 'push' }));
    expect(JSON.stringify(res.body)).not.toContain(WEBHOOK_SECRET);
  });

  it('error response for invalid signature does not contain the secret', async () => {
    const res = await handleGitHubWebhook(makeRequest(pushPayload, { secret: 'wrong', event: 'push' }));
    expect(JSON.stringify(res.body)).not.toContain(WEBHOOK_SECRET);
  });

  it('error response for invalid signature does not leak the expected HMAC value', async () => {
    const body     = JSON.stringify(pushPayload);
    const expected = signPayload(body);
    const req      = makeRequest(pushPayload, { event: 'push' });
    req.headers['x-hub-signature-256'] = 'sha256=badhash' + 'a'.repeat(57);
    const res = await handleGitHubWebhook(req);
    expect(JSON.stringify(res.body)).not.toContain(expected);
  });

  it('error response for invalid signature does not contain raw body content', async () => {
    const req = makeRequest(pushPayload, { secret: 'wrong', event: 'push' });
    const res = await handleGitHubWebhook(req);
    // Body content like the repo name should not appear in the error
    expect(JSON.stringify(res.body)).not.toContain('my-repo');
  });

  it('uses timing-safe comparison — different length signatures return 401', async () => {
    const req = makeRequest(pushPayload, { event: 'push' });
    req.headers['x-hub-signature-256'] = 'sha256=abc';
    const res = await handleGitHubWebhook(req);
    expect(res.status).toBe(401);
  });

  it('signature is computed over raw body, not re-serialised JSON', async () => {
    // A raw body with extra whitespace is valid JSON but a different string
    const rawBody    = '{ "ref" : "refs/heads/main" }';
    const validSig   = signPayload(rawBody);
    const reSeriSig  = signPayload(JSON.stringify(JSON.parse(rawBody)));
    // The two signatures must differ — proving raw body is used
    expect(validSig).not.toBe(reSeriSig);
    // And the handler must accept the raw-body signature
    const res = await handleGitHubWebhook({
      body: rawBody,
      headers: {
        'x-hub-signature-256': validSig,
        'x-github-event': 'push',
        'x-github-delivery': 'raw-sig-test',
      },
    });
    expect(res.status).toBe(200);
  });

  it('401 response body contains only a generic error key', async () => {
    const res = await handleGitHubWebhook(makeRequest(pushPayload, { signature: null, event: 'push' }));
    const keys = Object.keys(res.body);
    expect(keys).toEqual(['error']);
    expect(keys).not.toContain('secret');
    expect(keys).not.toContain('expected');
    expect(keys).not.toContain('received');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Edge Cases
// ─────────────────────────────────────────────────────────────────────────────

describe('Edge Cases', () => {
  it('returns 400 for malformed JSON body with a valid signature', async () => {
    const body = 'not-valid-json';
    const res  = await handleGitHubWebhook({
      body,
      headers: {
        'x-hub-signature-256': signPayload(body),
        'x-github-event':      'push',
        'x-github-delivery':   'bad-json',
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid JSON body');
  });

  it('returns 400 for an empty body', async () => {
    const body = '';
    const res  = await handleGitHubWebhook({
      body,
      headers: {
        'x-hub-signature-256': signPayload(body),
        'x-github-event':      'ping',
        'x-github-delivery':   'empty-body',
      },
    });
    expect(res.status).toBe(400);
  });

  it('handles very large delivery IDs without error', async () => {
    const deliveryId = 'a'.repeat(256);
    const res = await handleGitHubWebhook(makeRequest(pushPayload, { event: 'push', deliveryId }));
    expect(res.status).toBe(200);
  });

  it('handles concurrent deliveries with different IDs independently', async () => {
    const results = await Promise.all([
      handleGitHubWebhook(makeRequest(pushPayload, { event: 'push', deliveryId: 'concurrent-1' })),
      handleGitHubWebhook(makeRequest(pushPayload, { event: 'push', deliveryId: 'concurrent-2' })),
      handleGitHubWebhook(makeRequest(pushPayload, { event: 'push', deliveryId: 'concurrent-3' })),
    ]);
    expect(results.every(r => r.status === 200)).toBe(true);
    expect(mockProcessPush).toHaveBeenCalledTimes(3);
  });
});
