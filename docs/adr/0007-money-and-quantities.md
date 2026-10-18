# ADR 0007: Money and quantities: `numeric` + decimal.js, computed server-side

- Status: Accepted
- Date: 2026-10-18

## Context

JavaScript `number` is a binary float (`0.1 + 0.2 !== 0.3`). Procurement totals drive approval thresholds and over-ordering checks, so a rounding error changes who must approve. The brief requires decimal-safe types and server-side totals.

## Decision

### Storage (PostgreSQL)

| Kind | Type | Notes |
| --- | --- | --- |
| Monetary amounts (unit price, line and document totals) | `numeric(20,4)` | Up to 16 integer digits. Unit prices may use 4 decimal places. Totals are rounded to the currency scale. |
| Quantities | `numeric(18,3)` | Supports fractional units (kg, m). |
| Percentages (tax rate, tolerances) | `numeric(7,4)` | e.g. `11.0000` means 11%. |
| Currency | `char(3)` ISO 4217 code + `currency_scale smallint` in org settings | |

`CHECK` constraints enforce non-negative prices, positive quantities, and rates between 0 and 100.

### Runtime (TypeScript)

- Drizzle returns `numeric` as `string` (to be proven in Phase 2). The shared kernel wraps strings in **decimal.js** `Decimal` (`decimal.js` 10.6.0), configured once with `precision: 40` and `rounding: ROUND_HALF_UP`.
- `Money` and `Quantity` are small value types in `src/shared/decimal/`. Arithmetic goes through them, and raw `Number(...)` on these values is banned by a lint rule.
- **Inputs are strings.** Zod schemas accept money as `^\d{1,12}(\.\d{1,4})?$` and quantity as `^\d{1,9}(\.\d{1,3})?$`. JSON numbers for these fields are rejected. Input schemas are `.strict()`: a client that sends `total`, `line_total`, or `status` gets `VALIDATION_FAILED`.
- Server responses serialize decimals as strings. Display formatting happens in the UI with `Intl.NumberFormat`. Phase 2 checks that string input to `Intl.NumberFormat` keeps precision in Node 24 and the supported browsers.

### Computation rules (single source: `src/shared/decimal/pricing.ts`)

1. `line_subtotal = round(quantity × unit_price, currency_scale, HALF_UP)`
2. `line_tax = round(line_subtotal × tax_rate / 100, currency_scale, HALF_UP)` (PO lines only; PR lines are tax-exclusive estimates)
3. `line_total = line_subtotal + line_tax`
4. Document `subtotal`, `tax_total`, and `total` are sums of the **rounded** line values. Lines are never re-rounded at document level.
5. Line totals at or above `10^16` are rejected as `VALIDATION_FAILED` before they reach the database.
6. Threshold comparisons (approval amounts, tolerances) use `Decimal.comparedTo`, never `>` on numbers.

The server recomputes every stored total on every write. Client-side previews may use the same function for display, but their result is discarded.

### Currency scope (v1)

One installation currency (set in org settings, e.g. `USD` scale 2 or `IDR` scale 0). Every monetary document stores `currency_code`, and v1 rejects anything other than the org currency. FX and multi-currency are out of scope (see `PLAN.md`).

## Alternatives considered

- **Integer minor units (`bigint` cents).** Good for totals but awkward for 4-decimal unit prices and fractional quantities. It also needs per-currency exponent handling everywhere.
- **`big.js` / `dinero.js`.** decimal.js is mature, has no dependencies, and supports the rounding modes needed. Dinero would add a second abstraction on top.

## Consequences

- Every numeric boundary (DB, forms, JSON) is a string, so explicit parsing is required.
- Rounding policy is centralized, so changing it is one well-tested function. Existing stored totals are not recalculated.

## Verification

- Phase 2: table-driven tests (including `0.1 × 3`, half-up boundaries such as `2.345 → 2.35`, 0-scale and 2-scale currencies, and maximum magnitudes); property tests that `sum(rounded lines) == document total`; and DB round-trip tests.
- Each later phase: an integration test proves a tampered client total is rejected or ignored.
