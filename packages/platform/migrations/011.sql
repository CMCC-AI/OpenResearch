ALTER TABLE platform_sessions
  ADD COLUMN IF NOT EXISTS max_expires_at timestamptz DEFAULT (now() + interval '30 days');
UPDATE platform_sessions
  SET max_expires_at = created_at + interval '30 days'
  WHERE max_expires_at IS NULL;
