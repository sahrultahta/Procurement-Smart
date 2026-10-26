import { describe, expect, it } from 'vitest';
import { formatDecimal } from '@/shared/decimal/format';
import { dec, moneyInput, percentInput, quantityInput, toFixedScale } from '@/shared/decimal/decimal';

describe('decimal input schemas (ADR 0007)', () => {
  it.each(['0', '1', '1250.5', '1250.50', '999999999999.9999', '0.0001'])('accepts money %s', (value) => {
    expect(moneyInput.safeParse(value).success).toBe(true);
  });

  it.each(['', ' 1', '1 ', '-1', '+1', '1e5', '1.23456', '1,000', '0x10', 'NaN', 'Infinity', '.5', '5.', '1000000000000'])(
    'rejects money %j',
    (value) => {
      expect(moneyInput.safeParse(value).success).toBe(false);
    },
  );

  it('rejects JSON numbers for money (floats never enter the system)', () => {
    expect(moneyInput.safeParse(0.1).success).toBe(false);
    expect(moneyInput.safeParse(100).success).toBe(false);
  });

  it.each(['1', '0.001', '12.5', '999999999.999'])('accepts quantity %s', (value) => {
    expect(quantityInput.safeParse(value).success).toBe(true);
  });

  // '', 'abc', and '1,5' are not decimals at all: refused, not thrown (found in Phase 7).
  it.each(['0', '0.000', '-1', '1.0001', '1000000000', '', 'abc', '1,5', ' 1'])('rejects quantity %j', (value) => {
    expect(quantityInput.safeParse(value).success).toBe(false);
  });

  it.each(['0', '11', '12.5', '100', '100.0000'])('accepts percentage %s', (value) => {
    expect(percentInput.safeParse(value).success).toBe(true);
  });

  it.each(['100.0001', '101', '-5', '1e1', '', 'abc', '1,5', ' 1'])('rejects percentage %j', (value) => {
    expect(percentInput.safeParse(value).success).toBe(false);
  });
});

describe('decimal arithmetic', () => {
  it('computes 0.1 × 3 exactly (no binary floating point)', () => {
    expect(0.1 * 3).not.toBe(0.3); // the problem being avoided
    expect(dec('0.1').mul(3).toString()).toBe('0.3');
  });

  it.each([
    ['2.345', 2, '2.35'],
    ['2.344', 2, '2.34'],
    ['2.3449', 2, '2.34'],
    ['0.005', 2, '0.01'],
    ['0.5', 0, '1'],
    ['2.5', 0, '3'], // half-up, not banker's rounding
    ['1.4999', 0, '1'],
    ['7', 2, '7.00'],
  ])('rounds %s to %i places as %s', (value, scale, expected) => {
    expect(toFixedScale(dec(value), scale)).toBe(expected);
  });

  it('refuses non-finite values', () => {
    expect(() => dec('Infinity')).toThrow();
  });
});

describe('formatDecimal', () => {
  it('formats a 20-digit decimal string without losing precision (Node.js Intl)', () => {
    expect(formatDecimal('12345678901234.5678', { locale: 'en-US', scale: 4 })).toBe('12,345,678,901,234.5678');
  });

  it('uses locale grouping and the currency scale', () => {
    expect(formatDecimal('1250000', { locale: 'id-ID', scale: 0 })).toBe('1.250.000');
    expect(formatDecimal('1250.5', { locale: 'en-US', scale: 2 })).toBe('1,250.50');
  });
});
