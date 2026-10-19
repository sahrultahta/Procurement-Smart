import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { integer, numeric, pgTable } from 'drizzle-orm/pg-core';
import { describe, expect, expectTypeOf, it } from 'vitest';

// Settles the open technical questions from ADR 0004 against the installed drizzle-orm.
const probe = pgTable('probe', {
  id: integer('id').primaryKey(),
  amount: numeric('amount', { precision: 20, scale: 4 }).notNull(),
});

describe('drizzle-orm API assumptions', () => {
  it('infers numeric columns as string (no float conversion)', () => {
    expectTypeOf<(typeof probe.$inferSelect)['amount']>().toEqualTypeOf<string>();
    expectTypeOf<(typeof probe.$inferInsert)['amount']>().toEqualTypeOf<string>();
  });

  it('supports SELECT ... FOR UPDATE through .for()', () => {
    const db = drizzle.mock();
    const query = db.select().from(probe).where(eq(probe.id, 7)).for('update').toSQL();
    expect(query.sql.toLowerCase()).toMatch(/ for update$/);
    expect(query.params).toEqual([7]);
  });

  it('supports NOWAIT on row locks', () => {
    const db = drizzle.mock();
    const query = db.select().from(probe).for('update', { noWait: true }).toSQL();
    expect(query.sql.toLowerCase()).toMatch(/ for update nowait$/);
  });
});
