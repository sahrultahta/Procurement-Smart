# Working agreement for coding agents and contributors

Read `docs/PLAN.md` first. The current phase and its acceptance criteria define the scope of any change.

## Rules

1. **Work in the current phase only.** Do not start the next phase until the current one's gate has passed and the maintainer has approved it.
2. **Design first.** If a change needs a new endpoint, role, state, table, or dependency, update the relevant doc (`docs/state-machines.md`, `docs/schema.md`, `docs/api-contracts.md`, `docs/threat-model.md`) or write a superseding ADR **in the same change**.
3. **Never claim something works unless it ran.** Phase reports list exact commands, exit codes, and results. Anything not executed is listed as "not verified".
4. **Security invariants are non-negotiable:**
   - authorization inside every command and query (never only in pages or `proxy.ts`)
   - strict input validation (Zod `.strict()`)
   - state transitions checked against the locked row
   - totals computed server-side with decimal.js
   - no self-approval
   - no over-ordering and no over-receipt (application check + DB constraint)
   - audit event in the same transaction
5. **No secrets, no confidential data.** Seed and test data are fictional (`example.com`). Never copy code or data from any employer system (ADR 0001).
6. **Dependencies:** pin exact versions. Check `npm view <pkg> version engines peerDependencies` before adding or upgrading, and record the result in the phase report. TypeScript stays on 6.0.x until typescript-eslint supports 7 (ADR 0011).
7. **Next.js 16 specifics:** `proxy.ts`, not `middleware.ts`. Async `cookies()` / `headers()` / `params`. No `next lint`; use the ESLint CLI. Check version-matched docs in `node_modules/next/dist/docs/` once installed.

## Checks to run before declaring a phase done

```
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e        # from Phase 3
npm audit --audit-level=high
```

(Scripts exist from Phase 1 onward.)

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
