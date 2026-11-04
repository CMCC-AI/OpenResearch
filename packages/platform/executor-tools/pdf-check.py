#!/usr/bin/env python3
"""Offline Poppler acceptance with synthetic, non-sensitive PDF bytes."""
import argparse
import pathlib
import subprocess


def document(streams):
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    objects += [b"<< /Length " + str(len(s)).encode() + b" >>\nstream\n" + s + b"\nendstream" for s in streams]
    body = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for index, value in enumerate(objects, 1):
        offsets.append(len(body))
        body.extend(f"{index} 0 obj\n".encode() + value + b"\nendobj\n")
    xref = len(body)
    body.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        body.extend(f"{offset:010} 00000 n \n".encode())
    body.extend(f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return bytes(body)


def fixtures():
    normal = document([
        b"BT /F1 12 Tf 72 720 Td (First page alpha) Tj 0 -24 Td (First page beta) Tj ET",
        b"BT /F1 12 Tf 72 720 Td (Second page gamma) Tj ET",
    ])
    image = b"q 200 0 0 200 72 500 cm BI /W 1 /H 1 /CS /DeviceGray /BPC 8 /F /ASCIIHexDecode ID 00> EI Q"
    return {"normal.pdf": normal, "image-only.pdf": document([image, image]), "broken.pdf": b"%PDF-1.4\nnot a PDF object graph\n%%EOF\n"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixtures", type=pathlib.Path)
    args = parser.parse_args()
    data = fixtures()
    if args.fixtures:
        args.fixtures.mkdir(parents=True, exist_ok=True)
        for name, body in data.items():
            (args.fixtures / name).write_bytes(body)
        return
    version = subprocess.run(["pdftotext", "-v"], capture_output=True, check=True, timeout=10)
    print(version.stderr.decode().splitlines()[0])
    def read(name, page):
        return subprocess.run(["pdftotext", "-f", str(page), "-l", str(page), "-layout", "-", "-"], input=data[name], capture_output=True, timeout=30)
    first, second = read("normal.pdf", 1), read("normal.pdf", 2)
    assert first.returncode == second.returncode == 0
    assert b"First page alpha" in first.stdout and b"Second page gamma" not in first.stdout
    assert b"Second page gamma" in second.stdout and b"First page alpha" not in second.stdout
    assert read("normal.pdf", 3).returncode != 0
    assert read("broken.pdf", 1).returncode != 0
    scanned = read("image-only.pdf", 1)
    assert scanned.returncode == 0 and not scanned.stdout.strip()
    assert read("normal.pdf", 2).stdout == second.stdout
    print("Real PDF page selection, malformed/image-only input and recovery verified offline")


if __name__ == "__main__":
    main()
