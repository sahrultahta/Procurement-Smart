import { sql } from 'drizzle-orm';
import { numeric, pgTable, serial } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { priceDocument } from '@/shared/decimal/pricing';
import { createTestDatabase, sqlStateOf, type TestDatabase } from '../support/test-db';

// P2-AC2: numeric(20,4) values survive the database round trip exactly, as strings.
const moneyProbe = pgTable('money_probe', {
  id: serial('id').primaryKey(),
  amount: numeric('amount', { precision: 20, scale: 4 }).notNull(),
});

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
  await t.db.execute(sql`CREATE TABLE money_probe (id serial PRIMARY KEY, amount numeric(20,4) NOT NULL)`);
});

afterAll(async () => {
  await t?.drop();
});

describe('numeric(20,4) round trip', () => {
  it('returns exactly the stored decimal string', async () => {
    const [row] = await t.db.insert(moneyProbe).values({ amount: '12345678901234.5678' }).returning();
    expect(row?.amount).toBe('12345678901234.5678');
    expect(typeof row?.amount).toBe('string');
  });

  it('pads to the column scale instead of approximating', async () => {
    const [row] = await t.db.insert(moneyProbe).values({ amount: '0.1' }).returning();
    expect(row?.amount).toBe('0.1000');
  });

  it('stores the largest supported total and rejects anything at 10^16 or above', async () => {
    const total = priceDocument([{ quantity: '1', unitPrice: '999999999999.9999' }], 4).total;
    const [row] = await t.db.insert(moneyProbe).values({ amount: total }).returning();
    expect(row?.amount).toBe('999999999999.9999');
    const [max] = await t.db.insert(moneyProbe).values({ amount: '9999999999999999.9999' }).returning();
    expect(max?.amount).toBe('9999999999999999.9999');
    expect(await sqlStateOf(() => t.db.insert(moneyProbe).values({ amount: '10000000000000000' }))).toBe('22003');
  });
});
