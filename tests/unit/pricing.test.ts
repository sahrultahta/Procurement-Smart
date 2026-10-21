import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareAmounts, priceDocument } from '@/shared/decimal/pricing';
import { AppFailure } from '@/shared/result';

// P2-AC1: line and document totals follow ADR 0007 exactly.

function expectAmountTooLarge(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppFailure);
    expect((error as AppFailure).error).toMatchObject({ code: 'BUSINESS_RULE', rule: 'AMOUNT_TOO_LARGE' });
    return;
  }
  throw new Error('expected AMOUNT_TOO_LARGE');
}

describe('priceDocument: table cases', () => {
  it('rounds each line half-up at the currency scale', () => {
    const doc = priceDocument(
      [
        { quantity: '3', unitPrice: '0.1' },
        { quantity: '1', unitPrice: '2.345' },
        { quantity: '1', unitPrice: '2.344' },
      ],
      2,
    );
    expect(doc.lines.map((l) => l.lineSubtotal)).toEqual(['0.30', '2.35', '2.34']);
    expect(doc.subtotal).toBe('4.99');
    expect(doc.taxTotal).toBe('0.00');
    expect(doc.total).toBe('4.99');
  });

  it('sums rounded lines and never re-rounds the document', () => {
    // Each line is 0.3333 → 0.33. Summing unrounded values would give 1.00.
    const doc = priceDocument(
      [
        { quantity: '1', unitPrice: '0.3333' },
        { quantity: '1', unitPrice: '0.3333' },
        { quantity: '1', unitPrice: '0.3333' },
      ],
      2,
    );
    expect(doc.total).toBe('0.99');
  });

  it('computes tax per line from the rounded subtotal', () => {
    const doc = priceDocument(
      [
        { quantity: '1', unitPrice: '100', taxRatePct: '11' },
        { quantity: '1', unitPrice: '99.99', taxRatePct: '12.5' }, // 12.49875 → 12.50
        { quantity: '2', unitPrice: '10', taxRatePct: '0' },
      ],
      2,
    );
    expect(doc.lines).toEqual([
      { lineSubtotal: '100.00', lineTax: '11.00', lineTotal: '111.00' },
      { lineSubtotal: '99.99', lineTax: '12.50', lineTotal: '112.49' },
      { lineSubtotal: '20.00', lineTax: '0.00', lineTotal: '20.00' },
    ]);
    expect(doc).toMatchObject({ subtotal: '219.99', taxTotal: '23.50', total: '243.49' });
  });

  it('supports zero-decimal currencies such as IDR', () => {
    const doc = priceDocument(
      [
        { quantity: '3', unitPrice: '15000', taxRatePct: '11' },
        { quantity: '1', unitPrice: '2500.5' }, // → 2501
      ],
      0,
    );
    expect(doc.lines).toEqual([
      { lineSubtotal: '45000', lineTax: '4950', lineTotal: '49950' },
      { lineSubtotal: '2501', lineTax: '0', lineTotal: '2501' },
    ]);
    expect(doc.total).toBe('52451');
  });

  it('handles fractional quantities', () => {
    expect(priceDocument([{ quantity: '2.5', unitPrice: '3.99' }], 2).total).toBe('9.98'); // 9.975 → 9.98
  });

  it('accepts the largest total below 10^16', () => {
    const doc = priceDocument([{ quantity: '1', unitPrice: '999999999999.9999' }], 4);
    expect(doc.total).toBe('999999999999.9999');
    // 9999 × 999,999,999,999 = 9,998,999,999,990,001 (16 digits, just under 10^16)
    expect(priceDocument([{ quantity: '9999', unitPrice: '999999999999' }], 2).total).toBe('9998999999990001.00');
  });

  it('rejects a line total of 10^16 or more (AMOUNT_TOO_LARGE)', () => {
    expectAmountTooLarge(() => priceDocument([{ quantity: '10000', unitPrice: '1000000000000' }], 2));
    expectAmountTooLarge(() => priceDocument([{ quantity: '999999999.999', unitPrice: '999999999999.9999' }], 2));
  });

  it('rejects a document total of 10^16 or more even when every line fits', () => {
    const line = { quantity: '6000', unitPrice: '1000000000000' }; // 6 × 10^15 each
    expectAmountTooLarge(() => priceDocument([line, line], 2));
  });

  it('rejects an invalid currency scale', () => {
    expect(() => priceDocument([], 5)).toThrow(/scale/);
    expect(() => priceDocument([], 1.5)).toThrow(/scale/);
  });

  it('prices an empty document as zero', () => {
    expect(priceDocument([], 2)).toEqual({ lines: [], subtotal: '0.00', taxTotal: '0.00', total: '0.00' });
  });
});

describe('compareAmounts', () => {
  it('compares decimal strings exactly', () => {
    expect(compareAmounts('0.30', '0.3')).toBe(0);
    expect(compareAmounts('10000000.0001', '10000000')).toBe(1);
    expect(compareAmounts('9.99', '10')).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Property tests against an independent integer (BigInt) oracle.

const TEN = 10n;
const pow10 = (n: number): bigint => TEN ** BigInt(n);

/** Formats a non-negative scaled integer, e.g. (12345n, 2) → '123.45'. */
function scaledToString(value: bigint, scale: number): string {
  if (scale === 0) return value.toString();
  const digits = value.toString().padStart(scale + 1, '0');
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

/** Half-up division for non-negative integers. */
function divHalfUp(numerator: bigint, divisor: bigint): bigint {
  return (numerator * 2n + divisor) / (divisor * 2n);
}

type OracleLine = { q: bigint; p: bigint; t: bigint | null }; // q: 3 dp, p: 4 dp, t: 4 dp

function oracle(lines: OracleLine[], scale: number) {
  let subtotal = 0n;
  let tax = 0n;
  let tooLarge = false;
  const limit = pow10(16 + scale);
  const out = lines.map(({ q, p, t }) => {
    const lineSubtotal = divHalfUp(q * p, pow10(7 - scale)); // q·p has 7 decimals
    const lineTax = t === null ? 0n : divHalfUp(lineSubtotal * t, pow10(6)); // ×t/10^4 /100
    if (lineSubtotal + lineTax >= limit) tooLarge = true;
    subtotal += lineSubtotal;
    tax += lineTax;
    return {
      lineSubtotal: scaledToString(lineSubtotal, scale),
      lineTax: scaledToString(lineTax, scale),
      lineTotal: scaledToString(lineSubtotal + lineTax, scale),
    };
  });
  if (subtotal + tax >= limit) tooLarge = true;
  return {
    tooLarge,
    doc: {
      lines: out,
      subtotal: scaledToString(subtotal, scale),
      taxTotal: scaledToString(tax, scale),
      total: scaledToString(subtotal + tax, scale),
    },
  };
}

const lineArb = fc.record({
  q: fc.bigInt({ min: 1n, max: 999_999_999_999n }), // up to 999999999.999
  p: fc.bigInt({ min: 0n, max: 9_999_999_999_999_999n }), // up to 999999999999.9999
  t: fc.option(fc.bigInt({ min: 0n, max: 1_000_000n }), { nil: null }), // 0 to 100.0000
});

// Bias toward realistic magnitudes so most cases stay below the limit.
const smallLineArb = fc.record({
  q: fc.bigInt({ min: 1n, max: 1_000_000n }),
  p: fc.bigInt({ min: 0n, max: 100_000_000_000n }),
  t: fc.option(fc.bigInt({ min: 0n, max: 1_000_000n }), { nil: null }),
});

function toInput(line: OracleLine) {
  const base = { quantity: scaledToString(line.q, 3), unitPrice: scaledToString(line.p, 4) };
  return line.t === null ? base : { ...base, taxRatePct: scaledToString(line.t, 4) };
}

describe('priceDocument: properties', () => {
  it('matches the BigInt oracle for any valid input, including the AMOUNT_TOO_LARGE boundary', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(smallLineArb, lineArb), { minLength: 0, maxLength: 12 }),
        fc.constantFrom(0, 2, 4),
        (lines, scale) => {
          const expected = oracle(lines, scale);
          if (expected.tooLarge) {
            expectAmountTooLarge(() => priceDocument(lines.map(toInput), scale));
          } else {
            expect(priceDocument(lines.map(toInput), scale)).toEqual(expected.doc);
          }
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('document total always equals the sum of rounded line totals', () => {
    fc.assert(
      fc.property(fc.array(smallLineArb, { minLength: 1, maxLength: 20 }), fc.constantFrom(0, 2), (lines, scale) => {
        const doc = priceDocument(lines.map(toInput), scale);
        const sum = doc.lines.reduce((acc, l) => acc + BigInt(l.lineTotal.replace('.', '')), 0n);
        expect(BigInt(doc.total.replace('.', ''))).toBe(sum);
      }),
      { numRuns: 1000 },
    );
  });
});
