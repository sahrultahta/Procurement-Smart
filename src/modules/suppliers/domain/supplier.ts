/**
 * Supplier rules with no I/O (docs/state-machines.md §3, ADR 0006 SOD-03).
 */
export const SUPPLIER_STATUSES = ['pending_review', 'active', 'blocked', 'inactive'] as const;
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number];

/**
 * Everything that can happen to an existing supplier. An update is an identity change
 * when it touches the legal name or the tax ID (as typed, not just after normalization).
 */
export const SUPPLIER_COMMANDS = [
  'update.contact',
  'update.identity',
  'review.approve',
  'review.reject',
  'block',
  'unblock',
  'deactivate',
  'reactivate',
] as const;
export type SupplierCommand = (typeof SUPPLIER_COMMANDS)[number];

/**
 * SUP-T02 to SUP-T09 (SUP-T01, create, starts every supplier in pending_review).
 * Any (status, command) pair not listed here is an invalid transition.
 */
const TRANSITIONS: Readonly<Record<SupplierStatus, Partial<Record<SupplierCommand, SupplierStatus>>>> = {
  pending_review: {
    'update.contact': 'pending_review', // SUP-T02
    'update.identity': 'pending_review', // SUP-T02: still under review, by someone else (SOD-03)
    'review.approve': 'active', // SUP-T04
    'review.reject': 'inactive', // SUP-T05
  },
  active: {
    'update.contact': 'active', // SUP-T02
    'update.identity': 'pending_review', // SUP-T03
    block: 'blocked', // SUP-T06
    deactivate: 'inactive', // SUP-T08
  },
  blocked: {
    'update.contact': 'blocked', // SUP-T02
    'update.identity': 'blocked', // SUP-T02: stays blocked; unblocking then needs a fresh review
    unblock: 'pending_review', // SUP-T07
  },
  inactive: {
    reactivate: 'pending_review', // SUP-T09
  },
};

export function nextSupplierStatus(from: SupplierStatus, command: SupplierCommand): SupplierStatus | null {
  return TRANSITIONS[from][command] ?? null;
}

export function isSupplierStatus(value: string): value is SupplierStatus {
  return (SUPPLIER_STATUSES as readonly string[]).includes(value);
}

/**
 * Duplicate-detection key for names (maintainer decision 2026-10-22): Unicode-normalized,
 * lowercase, with every run of punctuation or whitespace reduced to one space, so
 * "PT. Maju-Jaya" and "pt maju jaya" collide. Legal suffixes (PT, CV, Ltd) still count.
 */
export function normalizeSupplierName(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Duplicate-detection key for tax IDs: letters and digits only, uppercase ("01.234.567.8-901.000" → "012345678901000"). */
export function normalizeTaxId(value: string): string {
  return value
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** SOD-03: whoever created the supplier, or last changed its identity, cannot review it. */
export function isMaker(supplier: { createdByUserId: string; identityChangedByUserId: string | null }, userId: string): boolean {
  return supplier.createdByUserId === userId || supplier.identityChangedByUserId === userId;
}

/** Only active suppliers can be used for new purchasing (SUP-R1). */
export function isSelectableForPurchasing(status: SupplierStatus): boolean {
  return status === 'active';
}
