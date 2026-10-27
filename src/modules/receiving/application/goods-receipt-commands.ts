import 'server-only';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { auditChanges, recordAuditEvent } from '@/modules/audit';
import { findPurchasingRules, todayIn } from '@/modules/organization';
import {
  applyReceivedQuantities,
  ISSUED_ORDER_STATUSES,
  lockOrderForReceiving,
  PO_STATUS_LABEL,
  takesReversals,
  type OrderForReceiving,
  type PurchaseOrderStatus,
} from '@/modules/purchasing';
import { defineCommand } from '@/shared/application/runner';
import { dec } from '@/shared/decimal/decimal';
import { allocateDocumentNumber, formatDocumentNumber } from '@/shared/db/document-numbers';
import { idempotencyKeyField, withIdempotency } from '@/shared/db/idempotency';
import type { Tx } from '@/shared/db/transaction';
import { AppFailure, fail, failBusinessRule } from '@/shared/result';
import { overReceivedLines, type GoodsReceiptStatus } from '../domain/goods-receipt';
import {
  findGoodsReceiptLines,
  findReversalsOf,
  insertGoodsReceipt,
  insertGoodsReceiptLines,
  updateGoodsReceipt,
  type GoodsReceiptLineRow,
} from '../infrastructure/goods-receipt-repository';
import { goodsReceiptAudit, goodsReceiptFields, goodsReceiptLineSummary, optionalReasonField, reasonField, versionField } from './goods-receipt-input';
import {
  assertNotOrderCreator,
  assertOrderTakesReceipts,
  assertReceiptTransition,
  assertReceiptVersion,
  lockReceiptRow,
  lockReceiptWithOrder,
} from './goods-receipt-locks';

/*
 * Goods receipts (US-GR-01, US-GR-02; GR-T01 to T04). Lock order (ADR 0008 C8): the purchase
 * order, the goods receipt, then the order's lines in ascending id order. The received quantities
 * move through the purchasing module (applyReceivedQuantities), never directly.
 */

function invalid(fieldErrors: Record<string, string[]>): never {
  throw new AppFailure({ code: 'VALIDATION_FAILED', message: 'Some fields are invalid.', fieldErrors });
}

type ReceiptItem = { purchaseOrderLineId: string; lineNo: number; description: string; uom: string; quantity: string; receivedQty: string; maxReceivableQty: string; note: string | null };

/** A receipt's lines with what their order lines ordered, received, and can take, by order line number. */
function itemsOf(order: OrderForReceiving, lines: readonly Pick<GoodsReceiptLineRow, 'purchaseOrderLineId' | 'quantity' | 'note'>[]): ReceiptItem[] {
  const byId = new Map(order.lines.map((l) => [l.id, l]));
  return lines
    .map((line) => {
      const source = byId.get(line.purchaseOrderLineId);
      if (!source) throw new Error(`line ${line.purchaseOrderLineId} is not on purchase order ${order.number}`);
      return {
        purchaseOrderLineId: source.id,
        lineNo: source.lineNo,
        description: source.description,
        uom: source.uom,
        quantity: dec(line.quantity).toString(),
        receivedQty: source.receivedQty,
        maxReceivableQty: source.maxReceivableQty ?? '0',
        note: line.note,
      };
    })
    .sort((a, b) => a.lineNo - b.lineNo);
}

/** OVER_RECEIPT names every line that is over, with what it can still take. The whole receipt is refused. */
function overReceipt(over: readonly { lineNo: number; remaining: string }[], items: readonly ReceiptItem[]): never {
  const [first] = over;
  const uom = items.find((i) => i.lineNo === first?.lineNo)?.uom ?? '';
  failBusinessRule('OVER_RECEIPT', `Line ${first?.lineNo} can take only ${first?.remaining} ${uom} more, so nothing on this receipt was received.`, over);
}

async function documentNumber(tx: Tx, today: string): Promise<string> {
  const year = Number(today.slice(0, 4));
  return formatDocumentNumber('GR', year, await allocateDocumentNumber(tx, 'GR', year));
}

/** GR-T01: a draft receipt against an issued or partially received order. */
export const createGoodsReceipt = defineCommand({
  name: 'receipt.create',
  permission: 'receipt.create',
  input: z.strictObject({ purchaseOrderId: z.uuid(), ...goodsReceiptFields, idempotencyKey: idempotencyKeyField }),
  handler: async ({ tx, actor, request, clock }, input) => {
    const { idempotencyKey, ...fields } = input;
    return withIdempotency(tx, { userId: actor.userId, key: idempotencyKey, operation: 'receipt.create', input: fields }, async () => {
      const order = await lockOrderForReceiving(tx, fields.purchaseOrderId);
      // Receivers read issued orders only (ADR 0006): any other order does not exist for them.
      if (!order || !(ISSUED_ORDER_STATUSES as readonly string[]).includes(order.status)) fail('NOT_FOUND', 'Purchase order not found.');
      assertNotOrderCreator(order, actor);
      assertOrderTakesReceipts(order);
      const rules = await findPurchasingRules(tx);
      const today = todayIn(rules.timezone, clock.now());
      if (fields.receivedOn > today) invalid({ receivedOn: ['Goods cannot be received in the future'] });
      const issuedOn = order.issuedAt ? todayIn(rules.timezone, order.issuedAt) : today;
      if (fields.receivedOn < issuedOn) invalid({ receivedOn: [`Purchase order ${order.number} was issued on ${issuedOn}: goods are received on or after that day`] });
      const onOrder = new Set(order.lines.map((l) => l.id));
      const errors: Record<string, string[]> = {};
      fields.lines.forEach((line, i) => {
        if (!onOrder.has(line.purchaseOrderLineId)) errors[`lines.${i}.purchaseOrderLineId`] = [`This line is not on purchase order ${order.number}.`];
      });
      if (Object.keys(errors).length > 0) invalid(errors);
      // Decision 2: refused now if it could not be posted now; posting checks again (C2).
      const items = itemsOf(order, fields.lines);
      const over = overReceivedLines(items);
      if (over.length > 0) overReceipt(over, items);

      const number = await documentNumber(tx, today);
      const goodsReceiptId = await insertGoodsReceipt(tx, {
        number,
        purchaseOrderId: order.id,
        kind: 'receipt',
        reversesGoodsReceiptId: null,
        receivedOn: fields.receivedOn,
        deliveryNoteRef: fields.deliveryNoteRef,
        notes: fields.notes,
        reason: null,
        createdByUserId: actor.userId,
      });
      await insertGoodsReceiptLines(
        tx,
        goodsReceiptId,
        fields.lines.map((l) => ({ purchaseOrderLineId: l.purchaseOrderLineId, quantity: l.quantity, note: l.note })),
      );
      await recordAuditEvent(tx, request, {
        action: 'receipt.created',
        entityType: 'goods_receipt',
        entityId: goodsReceiptId,
        changes: auditChanges(goodsReceiptAudit, null, {
          number,
          purchaseOrder: order.number,
          kind: 'receipt',
          receivedOn: fields.receivedOn,
          deliveryNoteRef: fields.deliveryNoteRef,
          notes: fields.notes,
          lines: items.map(goodsReceiptLineSummary),
          status: 'draft',
        }),
      });
      return { goodsReceiptId, number, version: 1 };
    });
  },
});

/** GR-T02: every line or none (OVER_RECEIPT); the order's received quantities and status follow. */
export const postGoodsReceipt = defineCommand({
  name: 'receipt.post',
  permission: 'receipt.create',
  input: z.strictObject({ goodsReceiptId: z.uuid(), expectedVersion: versionField }),
  handler: async ({ tx, actor, request }, input): Promise<{ version: number; status: GoodsReceiptStatus; purchaseOrderStatus: PurchaseOrderStatus }> => {
    const { row, order } = await lockReceiptWithOrder(tx, input.goodsReceiptId);
    assertReceiptVersion(row, input.expectedVersion);
    const status = assertReceiptTransition(row, 'post', 'posted');
    assertNotOrderCreator(order, actor);
    assertOrderTakesReceipts(order);
    const lines = await findGoodsReceiptLines(tx, row.id);
    const items = itemsOf(order, lines);
    const over = overReceivedLines(items);
    if (over.length > 0) overReceipt(over, items);

    // The receipt is posted before the quantities move: the database compares the two (GR-I1).
    const version = await updateGoodsReceipt(tx, row.id, row.version, { status, postedAt: sql`now()`, postedByUserId: actor.userId });
    const applied = await applyReceivedQuantities(
      tx,
      request,
      order,
      items.map((i) => ({ purchaseOrderLineId: i.purchaseOrderLineId, quantity: i.quantity })),
      { number: row.number, kind: 'receipt' },
    );
    if (!applied.ok) overReceipt([{ lineNo: applied.lineNo, remaining: applied.remaining }], items);
    await recordAuditEvent(tx, request, {
      action: 'receipt.posted',
      entityType: 'goods_receipt',
      entityId: row.id,
      changes: auditChanges(goodsReceiptAudit, { status: row.status, purchaseOrderStatus: applied.previousStatus }, { status, purchaseOrderStatus: applied.status }),
    });
    return { version, status, purchaseOrderStatus: applied.status };
  },
});

/** GR-T03: the user who recorded a draft discards it; nothing was received. */
export const cancelGoodsReceipt = defineCommand({
  name: 'receipt.cancel',
  permission: 'receipt.create',
  input: z.strictObject({ goodsReceiptId: z.uuid(), expectedVersion: versionField, reason: optionalReasonField }),
  handler: async ({ tx, actor, request }, input): Promise<{ version: number; status: GoodsReceiptStatus }> => {
    const row = await lockReceiptRow(tx, input.goodsReceiptId);
    assertReceiptVersion(row, input.expectedVersion);
    if (row.createdByUserId !== actor.userId) fail('FORBIDDEN', 'Only the user who recorded this draft can cancel it.');
    const status = assertReceiptTransition(row, 'cancel', 'cancelled');
    const version = await updateGoodsReceipt(tx, row.id, row.version, {
      status,
      cancelledAt: sql`now()`,
      cancelledByUserId: actor.userId,
      cancelReason: input.reason,
    });
    await recordAuditEvent(tx, request, {
      action: 'receipt.cancelled',
      entityType: 'goods_receipt',
      entityId: row.id,
      changes: auditChanges(goodsReceiptAudit, { status: row.status }, { status }),
      ...(input.reason === null ? {} : { reason: input.reason }),
    });
    return { version, status };
  },
});

/**
 * GR-T04: a new, posted reversal document with the receipt's lines takes the quantities back; the
 * receipt itself stays as it was. Once per receipt (ALREADY_REVERSED), not on a closed order
 * (PO_CLOSED). Dated the org day it is recorded (decision 5).
 */
export const reverseGoodsReceipt = defineCommand({
  name: 'receipt.reverse',
  permission: 'receipt.create',
  input: z.strictObject({ goodsReceiptId: z.uuid(), expectedVersion: versionField, reason: reasonField }),
  handler: async ({ tx, actor, request, clock }, input): Promise<{ goodsReceiptId: string; number: string; version: number; purchaseOrderStatus: PurchaseOrderStatus }> => {
    const { row, order } = await lockReceiptWithOrder(tx, input.goodsReceiptId);
    assertReceiptVersion(row, input.expectedVersion);
    assertReceiptTransition(row, 'reverse', 'reversed');
    const earlier = (await findReversalsOf(tx, [row.id])).get(row.id);
    if (earlier) failBusinessRule('ALREADY_REVERSED', `${row.number} was already reversed by ${earlier.number}.`);
    assertNotOrderCreator(order, actor);
    if (!takesReversals(order.status)) {
      failBusinessRule('PO_CLOSED', `Purchase order ${order.number} is ${PO_STATUS_LABEL[order.status]}, so its goods receipts can no longer be reversed.`);
    }
    const rules = await findPurchasingRules(tx);
    const today = todayIn(rules.timezone, clock.now());
    const items = itemsOf(order, await findGoodsReceiptLines(tx, row.id));

    const number = await documentNumber(tx, today);
    const goodsReceiptId = await insertGoodsReceipt(tx, {
      number,
      purchaseOrderId: order.id,
      kind: 'reversal',
      reversesGoodsReceiptId: row.id,
      receivedOn: today,
      deliveryNoteRef: null,
      notes: null,
      reason: input.reason,
      createdByUserId: actor.userId,
    });
    await insertGoodsReceiptLines(
      tx,
      goodsReceiptId,
      items.map((i) => ({ purchaseOrderLineId: i.purchaseOrderLineId, quantity: i.quantity, note: null })),
    );
    // Posted before the quantities move, in this transaction (the database checks both, GR-I1).
    const version = await updateGoodsReceipt(tx, goodsReceiptId, 1, { status: 'posted', postedAt: sql`now()`, postedByUserId: actor.userId });
    const applied = await applyReceivedQuantities(
      tx,
      request,
      order,
      items.map((i) => ({ purchaseOrderLineId: i.purchaseOrderLineId, quantity: i.quantity })),
      { number, kind: 'reversal' },
    );
    if (!applied.ok) throw new Error(`reversal ${number} was refused as an over-receipt`);
    await recordAuditEvent(tx, request, {
      action: 'receipt.reversalPosted',
      entityType: 'goods_receipt',
      entityId: goodsReceiptId,
      changes: auditChanges(goodsReceiptAudit, null, {
        number,
        purchaseOrder: order.number,
        kind: 'reversal',
        reverses: row.number,
        receivedOn: today,
        lines: items.map((i) => goodsReceiptLineSummary({ ...i, note: null })),
        status: 'posted',
        purchaseOrderStatus: applied.status,
      }),
      reason: input.reason,
    });
    await recordAuditEvent(tx, request, {
      action: 'receipt.reversed',
      entityType: 'goods_receipt',
      entityId: row.id,
      changes: auditChanges(goodsReceiptAudit, { purchaseOrderStatus: applied.previousStatus }, { reversedBy: number, purchaseOrderStatus: applied.status }),
      reason: input.reason,
    });
    return { goodsReceiptId, number, version, purchaseOrderStatus: applied.status };
  },
});
