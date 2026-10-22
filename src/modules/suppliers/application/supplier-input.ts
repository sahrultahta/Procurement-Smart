import { z } from 'zod';
import { defineAuditPolicy } from '@/modules/audit';
import { isCountryCode } from '../domain/countries';
import { normalizeSupplierName, normalizeTaxId } from '../domain/supplier';
import type { SupplierFields } from '../infrastructure/supplier-repository';

/** Optional text: blank (or missing from a form) means null. */
function optional<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === undefined || (typeof value === 'string' && value.trim() === '') ? null : value), schema.nullable());
}

const text = (max: number) => z.string().trim().max(max);

export const versionField = z.number().int().min(1).max(2_147_483_647);
export const reasonField = z.string().trim().min(1, 'Give a reason').max(500);

/** The fields a user enters for a supplier (US-SUP-01). Never code, status, or reviewers. */
export const supplierFields = {
  legalName: z
    .string()
    .trim()
    .min(1, 'Enter the legal name')
    .max(200)
    .refine((value) => normalizeSupplierName(value).length > 0, 'Use at least one letter or digit'),
  taxId: optional(
    text(40)
      .regex(/^[A-Za-z0-9 ./-]+$/, 'Use letters, digits, spaces, dots, dashes, or slashes')
      .refine((value) => /^[A-Z0-9]{5,30}$/.test(normalizeTaxId(value)), 'A tax ID has 5 to 30 letters or digits'),
  ),
  email: optional(z.email('Enter a valid email address').max(254)),
  phone: optional(text(30).regex(/^\+?[0-9 ()-]{5,30}$/, 'Use digits, spaces, parentheses, dashes, and an optional leading +')),
  addressLine1: optional(text(200)),
  addressLine2: optional(text(200)),
  city: optional(text(100)),
  region: optional(text(100)),
  postalCode: optional(text(20)),
  countryCode: z.string().refine(isCountryCode, 'Choose a country'),
};

type SupplierInput = {
  legalName: string;
  taxId: string | null;
  email: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  countryCode: string;
};

/** Validated input → columns, including the duplicate keys. */
export function toColumns(input: SupplierInput): SupplierFields {
  return {
    legalName: input.legalName,
    normalizedName: normalizeSupplierName(input.legalName),
    taxId: input.taxId,
    taxIdNormalized: input.taxId === null ? null : normalizeTaxId(input.taxId),
    email: input.email === null ? null : input.email.toLowerCase(),
    phone: input.phone,
    addressLine1: input.addressLine1,
    addressLine2: input.addressLine2,
    city: input.city,
    region: input.region,
    postalCode: input.postalCode,
    countryCode: input.countryCode,
  };
}

/** Supplier fields recorded in audit `changes` (ADR 0009). Business contact data, no credentials. */
export const supplierAudit = defineAuditPolicy<{
  code: string;
  legalName: string;
  taxId: string | null;
  email: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  countryCode: string;
  status: string;
}>({
  entityType: 'supplier',
  fields: [
    'code',
    'legalName',
    'taxId',
    'email',
    'phone',
    'addressLine1',
    'addressLine2',
    'city',
    'region',
    'postalCode',
    'countryCode',
    'status',
  ],
});
