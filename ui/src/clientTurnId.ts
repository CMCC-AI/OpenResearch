/** Web Crypto UUIDs require HTTPS; random bytes also work on an approved HTTP origin. */
export function createClientTurnId(source: Crypto = globalThis.crypto): string {
  const value = typeof source.randomUUID === "function"
    ? source.randomUUID()
    : Array.from(source.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
  return `ct_${value}`;
}
