import { describe, expect, it } from 'vitest';
import { formatDateTime, formatDuration, formatExpiryCompact, formatRelativeTime, formatTimestamp, previewSecret, stringifyClaimValue, truncateMiddle, truncateUrl } from '@/lib/format';
import { fingerprintToken } from '@/core/jwt/fingerprint';

describe('format helpers', () => {
  it('formats expiry countdowns relative to a supplied clock', () => {
    const now = 1_700_000_000_000;
    expect(formatExpiryCompact(null, now)).toBe('No expiry');
    expect(formatExpiryCompact(now + 30_000, now)).toBe('Expires in 30s');
    expect(formatExpiryCompact(now + 90 * 60_000, now)).toBe('Expires in 1h');
    expect(formatExpiryCompact(now - 5_000, now)).toBe('Expired 5s ago');
  });

  it('never throws on invalid dates', () => {
    expect(formatTimestamp(Number.NaN)).toBe('--:--:--');
    expect(formatDateTime(Number.POSITIVE_INFINITY)).toBe('Invalid date');
    expect(formatRelativeTime(Number.NaN, 0)).toBe('unknown');
    expect(formatDuration(Number.NaN)).toBe('-');
  });

  it('formats durations', () => {
    expect(formatDuration(0.4)).toBe('<1 ms');
    expect(formatDuration(42.4)).toBe('42 ms');
    expect(formatDuration(1234)).toBe('1.23 s');
  });

  it('truncates URLs and strings', () => {
    expect(truncateUrl('https://api.example.test/some/path?x=1', 100)).toBe('/some/path?x=1');
    expect(truncateUrl('not a url', 3)).toBe('not…');
    expect(truncateMiddle('abcdefghij', 5)).toBe('ab…ij');
    expect(previewSecret('abcdefghijklmnopqrstuvwxyz', 5)).toBe('abcde…');
    expect(previewSecret('abc', 5)).toBe('abc');
  });

  it('stringifies claim values safely', () => {
    expect(stringifyClaimValue({ a: [1, 2] })).toBe('{"a":[1,2]}');
    expect(stringifyClaimValue('x'.repeat(10), 4)).toBe('xxxx…');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(stringifyClaimValue(circular)).toBe('[object Object]');
  });
});

describe('fingerprintToken', () => {
  it('is stable, hex, and sensitive to single-character changes', () => {
    const a = fingerprintToken('abc.def.ghi');
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprintToken('abc.def.ghi')).toBe(a);
    expect(fingerprintToken('abc.def.ghj')).not.toBe(a);
    expect(fingerprintToken('')).toMatch(/^[0-9a-f]{16}$/);
  });
});
