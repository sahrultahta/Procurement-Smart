import { describe, expect, it } from 'vitest';
import { compareQuotations, justificationReasons, type AwardRule, type ComparedQuotation } from '@/modules/sourcing/domain/comparison';
import {
  QUOTATION_COMMANDS,
  QUOTATION_STATUSES,
  isLate,
  nextQuotationStatus,
  rfqAllows,
  validityOf,
  wasSubmitted,
  type QuotationCommand,
  type QuotationStatus,
} from '@/modules/sourcing/domain/quotation';
import { RFQ_STATUSES } from '@/modules/sourcing/domain/rfq';

// P6b-AC1: docs/state-machines.md §4 (quotation), written out independently of the implementation.
const EXPECTED: Record<string, QuotationStatus> = {
  'draft × update': 'draft', // QUO-T02
  'draft × submit': 'submitted', // QUO-T03
  'draft × withdraw': 'withdrawn', // discarding a draft (amendment)
  'submitted × withdraw': 'withdrawn', // QUO-T04
  'submitted × award': 'awarded', // QUO-T05
  'submitted × award_other': 'not_awarded', // QUO-T05
};

describe('P6b-AC1: quotation state machine, exhaustively', () => {
  const pairs = QUOTATION_STATUSES.flatMap((s) => QUOTATION_COMMANDS.map((c) => [s, c] as const));

  it('has 5 statuses × 5 commands', () => {
    expect(pairs).toHaveLength(25);
  });

  it.each(pairs)('%s × %s', (status: QuotationStatus, command: QuotationCommand) => {
    expect(nextQuotationStatus(status, command)).toBe(EXPECTED[`${status} × ${command}`] ?? null);
  });

  it('withdrawn, awarded, and not_awarded are terminal; the comparison looks at quotations that were submitted', () => {
    for (const terminal of ['withdrawn', 'awarded', 'not_awarded'] as const) {
      expect(QUOTATION_COMMANDS.map((c) => nextQuotationStatus(terminal, c))).toEqual(Array(5).fill(null));
    }
    expect(QUOTATION_STATUSES.filter(wasSubmitted)).toEqual(['submitted', 'awarded', 'not_awarded']);
  });

  it('gates every action on the RFQ status: quotations change only while it is issued, withdrawals until the award', () => {
    const allowed = (action: Parameters<typeof rfqAllows>[0]) => RFQ_STATUSES.filter((s) => rfqAllows(action, s));
    expect(allowed('record')).toEqual(['issued']);
    expect(allowed('update')).toEqual(['issued']);
    expect(allowed('submit')).toEqual(['issued']);
    expect(allowed('discard')).toEqual(['issued']);
    expect(allowed('withdraw')).toEqual(['issued', 'closed']);
    expect(allowed('award')).toEqual(['closed']);
  });
});

describe('validity and lateness', () => {
  const q = (status: QuotationStatus, validUntil = '2030-03-31', supplierActive = true) => ({ status, validUntil, supplierActive });

  it('is valid through its last day, in the order draft, withdrawn, expired, supplier not active', () => {
    expect(validityOf(q('submitted', '2030-03-31'), '2030-03-31')).toBe('valid');
    expect(validityOf(q('submitted', '2030-03-31'), '2030-04-01')).toBe('expired');
    expect(validityOf(q('submitted', '2030-03-31'), '2030-03-30')).toBe('valid');
    expect(validityOf(q('submitted', '2030-03-31', false), '2030-03-01')).toBe('supplier_not_active');
    expect(validityOf(q('submitted', '2029-12-31', false), '2030-03-01')).toBe('expired');
    expect(validityOf(q('draft'), '2030-03-01')).toBe('draft');
    expect(validityOf(q('withdrawn', '2020-01-01', false), '2030-03-01')).toBe('withdrawn');
    expect(validityOf(q('awarded'), '2030-03-01')).toBe('valid');
    expect(validityOf(q('not_awarded'), '2030-04-01')).toBe('expired');
  });

  it('is late only when submitted after the due time', () => {
    const due = new Date('2030-03-15T17:00:00Z');
    expect(isLate(new Date('2030-03-15T17:00:00Z'), due)).toBe(false);
    expect(isLate(new Date('2030-03-15T17:00:00.001Z'), due)).toBe(true);
    expect(isLate(new Date('2030-03-15T16:59:59Z'), due)).toBe(false);
    expect(isLate(null, due)).toBe(false);
  });
});

describe('P6b-AC6: comparison and justification rules', () => {
  const LINES = ['line-1', 'line-2'];
  const TODAY = '2030-03-20';
  const quote = (id: string, total: string, prices: [string, string], over: Partial<ComparedQuotation> = {}): ComparedQuotation => ({
    id,
    status: 'submitted',
    validUntil: '2030-03-31',
    supplierActive: true,
    total,
    unitPrices: new Map([
      ['line-1', prices[0]],
      ['line-2', prices[1]],
    ]),
    ...over,
  });
  const rule = (over: Partial<AwardRule> = {}): AwardRule => ({ estimatedTotal: '860.00', rfqRequiredAbove: '500', minQuotes: 3, ...over });

  it('finds the lowest valid total and the lowest price per line, ignoring drafts, withdrawn, expired, and inactive suppliers', () => {
    const quotes = [
      quote('a', '816.00', ['168', '36']),
      quote('b', '828.00', ['175', '32']),
      quote('expired', '10.00', ['1', '1.5'], { validUntil: '2030-03-19' }),
      quote('blocked', '20.00', ['2', '3'], { supplierActive: false }),
      quote('withdrawn', '30.00', ['3', '4.5'], { status: 'withdrawn' }),
      quote('draft', '40.00', ['4', '6'], { status: 'draft' }),
    ];
    const c = compareQuotations(quotes, LINES, rule(), TODAY);
    expect([...c.validity]).toEqual([
      ['a', 'valid'],
      ['b', 'valid'],
      ['expired', 'expired'],
      ['blocked', 'supplier_not_active'],
      ['withdrawn', 'withdrawn'],
      ['draft', 'draft'],
    ]);
    expect(c.validCount).toBe(2);
    expect(c.lowestTotal).toBe('816.00');
    expect([...c.lowestIds]).toEqual(['a']);
    expect([...(c.lowestOnLine.get('line-1') ?? [])]).toEqual(['a']);
    expect([...(c.lowestOnLine.get('line-2') ?? [])]).toEqual(['b']);
    expect(c).toMatchObject({ minQuotesApplies: true, belowMinQuotes: true });
    expect(justificationReasons(c, 'a')).toEqual(['below_min_quotes']);
    expect(justificationReasons(c, 'b')).toEqual(['below_min_quotes', 'not_lowest']);
  });

  it('compares as decimals, and a tie makes each tied quotation the lowest', () => {
    const c = compareQuotations([quote('a', '1000.00', ['9', '10']), quote('b', '999.99', ['10', '9']), quote('c', '999.990', ['9', '9.0'])], LINES, rule(), TODAY);
    expect([...c.lowestIds].sort()).toEqual(['b', 'c']);
    expect([...(c.lowestOnLine.get('line-1') ?? [])].sort()).toEqual(['a', 'c']);
    expect([...(c.lowestOnLine.get('line-2') ?? [])].sort()).toEqual(['b', 'c']);
    expect(justificationReasons(c, 'b')).toEqual([]);
    expect(justificationReasons(c, 'c')).toEqual([]);
    expect(justificationReasons(c, 'a')).toEqual(['not_lowest']);
    // 1000 is more than 999.99 as a decimal, though "1000.00" < "999.99" as text.
    expect(c.lowestTotal).toBe('999.99');
  });

  it('applies the minimum from the threshold itself, and only below the minimum count', () => {
    const three = [quote('a', '1', ['1', '0']), quote('b', '2', ['2', '0']), quote('c', '3', ['3', '0'])];
    const at = (estimatedTotal: string, rfqRequiredAbove: string | null, quotes = three, minQuotes = 3) =>
      compareQuotations(quotes, LINES, rule({ estimatedTotal, rfqRequiredAbove, minQuotes }), TODAY);
    expect(at('500.00', '500')).toMatchObject({ minQuotesApplies: true, belowMinQuotes: false });
    expect(at('500.00', '500', three.slice(0, 2))).toMatchObject({ minQuotesApplies: true, belowMinQuotes: true });
    expect(at('499.99', '500', three.slice(0, 2))).toMatchObject({ minQuotesApplies: false, belowMinQuotes: false });
    expect(at('0', '0', three.slice(0, 2))).toMatchObject({ minQuotesApplies: true, belowMinQuotes: true });
    expect(at('1000000', null, three.slice(0, 1))).toMatchObject({ minQuotesApplies: false, belowMinQuotes: false });
    expect(at('600', '500', three.slice(0, 1), 1)).toMatchObject({ belowMinQuotes: false });
    expect(at('600', '500', [], 1)).toMatchObject({ validCount: 0, lowestTotal: null, belowMinQuotes: true });
    // Expired quotations do not count towards the minimum.
    expect(at('600', '500', [...three.slice(0, 2), quote('old', '9', ['9', '0'], { validUntil: '2030-03-19' })])).toMatchObject({ validCount: 2, belowMinQuotes: true });
  });
});
