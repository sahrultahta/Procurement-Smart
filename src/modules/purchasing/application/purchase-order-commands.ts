import 'server-only';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { cancelApprovalRequest, openApprovalRequest } from '@/modules/approvals';
import { auditChanges, recordAuditEvent } from '@/modules/audit';
import { findPurchasingRules, lockPurchasingRules, resolveApprovalRoute, todayIn, type PurchasingRules } from '@/modules/organization';
import {
  lockRequisitionForPurchasing,
  releaseOrderedQuantity,
  reserveOrderedQuantity,
  type RequisitionForPurchasing,
} from '@/modules/requisitions';
import { findQuotationForPurchasing, type QuotationForPurchasing } from '@/modules/sourcing';
import { findSuppliersByIds, type SupplierRecord } from '@/modules/suppliers';
import { defineCommand } from '@/shared/application/runner';
import { dec, toFixedScale } from '@/shared/decimal/decimal';
import { compareAmounts, priceDocument, type PricedDocument } from '@/shared/decimal/pricing';
import { allocateDocumentNumber, formatDocumentNumber } from '@/shared/db/document-numbers';
import { idempotencyKeyField, withIdempotency } from '@/shared/db/idempotency';
import type { Tx } from '@/shared/db/transaction';
import { AppFailure, fail, failBusinessRule } from '@/shared/result';
import {
  approvalReasons,
  closeNeedsReason,
  maxReceivableQuantity,
  quantityReleasedOnClose,
  type ApprovalReason,
  type PurchaseOrderStatus,
} from '../domain/purchase-order';
import {
  findPurchaseOrderLines,
  insertPurchaseOrder,
  replacePurchaseOrderLines,
  setMaxReceivable,
  updatePurchaseOrder,
  type PurchaseOrderLineRow,
  type PurchaseOrderLineValues,
  type PurchaseOrderRow,
} from '../infrastructure/purchase-order-repository';
import {
  optionalReasonField,
  purchaseOrderAudit,
  purchaseOrderFields,
  purchaseOrderLineSummary,
  reasonField,
  versionField,
  type PurchaseOrderLineInput,
} from './purchase-order-input';
import {
  assertCreator,
  assertOrderTransition,
  assertOrderVersion,
  assertRequisitionApproved,
  lockOrderRow,
  lockOrderWithRequisition,
} from './purchase-order-locks';

/*
 * Purchase orders (US-PO-01 to US-PO-04; PO-T01 to T03, T05, T07 to T09). The approval outcomes
 * (PO-T04) are in approval-document.ts. Lock order (ADR 0008 C8): the requisition, the purchase
 * order, its approval round, then requisition lines in ascending id order.
 */

type DraftInput = {
  paymentTerms: string | null;
  deliveryAddress: string | null;
  expectedDeliveryDate: string | null;
  lines: PurchaseOrderLineInput[];
};

function invalid(fieldErrors: Record<string, string[]>): never {
  throw new AppFailure({ code: 'VALIDATION_FAILED', message: 'Some fields are invalid.', fieldErrors });
}

const supplierLabel = (supplier: Pick<SupplierRecord, 'code' | 'legalName'>) => `${supplier.code} ${supplier.legalName}`;

/** With a quotation (decision 5): awarded, still valid by the org date, from this supplier, for this requisition. */
async function usableQuotation(tx: Tx, quotationId: string, requisition: RequisitionForPurchasing, supplierId: string, today: string): Promise<QuotationForPurchasing> {
  const quotation = await findQuotationForPurchasing(tx, quotationId);
  if (!quotation || quotation.requisitionId !== requisition.id) invalid({ quotationId: [`This quotation is not for requisition ${requisition.number}.`] });
  if (quotation.status !== 'awarded' || quotation.awardedByUserId === null) {
    failBusinessRule('QUOTATION_NOT_AWARDED', `Only an awarded quotation can be ordered from. Award it on ${quotation.rfqNumber} first.`);
  }
  if (quotation.validUntil < today) {
    failBusinessRule('QUOTATION_EXPIRED', `The quotation on ${quotation.rfqNumber} was valid until ${quotation.validUntil}, so its prices can no longer be ordered.`);
  }
  if (quotation.supplierId !== supplierId) invalid({ supplierId: ['The quotation is from another supplier.'] });
  return quotation;
}

/** PO-T01 (and again at submit, decision 7): at or above `rfq_required_above`, only from an awarded quotation. */
function assertSourced(requisition: RequisitionForPurchasing, hasQuotation: boolean, rules: PurchasingRules): void {
  if (hasQuotation || rules.rfqRequiredAbove === null || compareAmounts(requisition.estimatedTotal, rules.rfqRequiredAbove) < 0) return;
  const threshold = toFixedScale(dec(rules.rfqRequiredAbove), requisition.currencyScale);
  failBusinessRule(
    'RFQ_REQUIRED',
    `Requisition ${requisition.number} is estimated at ${requisition.estimatedTotal} ${requisition.currencyCode}, at or above ${threshold} ${requisition.currencyCode}: order it from an awarded quotation.`,
  );
}

async function activeSupplier(tx: Tx, supplierId: string, verb: string): Promise<SupplierRecord> {
  const supplier = (await findSuppliersByIds(tx, [supplierId])).get(supplierId);
  if (supplier?.status !== 'active') {
    failBusinessRule(
      'SUPPLIER_NOT_ACTIVE',
      supplier ? `${supplier.legalName} (${supplier.code}) is not active, so this purchase order cannot be ${verb}.` : 'The supplier does not exist or is not active.',
    );
  }
  return supplier;
}

type PreparedDraft = {
  lines: PurchaseOrderLineValues[];
  priced: PricedDocument;
  /** Ordered quantity per requisition line. */
  quantities: Map<string, string>;
  summaries: string[];
};

/**
 * The rules shared by create and edit (PO-T01 / T02): lines of this requisition, with a
 * quotation its lines at its prices and for no more than it quoted, amounts per ADR 0007.
 */
function prepareDraft(requisition: RequisitionForPurchasing, quotation: QuotationForPurchasing | null, input: DraftInput): PreparedDraft {
  const byId = new Map(requisition.lines.map((l) => [l.id, l]));
  const quoted = new Map((quotation?.lines ?? []).map((l) => [l.id, l]));
  const errors: Record<string, string[]> = {};
  input.lines.forEach((line, i) => {
    const source = byId.get(line.requisitionLineId);
    if (!source) {
      errors[`lines.${i}.requisitionLineId`] = [`This line is not on requisition ${requisition.number}.`];
      return;
    }
    if (quotation) {
      const quotedLine = line.quotationLineId ? quoted.get(line.quotationLineId) : undefined;
      if (quotedLine?.requisitionLineId !== source.id) errors[`lines.${i}.quotationLineId`] = [`Requisition line ${source.lineNo} is not on this quotation.`];
    } else {
      if (line.quotationLineId) errors[`lines.${i}.quotationLineId`] = ['This purchase order is not from a quotation.'];
      if (line.unitPrice === undefined) errors[`lines.${i}.unitPrice`] = ['Enter a unit price'];
    }
  });
  if (Object.keys(errors).length > 0) invalid(errors);

  const chosen = input.lines.map((line) => {
    const source = byId.get(line.requisitionLineId);
    if (!source) throw new Error('requisition line vanished after validation');
    const quotedLine = line.quotationLineId ? quoted.get(line.quotationLineId) : undefined;
    // Client prices are ignored when the order has a quotation (P7-AC4).
    const unitPrice = quotedLine ? quotedLine.unitPrice : (line.unitPrice ?? '0');
    return { line, source, quotedLine, unitPrice };
  });
  const tooMuch = chosen.filter(({ line, quotedLine }) => quotedLine !== undefined && dec(line.quantity).gt(dec(quotedLine.quantity)));
  if (tooMuch.length > 0) {
    const [first] = tooMuch;
    failBusinessRule(
      'QUANTITY_EXCEEDS_QUOTED',
      `Requisition line ${first?.source.lineNo} was quoted for ${first?.quotedLine?.quantity} ${first?.source.uom}; order no more than that from this quotation.`,
      tooMuch.map(({ source, quotedLine }) => ({ lineNo: source.lineNo, quoted: quotedLine?.quantity })),
    );
  }

  const priced = priceDocument(
    chosen.map(({ line, unitPrice }) => ({ quantity: line.quantity, unitPrice, taxRatePct: line.taxRatePct })),
    requisition.currencyScale,
  );
  const lines = chosen.map(({ line, source, quotedLine, unitPrice }, i) => {
    const amounts = priced.lines[i];
    if (!amounts) throw new Error('priced line missing');
    return {
      requisitionLineId: source.id,
      quotationLineId: quotedLine?.id ?? null,
      description: source.description,
      uom: source.uom,
      quantity: line.quantity,
      unitPrice,
      taxRatePct: line.taxRatePct,
      lineSubtotal: amounts.lineSubtotal,
      lineTax: amounts.lineTax,
      lineTotal: amounts.lineTotal,
    };
  });
  return {
    lines,
    priced,
    quantities: new Map(lines.map((l) => [l.requisitionLineId, dec(l.quantity).toString()])),
    summaries: lines.map((l, i) => purchaseOrderLineSummary(i + 1, { ...l, requisitionLineNo: byId.get(l.requisitionLineId)?.lineNo ?? 0 })),
  };
}

/**
 * OVER_ORDER (PO-T01 / T02, P7-AC2): moves each requisition line's ordered quantity by the change
 * in what this order asks for, in ascending line id order, with the conditional update (C2)
 * as the guard and the CHECK as its backstop. `remainingQty` was read under the requisition's lock.
 */
async function applyQuantityChanges(tx: Tx, requisition: RequisitionForPurchasing, before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): Promise<void> {
  const byId = new Map(requisition.lines.map((l) => [l.id, l]));
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
  const deltas = ids.map((id) => ({ id, delta: dec(after.get(id) ?? '0').sub(dec(before.get(id) ?? '0')) }));
  const over = deltas.flatMap(({ id, delta }) => {
    const line = byId.get(id);
    return line && delta.gt(dec(line.remainingQty)) ? [{ lineNo: line.lineNo, remaining: line.remainingQty, uom: line.uom }] : [];
  });
  const overOrder = (lines: { lineNo: number; remaining: string; uom: string }[]): never => {
    const [first] = lines;
    failBusinessRule(
      'OVER_ORDER',
      `Requisition line ${first?.lineNo} has only ${first?.remaining} ${first?.uom} left to order.`,
      lines.map(({ lineNo, remaining }) => ({ lineNo, remaining })),
    );
  };
  if (over.length > 0) overOrder(over);
  for (const { id, delta } of deltas) {
    if (delta.gt(0)) {
      if (!(await reserveOrderedQuantity(tx, id, delta.toString()))) {
        const line = byId.get(id);
        overOrder([{ lineNo: line?.lineNo ?? 0, remaining: line?.remainingQty ?? '0', uom: line?.uom ?? '' }]);
      }
    } else if (delta.lt(0)) {
      await releaseOrderedQuantity(tx, id, delta.neg().toString());
    }
  }
}

/** What every quantity-releasing transition gives back, per requisition line: "1. 4 pcs (requisition line 2)". */
async function release(
  tx: Tx,
  requisition: RequisitionForPurchasing,
  lines: readonly PurchaseOrderLineRow[],
  amount: (line: PurchaseOrderLineRow) => string,
): Promise<string[]> {
  const lineNo = new Map(requisition.lines.map((l) => [l.id, l.lineNo]));
  const released: string[] = [];
  for (const line of [...lines].sort((a, b) => (a.requisitionLineId < b.requisitionLineId ? -1 : 1))) {
    const quantity = amount(line);
    if (dec(quantity).gt(0)) {
      await releaseOrderedQuantity(tx, line.requisitionLineId, quantity);
      released.push(`${dec(quantity).toString()} ${line.uom} (requisition line ${lineNo.get(line.requisitionLineId) ?? 0})`);
    }
  }
  return released.sort();
}

export const releaseAll = (tx: Tx, requisition: RequisitionForPurchasing, lines: readonly PurchaseOrderLineRow[]) =>
  release(tx, requisition, lines, (line) => dec(line.quantity).toString());

type StoredDraft = { paymentTerms: string | null; deliveryAddress: string | null; expectedDeliveryDate: string | null; lines: string[]; subtotal: string; taxTotal: string; total: string };

function storedDraft(row: PurchaseOrderRow, lines: readonly PurchaseOrderLineRow[], requisition: RequisitionForPurchasing): StoredDraft {
  const lineNo = new Map(requisition.lines.map((l) => [l.id, l.lineNo]));
  const money = (value: string) => toFixedScale(dec(value), row.currencyScale);
  return {
    paymentTerms: row.paymentTerms,
    deliveryAddress: row.deliveryAddress,
    expectedDeliveryDate: row.expectedDeliveryDate,
    lines: lines.map((l) => purchaseOrderLineSummary(l.lineNo, { ...l, lineTotal: money(l.lineTotal), requisitionLineNo: lineNo.get(l.requisitionLineId) ?? 0 })),
    subtotal: money(row.subtotal),
    taxTotal: money(row.taxTotal),
    total: money(row.total),
  };
}

/** PO-T01 */
export const createPurchaseOrder = defineCommand({
  name: 'po.create',
  permission: 'po.create',
  input: z.strictObject({
    requisitionId: z.uuid(),
    supplierId: z.uuid(),
    quotationId: z.uuid().nullable().optional(),
    ...purchaseOrderFields,
    idempotencyKey: idempotencyKeyField,
  }),
  handler: async ({ tx, actor, request, clock }, input) => {
    const { idempotencyKey, ...fields } = input;
    return withIdempotency(tx, { userId: actor.userId, key: idempotencyKey, operation: 'po.create', input: fields }, async () => {
      const requisition = await lockRequisitionForPurchasing(tx, fields.requisitionId);
      if (!requisition) fail('NOT_FOUND', 'Requisition not found.');
      assertRequisitionApproved(requisition);
      const rules = await lockPurchasingRules(tx);
      const today = todayIn(rules.timezone, clock.now());
      const quotation = fields.quotationId ? await usableQuotation(tx, fields.quotationId, requisition, fields.supplierId, today) : null;
      assertSourced(requisition, quotation !== null, rules);
      const supplier = await activeSupplier(tx, fields.supplierId, 'created');
      const draft = prepareDraft(requisition, quotation, fields);
      await applyQuantityChanges(tx, requisition, new Map(), draft.quantities);

      const year = Number(today.slice(0, 4));
      const number = formatDocumentNumber('PO', year, await allocateDocumentNumber(tx, 'PO', year));
      const purchaseOrderId = await insertPurchaseOrder(tx, {
        number,
        requisitionId: requisition.id,
        departmentId: requisition.departmentId,
        supplierId: supplier.id,
        quotationId: quotation?.id ?? null,
        currencyCode: requisition.currencyCode,
        currencyScale: requisition.currencyScale,
        paymentTerms: fields.paymentTerms,
        deliveryAddress: fields.deliveryAddress,
        expectedDeliveryDate: fields.expectedDeliveryDate,
        subtotal: draft.priced.subtotal,
        taxTotal: draft.priced.taxTotal,
        total: draft.priced.total,
        createdByUserId: actor.userId,
      });
      await replacePurchaseOrderLines(tx, purchaseOrderId, draft.lines);
      await recordAuditEvent(tx, request, {
        action: 'po.created',
        entityType: 'purchase_order',
        entityId: purchaseOrderId,
        changes: auditChanges(purchaseOrderAudit, null, {
          number,
          requisitionNumber: requisition.number,
          supplier: supplierLabel(supplier),
          quotation: quotation?.rfqNumber ?? null,
          paymentTerms: fields.paymentTerms,
          deliveryAddress: fields.deliveryAddress,
          expectedDeliveryDate: fields.expectedDeliveryDate,
          currencyCode: requisition.currencyCode,
          lines: draft.summaries,
          subtotal: draft.priced.subtotal,
          taxTotal: draft.priced.taxTotal,
          total: draft.priced.total,
          status: 'draft',
        }),
      });
      return { purchaseOrderId, number, version: 1, total: draft.priced.total };
    });
  },
});

/** PO-T02: replace terms, lines, and tax rates while the order is a draft; quantity changes are re-reserved. */
export const updatePurchaseOrderDraft = defineCommand({
  name: 'po.update',
  permission: 'po.create',
  input: z.strictObject({ purchaseOrderId: z.uuid(), expectedVersion: versionField, ...purchaseOrderFields }),
  handler: async ({ tx, actor, request, clock }, input): Promise<{ version: number; total: string }> => {
    const { row, requisition } = await lockOrderWithRequisition(tx, input.purchaseOrderId);
    assertOrderVersion(row, input.expectedVersion);
    assertCreator(row, actor, 'edit');
    assertOrderTransition(row, 'update', 'edited');
    assertRequisitionApproved(requisition);
    const rules = await findPurchasingRules(tx);
    const quotation = row.quotationId ? await usableQuotation(tx, row.quotationId, requisition, row.supplierId, todayIn(rules.timezone, clock.now())) : null;
    const draft = prepareDraft(requisition, quotation, input);
    const stored = await findPurchaseOrderLines(tx, row.id);
    const changes = auditChanges(purchaseOrderAudit, storedDraft(row, stored, requisition), {
      paymentTerms: input.paymentTerms,
      deliveryAddress: input.deliveryAddress,
      expectedDeliveryDate: input.expectedDeliveryDate,
      lines: draft.summaries,
      subtotal: draft.priced.subtotal,
      taxTotal: draft.priced.taxTotal,
      total: draft.priced.total,
    });
    if (Object.keys(changes).length === 0) return { version: row.version, total: toFixedScale(dec(row.total), row.currencyScale) };

    await applyQuantityChanges(tx, requisition, new Map(stored.map((l) => [l.requisitionLineId, dec(l.quantity).toString()])), draft.quantities);
    if (changes.lines) await replacePurchaseOrderLines(tx, row.id, draft.lines);
    const version = await updatePurchaseOrder(tx, row.id, row.version, {
      paymentTerms: input.paymentTerms,
      deliveryAddress: input.deliveryAddress,
      expectedDeliveryDate: input.expectedDeliveryDate,
      subtotal: draft.priced.subtotal,
      taxTotal: draft.priced.taxTotal,
      total: draft.priced.total,
    });
    await recordAuditEvent(tx, request, { action: 'po.updated', entityType: 'purchase_order', entityId: row.id, changes });
    return { version, total: draft.priced.total };
  },
});

/** The reason recorded when a purchase order needs no approval (PO-T03). */
export const BELOW_THRESHOLD = 'BELOW_THRESHOLD';

/**
 * PO-T03: approval is required for the amount, a unit-price variance, or a total variance
 * (decision 6); otherwise the order is approved at once, audited as BELOW_THRESHOLD. The rule
 * used is stored with the order, and the database recomputes the reasons from it.
 */
export const submitPurchaseOrder = defineCommand({
  name: 'po.submit',
  permission: 'po.create',
  input: z.strictObject({ purchaseOrderId: z.uuid(), expectedVersion: versionField }),
  handler: async (
    { tx, actor, request, clock },
    input,
  ): Promise<{ version: number; status: PurchaseOrderStatus; approvalReasons: ApprovalReason[]; approvalRequestId: string | null; round: number | null }> => {
    const { row, requisition } = await lockOrderWithRequisition(tx, input.purchaseOrderId);
    assertOrderVersion(row, input.expectedVersion);
    assertCreator(row, actor, 'submit');
    const pending = assertOrderTransition(row, 'submit', 'submitted');
    const rules = await lockPurchasingRules(tx);
    assertSourced(requisition, row.quotationId !== null, rules);
    await activeSupplier(tx, row.supplierId, 'submitted');
    const today = todayIn(rules.timezone, clock.now());
    if (row.expectedDeliveryDate !== null && row.expectedDeliveryDate < today) {
      failBusinessRule('DELIVERY_DATE_IN_PAST', `The expected delivery date (${row.expectedDeliveryDate}) has passed. Set a later one before submitting.`);
    }

    const lines = await findPurchaseOrderLines(tx, row.id);
    const estimate = new Map(requisition.lines.map((l) => [l.id, l.estimatedUnitPrice]));
    const reasons = approvalReasons(
      {
        subtotal: row.subtotal,
        total: row.total,
        lines: lines.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice, estimatedUnitPrice: estimate.get(l.requisitionLineId) ?? '0' })),
      },
      { threshold: rules.poApprovalThreshold, tolerancePct: rules.poPriceTolerancePct },
      row.currencyScale,
    );
    const rule = { approvalThreshold: rules.poApprovalThreshold, priceTolerancePct: rules.poPriceTolerancePct };

    if (reasons.length === 0) {
      const status = assertOrderTransition(row, 'auto_approve', 'approved');
      const version = await updatePurchaseOrder(tx, row.id, row.version, {
        status,
        approvalReasons: [],
        ...rule,
        submittedAt: sql`now()`,
        submittedByUserId: actor.userId,
        approvedAt: sql`now()`,
      });
      await recordAuditEvent(tx, request, {
        action: 'po.submitted',
        entityType: 'purchase_order',
        entityId: row.id,
        changes: auditChanges(purchaseOrderAudit, { status: row.status }, { status, approvalReasons: [], ...rule }),
        reason: BELOW_THRESHOLD,
      });
      return { version, status, approvalReasons: [], approvalRequestId: null, round: null };
    }

    const status = pending;
    const route = await resolveApprovalRoute(tx, 'purchase_order', row.departmentId, row.total);
    if (!route || route.steps.length === 0) {
      failBusinessRule('NO_APPROVAL_ROUTE', 'This purchase order needs approval, but no approval policy for purchase orders is published. Ask an admin to publish one.');
    }
    const quotation = row.quotationId ? await findQuotationForPurchasing(tx, row.quotationId) : null;
    const opened = await openApprovalRequest(tx, request, {
      documentType: 'purchase_order',
      documentId: row.id,
      documentNumber: row.number,
      documentTitle: requisition.title,
      amount: row.total,
      currencyCode: row.currencyCode,
      currencyScale: row.currencyScale,
      departmentId: row.departmentId,
      submittedByUserId: actor.userId,
      // SOD-06: the buyer who awarded the quotation never approves the order.
      awardedByUserId: quotation?.awardedByUserId ?? null,
      route,
    });
    const version = await updatePurchaseOrder(tx, row.id, row.version, {
      status,
      approvalReasons: reasons,
      ...rule,
      currentApprovalRequestId: opened.approvalRequestId,
      submittedAt: sql`now()`,
      submittedByUserId: actor.userId,
    });
    await recordAuditEvent(tx, request, {
      action: 'po.submitted',
      entityType: 'purchase_order',
      entityId: row.id,
      changes: auditChanges(purchaseOrderAudit, { status: row.status }, { status, approvalReasons: reasons, ...rule, round: opened.round, approvalRoute: opened.route }),
    });
    return { version, status, approvalReasons: reasons, approvalRequestId: opened.approvalRequestId, round: opened.round };
  },
});

/** PO-T05: from now on the order is immutable; each line's receivable quantity is fixed with today's tolerance. */
export const issuePurchaseOrder = defineCommand({
  name: 'po.issue',
  permission: 'po.create',
  input: z.strictObject({ purchaseOrderId: z.uuid(), expectedVersion: versionField }),
  handler: async ({ tx, actor, request }, input): Promise<{ version: number; status: PurchaseOrderStatus }> => {
    const row = await lockOrderRow(tx, input.purchaseOrderId);
    assertOrderVersion(row, input.expectedVersion);
    const status = assertOrderTransition(row, 'issue', 'issued');
    await activeSupplier(tx, row.supplierId, 'issued');
    const tolerance = (await lockPurchasingRules(tx)).overReceiptTolerancePct;
    const version = await updatePurchaseOrder(tx, row.id, row.version, {
      status,
      issuedAt: sql`now()`,
      issuedByUserId: actor.userId,
      receiptTolerancePct: tolerance,
    });
    const maxReceivable: string[] = [];
    for (const line of await findPurchaseOrderLines(tx, row.id)) {
      const max = maxReceivableQuantity(line.quantity, tolerance);
      await setMaxReceivable(tx, line.id, max);
      maxReceivable.push(`${line.lineNo}. ${dec(line.quantity).toString()} ${line.uom}, up to ${max}`);
    }
    await recordAuditEvent(tx, request, {
      action: 'po.issued',
      entityType: 'purchase_order',
      entityId: row.id,
      changes: auditChanges(purchaseOrderAudit, { status: row.status }, { status, receiptTolerancePct: tolerance, maxReceivable }),
    });
    return { version, status };
  },
});

/** PO-T08 / T09: everything reserved goes back to the requisition; a pending approval round is withdrawn. */
export const cancelPurchaseOrder = defineCommand({
  name: 'po.cancel',
  permission: 'po.create',
  input: z.strictObject({ purchaseOrderId: z.uuid(), expectedVersion: versionField, reason: reasonField }),
  handler: async ({ tx, actor, request }, input): Promise<{ version: number; status: PurchaseOrderStatus }> => {
    const { row, requisition } = await lockOrderWithRequisition(tx, input.purchaseOrderId);
    assertOrderVersion(row, input.expectedVersion);
    const status = assertOrderTransition(row, 'cancel', 'cancelled');
    const lines = await findPurchaseOrderLines(tx, row.id);
    if (lines.some((l) => dec(l.receivedQty).gt(0))) {
      failBusinessRule('RECEIPTS_EXIST', 'Goods were already received against this purchase order, so it cannot be cancelled. Close it instead.');
    }
    if (row.status === 'pending_approval') {
      if (!row.currentApprovalRequestId) throw new Error(`purchase order ${row.id} is pending without an approval round`);
      await cancelApprovalRequest(tx, request, row.currentApprovalRequestId, input.reason);
    }
    const released = await releaseAll(tx, requisition, lines);
    const version = await updatePurchaseOrder(tx, row.id, row.version, {
      status,
      cancelledAt: sql`now()`,
      cancelledByUserId: actor.userId,
      cancelReason: input.reason,
    });
    await recordAuditEvent(tx, request, {
      action: 'po.cancelled',
      entityType: 'purchase_order',
      entityId: row.id,
      changes: auditChanges(purchaseOrderAudit, { status: row.status }, { status, ...(released.length > 0 ? { released } : {}) }),
      reason: input.reason,
    });
    return { version, status };
  },
});

/** PO-T07: no further receipts; what was not received goes back to the requisition. */
export const closePurchaseOrder = defineCommand({
  name: 'po.close',
  permission: 'po.create',
  input: z.strictObject({ purchaseOrderId: z.uuid(), expectedVersion: versionField, reason: optionalReasonField }),
  handler: async ({ tx, actor, request }, input): Promise<{ version: number; status: PurchaseOrderStatus }> => {
    const { row, requisition } = await lockOrderWithRequisition(tx, input.purchaseOrderId);
    assertOrderVersion(row, input.expectedVersion);
    const status = assertOrderTransition(row, 'close', 'closed');
    if (input.reason === null && closeNeedsReason(row.status)) invalid({ reason: ['Give a reason (required unless everything was received)'] });
    const lines = await findPurchaseOrderLines(tx, row.id);
    const released = await release(tx, requisition, lines, (line) => quantityReleasedOnClose(line.quantity, line.receivedQty));
    const version = await updatePurchaseOrder(tx, row.id, row.version, {
      status,
      closedAt: sql`now()`,
      closedByUserId: actor.userId,
      closeReason: input.reason,
    });
    await recordAuditEvent(tx, request, {
      action: 'po.closed',
      entityType: 'purchase_order',
      entityId: row.id,
      changes: auditChanges(purchaseOrderAudit, { status: row.status }, { status, ...(released.length > 0 ? { released } : {}) }),
      ...(input.reason === null ? {} : { reason: input.reason }),
    });
    return { version, status };
  },
});
