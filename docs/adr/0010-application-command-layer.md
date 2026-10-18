# ADR 0010: Transport-agnostic command layer; Server Actions first, REST later

- Status: Accepted
- Date: 2026-10-18

## Context

The UI needs mutations (forms) and reads. Integrations, such as a future ERP export, need a stable HTTP API. Next.js docs warn that Server Actions are public POST endpoints that must authenticate, authorize, and validate on their own, and that they get same-origin checks (Origin vs Host) for CSRF protection.

Two entry styles exposing the same operations would double the attack surface unless both share one enforcement path.

## Decision

1. All business operations are **commands** (mutations) or **queries** (reads), defined in `modules/*/application/`. Each one declares:
   - `name` (e.g. `requisition.submit`), which is also its audit action prefix,
   - a strict Zod input schema,
   - the required permission (coarse check),
   - the handler, which does resource-level authorization, domain transition, persistence, and audit,
   - an output DTO (only the fields the caller needs).
2. A single runner, `runCommand(ctx, command, rawInput)`, always executes in this order:
   require an authenticated actor → coarse permission check → parse and validate input → open the transaction (with timeouts, ADR 0008) → handler (resource-level checks) → commit → map to `Result`.
   Authentication and the permission check come **before** input validation, so anonymous or forbidden callers learn nothing about input schemas. They get `UNAUTHENTICATED` / `FORBIDDEN` whatever they send.
   No transport may call a handler directly. A unit test asserts that every exported command is registered and only reachable through the runner.
3. **v1 transport: Server Actions.** Each action is a few lines: build the context from `headers()`, call `runCommand`, `revalidatePath` / `updateTag`, and return the `Result` to `useActionState`. Next.js's built-in Origin/Host check provides CSRF protection, and session cookies use `SameSite=Lax`.
4. **Later transport: REST `/api/v1`** (optional phase). Route Handlers call the same runner. The OpenAPI document is generated from the same Zod schemas, using Zod 4's JSON Schema export (to be verified when that phase starts). Token auth for integrations is designed at that time.
5. **Result and error contract**, identical for every transport:

```ts
type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ErrorCode; message: string; fieldErrors?: Record<string, string[]> } };

type ErrorCode =
  | 'VALIDATION_FAILED'     // HTTP 400/422
  | 'UNAUTHENTICATED'       // 401
  | 'FORBIDDEN'             // 403
  | 'NOT_FOUND'             // 404 (also used when the actor may not see the resource)
  | 'CONFLICT'              // 409 stale version, lock timeout, duplicate
  | 'INVALID_TRANSITION'    // 409 action not allowed in current state
  | 'BUSINESS_RULE'         // 422 e.g. OVER_RECEIPT, SELF_APPROVAL; carries a sub-code
  | 'RATE_LIMITED'          // 429
  | 'INTERNAL';             // 500; message is generic, details only in server log
```

Error messages never include stack traces, SQL, or other users' data.

## Alternatives considered

- **REST-first with a client fetch layer.** More boilerplate for forms, and it loses progressive enhancement.
- **tRPC.** Another layer with similar guarantees. Server Actions plus the runner are enough.

## Consequences

- Command definitions are the API contract (`docs/api-contracts.md`). Changing one is an API change.
- Server Action IDs change per build, so external clients must never call Server Actions. They wait for `/api/v1`.

## Verification

- Phase 2: runner skeleton with unit tests for step order and error mapping (an anonymous caller with invalid input gets `UNAUTHENTICATED`; a forbidden caller with invalid input gets `FORBIDDEN`; a thrown unknown error becomes `INTERNAL` with a generic message).
- Phase 3: the same order is asserted end to end through real Server Actions.
