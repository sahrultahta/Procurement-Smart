/**
 * CSV export (decision 9): UTF-8 with a byte-order mark, comma separators, CRLF rows, '.' decimals
 * without thousands separators, ISO dates.
 *
 * Formula injection (P9-AC5): a text cell starting with = + - @ TAB or CR is prefixed with an
 * apostrophe, so a spreadsheet shows it as text. Number cells are written as they are, but only
 * when they are plain decimals (an optional minus, digits, an optional fraction); anything else
 * is treated as text.
 */
export type CsvCell = { readonly text: string | null } | { readonly number: string | null };
export type CsvColumn<Row> = { readonly header: string; readonly cell: (row: Row) => CsvCell };

export const CSV_BOM = '﻿';
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_DECIMAL = /^-?[0-9]+(\.[0-9]+)?$/;
const NEEDS_QUOTES = /[",\r\n]/;

export const text = (value: string | null): CsvCell => ({ text: value });
export const number = (value: string | null): CsvCell => ({ number: value });

/** A text cell, safe to open in a spreadsheet. */
export function textCell(value: string | null): string {
  if (value === null || value === '') return '';
  return quote(FORMULA_START.test(value) ? `'${value}` : value);
}

function cellOf(cell: CsvCell): string {
  if ('number' in cell) {
    if (cell.number === null) return '';
    return PLAIN_DECIMAL.test(cell.number) ? cell.number : textCell(cell.number);
  }
  return textCell(cell.text);
}

function quote(value: string): string {
  return NEEDS_QUOTES.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function toCsv<Row>(columns: readonly CsvColumn<Row>[], rows: readonly Row[]): string {
  const lines = [columns.map((c) => textCell(c.header)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => cellOf(c.cell(row))).join(','));
  return `${CSV_BOM}${lines.join('\r\n')}\r\n`;
}
