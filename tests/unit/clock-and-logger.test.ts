import { describe, expect, it } from 'vitest';
import { businessDate, businessYear, fixedClock } from '@/shared/clock';
import { isUuid, newRequestId } from '@/shared/ids';
import { createLogger, describeError } from '@/shared/logger';

describe('clock', () => {
  it('derives the business date in the organization time zone', () => {
    const clock = fixedClock('2026-12-31T20:30:00Z');
    expect(businessDate(clock, 'UTC')).toBe('2026-12-31');
    expect(businessDate(clock, 'Asia/Jakarta')).toBe('2027-01-01'); // UTC+7
    expect(businessYear(clock, 'Asia/Jakarta')).toBe(2027);
    expect(businessYear(clock, 'America/New_York')).toBe(2026);
  });

  it('rejects an invalid instant', () => {
    expect(() => fixedClock('not-a-date')).toThrow();
  });
});

describe('ids', () => {
  it('generates UUID request ids', () => {
    const id = newRequestId();
    expect(isUuid(id)).toBe(true);
    expect(newRequestId()).not.toBe(id);
    expect(isUuid('not-a-uuid')).toBe(false);
  });
});

describe('logger (threat model I-05)', () => {
  function capture(level: 'debug' | 'info' | 'warn' | 'error' = 'debug') {
    const lines: { level: string; record: Record<string, unknown> }[] = [];
    const log = createLogger({
      level,
      clock: fixedClock('2026-10-21T00:00:00Z'),
      sink: (lvl, line) => lines.push({ level: lvl, record: JSON.parse(line) as Record<string, unknown> }),
    });
    return { log, lines };
  }

  it('writes one JSON object per event with allowlisted fields', () => {
    const { log, lines } = capture();
    log.info('command.completed', { requestId: 'r-1', command: 'probe.run', durationMs: 12, outcome: 'ok' });
    expect(lines).toEqual([
      {
        level: 'info',
        record: {
          level: 'info',
          time: '2026-10-21T00:00:00.000Z',
          msg: 'command.completed',
          requestId: 'r-1',
          command: 'probe.run',
          durationMs: 12,
          outcome: 'ok',
        },
      },
    ]);
  });

  it('drops fields that are not on the allowlist', () => {
    const { log, lines } = capture();
    const sneaky = { requestId: 'r-2', password: 'hunter2', input: { email: 'a@example.com' } } as Record<string, unknown>;
    log.info('command.completed', sneaky);
    const text = JSON.stringify(lines);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('a@example.com');
    expect(lines[0]?.record.requestId).toBe('r-2');
  });

  it('refuses interpolated messages', () => {
    const { log, lines } = capture();
    log.warn('user a@example.com failed');
    expect(lines[0]?.record.msg).toBe('log.invalid_message');
  });

  it('respects the level threshold', () => {
    const { log, lines } = capture('warn');
    log.debug('a.b');
    log.info('a.b');
    log.warn('a.b');
    log.error('a.b');
    expect(lines.map((l) => l.level)).toEqual(['warn', 'error']);
  });

  it('describes PostgreSQL errors without SQL text, parameters, or row detail', () => {
    const pgError = Object.assign(new Error('duplicate key value violates unique constraint "x_key"'), {
      name: 'DatabaseError',
      code: '23505',
      constraint: 'x_key',
      detail: 'Key (email)=(secret@example.com) already exists.',
    });
    const wrapped = Object.assign(new Error('Failed query: insert into x values ($1)\nparams: secret@example.com'), {
      cause: pgError,
    });
    const described = describeError(wrapped);
    expect(described).toEqual({
      name: 'DatabaseError',
      message: 'duplicate key value violates unique constraint "x_key"',
      sqlState: '23505',
      constraint: 'x_key',
    });
    expect(JSON.stringify(described)).not.toContain('secret@example.com');
  });

  it('describes non-database and non-Error values', () => {
    expect(describeError(new TypeError('boom'))).toEqual({ name: 'TypeError', message: 'boom' });
    expect(describeError('plain string')).toEqual({ name: 'NonError', message: 'plain string' });
    expect(describeError(new Error('x'.repeat(600))).message).toHaveLength(501);
  });
});
