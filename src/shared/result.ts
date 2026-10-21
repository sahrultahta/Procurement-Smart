/**
 * Result envelope and error contract shared by every transport (ADR 0010).
 * Messages are safe to show to the caller: never SQL, stack traces, or other users' data.
 */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_TRANSITION'
  | 'BUSINESS_RULE'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export type AppError = {
  code: ErrorCode;
  message: string;
  /** Sub-code for BUSINESS_RULE errors, e.g. 'OVER_RECEIPT' (docs/api-contracts.md). */
  rule?: string;
  fieldErrors?: Record<string, string[]>;
  details?: unknown;
};

export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError };

export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

export function err<T = never>(error: AppError): Result<T> {
  return { ok: false, error };
}

/**
 * Thrown inside a command handler to abort its transaction with an expected,
 * caller-visible error. Anything else thrown becomes INTERNAL.
 */
export class AppFailure extends Error {
  readonly error: AppError;

  constructor(error: AppError) {
    super(error.message);
    this.name = 'AppFailure';
    this.error = error;
  }
}

export function fail(code: Exclude<ErrorCode, 'BUSINESS_RULE' | 'INTERNAL'>, message: string): never {
  throw new AppFailure({ code, message });
}

export function failBusinessRule(rule: string, message: string, details?: unknown): never {
  throw new AppFailure(
    details === undefined ? { code: 'BUSINESS_RULE', rule, message } : { code: 'BUSINESS_RULE', rule, message, details },
  );
}
