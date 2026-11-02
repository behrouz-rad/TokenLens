const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

export class Base64UrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Base64UrlError';
  }
}

export function isBase64Url(value: string): boolean {
  return BASE64URL_PATTERN.test(value);
}

export function base64UrlToBytes(value: string): Uint8Array {
  if (!isBase64Url(value)) {
    throw new Base64UrlError('Segment contains characters outside the base64url alphabet');
  }
  if (value.length % 4 === 1) {
    throw new Base64UrlError('Segment has an invalid base64url length');
  }
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Base64UrlError('Segment is not valid base64url data');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export function base64UrlToUtf8(value: string): string {
  const bytes = base64UrlToBytes(value);
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw new Base64UrlError('Segment is not valid UTF-8');
  }
}

export function utf8ToBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
