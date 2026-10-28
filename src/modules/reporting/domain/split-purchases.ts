import { Dec, dec, toFixedScale, type DecimalValue } from '@/shared/decimal/decimal';

/**
 * Potential split purchases (decision 5). Orders for the same requester and supplier, each below a
 * threshold, approved within `windowDays` of the first one, whose amounts together reach it.
 *
 * - `po_approval`: order totals (tax included) against `po_approval_threshold`.
 * - `rfq`: order subtotals (tax excluded) against `rfq_required_above`; orders from an awarded
 *   quotation went through an RFQ, so they never count here.
 *
 * A window starts at an order and takes the later ones up to `windowDays` after it (inclusive).
 * A window that reaches the threshold is reported and the next one starts after it; otherwise the
 * next window starts at the following order. So no order is reported twice for one threshold.
 */
export const SPLIT_THRESHOLDS = ['po_approval', 'rfq'] as const;
export type SplitThreshold = (typeof SPLIT_THRESHOLDS)[number];

export type SplitCandidate = {
  purchaseOrderId: string;
  number: string;
  requisitionNumber: string;
  requesterUserId: string;
  requesterName: string;
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  currencyCode: string;
  currencyScale: number;
  fromQuotation: boolean;
  subtotal: string;
  total: string;
  /** YYYY-MM-DD, the org date the order was approved. */
  approvedOn: string;
};

export type SplitGroup = {
  threshold: SplitThreshold;
  thresholdAmount: string;
  requesterName: string;
  supplierCode: string;
  supplierName: string;
  currencyCode: string;
  currencyScale: number;
  firstOn: string;
  lastOn: string;
  combinedAmount: string;
  orders: { purchaseOrderId: string; number: string; requisitionNumber: string; approvedOn: string; amount: string }[];
};

const DAY_MS = 86_400_000;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;

export function findSplitGroups(
  candidates: readonly SplitCandidate[],
  thresholds: { readonly poApproval: string | null; readonly rfq: string | null },
  windowDays: number,
): SplitGroup[] {
  const groups: SplitGroup[] = [];
  for (const threshold of SPLIT_THRESHOLDS) {
    const limit = threshold === 'po_approval' ? thresholds.poApproval : thresholds.rfq;
    if (limit === null) continue;
    const limitValue = dec(limit);
    const amountOf = (c: SplitCandidate) => dec(threshold === 'po_approval' ? c.total : c.subtotal);
    const below = candidates.filter((c) => (threshold === 'rfq' ? !c.fromQuotation : true) && amountOf(c).lt(limitValue));

    const byKey = new Map<string, SplitCandidate[]>();
    for (const c of below) {
      const key = `${c.requesterUserId}|${c.supplierId}|${c.currencyCode}`;
      const list = byKey.get(key) ?? [];
      list.push(c);
      byKey.set(key, list);
    }
    for (const list of byKey.values()) {
      list.sort((a, b) => a.approvedOn.localeCompare(b.approvedOn) || a.number.localeCompare(b.number));
      let start = 0;
      while (start < list.length) {
        const first = list[start] as SplitCandidate;
        let end = start + 1;
        while (end < list.length && dayNumber((list[end] as SplitCandidate).approvedOn) - dayNumber(first.approvedOn) <= windowDays) end++;
        const window = list.slice(start, end);
        const combined = window.reduce<DecimalValue>((sum, c) => sum.add(amountOf(c)), new Dec(0));
        if (window.length >= 2 && combined.gte(limitValue)) {
          const scale = first.currencyScale;
          groups.push({
            threshold,
            thresholdAmount: toFixedScale(limitValue, scale),
            requesterName: first.requesterName,
            supplierCode: first.supplierCode,
            supplierName: first.supplierName,
            currencyCode: first.currencyCode,
            currencyScale: scale,
            firstOn: first.approvedOn,
            lastOn: (window.at(-1) as SplitCandidate).approvedOn,
            combinedAmount: toFixedScale(combined, scale),
            orders: window.map((c) => ({
              purchaseOrderId: c.purchaseOrderId,
              number: c.number,
              requisitionNumber: c.requisitionNumber,
              approvedOn: c.approvedOn,
              amount: toFixedScale(amountOf(c), scale),
            })),
          });
          start = end;
        } else {
          start++;
        }
      }
    }
  }
  return groups.sort(
    (a, b) => a.firstOn.localeCompare(b.firstOn) || a.requesterName.localeCompare(b.requesterName) || a.supplierName.localeCompare(b.supplierName) || a.threshold.localeCompare(b.threshold),
  );
}
