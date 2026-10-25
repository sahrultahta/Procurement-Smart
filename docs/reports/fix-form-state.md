## Fix report: forms keep what was typed after a server error

- Date: 2026-10-25
- Base commit: `4c0360a` (Phase 6a). Committed as a single commit on top of it (2026-10-25, after maintainer approval), together with this report. Not pushed: there is no remote.
- Found while testing Phase 6a ([report](phase-6a.md), "Known limitations"). Maintainer decisions (2026-10-25): find every affected form, make a short plan, and fix it before Phase 6b; then commit it as one commit, without ignored files, and do not push.

### The problem

React 19 resets the uncontrolled fields of a `<form action={…}>` after **every** form action it runs, also when the action returns an error. Every form that submits a Server Action through `useActionState` was affected: after the server refused the input, the fields went back to their initial values while the error message was shown. Fields kept in React state (requisition lines, policy rules) were not affected.

The worst case was the **approval decision form**: an approver who chose *Reject* without a comment got "comment required", and the choice silently went back to the default *Approve*. Typing the comment and clicking **Record decision** again would have approved the requisition.

Reproduced before the fix by `tests/e2e/form-state.spec.ts` (3 tests, all failing): the requisition title came back empty, *Reject* came back unchecked, and the supplier's legal name came back empty.

### The fix

- **`ActionForm`** (`src/components/action-form.tsx`): its submit handler calls `preventDefault()` and runs the action inside `startTransition`. In react-dom 19.3.0 (checked in the installed source), a form reset is requested only when React itself runs the form action; when the submit handler prevents it and starts a transition, React keeps the pending state and does not reset. The `action` attribute stays, so a form submitted before hydration still works, and the clicked button's name and value are sent as before (the supplier review uses them).
- **All 24 forms in 12 files** now use it: administration (create user, edit profile, deactivate, reactivate, setup link, grant and revoke role, create and edit department, settings, approval policy), suppliers (register and edit, review, block, unblock, deactivate, reactivate), requisitions (create and edit, submit, cancel and withdraw, close, approval decision), and RFQs (create and edit, issue, close, cancel). The RFQ form's temporary controlled title and due time went back to plain fields.
- **Forms that stay on the page to create another record** (create department, grant role) clear their fields after a success only (`resetOnSuccess`). Forms that redirect, or update what they show, keep their values.
- **Lint rule** (`no-restricted-syntax`): a plain `<form action={formAction}>` is an error, with a message pointing to `ActionForm`; tested in `tests/unit/eslint-rules.test.ts`. The sign-out button (a form with no fields, in a server component) is unaffected.
- The sign-in and set-password forms already submitted through their own handlers and were not affected.

### Commands run (exact) and results

Recorded after the verification run below finished (`scratchpad/verify-forms/run.sh`, from `npm ci`, with `NEXT_TELEMETRY_DISABLED=1`).

| Command | Exit | Result |
| --- | --- | --- |
| `npx playwright test tests/e2e/form-state.spec.ts`, before the fix | 1 | **3 failed**: requisition title empty, *Reject* unchecked, supplier legal name empty (the evidence above) |
| the same, after the fix | 0 | 3 passed |
| `git diff --stat HEAD -- package.json package-lock.json` | 0 | empty: **no dependency changes** |
| `npm ci` | 0 | 597 packages from the lockfile |
| `npm run lint` | 0 | no findings, with the new rule |
| `npm run typecheck` | 0 | no errors |
| `npm run test:unit` | 0 | 15 files, **523 passed** (was 522: the new lint-rule test) |
| `npm run test:integration` | 0 | 21 files, **242 passed** (unchanged) |
| `npx vitest run --coverage` | 0 | **765 passed**; domain/application scope 1066/1070 lines (99.63 %) |
| `rm -rf .next && npm run build` | 0 | **0 warnings** |
| `npx playwright test` (twice, back to back) | 0 / 0 | **36 passed** both times (33 earlier + 3 new); the earlier E2E tests also go through the redirecting forms, creating a user, publishing a policy, and reviewing a supplier with its Approve and Reject buttons. Granting a role (which now clears after success) has no E2E test; its command is covered by integration tests |
| `npm audit --omit=dev --audit-level=high` | 0 | 0 high/critical; the same 4 moderate (`esbuild` via `drizzle-kit`) |
| secret scan: 18 distinct local secrets over all 318 committable files | — | **0 hits** |
| relative-link check over `README.md` and `docs/**/*.md` | — | 0 broken |
| `gitleaks`, `actionlint` | — | **BLOCKED** (not installed) |

### Files changed

- New: `src/components/action-form.tsx`, `tests/e2e/form-state.spec.ts`, this report.
- Changed: the 12 form files listed above, `eslint.config.mjs`, `tests/unit/eslint-rules.test.ts`, `docs/PLAN.md` (status).

### Known limitations

- The lint rule recognizes the repository's convention (`const [state, formAction, pending] = useActionState(…)`); a dispatch function with another name would not be caught.
- Forms with a single button and no fields (submit, issue, close, reactivate, setup link) had nothing to lose; they use `ActionForm` too, for one consistent pattern.
