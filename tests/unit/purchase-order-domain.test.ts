import { describe, expect, it } from 'vitest';
import {
  PURCHASE_ORDER_COMMANDS,
  PURCHASE_ORDER_STATUSES,
  approvalReasons,
  closeNeedsReason,
  holdsOrderedQuantity,
  maxReceivableQuantity,
  nextPurchaseOrderStatus,
  quantityReleasedOnClose,
  receiptStatus,
  type PurchaseOrderCommand,
  type PurchaseOrderStatus,
} from '@/modules/purchasing/domain/purchase-order';
import { priceDocument } from '@/shared/decimal/pricing';

// P7-AC1: docs/state-machines.md §5, written out independently of the implementation.
const EXPECTED: Record<string, PurchaseOrderStatus> = {
  'draft × update': 'draft', // PO-T02
  'draft × submit': 'pending_approval', // PO-T03, approval required
  'draft × auto_approve': 'approved', // PO-T03, no approval required
  'draft × cancel': 'cancelled', // PO-T08
  'pending_approval × approve': 'approved', // PO-T04
  'pending_approval × return': 'draft', // PO-T04
  'pending_approval × reject': 'rejected', // PO-T04
  'pending_approval × cancel': 'cancelled', // PO-T08
  'approved × issue': 'issued', // PO-T05
  'approved × cancel': 'cancelled', // PO-T08
  'issued × close': 'closed', // PO-T07
  'issued × cancel': 'cancelled', // PO-T09
  'partially_received × close': 'closed', // PO-T07 (short-close)
  'received × close': 'closed', // PO-T07
};

describe('P7-AC1: purchase order state machine, exhaustively', () => {
  const pairs = PURCHASE_ORDER_STATUSES.flatMap((s) => PURCHASE_ORDER_COMMANDS.map((c) => [s, c] as const));

  it('has 9 statuses × 9 commands', () => {
    expect(pairs).toHaveLength(81);
  });

  it.each(pairs)('%s × %s', (status: PurchaseOrderStatus, command: PurchaseOrderCommand) => {
    expect(nextPurchaseOrderStatus(status, command)).toBe(EXPECTED[`${status} × ${command}`] ?? null);
  });

  it('lists only real pairs, and the terminal states accept nothing', () => {
    const real = new Set(pairs.map(([s, c]) => `${s} × ${c}`));
    for (const key of Object.keys(EXPECTED)) expect(real.has(key)).toBe(true);
    for (const terminal of ['closed', 'rejected', 'cancelled'] as const) {
      expect(PURCHASE_ORDER_COMMANDS.map((c) => nextPurchaseOrderStatus(terminal, c))).toEqual(Array(9).fill(null));
    }
  });

  it('a reason closes everything but a fully received order; cancelled and rejected orders hold nothing (PO-I1)', () => {
    expect(PURCHASE_ORDER_STATUSES.filter((s) => !closeNeedsReason(s))).toEqual(['received']);
    expect(PURCHASE_ORDER_STATUSES.filter((s) => !holdsOrderedQuantity(s))).toEqual(['rejected', 'cancelled']);
  });

  it('PO-T06: the receipt status follows the lines', () => {
    const lines = (...received: string[]) => received.map((r, i) => ({ quantity: i === 0 ? '4' : '2.5', receivedQty: r }));
    expect(receiptStatus(lines('0', '0'))).toBe('issued');
    expect(receiptStatus(lines('0.001', '0'))).toBe('partially_received');
    expect(receiptStatus(lines('4', '2.499'))).toBe('partially_received');
    expect(receiptStatus(lines('4', '2.5'))).toBe('received');
    expect(receiptStatus(lines('4.2', '2.6'))).toBe('received'); // within the receipt tolerance
    expect(receiptStatus([])).toBe('issued');
  });

  it('PO-T07: closing gives back max(0, quantity − received)', () => {
    expect(quantityReleasedOnClose('4', '0')).toBe('4');
    expect(quantityReleasedOnClose('4', '1.25')).toBe('2.75');
    expect(quantityReleasedOnClose('4', '4')).toBe('0');
    expect(quantityReleasedOnClose('4', '4.1')).toBe('0');
  });
});

describe('P7-AC8 (PO-T05): the receivable quantity, floor3(quantity × (1 + tolerance / 100))', () => {
  it.each([
    ['4', '0', '4'],
    ['4', '2.5', '4.1'],
    ['3.333', '2.5', '3.416'], // 3.416325, rounded down
    ['1', '0.0001', '1'], // 1.000001
    ['1', '0.05', '1'], // 1.0005: never rounded up
    ['999999999.999', '0', '999999999.999'],
    ['10', '100', '20'],
    ['0.001', '33.3333', '0.001'],
    ['7', '33.3333', '9.333'], // 9.3333331
  ])('%s at %s %% → %s', (quantity, tolerance, expected) => {
    expect(maxReceivableQuantity(quantity, tolerance)).toBe(expected);
  });
});

describe('P7-AC5 (PO-T03): when a purchase order needs approval', () => {
  const rule = { threshold: '1000', tolerancePct: '5' };
  const order = (subtotal: string, total: string, lines: [string, string, string][]) => ({
    subtotal,
    total,
    lines: lines.map(([quantity, unitPrice, estimatedUnitPrice]) => ({ quantity, unitPrice, estimatedUnitPrice })),
  });

  it('the amount threshold is inclusive and uses the total with tax', () => {
    expect(approvalReasons(order('900.00', '999.99', [['5', '180', '180']]), rule, 2)).toEqual([]);
    expect(approvalReasons(order('900.00', '1000.00', [['5', '180', '180']]), rule, 2)).toEqual(['AMOUNT_THRESHOLD']);
    expect(approvalReasons(order('1000.00', '1000.00', [['1', '1000', '1000']]), { ...rule, threshold: '1000.0000' }, 2)).toEqual(['AMOUNT_THRESHOLD']);
    expect(approvalReasons(order('0.01', '0.01', [['1', '0.01', '0.01']]), { ...rule, threshold: null }, 2)).toEqual(['NO_THRESHOLD']);
    expect(approvalReasons(order('0.00', '0.00', [['1', '0', '0']]), { ...rule, threshold: '0' }, 2)).toEqual(['AMOUNT_THRESHOLD']);
  });

  it('a unit price above estimate × (1 + tolerance), exactly; never for prices at or below it', () => {
    expect(approvalReasons(order('189.00', '189.00', [['1', '189', '180']]), rule, 2)).toEqual([]);
    expect(approvalReasons(order('189.00', '189.00', [['1', '189.0001', '180']]), rule, 2)).toEqual(['PRICE_VARIANCE']);
    expect(approvalReasons(order('100.00', '100.00', [['1', '100', '100']]), { ...rule, tolerancePct: '0' }, 2)).toEqual([]);
    expect(approvalReasons(order('100.00', '100.00', [['1', '100.0001', '100']]), { ...rule, tolerancePct: '0' }, 2)).toEqual(['PRICE_VARIANCE']);
    // An estimate of 0: any price is above it, unless the price is 0 too.
    expect(approvalReasons(order('0.01', '0.01', [['1', '0.01', '0']]), rule, 2)).toEqual(['PRICE_VARIANCE', 'TOTAL_VARIANCE']);
    expect(approvalReasons(order('0.00', '0.00', [['1', '0', '0']]), rule, 2)).toEqual([]);
  });

  it('the subtotal above the rounded estimate × (1 + tolerance), also when every price is within it', () => {
    // 0.005 is within 25 % of 0.004, but rounds to 0.01 against an estimate of round(0.004) = 0.00.
    expect(approvalReasons(order('0.01', '0.01', [['1', '0.005', '0.004']]), { ...rule, tolerancePct: '25' }, 2)).toEqual(['TOTAL_VARIANCE']);
    // At scale 0 (e.g. IDR) the estimate rounds per line: 3 × 0.4 = 1.2 → 1; a subtotal of 1 is not above 1.05.
    expect(approvalReasons(order('1', '1', [['3', '0.4', '0.4']]), rule, 0)).toEqual([]);
    expect(approvalReasons(order('378.00', '378.00', [['2', '189', '180']]), rule, 2)).toEqual([]);
    expect(approvalReasons(order('378.01', '378.01', [['2', '189', '180']]), rule, 2)).toEqual(['TOTAL_VARIANCE']);
  });

  it('every reason at once, in a fixed order', () => {
    expect(approvalReasons(order('1000.00', '1110.00', [['4', '250', '180']]), rule, 2)).toEqual(['AMOUNT_THRESHOLD', 'PRICE_VARIANCE', 'TOTAL_VARIANCE']);
    expect(approvalReasons(order('1000.00', '1110.00', [['4', '250', '180']]), { ...rule, threshold: null }, 2)).toEqual(['NO_THRESHOLD', 'PRICE_VARIANCE', 'TOTAL_VARIANCE']);
  });
});

describe('P7-AC8 (ADR 0007): purchase-order line tax and totals', () => {
  // [quantity, unit price, tax %, scale] → [subtotal, tax, total]
  it.each([
    ['2', '175', '0', 2, '350.00', '0.00', '350.00'],
    ['2', '175', '11', 2, '350.00', '38.50', '388.50'],
    ['2', '175', '12.5', 2, '350.00', '43.75', '393.75'],
    ['4', '33.333', '12.5', 2, '133.33', '16.67', '150.00'], // 133.332 → 133.33; 16.66625 → 16.67
    ['1', '0.05', '11', 2, '0.05', '0.01', '0.06'], // 0.0055 → 0.01 (half-up)
    ['1', '0.04', '12.5', 2, '0.04', '0.01', '0.05'], // 0.005 → 0.01 (half-up; half-even would give 0.00)
    ['3', '0.015', '11', 2, '0.05', '0.01', '0.06'], // 0.045 → 0.05; 0.0055 → 0.01
    ['1', '100000', '11', 0, '100000', '11000', '111000'], // IDR
    ['1', '4545', '11', 0, '4545', '500', '5045'], // 499.95 → 500
    ['1', '4545', '12.5', 0, '4545', '568', '5113'], // 568.125 → 568
    ['1.5', '0.3333', '12.5', 4, '0.5000', '0.0625', '0.5625'], // 0.49995 → 0.5000
  ])('%s × %s at %s %% (scale %s) → %s + %s = %s', (quantity, unitPrice, taxRatePct, scale, subtotal, tax, total) => {
    const priced = priceDocument([{ quantity, unitPrice, taxRatePct }], scale);
    expect(priced.lines[0]).toEqual({ lineSubtotal: subtotal, lineTax: tax, lineTotal: total });
    expect(priced).toMatchObject({ subtotal, taxTotal: tax, total });
  });

  it('document totals are sums of the rounded lines, with mixed rates', () => {
    const priced = priceDocument(
      [
        { quantity: '2', unitPrice: '175', taxRatePct: '11' },
        { quantity: '4', unitPrice: '33.333', taxRatePct: '12.5' },
        { quantity: '1', unitPrice: '0.05', taxRatePct: '0' },
      ],
      2,
    );
    expect(priced).toMatchObject({ subtotal: '483.38', taxTotal: '55.17', total: '538.55' });
  });
});
