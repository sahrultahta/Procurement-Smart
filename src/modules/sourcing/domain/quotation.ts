import type { RfqStatus } from './rfq';

/**
 * Quotation rules with no I/O (docs/state-machines.md §4). Suppliers have no login in v1: the
 * buyer records what a supplier sent, then submits it once it is complete.
 */
export const QUOTATION_STATUSES = ['draft', 'submitted', 'withdrawn', 'awarded', 'not_awarded'] as const;
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];

/** Everything that can happen to an existing quotation (`record`, QUO-T01, starts in draft). */
export const QUOTATION_COMMANDS = ['update', 'submit', 'withdraw', 'award', 'award_other'] as const;
export type QuotationCommand = (typeof QUOTATION_COMMANDS)[number];

/** QUO-T02 to T05. Any (status, command) pair not listed is an invalid transition. */
const TRANSITIONS: Readonly<Record<QuotationStatus, Partial<Record<QuotationCommand, QuotationStatus>>>> = {
  draft: {
    update: 'draft', // QUO-T02
    submit: 'submitted', // QUO-T03
    withdraw: 'withdrawn', // discarding a draft (amendment 2026-10-25), also when the RFQ closes
  },
  submitted: {
    withdraw: 'withdrawn', // QUO-T04
    award: 'awarded', // QUO-T05, the chosen one (RFQ-T05)
    award_other: 'not_awarded', // QUO-T05, every other submitted one
  },
  withdrawn: {},
  awarded: {},
  not_awarded: {},
};

export function nextQuotationStatus(from: QuotationStatus, command: QuotationCommand): QuotationStatus | null {
  return TRANSITIONS[from][command] ?? null;
}

export function isQuotationStatus(value: string): value is QuotationStatus {
  return (QUOTATION_STATUSES as readonly string[]).includes(value);
}

/**
 * The RFQ statuses in which a quotation may be recorded or changed. Recording, editing, and
 * submitting need an issued RFQ (also after the due time: a late quotation is flagged, not
 * refused). A draft is discarded while the RFQ is issued (closing discards the rest); a submitted
 * quotation can be withdrawn until the award. On a cancelled RFQ quotations stay as recorded.
 */
const RFQ_STATUS_FOR: Readonly<Record<'record' | 'update' | 'submit' | 'discard' | 'withdraw' | 'award', readonly RfqStatus[]>> = {
  record: ['issued'],
  update: ['issued'],
  submit: ['issued'],
  discard: ['issued'],
  withdraw: ['issued', 'closed'],
  award: ['closed'],
};

export type QuotationAction = keyof typeof RFQ_STATUS_FOR;

export function rfqAllows(action: QuotationAction, rfqStatus: RfqStatus): boolean {
  return RFQ_STATUS_FOR[action].includes(rfqStatus);
}

/** Submitted at some point and not withdrawn: what the comparison and the award look at. */
export function wasSubmitted(status: QuotationStatus): boolean {
  return status === 'submitted' || status === 'awarded' || status === 'not_awarded';
}

/**
 * Why a quotation does or does not count (maintainer decision 2026-10-25: only valid quotations
 * count towards `min_quotes` and the lowest price). `validUntil` and `today` are YYYY-MM-DD dates
 * in the organization's time zone; a quotation is still valid on its last day.
 */
export type Validity = 'valid' | 'draft' | 'withdrawn' | 'expired' | 'supplier_not_active';

export function validityOf(quotation: { status: QuotationStatus; validUntil: string; supplierActive: boolean }, today: string): Validity {
  if (quotation.status === 'draft') return 'draft';
  if (quotation.status === 'withdrawn') return 'withdrawn';
  if (quotation.validUntil < today) return 'expired';
  if (!quotation.supplierActive) return 'supplier_not_active';
  return 'valid';
}

/** Submitted after the RFQ's due time: accepted while the RFQ is issued, and shown as late. */
export function isLate(submittedAt: Date | null, responseDueAt: Date): boolean {
  return submittedAt !== null && submittedAt.getTime() > responseDueAt.getTime();
}

export const MAX_SUPPLIER_REFERENCE = 100;
export const MAX_LEAD_TIME_DAYS = 365;
export const MAX_JUSTIFICATION = 2000;
