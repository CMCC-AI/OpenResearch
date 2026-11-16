-- Separate mandatory quota accounting from optional client analytics.
CREATE TABLE token_quota_accounts (
  user_id uuid PRIMARY KEY REFERENCES platform_users(id),
  monthly_limit bigint NOT NULL CHECK (monthly_limit BETWEEN 0 AND 9007199254740991),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE token_quota_periods (
  user_id uuid NOT NULL REFERENCES token_quota_accounts(user_id),
  period text NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),
  granted bigint NOT NULL CHECK (granted BETWEEN 0 AND 9007199254740991),
  used bigint NOT NULL DEFAULT 0 CHECK (used BETWEEN 0 AND 9007199254740991),
  reserved bigint NOT NULL DEFAULT 0 CHECK (reserved BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(user_id,period)
);
CREATE TABLE token_quota_adjustments (
  user_id uuid NOT NULL REFERENCES token_quota_accounts(user_id),
  idempotency_key uuid NOT NULL,
  monthly_limit bigint NOT NULL,
  actor_id uuid NOT NULL REFERENCES platform_users(id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,idempotency_key)
);
CREATE TABLE token_quota_requests (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  period text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  model text NOT NULL,
  upstream_request_id text,
  reserved bigint NOT NULL CHECK (reserved > 0),
  actual bigint CHECK (actual >= 0),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','pending','settled')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  FOREIGN KEY(user_id,period) REFERENCES token_quota_periods(user_id,period)
);
CREATE INDEX token_quota_requests_user ON token_quota_requests(user_id,(state <> 'settled') DESC,created_at DESC,id DESC);
