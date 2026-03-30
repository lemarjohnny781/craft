# @craft/stellar

Stellar SDK wrapper package for shared usage across templates and app surfaces.

## Exports

- Network config constants via `config`
- Common operations:
  - `loadAccount(publicKey)`
  - `getAccountBalance(publicKey)`
  - `submitTransaction(transaction)`
- Typed operation contracts:
  - `StellarAccount`
  - `StellarBalance`
  - `SubmitTransactionResult`
- Error helpers:
  - `parseStellarError`
  - `getErrorGuidance`
  - `isRetryableError`
  - `formatError`
- Test mocks:
  - `mockAccount`
  - `mockTransaction`

## Usage

```ts
import {
  loadAccount,
  getAccountBalance,
  submitTransaction,
  type StellarAccount,
  type SubmitTransactionResult,
} from '@craft/stellar';
```

## Notes

- The package centralizes Stellar network interactions for consistency.
- Runtime configuration is read from `NEXT_PUBLIC_STELLAR_*` environment variables.
