import 'server-only';
import { z } from 'zod';

/**
 * The only place that reads process.env (enforced by ESLint).
 * Error messages name the offending variables but never echo their values.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /** Signs session cookies and tokens. At least 32 characters (threat model section 8). */
  BETTER_AUTH_SECRET: z.string().min(32),
  /** Public origin of the app, e.g. https://procureflow.example.com. Also the only trusted origin. */
  BETTER_AUTH_URL: z.url({ protocol: /^https?$/ }),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {
  readonly variables: readonly string[];

  constructor(variables: readonly string[]) {
    super(`Invalid or missing environment variables: ${variables.join(', ')}. See .env.example.`);
    this.name = 'EnvError';
    this.variables = variables;
  }
}

export function parseEnv(source: Readonly<Record<string, string | undefined>>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? '(root)')))].sort();
    throw new EnvError(names);
  }
  return result.data;
}

export type LogLevel = Env['LOG_LEVEL'];

/**
 * LOG_LEVEL alone, without requiring the rest of the configuration, so logging
 * works even while reporting a configuration error.
 */
export function readLogLevel(): LogLevel {
  const parsed = envSchema.shape.LOG_LEVEL.safeParse(process.env.LOG_LEVEL);
  return parsed.success ? parsed.data : 'info';
}

let cached: Env | undefined;

export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
