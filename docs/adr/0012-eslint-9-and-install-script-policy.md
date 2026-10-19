# ADR 0012: ESLint 9 instead of 10; dependency install scripts disabled

- Status: Accepted (supersedes the ESLint row of ADR 0011)
- Date: 2026-10-18 (Phase 1)

## Context

- ADR 0011 chose ESLint 10. Installing `eslint@10.12.0` with `eslint-config-next@16.4.2` produced `ERESOLVE overriding peer dependency` for three plugins that `eslint-config-next` depends on. Even their **latest** versions on 2026-10-18 declare ESLint ≤ 9:
  - `eslint-plugin-import@2.32.0`: peer `eslint ^2 … || ^9`
  - `eslint-plugin-react@7.37.5`: peer `… || ^9.7`
  - `eslint-plugin-jsx-a11y@6.10.2`: peer `… || ^9`
- The Next.js 16.4.2 bundled docs (`node_modules/next/dist/docs/01-app/03-api-reference/05-config/03-eslint.md`) say `eslint-config-next` supports ESLint 9 and 10, and also that "some of the plugins included in `eslint-config-next` don't list ESLint 10 in their peer dependencies yet."
- The first install also showed four packages with lifecycle scripts: `esbuild` (three versions, `postinstall: node install.js`) and `unrs-resolver` (`postinstall`). Their platform binaries already arrive as npm optional dependencies (`@esbuild/win32-x64`, `@unrs/resolver-binding-win32-x64-msvc`).

## Decision

1. Use **ESLint 9.39.5** (`maintenance` dist-tag, published 2026-07-10). That release satisfies every plugin's peer range with no overrides. `npm install --dry-run` reports 0 `ERESOLVE` and `npm ls --all` reports 0 invalid entries. Move to ESLint 10 when all bundled plugins declare support.
2. Project `.npmrc` sets `ignore-scripts=true`, `save-exact=true`, `engine-strict=true`. Dependency lifecycle scripts never run, locally or in CI (`npm ci` reads the same `.npmrc`). If a future dependency truly needs an install script, that is recorded in the phase report with the reason.

## Consequences

- ESLint 9 is in maintenance, so it receives security fixes but no new features. Acceptable for a lint toolchain.
- If a package depends on its postinstall step, it fails visibly at build or test time instead of silently fetching something. The full suite (lint, typecheck, test, build) runs with scripts disabled, which proves the current set works without them.
