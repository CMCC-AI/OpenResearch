CREATE TABLE IF NOT EXISTS platform_users (
  id uuid PRIMARY KEY, email text UNIQUE NOT NULL, name text NOT NULL,
  password_hash text NOT NULL, disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY, name text NOT NULL, created_by uuid NOT NULL REFERENCES platform_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id), user_id uuid NOT NULL REFERENCES platform_users(id),
  role text NOT NULL CHECK(role IN ('owner','editor','viewer')), PRIMARY KEY(workspace_id,user_id)
);
CREATE TABLE IF NOT EXISTS platform_sessions (
  token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES platform_users(id),
  host text NOT NULL, parent_hash text REFERENCES platform_sessions(token_hash) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user ON platform_sessions(user_id);
CREATE TABLE IF NOT EXISTS launch_tickets (
  token_hash text PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id),
  session_hash text NOT NULL REFERENCES platform_sessions(token_hash) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_invites (
  token_hash text PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id),
  email text NOT NULL, role text NOT NULL CHECK(role IN ('editor','viewer')),
  expires_at timestamptz NOT NULL, created_by uuid NOT NULL REFERENCES platform_users(id)
);
CREATE TABLE IF NOT EXISTS runners (
  id uuid PRIMARY KEY, workspace_id uuid UNIQUE NOT NULL REFERENCES workspaces(id),
  token_hash text UNIQUE NOT NULL, expires_at timestamptz NOT NULL,
  last_seen timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auth_limits (
  key text PRIMARY KEY, attempts integer NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces(id), actor_id uuid REFERENCES platform_users(id),
  action text NOT NULL, resource text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_workspace ON audit_events(workspace_id,created_at DESC);
CREATE TABLE IF NOT EXISTS workspace_preferences (
  workspace_id uuid NOT NULL REFERENCES workspaces(id), user_id uuid NOT NULL REFERENCES platform_users(id),
  key text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(workspace_id,user_id,key)
);
