import 'server-only';
import { dec } from '@/shared/decimal/decimal';
import type { Database, Tx } from '@/shared/db/transaction';
import type { QuotationStatus } from '../domain/quotation';
import { findQuotation, findQuotationLines, type QuotationRow } from '../infrastructure/quotation-repository';
import { findAwardedRfqs, findRfq, findRfqLines, type RfqRow } from '../infrastructure/rfq-repository';

/*
 * What purchase orders (Phase 7) need from sourcing: a quotation's prices and quantities per
 * requisition line, its validity, and who awarded it (SOD-06). Awarded RFQs and quotations never
 * change again (rfqs_guard, quotations_guard), so these reads need no lock. Prices and quantities
 * are decimal strings without trailing zeros.
 */

export type QuotationForPurchasing = {
  id: string;
  status: QuotationStatus;
  rfqId: string;
  rfqNumber: string;
  requisitionId: string;
  supplierId: string;
  supplierReference: string | null;
  validUntil: string;
  /** The buyer who awarded it, when it is the awarded quotation of its RFQ. */
  awardedByUserId: string | null;
  lines: { id: string; requisitionLineId: string; quantity: string; unitPrice: string }[];
};

export async function findQuotationForPurchasing(db: Database | Tx, quotationId: string): Promise<QuotationForPurchasing | null> {
  const quotation = await findQuotation(db, quotationId);
  if (!quotation) return null;
  const rfq = await findRfq(db, quotation.rfqId);
  if (!rfq) throw new Error(`RFQ ${quotation.rfqId} of quotation ${quotation.id} is missing`);
  return forPurchasing(db, rfq, quotation);
}

/** The awarded quotation of each awarded RFQ of a requisition, newest RFQ first. */
export async function findAwardedQuotations(db: Database | Tx, requisitionId: string): Promise<QuotationForPurchasing[]> {
  const found: QuotationForPurchasing[] = [];
  for (const rfq of await findAwardedRfqs(db, requisitionId)) {
    const quotation = rfq.awardedQuotationId ? await findQuotation(db, rfq.awardedQuotationId) : null;
    if (quotation) found.push(await forPurchasing(db, rfq, quotation));
  }
  return found;
}

async function forPurchasing(db: Database | Tx, rfq: RfqRow, quotation: QuotationRow): Promise<QuotationForPurchasing> {
  const rfqLines = new Map((await findRfqLines(db, rfq.id)).map((l) => [l.id, l]));
  const lines = await findQuotationLines(db, [quotation.id]);
  return {
    id: quotation.id,
    status: quotation.status as QuotationStatus,
    rfqId: rfq.id,
    rfqNumber: rfq.number,
    requisitionId: rfq.requisitionId,
    supplierId: quotation.supplierId,
    supplierReference: quotation.supplierReference,
    validUntil: quotation.validUntil,
    awardedByUserId: rfq.status === 'awarded' && rfq.awardedQuotationId === quotation.id ? rfq.awardedByUserId : null,
    lines: lines.map((l) => {
      const rfqLine = rfqLines.get(l.rfqLineId);
      if (!rfqLine) throw new Error(`RFQ line ${l.rfqLineId} of quotation ${quotation.id} is missing`);
      return { id: l.id, requisitionLineId: rfqLine.requisitionLineId, quantity: dec(l.quantity).toString(), unitPrice: dec(l.unitPrice).toString() };
    }),
  };
}
