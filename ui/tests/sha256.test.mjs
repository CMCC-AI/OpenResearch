import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import test from "node:test";
import { sha256Hex } from "../src/product/sha256.ts";

test("HTTP fallback and Web Crypto produce identical file fingerprints", async () => {
  // Include SHA-256 padding boundaries, empty files, Unicode and binary content.
  const inputs = [new TextEncoder().encode("科研成果"), ...[0, 1, 55, 56, 63, 64, 65, 127, 128, 1024 * 1024].map(
    (length) => Uint8Array.from({ length }, (_, index) => index % 256),
  )];
  for (const bytes of inputs) {
    const expected = createHash("sha256").update(bytes).digest("hex");
    assert.equal(await sha256Hex(bytes, {}), expected, `HTTP: ${bytes.length} bytes`);
    assert.equal(await sha256Hex(bytes, webcrypto), expected, `HTTPS: ${bytes.length} bytes`);
  }
});

test("HTTP browsers can hash files when the global crypto lacks subtle", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });
  try {
    assert.equal(await sha256Hex(new TextEncoder().encode("abc")),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    else delete globalThis.crypto;
  }
});
