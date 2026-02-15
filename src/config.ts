import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().default('postgresql://localhost:5432/test'),
  JWT_SECRET: z.string().min(1).default('test-secret-not-for-production'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  TAKER_FEE_BPS: z.coerce.number().int().min(0).max(1000).default(100), // 1% default
  TICK_SIZE_CENTS: z.coerce.number().int().min(1).max(10).default(1),
});

export type Env = z.infer<typeof envSchema>;

let _config: Env | null = null;

export const config: Env = new Proxy({} as Env, {
  get(_target, prop: string) {
    if (!_config) {
      const result = envSchema.safeParse(process.env);
      if (!result.success) {
        console.error('Invalid environment variables:', result.error.flatten().fieldErrors);
        process.exit(1);
      }
      _config = result.data;
    }
    return _config[prop as keyof Env];
  },
});
