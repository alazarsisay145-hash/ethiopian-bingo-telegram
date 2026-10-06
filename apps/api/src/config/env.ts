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
  BOT_TOKEN: z.string().trim().min(1),
  JWT_SECRET: z.string().min(32),
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
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, unknown> = process.env): Env {
  return envSchema.parse(source);
}
