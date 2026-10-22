import { COUNTRY_CODES } from '@/modules/suppliers';
import type { CountryOption } from './_components/supplier-form';

const names = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'code' });

/** ISO 3166-1 countries with English names, sorted by name, for the supplier form. */
export const COUNTRY_OPTIONS: CountryOption[] = COUNTRY_CODES.map((code) => ({ code, name: names.of(code) ?? code })).sort((a, b) =>
  a.name.localeCompare(b.name, 'en'),
);

export function countryName(code: string): string {
  return names.of(code) ?? code;
}
