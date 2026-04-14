# 14 — Unit tests

STATUS: open
PRIORITY: p1
COMPLEXITY: architectural
BLOCKED_BY: 03, 05, 07, 08 (VERIFY: `test -f src/addr.ts -a -f src/route-snapshot.ts -a -f src/slot-tracker.ts -a -f src/leader-cache.ts`)
TOUCHES: test/unit/addr.test.ts, test/unit/route-snapshot.test.ts, test/unit/slot-tracker.test.ts, test/unit/leader-cache.test.ts, test/unit/quic-pool.test.ts, test/unit/identity.test.ts

## Goal
Cover the deterministic logic with vitest unit tests. No real network; mock RPC/subscriptions via tiny fakes. Target: the correctness bugs being fixed + epoch-boundary edges + refcount/race safety.

## Approach

### `test/unit/addr.test.ts`
- IPv4 happy path: `parseHostPort('1.2.3.4:8009')` → `{host: '1.2.3.4', port: 8009}`
- IPv6 bracketed: `parseHostPort('[::1]:8009')` → `{host: '::1', port: 8009}`
- Hostname: `parseHostPort('validator.example:8009')`
- Invalid port 0 / 65536 / 'abc' → throws
- Missing port → throws
- `tpuQuicFromTpu('1.2.3.4:8003')` → `'1.2.3.4:8009'`
- `resolveTpuQuicAddr({tpuQuic: 'x', tpu: 'y'})` → `'x'`
- `resolveTpuQuicAddr({tpu: '1.2.3.4:8003'})` → `'1.2.3.4:8009'`
- `resolveTpuQuicAddr({})` → `null`

### `test/unit/route-snapshot.test.ts`
- `makeSnapshot` freezes both snapshot and leaders array (mutation attempts in strict mode throw).
- `AtomicSnapshotRef.store`/`load` round-trip.
- Generations monotonic when created in sequence.
- `EMPTY_SNAPSHOT.leaders.length === 0`.

### `test/unit/slot-tracker.test.ts`
- Fake `rpcSubscriptions.slotNotifications()` returns an async iterable we control.
- Push 12 notifications → `tracker.ready` resolves; `estimate()` returns last slot.
- Zero WS events + fake `getSlot` resolves → `ready` resolves via fallback; emits `slot-stall` after 2s.
- Skip detection: emit `{slot: 100, parent: 97}` → event has `skipped: 2`.
- Abort signal closes subscription loop.

### `test/unit/leader-cache.test.ts`
- Mock provider: given `(slot=100, fanout=5)` inside an epoch with `epochEnd=200`, calls `getSlotLeaders(100, 5)` only (no union).
- Cross-boundary: `(slot=198, fanout=5)`, `epochEnd=200` → calls `getSlotLeaders(198, 3)` + `getLeaderSchedule(nextEpoch)`; result is 3+2=5 leaders.
- Next-epoch schedule unavailable (returns null) → returns clamped 3 leaders only.
- `getClusterNodes` returning entries with `tpuQuic: null` but valid `tpu` → snapshot has `tpuQuicAddr = tpu + 6`.
- Cluster refresh cadence with fake timers: no refresh at t=1s, refresh at t=6min.

### `test/unit/quic-pool.test.ts`
- `openConn` mocked returning fake `QuicConnection`.
- `acquire` same identity twice → same entry, refcount=2.
- `release` → refcount=1.
- LRU eviction: pool cap=2, acquire A + release, acquire B + release, acquire C → A evicted.
- Evictor tick: idle > 30s with no upcoming → evicted; idle < 30s + not upcoming + idle > 5s → evicted.
- Semaphore: `tryAcquire` returns false after capacity exhausted; `release` restores.
- Abort signal → all entries closed.

### `test/unit/identity.test.ts`
- `buildIdentity()` with no arg → ephemeral=true, pubkeyRaw is 32 bytes, certDer is non-empty.
- `buildIdentity(keypair)` returns ephemeral=false, pubkeyRaw matches exported SPKI[12:].
- Cert roundtrip: parse `certDer` with `@peculiar/x509`, extract SPKI[12:], matches `pubkeyRaw`.

## Test setup

- `vitest` already installed (concern 01).
- Create `vitest.config.ts` with `test: { environment: 'node', include: ['test/**/*.test.ts'] }`.
- Use `vi.useFakeTimers()` for timer-sensitive tests (evictor, stall watchdog, cluster refresh).
- Helper `createFakeRpc(responses)` — plain object with methods returning `{ send: () => Promise.resolve(mockedValue) }`.
- Helper `createFakeSubscriptions(generator)` — returns an object with `slotNotifications().subscribe(...)` returning a controlled async iterable.

## Verify

```bash
npx vitest run test/unit/ --reporter=verbose
# Expected: all tests pass, coverage on listed modules > 80%.
```

## Notes

- `quic-sender` unit testing skipped — requires real QUIC. Covered by concern 15 integration test.
- `tpu-client.ts` orchestration unit test skipped — too much fake-wiring cost vs value. Integration test covers it.
- `confirm.ts` unit test skipped pending kit transaction-confirmation internals from NOTES-04.
