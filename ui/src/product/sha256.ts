import { sha256 } from "@noble/hashes/sha2.js";

/** Public HTTP deployments do not expose Web Crypto's secure-context-only subtle API. */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>, cryptoApi = globalThis.crypto): Promise<string> {
  const digest = cryptoApi?.subtle
    ? new Uint8Array(await cryptoApi.subtle.digest("SHA-256", bytes))
    : sha256(bytes);
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
