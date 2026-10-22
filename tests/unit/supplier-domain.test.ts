import { describe, expect, it } from 'vitest';
import { COUNTRY_CODES, isCountryCode } from '@/modules/suppliers/domain/countries';
import {
  SUPPLIER_COMMANDS,
  SUPPLIER_STATUSES,
  isMaker,
  isSelectableForPurchasing,
  nextSupplierStatus,
  normalizeSupplierName,
  normalizeTaxId,
  type SupplierCommand,
  type SupplierStatus,
} from '@/modules/suppliers/domain/supplier';

// P4-AC1: the transitions of docs/state-machines.md §3, written out independently of
// the implementation. Every other (status, command) pair must be rejected.
const EXPECTED: Record<string, SupplierStatus> = {
  'pending_review × update.contact': 'pending_review', // SUP-T02
  'pending_review × update.identity': 'pending_review', // SUP-T02
  'pending_review × review.approve': 'active', // SUP-T04
  'pending_review × review.reject': 'inactive', // SUP-T05
  'active × update.contact': 'active', // SUP-T02
  'active × update.identity': 'pending_review', // SUP-T03
  'active × block': 'blocked', // SUP-T06
  'active × deactivate': 'inactive', // SUP-T08
  'blocked × update.contact': 'blocked', // SUP-T02
  'blocked × update.identity': 'blocked', // SUP-T02 (review is cleared; unblock needs a fresh one)
  'blocked × unblock': 'pending_review', // SUP-T07
  'inactive × reactivate': 'pending_review', // SUP-T09
};

describe('P4-AC1: supplier state machine, exhaustively', () => {
  const pairs = SUPPLIER_STATUSES.flatMap((status) => SUPPLIER_COMMANDS.map((command) => [status, command] as const));

  it('has 4 statuses × 8 commands', () => {
    expect(pairs).toHaveLength(32);
  });

  it.each(pairs)('%s × %s', (status: SupplierStatus, command: SupplierCommand) => {
    expect(nextSupplierStatus(status, command)).toBe(EXPECTED[`${status} × ${command}`] ?? null);
  });

  it('lists only real pairs in the expected table', () => {
    const real = new Set(pairs.map(([s, c]) => `${s} × ${c}`));
    for (const key of Object.keys(EXPECTED)) expect(real.has(key)).toBe(true);
  });

  it('only active suppliers are selectable for purchasing (SUP-R1)', () => {
    expect(SUPPLIER_STATUSES.filter(isSelectableForPurchasing)).toEqual(['active']);
  });
});

describe('duplicate keys (maintainer decision 2026-10-22)', () => {
  it.each([
    ['PT. Maju-Jaya', 'pt maju jaya'],
    ['  PT   Maju   Jaya  ', 'pt maju jaya'],
    ['pt maju jaya', 'pt maju jaya'],
    ['PT MAJU JAYA, Tbk.', 'pt maju jaya tbk'],
    ['Ｆｕｌｌｗｉｄｔｈ Co', 'fullwidth co'],
    ['Café Ünïcode', 'café ünïcode'],
    ['A&B (Asia) Ltd', 'a b asia ltd'],
    ['%_\\', ''],
  ])('name %j → %j', (input, expected) => {
    expect(normalizeSupplierName(input)).toBe(expected);
  });

  it('keeps legal suffixes: "PT X" and "CV X" are different suppliers', () => {
    expect(normalizeSupplierName('PT Sinar')).not.toBe(normalizeSupplierName('CV Sinar'));
  });

  it.each([
    ['01.234.567.8-901.000', '012345678901000'],
    ['0123 4567 8901 000', '012345678901000'],
    ['de-123/456', 'DE123456'],
    ["'; drop table suppliers; --", 'DROPTABLESUPPLIERS'],
  ])('tax ID %j → %j', (input, expected) => {
    expect(normalizeTaxId(input)).toBe(expected);
  });
});

describe('SOD-03 maker check', () => {
  const supplier = { createdByUserId: 'maker', identityChangedByUserId: 'changer' };
  it('treats the creator and the last identity changer as makers, nobody else', () => {
    expect(isMaker(supplier, 'maker')).toBe(true);
    expect(isMaker(supplier, 'changer')).toBe(true);
    expect(isMaker(supplier, 'checker')).toBe(false);
    expect(isMaker({ createdByUserId: 'maker', identityChangedByUserId: null }, 'checker')).toBe(false);
  });
});

describe('ISO 3166-1 alpha-2 country codes', () => {
  it('has the 249 assigned codes, unique and sorted', () => {
    expect(COUNTRY_CODES).toHaveLength(249);
    expect(new Set(COUNTRY_CODES).size).toBe(249);
    expect([...COUNTRY_CODES].sort()).toEqual(COUNTRY_CODES);
  });

  it('every code is a region ICU knows by name', () => {
    const names = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
    const unknown = COUNTRY_CODES.filter((code) => !names.of(code) || names.of(code) === code);
    expect(unknown).toEqual([]);
  });

  it('rejects non-country and malformed codes', () => {
    for (const code of ['EU', 'UN', 'ZZ', 'XK', 'id', 'IDN', '', 'U1']) expect(isCountryCode(code)).toBe(false);
    for (const code of ['ID', 'US', 'DE', 'SG']) expect(isCountryCode(code)).toBe(true);
  });
});
