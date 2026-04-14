# 01 — Scaffold

STATUS: open
PRIORITY: p0
COMPLEXITY: mechanical
BLOCKED_BY: (none)
TOUCHES: package.json, tsconfig.json, src/, test/, .gitignore, .npmignore

## Goal
Blank-slate the repo for a kit-v3 rewrite: update `package.json` (ESM-only, Node ≥22.11, new deps), replace `tsconfig.json` for NodeNext/ESM, delete the old `src/` and `test/` contents, create the new directory skeleton.

## Approach

1. **Read current `package.json`** — preserve `name`, `repository`, `author`, `license`, `bugs`, `homepage`. Bump `version` to `2.0.0-alpha.0`.

2. **Write new `package.json`**:
   - `"type": "module"`
   - `"engines": { "node": ">=22.11" }`
   - `"main"`, `"types"`, `"exports"` pointing at `./lib/index.js` / `./lib/index.d.ts`
   - `"files": ["lib", "README.md", "LICENSE", "MIGRATION.md"]`
   - Dependencies:
     - `@solana/kit`: `^3.0.3`
     - `@matrixai/quic`: `^1.3.0` (leave as-is; concern 04 may bump)
     - `@peculiar/x509`: `^1.12.0`
   - Drop: `@solana/web3.js`, `bs58`, `denque`, `selfsigned`, `@peculiar/webcrypto`
   - DevDependencies: `typescript` ^5.6, `@types/node` ^22, `tsx` (ESM-friendly replacement for ts-node), `vitest` ^2 for test runner, `@typescript-eslint/*` latest, `prettier`
   - Scripts: `build: tsc`, `test: vitest run`, `test:unit: vitest run test/unit`, `test:integration: vitest run test/integration`, `lint`, `format`, `typecheck: tsc --noEmit`

3. **Write new `tsconfig.json`**:
   - `target: ES2023`, `module: NodeNext`, `moduleResolution: NodeNext`
   - `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`
   - `outDir: lib`, `rootDir: src`, `declaration: true`, `declarationMap: true`, `sourceMap: true`
   - `include: ["src/**/*"]`, exclude `test`, `node_modules`, `lib`

4. **Delete old sources**: `rm -rf src/* test/* lib/`. Preserve top-level `README.md` for now — concern 15 rewrites it.

5. **Create skeleton**:
   - `src/.gitkeep`
   - `test/unit/.gitkeep`
   - `test/integration/.gitkeep`

6. **Update `.gitignore`** — add `lib/`, `*.tsbuildinfo`, `coverage/`, `.vitest/` if missing.

7. **Add `.npmignore`** or rely on `files` in package.json (prefer `files`).

8. **Do not install** — leave `npm install` for after concern 15 so lockfile reflects final deps. Note in completion that `npm install` is required.

## Verify

```bash
cat package.json | jq '.type, .engines.node, .dependencies'
cat tsconfig.json | jq '.compilerOptions.module'
ls src/ test/unit test/integration     # exist, empty except .gitkeep
git status                             # shows the changes cleanly
```

Expected: `"module"`, `">=22.11"`, deps list shows `@solana/kit`, `@matrixai/quic`, `@peculiar/x509` (and `NodeNext`).

## Notes for implementer

- Preserve git history — use `git rm` not plain `rm` for tracked files.
- Don't run `npm install`. Lockfile comes at the end.
- If `lib/` is in git (shouldn't be but check), remove + gitignore.
