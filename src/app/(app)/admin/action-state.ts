import type { AppError, Result } from '@/shared/result';

/**
 * What an admin Server Action sends back to the browser: a status, a safe message,
 * and field errors. Never a database row (threat I-02). `link` carries a one-time
 * password-setup URL, shown to the admin once.
 */
export type ActionState =
  | { status: 'idle' }
  | { status: 'ok'; message: string; link?: string; userId?: string }
  | { status: 'error'; code: AppError['code']; rule?: string; message: string; fieldErrors?: Record<string, string[]> };

export const IDLE: ActionState = { status: 'idle' };

export function failed(error: AppError): ActionState {
  return {
    status: 'error',
    code: error.code,
    message: error.message,
    ...(error.rule ? { rule: error.rule } : {}),
    ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
  };
}

export function outcome(result: Result<unknown>, message: string): ActionState {
  return result.ok ? { status: 'ok', message } : failed(result.error);
}

// FormData readers. Only named fields are read; anything else in the request is ignored
// here and could not reach a command anyway (strict input schemas).
export function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

export function optional(form: FormData, name: string): string | null {
  const value = text(form, name).trim();
  return value === '' ? null : value;
}

export function integer(form: FormData, name: string): number {
  const value = text(form, name);
  return /^\d{1,10}$/.test(value) ? Number(value) : Number.NaN;
}
