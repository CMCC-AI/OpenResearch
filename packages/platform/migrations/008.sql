ALTER TABLE featured_cases
  DROP CONSTRAINT featured_cases_expected_file_count_check,
  ADD CONSTRAINT featured_cases_expected_file_count_check
    CHECK (expected_file_count BETWEEN 0 AND 2000);

ALTER TABLE featured_case_files
  DROP CONSTRAINT featured_case_files_size_check,
  ADD CONSTRAINT featured_case_files_size_check
    CHECK (size BETWEEN 0 AND 134217728);
