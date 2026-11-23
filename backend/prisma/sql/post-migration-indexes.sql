-- =============================================================================
-- ÍNDICES AVANÇADOS (PG_TRGM + PGVECTOR HNSW) — SUPABASE POSTGRESQL
-- Execute este SQL após a primeira migration (ou cole no SQL Editor do Supabase)
-- porque o Prisma ainda não expressa operadores `gin_trgm_ops` nem `vector_cosine_ops`.
-- =============================================================================

-- 1. Busca fuzzy ultrarrápida (Ctrl+K, busca de contatos e busca dentro do chat)
CREATE INDEX IF NOT EXISTS idx_contacts_name_trgm
  ON public.contacts USING gin (name extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_contacts_phone_trgm
  ON public.contacts USING gin (phone_e164 extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_contacts_email_trgm
  ON public.contacts USING gin (email extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_messages_content_trgm
  ON public.messages USING gin (content extensions.gin_trgm_ops);

-- 2. Busca vetorial aproximada (HNSW com distância de cosseno) para o Assistente IA (RAG)
CREATE INDEX IF NOT EXISTS idx_ai_knowledge_chunks_embedding_hnsw
  ON public.ai_knowledge_chunks
  USING hnsw (embedding extensions.vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
