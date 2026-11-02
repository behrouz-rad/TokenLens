/**
 * Fast, synchronous, non-cryptographic 64-bit fingerprint (two independent 32-bit
 * multiply/xor rounds, cyrb53-style). It is used only as an in-memory index key so the
 * capture session never has to scan every token or key a Map by the raw credential.
 * Callers must still compare the raw value on a hit; collisions are tolerated, not assumed away.
 */
export function fingerprintToken(raw: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}
