import 'server-only';
import { z } from 'zod';
import { systemClock, type Clock } from '../clock';
import { getDb } from '../db/client';
import { inTransaction, type Database, type IsolationLevel, type Tx } from '../db/transaction';
import { databaseErrorOf, describeError, logger as defaultLogger, type Logger } from '../logger';
import { AppFailure, err, ok, type AppError, type Result } from '../result';
import type { Actor, Permission, RequestContext } from './context';

/**
 * The single path into business logic (ADR 0010). Fixed order:
 *   authenticate → permission → validate input → transaction (timeouts) → handler → commit → Result
 * Authentication and permission come before validation, so anonymous or forbidden
 * callers learn nothing about input schemas.
 */
export type HandlerContext = {
  readonly tx: Tx;
  readonly actor: Actor;
  readonly request: RequestContext;
  readonly clock: Clock;
};

type Kind = 'command' | 'query';

/**
 * One permission, or a non-empty list of which the caller needs **any one** (for reads whose
 * scope depends on the permission held, e.g. own / department / all requisitions; ADR 0010
 * amendment). Which rows the caller then sees is decided by the handler, in SQL.
 */
export type PermissionRequirement = Permission | readonly [Permission, ...Permission[]];

export type Operation<I, O> = {
  readonly kind: Kind;
  readonly name: string;
  readonly permission: PermissionRequirement;
  readonly input: z.ZodType<I>;
  readonly retrySafe: boolean;
  readonly isolationLevel: IsolationLevel;
  /** Type-level only. */
  readonly _output?: O;
};

type AnyHandler = (context: HandlerContext, input: unknown) => Promise<unknown>;

// Handlers are reachable only through this module, never as a property of the definition.
const handlers = new WeakMap<object, AnyHandler>();
const registry = new Map<string, { kind: Kind; permission: PermissionRequirement }>();

const NAME_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

type Definition<S extends z.ZodType, O> = {
  name: string;
  permission: PermissionRequirement;
  /** Must be z.strictObject(...): unknown fields are rejected (ADR 0007, threat T-01). */
  input: S;
  /** Whole-transaction retry on serialization failure or deadlock (ADR 0008 C8). */
  retrySafe?: boolean;
  isolationLevel?: IsolationLevel;
  handler: (context: HandlerContext, input: z.output<S>) => Promise<O>;
};

function define<S extends z.ZodType, O>(kind: Kind, def: Definition<S, O>): Operation<z.output<S>, O> {
  if (!NAME_PATTERN.test(def.name)) throw new Error(`Invalid ${kind} name: ${def.name}`);
  if (registry.has(def.name)) throw new Error(`Duplicate operation name: ${def.name}`);
  if (typeof def.permission !== 'string' && def.permission.length === 0) throw new Error(`${def.name}: empty permission list`);
  const schemaDef = (def.input as unknown as { def?: { type?: string; catchall?: { def?: { type?: string } } } }).def;
  if (schemaDef?.type !== 'object' || schemaDef.catchall?.def?.type !== 'never') {
    throw new Error(`${def.name}: input must be a z.strictObject(...) schema`);
  }
  const operation: Operation<z.output<S>, O> = Object.freeze({
    kind,
    name: def.name,
    // A private frozen copy: the caller cannot widen an operation's permissions afterwards.
    permission: typeof def.permission === 'string' ? def.permission : (Object.freeze([...def.permission]) as unknown as PermissionRequirement),
    input: def.input as z.ZodType<z.output<S>>,
    retrySafe: def.retrySafe ?? false,
    isolationLevel: def.isolationLevel ?? 'read committed',
  });
  handlers.set(operation, def.handler as AnyHandler);
  registry.set(def.name, { kind, permission: def.permission });
  return operation;
}

export function defineCommand<S extends z.ZodType, O>(def: Definition<S, O>): Operation<z.output<S>, O> {
  return define('command', def);
}

/** Queries run in a READ ONLY transaction: any write attempt fails. */
export function defineQuery<S extends z.ZodType, O>(def: Omit<Definition<S, O>, 'retrySafe'>): Operation<z.output<S>, O> {
  return define('query', { ...def, retrySafe: true });
}

export function registeredOperations(): readonly { name: string; kind: Kind; permission: PermissionRequirement }[] {
  return [...registry].map(([name, info]) => ({ name, ...info }));
}

export type RunnerOptions = {
  db?: Database;
  logger?: Logger;
  clock?: Clock;
  lockTimeout?: string;
  statementTimeout?: string;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
};

const RETRYABLE = new Set(['40001', '40P01']);

export function runCommand<I, O>(request: RequestContext, operation: Operation<I, O>, rawInput: unknown, options?: RunnerOptions): Promise<Result<O>> {
  if (operation.kind !== 'command') throw new Error(`${operation.name} is not a command`);
  return execute(request, operation, rawInput, options ?? {});
}

export function runQuery<I, O>(request: RequestContext, operation: Operation<I, O>, rawInput: unknown, options?: RunnerOptions): Promise<Result<O>> {
  if (operation.kind !== 'query') throw new Error(`${operation.name} is not a query`);
  return execute(request, operation, rawInput, options ?? {});
}

async function execute<I, O>(request: RequestContext, operation: Operation<I, O>, rawInput: unknown, options: RunnerOptions): Promise<Result<O>> {
  const log = options.logger ?? defaultLogger;
  const started = performance.now();
  const base = { requestId: request.requestId, command: operation.name, userId: request.actor?.userId ?? null };
  const elapsed = (): number => Math.round(performance.now() - started);

  const reject = (error: AppError, extra: { error?: ReturnType<typeof describeError>; attempt?: number } = {}): Result<O> => {
    const denied = error.code === 'UNAUTHENTICATED' || error.code === 'FORBIDDEN';
    const integrity = error.rule === 'INTEGRITY_CONSTRAINT';
    const fields = { ...base, durationMs: elapsed(), outcome: 'rejected' as const, errorCode: error.code, ...extra };
    if (error.rule !== undefined) Object.assign(fields, { rule: error.rule });
    if (denied) log.warn(`${operation.kind}.denied`, fields);
    else if (integrity) log.warn(`${operation.kind}.rejected`, fields);
    else log.info(`${operation.kind}.rejected`, fields);
    return err(error);
  };

  const actor = request.actor;
  if (!actor) return reject({ code: 'UNAUTHENTICATED', message: 'Sign in to continue.' });
  if (!holds(actor, operation.permission)) {
    return reject({ code: 'FORBIDDEN', message: 'You do not have permission to perform this action.' });
  }

  const parsed = operation.input.safeParse(rawInput);
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.length > 0 ? issue.path.join('.') : '_form';
      (fieldErrors[key] ??= []).push(issue.message);
    }
    return reject({ code: 'VALIDATION_FAILED', message: 'Some fields are invalid.', fieldErrors });
  }

  const handler = handlers.get(operation);
  if (!handler) throw new Error(`${operation.name} was not created with defineCommand/defineQuery`);
  const db = options.db ?? getDb();
  const clock = options.clock ?? systemClock;
  const maxAttempts = options.maxAttempts ?? 3;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 1; ; attempt++) {
    try {
      const data = await inTransaction(
        db,
        {
          isolationLevel: operation.isolationLevel,
          readOnly: operation.kind === 'query',
          lockTimeout: options.lockTimeout ?? '5s',
          statementTimeout: options.statementTimeout ?? '15s',
        },
        (tx) => handler({ tx, actor, request, clock }, parsed.data),
      );
      log.info(`${operation.kind}.completed`, { ...base, durationMs: elapsed(), outcome: 'ok', attempt });
      return ok(data as O);
    } catch (error) {
      if (error instanceof AppFailure) return reject(error.error, { attempt });
      const dbError = databaseErrorOf(error);
      if (dbError && RETRYABLE.has(dbError.code) && operation.retrySafe && attempt < maxAttempts) {
        log.warn(`${operation.kind}.retrying`, { ...base, attempt, error: describeError(error) });
        await sleep(10 * attempt + Math.floor(Math.random() * 40));
        continue;
      }
      const mapped = dbError ? mapDatabaseError(dbError.code) : undefined;
      if (mapped) return reject(mapped, { attempt, error: describeError(error) });
      log.error(`${operation.kind}.failed`, {
        ...base,
        durationMs: elapsed(),
        outcome: 'failed',
        errorCode: 'INTERNAL',
        attempt,
        error: describeError(error),
      });
      return err({ code: 'INTERNAL', message: 'Something went wrong. The action was not completed.' });
    }
  }
}

function holds(actor: Actor, requirement: PermissionRequirement): boolean {
  return typeof requirement === 'string' ? actor.permissions.has(requirement) : requirement.some((p) => actor.permissions.has(p));
}

/** Expected database conditions → caller-visible errors. Everything else is INTERNAL. */
function mapDatabaseError(sqlState: string): AppError | undefined {
  switch (sqlState) {
    case '55P03': // lock_not_available (lock_timeout)
      return { code: 'CONFLICT', message: 'This record is being changed by someone else. Try again.' };
    case '40001': // serialization_failure
    case '40P01': // deadlock_detected
      return { code: 'CONFLICT', message: 'The action conflicted with another change. Try again.' };
    case '23505': // unique_violation
      return { code: 'CONFLICT', message: 'A record with the same unique value already exists.' };
    case '23502': // not_null_violation
    case '23503': // foreign_key_violation
    case '23514': // check_violation
    case '23P01': // exclusion_violation
      // The database caught what application checks should have: a backstop, logged at warn.
      return { code: 'BUSINESS_RULE', rule: 'INTEGRITY_CONSTRAINT', message: 'The change violates a data integrity rule.' };
    default:
      return undefined;
  }
}
