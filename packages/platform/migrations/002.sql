CREATE TABLE sso_authorization_codes (
  token_hash text PRIMARY KEY,
  root_session_hash text NOT NULL REFERENCES platform_sessions(token_hash) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  state text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX sso_codes_expiry ON sso_authorization_codes(expires_at);

CREATE TABLE sso_grants (
  id uuid PRIMARY KEY,
  client text NOT NULL CHECK (client = 'deeplit'),
  root_session_hash text NOT NULL REFERENCES platform_sessions(token_hash) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sso_grants_session ON sso_grants(root_session_hash);
