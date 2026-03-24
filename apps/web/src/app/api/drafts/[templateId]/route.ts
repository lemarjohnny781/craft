import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuth } from '@/lib/api/with-auth';
import { customizationDraftService } from '@/services/customization-draft.service';

const customizationConfigSchema = z.object({
    branding: z.object({
        appName: z.string().min(1),
        logoUrl: z.string().url().optional(),
        primaryColor: z.string(),
        secondaryColor: z.string(),
        fontFamily: z.string(),
    }),
    features: z.object({
        enableCharts: z.boolean(),
        enableTransactionHistory: z.boolean(),
        enableAnalytics: z.boolean(),
        enableNotifications: z.boolean(),
    }),
    stellar: z.object({
        network: z.enum(['mainnet', 'testnet']),
        horizonUrl: z.string().url(),
        sorobanRpcUrl: z.string().url().optional(),
        assetPairs: z.array(z.any()).optional(),
        contractAddresses: z.record(z.string()).optional(),
    }),
});

type Params = { templateId: string };

/**
 * GET /api/drafts/[templateId]
 * Returns the saved draft for the authenticated user and template, or 404.
 */
export const GET = withAuth<Params>(async (_req, { user, params }) => {
    try {
        const draft = await customizationDraftService.getDraft(user.id, params.templateId);
        if (!draft) {
            return NextResponse.json({ error: 'Draft not found' }, { status: 404 });
        }
        return NextResponse.json(draft);
    } catch (error: any) {
        return NextResponse.json({ error: error.message || 'Failed to get draft' }, { status: 500 });
    }
});

/**
 * POST /api/drafts/[templateId]
 * Creates or overwrites the draft for the authenticated user and template.
 * Returns the saved draft with id and updatedAt.
 */
export const POST = withAuth<Params>(async (req: NextRequest, { user, params }) => {
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const parsed = customizationConfigSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 });
    }

    try {
        const draft = await customizationDraftService.saveDraft(user.id, params.templateId, parsed.data);
        return NextResponse.json(draft, { status: 200 });
    } catch (error: any) {
        const status = error.message === 'Template not found' ? 404 : 500;
        return NextResponse.json({ error: error.message || 'Failed to save draft' }, { status });
    }
});
