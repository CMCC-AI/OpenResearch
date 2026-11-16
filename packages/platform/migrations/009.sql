-- Account ownership is independent of the bounded pool of running executors.
ALTER TABLE workspace_runtimes DROP CONSTRAINT workspace_runtimes_status_check;
ALTER TABLE workspace_runtimes ADD CONSTRAINT workspace_runtimes_status_check
  CHECK (status IN ('waiting','sleeping','queued','starting','ready','failed','deleted'));
ALTER TABLE workspace_runtimes ADD COLUMN requested_at timestamptz;
ALTER TABLE workspace_runtimes ADD COLUMN last_requested_at timestamptz;
ALTER TABLE workspace_runtimes ADD COLUMN last_used_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE workspace_runtime_leases (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX workspace_runtime_leases_workspace ON workspace_runtime_leases(workspace_id, expires_at);
