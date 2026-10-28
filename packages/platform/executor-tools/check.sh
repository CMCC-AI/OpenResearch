#!/bin/sh
# Offline verification under the actual executor UID, also usable after deployment.
set -eu
test "$(id -u)" = 1000
for tool in python python3 pip pip3 uv uvx git ssh curl wget rg jq sqlite3 zip unzip file ps cc make pkg-config pdftotext; do
  command -v "$tool" >/dev/null
done
python3 -m pip --version
uv --version
python3 -c 'import numpy, pandas, scipy, matplotlib, openpyxl, requests, bs4, lxml, PIL, docx, shapefile, shapely, PyPDF2'
scratch=$(mktemp -d /tmp/opencode/runtime-check.XXXXXX)
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
printf 'print("executor write check passed")\n' > "$scratch/check.py"
python3 "$scratch/check.py"
python3 -m venv "$scratch/venv"
"$scratch/venv/bin/python" -m pip --version
uv --offline --no-python-downloads venv --python /usr/bin/python3 "$scratch/uv-venv"
"$scratch/uv-venv/bin/python" -c 'import sys; assert sys.prefix != sys.base_prefix'
echo 'Executor tools and non-root temporary writes verified offline'
