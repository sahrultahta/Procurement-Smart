/**
 * Config used only by the Better Auth schema generator:
 *   npx auth generate --config scripts/auth-cli.config.ts --adapter drizzle --dialect postgresql \
 *     --output src/modules/identity/infrastructure/auth-schema.generated.ts --yes
 * The generated file is a starting point; the committed schema is
 * src/modules/identity/infrastructure/auth-schema.ts (snake_case columns, reviewed).
 */
import { betterAuth } from 'better-auth';
import { authSchemaOptions } from '../src/server/auth-schema-options.ts';

export const auth = betterAuth({
  ...authSchemaOptions,
  secret: 'schema-generation-only-not-a-real-secret-0000000000',
  telemetry: { enabled: false },
});
