ALTER TABLE platform_users ADD COLUMN is_admin boolean NOT NULL DEFAULT false;
ALTER TABLE platform_users ADD COLUMN last_login_at timestamptz;
ALTER TABLE platform_users ADD COLUMN password_version integer NOT NULL DEFAULT 0;
UPDATE platform_users u SET last_login_at = (
  SELECT max(created_at) FROM audit_events WHERE actor_id=u.id AND action='login'
);
CREATE INDEX platform_users_created ON platform_users(created_at DESC, id);
CREATE TABLE password_reset_tokens (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  password_version integer NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX password_reset_user ON password_reset_tokens(user_id);
CREATE INDEX password_reset_expiry ON password_reset_tokens(expires_at);
