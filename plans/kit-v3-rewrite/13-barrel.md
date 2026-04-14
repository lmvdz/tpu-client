# 13 — index.ts barrel

STATUS: open
PRIORITY: p2
COMPLEXITY: mechanical
BLOCKED_BY: 11, 12 (VERIFY: `test -f src/tpu-client.ts -a -f src/confirm.ts`)
TOUCHES: src/index.ts

## Goal
Single public entry point re-exporting only the intended public surface. Internal modules (`quic-pool`, `route-snapshot`, `slot-tracker`, `addr`, `identity`) stay private.

## Approach

```ts
export { createTpuClient } from './tpu-client.js';
export type {
  TpuClient,
  CreateTpuClientOptions,
  SendResult,
} from './tpu-client.js';

export { sendAndConfirmTpuTransactionFactory } from './confirm.js';
export type {
  TpuConfirmFactoryCfg,
  TpuConfirmOptions,
  TpuConfirmResult,
} from './confirm.js';

export type { TpuEvent, LeaderAttempt, EventEmitter } from './events.js';
export { TpuSendError } from './errors.js';
export type { TpuError } from './errors.js';

export type { LeaderDiscoveryProvider } from './leader-cache.js';
export type { LeaderInfo } from './route-snapshot.js';

export { buildIdentity, ed25519KeyPairFromSeed } from './identity.js';
export type { TpuIdentity } from './identity.js';
```

## Verify

```bash
npx tsc --noEmit
# Confirm all listed exports resolve:
npx tsc --listFiles --noEmit 2>&1 | grep -c 'src/index.ts'   # ≥ 1
```

Check that internal modules are NOT in the public namespace:

```bash
! grep -E "quic-pool|quic-sender|slot-tracker|route-snapshot|addr\.js" src/index.ts
```
