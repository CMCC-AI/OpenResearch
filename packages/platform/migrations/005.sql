CREATE TABLE featured_cases (
  id uuid PRIMARY KEY,
  created_by uuid NOT NULL REFERENCES platform_users(id),
  source_project_id text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  category text NOT NULL,
  snapshot jsonb NOT NULL,
  expected_file_count integer NOT NULL DEFAULT 0 CHECK (expected_file_count BETWEEN 0 AND 200),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  revision integer NOT NULL DEFAULT 1,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX featured_cases_public ON featured_cases(status, sort_order, published_at DESC);
CREATE TABLE featured_case_files (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES featured_cases(id) ON DELETE CASCADE,
  name text NOT NULL,
  size integer NOT NULL CHECK (size BETWEEN 0 AND 26214400),
  sha256 text NOT NULL,
  content bytea NOT NULL,
  UNIQUE(case_id,name)
);
