import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3333),
  HOST: z.string().default('0.0.0.0'),
  CORS_ORIGIN: z.string().default('http://localhost:8080'),

  // Supabase PostgreSQL
  DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatória'),
  DIRECT_URL: z.string().min(1, 'DIRECT_URL é obrigatória'),

  // Supabase Storage
  SUPABASE_URL: z.string().url('SUPABASE_URL inválida'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY é obrigatória'),
  SUPABASE_STORAGE_BUCKET_ATTACHMENTS: z.string().default('smv-attachments'),
  SUPABASE_STORAGE_BUCKET_AVATARS: z.string().default('smv-avatars'),

  // Auth & Criptografia
  JWT_SECRET: z.string().min(16, 'JWT_SECRET deve ter pelo menos 16 caracteres'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET deve ter pelo menos 16 caracteres'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  CREDENTIALS_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'CREDENTIALS_ENCRYPTION_KEY deve ser uma string hex de 64 caracteres (32 bytes)'),

  // Persistência de sessão Baileys ('database' criptografada no PostgreSQL por padrão; 'file' opcional em disco)
  BAILEYS_AUTH_STORAGE: z.enum(['database', 'file']).default('database'),

  // Opcionais no MVP
  REDIS_URL: z.string().optional().default(''),
  AI_PROVIDER: z.string().optional().default('openai'),
  AI_API_KEY: z.string().optional().default(''),
  AI_CHAT_MODEL: z.string().optional().default('gpt-4o-mini'),
  AI_EMBEDDING_MODEL: z.string().optional().default('text-embedding-3-small'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Erro na validação das variáveis de ambiente (.env):');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

/**
 * Normaliza múltiplas origens CORS separadas por vírgula (ex.: http://localhost:8080,https://meu-app.vercel.app)
 * removendo barras finais para evitar mismatch de CORS no Fastify e Socket.IO.
 */
export function getCorsOrigins(): string[] {
  return env.CORS_ORIGIN.split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}
