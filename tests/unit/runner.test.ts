import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createRequestContext, type Actor } from '@/shared/application/context';
import { defineCommand, defineQuery, registeredOperations, runCommand, runQuery } from '@/shared/application/runner';
import { fixedClock } from '@/shared/clock';
import type { Database } from '@/shared/db/transaction';
import { createLogger } from '@/shared/logger';
import { AppFailure, failBusinessRule } from '@/shared/result';

// P2-AC5: the runner's step order, error mapping, and logging. No database: a fake records calls.

function fakeDb() {
  const configs: unknown[] = [];
  const db = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>, config: unknown) => {
      configs.push(config);
      return fn({ execute: async () => ({ rows: [] }) });
    },
  };
  return { db: db as unknown as Database, configs };
}

function capturingLogger() {
  const lines: string[] = [];
  return { logger: createLogger({ level: 'debug', sink: (_level, line) => lines.push(line) }), lines };
}

const actor = (permissions: string[]): Actor => ({ userId: 'user-1', roles: ['requester'], permissions: new Set(permissions) });

const echo = defineCommand({
  name: 'test.echo',
  permission: 'test.write',
  input: z.strictObject({ amount: z.string().regex(/^\d+$/), note: z.string().max(10) }),
  handler: async ({ actor: who, request, clock }, input) => ({
    amount: input.amount,
    userId: who.userId,
    requestId: request.requestId,
    now: clock.now().toISOString(),
  }),
});

function setup(permissions: string[] | null) {
  const { db, configs } = fakeDb();
  const { logger, lines } = capturingLogger();
  const request = createRequestContext({ actor: permissions ? actor(permissions) : null });
  return { db, configs, logger, lines, request, options: { db, logger, clock: fixedClock('2026-10-21T01:02:03Z') } };
}

describe('runCommand step order', () => {
  const invalid = { amount: 'not-digits', note: 'way too long for the limit', extra: 'secret-input-value' };

  it('rejects anonymous callers before looking at input', async () => {
    const { request, options, configs, lines } = setup(null);
    const result = await runCommand(request, echo, invalid, options);
    expect(result).toEqual({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } });
    expect(configs).toHaveLength(0);
    expect(lines.join('\n')).toContain('"msg":"command.denied"');
    expect(lines.join('\n')).not.toContain('secret-input-value');
  });

  it('rejects callers without the permission before looking at input', async () => {
    const { request, options, configs } = setup(['something.else']);
    const result = await runCommand(request, echo, invalid, options);
    expect(result.ok ? null : result.error.code).toBe('FORBIDDEN');
    expect(configs).toHaveLength(0);
  });

  it('validates input strictly, including unknown fields, before any transaction', async () => {
    const { request, options, configs, lines } = setup(['test.write']);
    const result = await runCommand(request, echo, invalid, options);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_FAILED');
    expect(Object.keys(result.error.fieldErrors ?? {}).sort()).toEqual(['_form', 'amount', 'note']);
    expect(configs).toHaveLength(0);
    expect(lines.join('\n')).not.toContain('secret-input-value');
  });

  it('runs the handler in a read-write transaction and returns its result', async () => {
    const { request, options, configs } = setup(['test.write']);
    const result = await runCommand(request, echo, { amount: '42', note: 'ok' }, options);
    expect(result).toEqual({
      ok: true,
      data: { amount: '42', userId: 'user-1', requestId: request.requestId, now: '2026-10-21T01:02:03.000Z' },
    });
    expect(configs).toEqual([{ accessMode: 'read write', isolationLevel: 'read committed' }]);
  });
});

describe('runCommand error mapping', () => {
  const failing = (name: string, error: () => unknown, retrySafe = false) =>
    defineCommand({
      name,
      permission: 'test.write',
      retrySafe,
      input: z.strictObject({ secret: z.string() }),
      handler: async () => {
        throw error();
      },
    });

  it('turns unexpected errors into a generic INTERNAL error and logs them without the input', async () => {
    const { request, options, lines } = setup(['test.write']);
    const op = failing('test.crash', () => new Error('connection to db-internal-host refused'));
    const result = await runCommand(request, op, { secret: 'secret-input-value' }, options);
    expect(result).toEqual({
      ok: false,
      error: { code: 'INTERNAL', message: 'Something went wrong. The action was not completed.' },
    });
    const log = lines.find((l) => l.includes('"msg":"command.failed"'));
    expect(log).toBeDefined();
    expect(JSON.parse(log ?? '{}')).toMatchObject({ requestId: request.requestId, command: 'test.crash', errorCode: 'INTERNAL' });
    expect(lines.join('\n')).not.toContain('secret-input-value');
    expect(JSON.stringify(result)).not.toContain('db-internal-host');
  });

  it('passes AppFailure errors through unchanged', async () => {
    const { request, options } = setup(['test.write']);
    const op = failing('test.overReceipt', () => {
      try {
        failBusinessRule('OVER_RECEIPT', 'Too much.', { line: 2 });
      } catch (error) {
        return error;
      }
    });
    const result = await runCommand(request, op, { secret: 'x' }, options);
    expect(result).toEqual({
      ok: false,
      error: { code: 'BUSINESS_RULE', rule: 'OVER_RECEIPT', message: 'Too much.', details: { line: 2 } },
    });
  });

  const dbError = (code: string) =>
    Object.assign(new Error('Failed query: select ...'), { cause: Object.assign(new Error('pg says no'), { code }) });

  it.each([
    ['55P03', 'CONFLICT', undefined],
    ['23505', 'CONFLICT', undefined],
    ['23514', 'BUSINESS_RULE', 'INTEGRITY_CONSTRAINT'],
    ['23503', 'BUSINESS_RULE', 'INTEGRITY_CONSTRAINT'],
    ['40001', 'CONFLICT', undefined],
    ['PFA01', 'INTERNAL', undefined],
    ['25006', 'INTERNAL', undefined],
  ])('maps SQLSTATE %s to %s', async (sqlState, code, rule) => {
    const { request, options } = setup(['test.write']);
    const op = failing(`test.sqlstate${sqlState}`, () => dbError(sqlState));
    const result = await runCommand(request, op, { secret: 'x' }, options);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(code);
    expect(result.error.rule).toBe(rule);
  });

  it('retries a retry-safe command on serialization failure, then succeeds', async () => {
    const { request, options } = setup(['test.write']);
    let calls = 0;
    const op = defineCommand({
      name: 'test.retryThenSucceed',
      permission: 'test.write',
      retrySafe: true,
      input: z.strictObject({}),
      handler: async () => {
        calls++;
        if (calls === 1) throw dbError('40001');
        return 'done';
      },
    });
    const sleep = vi.fn(async () => {});
    const result = await runCommand(request, op, {}, { ...options, sleep });
    expect(result).toEqual({ ok: true, data: 'done' });
    expect(calls).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts and does not retry commands that are not retry-safe', async () => {
    const { request, options } = setup(['test.write']);
    let safeCalls = 0;
    const safe = defineCommand({
      name: 'test.alwaysDeadlocks',
      permission: 'test.write',
      retrySafe: true,
      input: z.strictObject({}),
      handler: async () => {
        safeCalls++;
        throw dbError('40P01');
      },
    });
    const sleep = async () => {};
    const safeResult = await runCommand(request, safe, {}, { ...options, sleep, maxAttempts: 3 });
    expect(safeResult.ok ? null : safeResult.error.code).toBe('CONFLICT');
    expect(safeCalls).toBe(3);

    let unsafeCalls = 0;
    const unsafe = defineCommand({
      name: 'test.notRetrySafe',
      permission: 'test.write',
      input: z.strictObject({}),
      handler: async () => {
        unsafeCalls++;
        throw dbError('40001');
      },
    });
    await runCommand(request, unsafe, {}, { ...options, sleep });
    expect(unsafeCalls).toBe(1);
  });
});

describe('operation definitions', () => {
  it('runs queries in a read-only transaction', async () => {
    const { request, options, configs } = setup(['test.read']);
    const op = defineQuery({
      name: 'test.readSomething',
      permission: 'test.read',
      input: z.strictObject({}),
      handler: async () => 1,
    });
    expect(await runQuery(request, op, {}, options)).toEqual({ ok: true, data: 1 });
    expect(configs).toEqual([{ accessMode: 'read only', isolationLevel: 'read committed' }]);
    await expect(() => runCommand(request, op, {}, options)).toThrow(/not a command/);
    await expect(() => runQuery(request, echo, {}, options)).toThrow(/not a query/);
  });

  it('requires strict object input schemas', () => {
    expect(() =>
      defineCommand({ name: 'test.loose', permission: 'p', input: z.object({ a: z.string() }), handler: async () => 1 }),
    ).toThrow(/strictObject/);
    expect(() => defineCommand({ name: 'test.scalar', permission: 'p', input: z.string(), handler: async () => 1 })).toThrow(
      /strictObject/,
    );
  });

  it('rejects malformed and duplicate names', () => {
    const def = { permission: 'p', input: z.strictObject({}), handler: async () => 1 };
    expect(() => defineCommand({ ...def, name: 'NoDots' })).toThrow(/name/);
    expect(() => defineCommand({ ...def, name: 'test.echo' })).toThrow(/Duplicate/);
  });

  it('keeps handlers out of the operation object and lists registered operations', () => {
    expect(Object.keys(echo).sort()).toEqual(['input', 'isolationLevel', 'kind', 'name', 'permission', 'retrySafe']);
    expect(Object.isFrozen(echo)).toBe(true);
    expect(registeredOperations()).toContainEqual({ name: 'test.echo', kind: 'command', permission: 'test.write' });
  });

  it('P5a-AC9: accepts any one of a list of permissions, and nothing else', async () => {
    const scopes: [string, ...string[]] = ['test.read.own', 'test.read.all'];
    const op = defineQuery({ name: 'test.readScoped', permission: scopes, input: z.strictObject({}), handler: async () => 'ok' });
    for (const held of [['test.read.own'], ['test.read.all'], ['test.read.own', 'test.read.all']]) {
      const { request, options } = setup(held);
      expect(await runQuery(request, op, {}, options)).toEqual({ ok: true, data: 'ok' });
    }
    for (const held of [[], ['test.read'], ['test.read.ownx']]) {
      const { request, options, configs } = setup(held);
      expect(await runQuery(request, op, {}, options)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
      expect(configs).toHaveLength(0);
    }
    // The operation keeps its own frozen copy of the list.
    scopes.push('test.widened');
    expect(op.permission).toEqual(['test.read.own', 'test.read.all']);
    expect(Object.isFrozen(op.permission)).toBe(true);
    expect(() =>
      defineQuery({ name: 'test.noPermissions', permission: [] as unknown as ['x'], input: z.strictObject({}), handler: async () => 1 }),
    ).toThrow(/empty permission list/);
  });

  it('exposes AppFailure for expected handler errors', () => {
    expect(new AppFailure({ code: 'CONFLICT', message: 'x' }).error.code).toBe('CONFLICT');
  });
});

describe('createRequestContext', () => {
  it('normalizes untrusted transport values', () => {
    const ctx = createRequestContext({ actor: null, requestId: 'not-a-uuid', ip: '999.1.1.1', userAgent: 'x'.repeat(600) });
    expect(ctx.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ctx.ip).toBeNull();
    expect(ctx.userAgent).toHaveLength(512);
    const kept = createRequestContext({
      actor: null,
      requestId: '0199f0a0-1111-7222-8333-944445555666',
      ip: '2001:db8::1',
    });
    expect(kept.requestId).toBe('0199f0a0-1111-7222-8333-944445555666');
    expect(kept.ip).toBe('2001:db8::1');
    expect(kept.userAgent).toBeNull();
  });
});
