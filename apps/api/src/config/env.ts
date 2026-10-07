import { z } from 'zod';

const optionalUrl = z.preprocess(
  (value) => value === '' ? undefined : value,
  z.string().url().optional(),
);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TELEGRAM_BOT_TOKEN: z.string().trim().min(1).optional(),
  BOT_TOKEN: z.string().trim().min(1).optional(),
  // A one-hour session bounds replay exposure while tolerating normal Mini App sessions.
  TELEGRAM_INITDATA_MAX_AGE_SECONDS: z.coerce.number().int().positive().safe().default(3600),
  TELEGRAM_INITDATA_CLOCK_SKEW_SECONDS: z.coerce.number().int().nonnegative().safe().default(30),
  TELEGRAM_INITDATA_MAX_BYTES: z.coerce.number().int().positive().safe().default(16384),
  JWT_SECRET: z.string().min(32),
  SEED_ENCRYPTION_KEY: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().regex(/^[a-f\d]{64}$/i).optional(),
  ),
  DATABASE_URL: optionalUrl,
  REDIS_URL: optionalUrl,
  CORS_ORIGINS: z.string().default('').transform((value) =>
    value.split(',').map((origin) => origin.trim()).filter(Boolean),
  ).pipe(z.array(z.string().url().refine((origin) => {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === origin;
  }, 'CORS origins must be exact HTTP(S) origins'))),
  ADMIN_TELEGRAM_IDS: z.string().default('').transform((value) =>
    value.split(',').map((id) => id.trim()).filter(Boolean),
  ).pipe(z.array(z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(
    z.number().int().positive().safe(),
  ))),
  MAX_ACTIVE_GAMES_PER_USER: z.coerce.number().int().min(1).max(100).default(3),
  HTTP_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10000).default(100),
  HTTP_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).max(3600000).default(60000),
  WS_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).max(3600000).default(10000),
}).superRefine((env, context) => {
  if (!env.TELEGRAM_BOT_TOKEN && (env.NODE_ENV === 'production' || !env.BOT_TOKEN)) {
    context.addIssue({
      code: 'custom',
      path: ['TELEGRAM_BOT_TOKEN'],
      message: 'TELEGRAM_BOT_TOKEN is required (BOT_TOKEN is supported only outside production)',
    });
  }
  if (env.NODE_ENV === 'production' && !env.SEED_ENCRYPTION_KEY) {
    context.addIssue({
      code: 'custom',
      path: ['SEED_ENCRYPTION_KEY'],
      message: 'SEED_ENCRYPTION_KEY is required in production',
    });
  }
}).transform((env) => ({
  ...env,
  TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN ?? env.BOT_TOKEN!,
}));

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, unknown> = process.env): Env {
  return envSchema.parse(source);
}
