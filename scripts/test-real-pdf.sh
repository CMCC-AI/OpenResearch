#!/usr/bin/env bash
# Required external-tool gate; never accept an empty Cargo test filter.
set -euo pipefail
pdf_case=material_cli_real_pdf_pages_failures_and_parser_recovery_preserve_receipts
pdftotext -v
cargo test --locked --test materials_cli -- --ignored --list | grep -Fx "$pdf_case: test"
cargo test --locked --test materials_cli "$pdf_case" -- --ignored --exact --nocapture
