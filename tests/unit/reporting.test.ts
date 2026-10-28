import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CSV_BOM, number, text, textCell, toCsv } from '@/modules/reporting/domain/csv';
import { findSplitGroups, type SplitCandidate } from '@/modules/reporting/domain/split-purchases';
import { hoursOf, percentile } from '@/modules/reporting/domain/statistics';
import { dec } from '@/shared/decimal/decimal';

describe('P9-AC7: CSV formula-injection protection', () => {
  it.each([
    ['=SUM(A1:A9)', "'=SUM(A1:A9)"],
    ['+1555', "'+1555"],
    ['-2+3', "'-2+3"],
    ['@cmd', "'@cmd"],
    ['\tTAB first', "'\tTAB first"],
    ['\rCR first', `"'\rCR first"`],
  ])('prefixes %j with an apostrophe', (input, output) => {
    expect(textCell(input)).toBe(output);
  });

  it('leaves ordinary text alone and quotes commas, quotes, and line breaks', () => {
    expect(textCell('Example Office Supplies Ltd')).toBe('Example Office Supplies Ltd');
    expect(textCell('a = b')).toBe('a = b');
    expect(textCell('Paper, A4')).toBe('"Paper, A4"');
    expect(textCell('The "best" desk')).toBe('"The ""best"" desk"');
    expect(textCell('two\nlines')).toBe('"two\nlines"');
    expect(textCell('=HYPERLINK("http://example.com","x")')).toBe(`"'=HYPERLINK(""http://example.com"",""x"")"`);
    expect(textCell(null)).toBe('');
    expect(textCell('')).toBe('');
  });

  it('writes plain decimals as numbers (a minus sign included) and anything else as safe text', () => {
    const csv = toCsv(
      [
        { header: 'Amount', cell: (row: { amount: string | null }) => number(row.amount) },
        { header: 'Note', cell: () => text('-') },
      ],
      [{ amount: '-303.03' }, { amount: '1186.99' }, { amount: '0' }, { amount: null }, { amount: '-1+1' }, { amount: '1e5' }, { amount: '=1' }],
    );
    expect(csv).toBe(`${CSV_BOM}Amount,Note\r\n-303.03,'-\r\n1186.99,'-\r\n0,'-\r\n,'-\r\n'-1+1,'-\r\n1e5,'-\r\n'=1,'-\r\n`);
  });

  it('starts with a UTF-8 byte-order mark, separates rows with CRLF, and protects headers too', () => {
    const csv = toCsv([{ header: '=Total', cell: () => text('x') }], []);
    expect(csv).toBe(`﻿'=Total\r\n`);
  });
});

describe('percentile and hours', () => {
  it('interpolates between the closest ranks, like percentile_cont', () => {
    const values = ['10800', '19200', '43200', '108000', '122400', '172800'];
    expect(percentile(values, 0.5)?.toString()).toBe('75600');
    expect(percentile(values, 0.9)?.toString()).toBe('147600');
    expect(percentile(values, 0)?.toString()).toBe('10800');
    expect(percentile(values, 1)?.toString()).toBe('172800');
    expect(percentile(['7'], 0.9)?.toString()).toBe('7');
    expect(percentile([], 0.5)).toBeNull();
    // Order of input does not matter.
    expect(percentile(['3', '1', '2'], 0.5)?.toString()).toBe('2');
  });

  it('is exact where floating point is not', () => {
    // 0.1 + (0.3 - 0.1) × 0.5 = 0.2 exactly.
    expect(percentile(['0.1', '0.3'], 0.5)?.toString()).toBe('0.2');
  });

  it('rejects a fraction outside 0 to 1', () => {
    expect(() => percentile(['1'], 1.5)).toThrow();
    expect(() => percentile(['1'], -0.1)).toThrow();
  });

  it('turns seconds into hours with 2 decimals, half up', () => {
    expect(hoursOf(dec('19200'))).toBe('5.33');
    expect(hoursOf(dec('142080'))).toBe('39.47');
    expect(hoursOf(dec('18'))).toBe('0.01'); // 0.005 h rounds up
    expect(hoursOf(dec('0'))).toBe('0.00');
  });
});

describe('P9-AC5: potential split purchases', () => {
  let n = 0;
  function candidate(overrides: Partial<SplitCandidate>): SplitCandidate {
    n++;
    return {
      purchaseOrderId: `po-${n}`,
      number: `PO-2025-${String(n).padStart(6, '0')}`,
      requisitionNumber: `PR-2025-${String(n).padStart(6, '0')}`,
      requesterUserId: 'rina',
      requesterName: 'Rina',
      supplierId: 'office',
      supplierCode: 'SUP-1',
      supplierName: 'Office',
      currencyCode: 'USD',
      currencyScale: 2,
      fromQuotation: false,
      subtotal: '200.00',
      total: '222.00',
      approvedOn: '2025-03-01',
      ...overrides,
    };
  }
  const thresholds = { poApproval: '1000', rfq: '500' };

  it('groups orders below the threshold whose sum reaches it, within the window', () => {
    const a = candidate({ subtotal: '300.00', approvedOn: '2025-03-01' });
    const b = candidate({ subtotal: '200.00', approvedOn: '2025-03-31' });
    const groups = findSplitGroups([b, a], thresholds, 30);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ threshold: 'rfq', thresholdAmount: '500.00', combinedAmount: '500.00', firstOn: '2025-03-01', lastOn: '2025-03-31' });
    expect(groups[0]?.orders.map((o) => o.purchaseOrderId)).toEqual([a.purchaseOrderId, b.purchaseOrderId]);
    // One day further apart: outside a 30-day window.
    expect(findSplitGroups([a, candidate({ subtotal: '200.00', approvedOn: '2025-04-01' })], thresholds, 30)).toEqual([]);
  });

  it('never counts an order at or above the threshold, nor a lone order', () => {
    expect(findSplitGroups([candidate({ subtotal: '500.00' }), candidate({ subtotal: '100.00' })], thresholds, 30)).toEqual([]);
    expect(findSplitGroups([candidate({ subtotal: '499.99' })], thresholds, 30)).toEqual([]);
  });

  it('keeps requesters, suppliers, and currencies apart', () => {
    const groups = findSplitGroups(
      [
        candidate({ subtotal: '300.00' }),
        candidate({ subtotal: '300.00', requesterUserId: 'tia', requesterName: 'Tia' }),
        candidate({ subtotal: '300.00', supplierId: 'parts' }),
        candidate({ subtotal: '300.00', currencyCode: 'EUR' }),
      ],
      thresholds,
      30,
    );
    expect(groups).toEqual([]);
  });

  it('leaves orders from an RFQ award out of the RFQ check, not out of the approval check', () => {
    const quoted = [candidate({ subtotal: '400.00', total: '600.00', fromQuotation: true }), candidate({ subtotal: '400.00', total: '600.00', fromQuotation: true })];
    expect(findSplitGroups(quoted, thresholds, 30).map((g) => [g.threshold, g.combinedAmount])).toEqual([['po_approval', '1200.00']]);
  });

  it('slides the window on when a window falls short, and does not report an order twice', () => {
    // a (day 0) + b (day 6) = 400 short; b + c (day 10) = 600 reaches 500 with a 7-day window.
    const a = candidate({ subtotal: '200.00', approvedOn: '2025-03-01' });
    const b = candidate({ subtotal: '200.00', approvedOn: '2025-03-07' });
    const c = candidate({ subtotal: '400.00', approvedOn: '2025-03-11' });
    const d = candidate({ subtotal: '400.00', approvedOn: '2025-03-12' });
    const groups = findSplitGroups([a, b, c, d], { poApproval: null, rfq: '500' }, 7);
    expect(groups.map((g) => g.orders.map((o) => o.purchaseOrderId))).toEqual([[b.purchaseOrderId, c.purchaseOrderId, d.purchaseOrderId]]);
  });

  it('skips a threshold that is not set', () => {
    expect(findSplitGroups([candidate({ subtotal: '300.00' }), candidate({ subtotal: '300.00' })], { poApproval: null, rfq: null }, 30)).toEqual([]);
  });
});

describe('P9-AC6: no metric is written into a report component', () => {
  const root = resolve(import.meta.dirname, '../../src/app/(app)/reports');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(tsx?|jsx?)$/.test(name)) files.push(path);
    }
  };
  walk(root);

  it('finds the report pages', () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
  });

  it.each([
    ['a decimal number', /(?<![\w.-])\d+\.\d+(?![\w.])/],
    ['a currency amount', /[$€£¥]\s?\d|\b(USD|EUR|IDR|GBP)\s?\d/],
    ['a percentage', /\b\d+(\.\d+)?\s?%/],
    ['a number with thousands separators', /\b\d{1,3}(,\d{3})+\b/],
  ])('contains no %s', (_label, pattern) => {
    const hits = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) => (pattern.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [])),
    );
    expect(hits).toEqual([]);
  });
});
