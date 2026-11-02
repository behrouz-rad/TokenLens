import { describe, expect, it } from 'vitest';
import { Base64UrlError, base64UrlToBytes, base64UrlToUtf8, isBase64Url, utf8ToBase64Url } from '@/core/jwt/base64url';

describe('base64url', () => {
  it('round-trips ASCII and Unicode text', () => {
    for (const text of ['{"alg":"HS256"}', 'Zoë Ürsula Ångström 🔐', '', '日本語']) {
      expect(base64UrlToUtf8(utf8ToBase64Url(text))).toBe(text);
    }
  });

  it('accepts unpadded input and rejects padding characters', () => {
    expect(base64UrlToUtf8('aGVsbG8')).toBe('hello');
    expect(isBase64Url('aGVsbG8=')).toBe(false);
    expect(() => base64UrlToBytes('aGVsbG8=')).toThrow(Base64UrlError);
  });

  it('rejects characters outside the alphabet', () => {
    expect(isBase64Url('abc+def/')).toBe(false);
    expect(() => base64UrlToBytes('abc+def/')).toThrow(/alphabet/);
  });

  it('rejects impossible lengths', () => {
    expect(() => base64UrlToBytes('a')).toThrow(/length/);
    expect(() => base64UrlToBytes('abcde')).toThrow(/length/);
  });

  it('rejects bytes that are not valid UTF-8', () => {
    expect(() => base64UrlToUtf8('_w')).toThrow(/UTF-8/);
  });
});
