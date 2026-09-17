-- =============================================
-- News Manager Bot tables (run in Supabase SQL Editor)
-- =============================================

CREATE TABLE IF NOT EXISTS public.nm_kv (
  key TEXT PRIMARY KEY,
  value JSONB,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW())
);

CREATE TABLE IF NOT EXISTS public.nm_hashes (
  hash TEXT PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW())
);

CREATE TABLE IF NOT EXISTS public.nm_queue (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  msg_id BIGINT NOT NULL,
  text TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW())
);

CREATE INDEX IF NOT EXISTS idx_nm_queue_status ON public.nm_queue(status, id);
