import { describe, expect, it } from 'vitest';
import {
  GOODS_RECEIPT_COMMANDS,
  GOODS_RECEIPT_KINDS,
  GOODS_RECEIPT_STATUSES,
  nextGoodsReceiptStatus,
  overReceivedLines,
  remainingReceivable,
  type GoodsReceiptCommand,
  type GoodsReceiptKind,
  type GoodsReceiptStatus,
} from '@/modules/receiving/domain/goods-receipt';

// P8-AC1: docs/state-machines.md §6, written out independently of the implementation.
const EXPECTED: Record<string, GoodsReceiptStatus> = {
  'receipt × draft × post': 'posted', // GR-T02
  'receipt × draft × cancel': 'cancelled', // GR-T03
  'receipt × posted × reverse': 'posted', // GR-T04: the receipt stays posted; the reversal is a new document
  'reversal × draft × post': 'posted', // GR-T04, in the same transaction that records it
};

describe('P8-AC1: goods receipt state machine, exhaustively', () => {
  const triples = GOODS_RECEIPT_KINDS.flatMap((k) => GOODS_RECEIPT_STATUSES.flatMap((s) => GOODS_RECEIPT_COMMANDS.map((c) => [k, s, c] as const)));

  it('has 2 kinds × 3 statuses × 3 commands', () => {
    expect(triples).toHaveLength(18);
  });

  it.each(triples)('%s × %s × %s', (kind: GoodsReceiptKind, status: GoodsReceiptStatus, command: GoodsReceiptCommand) => {
    expect(nextGoodsReceiptStatus(kind, status, command)).toBe(EXPECTED[`${kind} × ${status} × ${command}`] ?? null);
  });

  it('lists only real triples; cancelled receipts and posted reversals accept nothing', () => {
    const real = new Set(triples.map(([k, s, c]) => `${k} × ${s} × ${c}`));
    for (const key of Object.keys(EXPECTED)) expect(real.has(key)).toBe(true);
    for (const kind of GOODS_RECEIPT_KINDS) expect(GOODS_RECEIPT_COMMANDS.map((c) => nextGoodsReceiptStatus(kind, 'cancelled', c))).toEqual([null, null, null]);
    expect(GOODS_RECEIPT_COMMANDS.map((c) => nextGoodsReceiptStatus('reversal', 'posted', c))).toEqual([null, null, null]);
  });
});

describe('P8-AC3 (GR-T02): what an order line can still take, and OVER_RECEIPT', () => {
  it('remaining = max(0, receivable − received)', () => {
    expect(remainingReceivable('11', '0')).toBe('11');
    expect(remainingReceivable('11', '8.25')).toBe('2.75');
    expect(remainingReceivable('4.4', '4.4')).toBe('0');
    expect(remainingReceivable('4', '4.5')).toBe('0');
  });

  it('names every line over what it can take, at the exact edge', () => {
    const line = (lineNo: number, quantity: string, receivedQty: string, maxReceivableQty: string) => ({ lineNo, quantity, receivedQty, maxReceivableQty });
    expect(overReceivedLines([line(1, '3', '8', '11'), line(2, '4.4', '0', '4.4')])).toEqual([]);
    expect(overReceivedLines([line(1, '3.001', '8', '11'), line(2, '4.401', '0', '4.4'), line(3, '1', '0', '1')])).toEqual([
      { lineNo: 1, remaining: '3' },
      { lineNo: 2, remaining: '4.4' },
    ]);
    expect(overReceivedLines([line(1, '0.001', '11', '11')])).toEqual([{ lineNo: 1, remaining: '0' }]);
  });
});
