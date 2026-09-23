-- Retain tombstones after workspace deletion until resource cleanup completes.
CREATE TABLE workspace_runtimes (
  workspace_id uuid PRIMARY KEY,
  desired text NOT NULL DEFAULT 'running' CHECK (desired IN ('running','deleted')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','starting','ready','failed','deleted')),
  error text,
  checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
