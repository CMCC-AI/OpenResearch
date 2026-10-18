-- Logical ownership exists independently of compute allocation.
CREATE TABLE personal_spaces (
  user_id uuid PRIMARY KEY REFERENCES platform_users(id),
  workspace_id uuid UNIQUE NOT NULL REFERENCES workspaces(id)
);
