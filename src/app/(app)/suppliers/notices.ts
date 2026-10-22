/** Confirmations shown on the supplier page after a status change (see actions.ts). */
export const SUPPLIER_NOTICES = {
  approved: 'Supplier approved. It can now be used for purchasing.',
  rejected: 'Supplier rejected.',
  blocked: 'Supplier blocked.',
  unblocked: 'Supplier unblocked. It needs a new review before it can be used.',
  deactivated: 'Supplier deactivated.',
  reactivated: 'Supplier reactivated. It needs a new review before it can be used.',
} as const;

export type SupplierNotice = keyof typeof SUPPLIER_NOTICES;

export function supplierNotice(value: unknown): string | null {
  return typeof value === 'string' && Object.hasOwn(SUPPLIER_NOTICES, value) ? SUPPLIER_NOTICES[value as SupplierNotice] : null;
}
