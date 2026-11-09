import { format, formatDistanceStrict } from 'date-fns';

export function formatTimestamp(ts: number): string {
  try {
    return format(ts, 'HH:mm:ss');
  } catch {
    return '--:--:--';
  }
}

export function formatDateTime(ts: number): string {
  try {
    return format(ts, 'MMM dd, yyyy, HH:mm:ss');
  } catch {
    return 'Invalid date';
  }
}

export function formatRelativeTime(ts: number, now: number): string {
  try {
    return formatDistanceStrict(ts, now, { addSuffix: true });
  } catch {
    return 'unknown';
  }
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatCompactCountdown(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function formatExpiryCompact(expiresAt: number | null, now: number): string {
  if (expiresAt === null) return 'No expiry';
  const diff = expiresAt - now;
  if (diff <= 0) return `Expired ${formatCompactCountdown(-diff)} ago`;
  return `Expires in ${formatCompactCountdown(diff)}`;
}

export function truncateUrl(url: string, maxLen = 60): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    return path.length > maxLen ? `${path.slice(0, maxLen)}…` : path;
  } catch {
    return url.length > maxLen ? `${url.slice(0, maxLen)}…` : url;
  }
}

export function truncateMiddle(str: string, maxLen = 40): string {
  if (str.length <= maxLen) return str;
  const half = Math.floor((maxLen - 1) / 2);
  return `${str.slice(0, half)}…${str.slice(-half)}`;
}

/** Short, non-reversible preview of a credential for display. Never shows more than a prefix. */
export function previewSecret(raw: string, visibleChars = 12): string {
  if (raw.length <= visibleChars) return raw;
  return `${raw.slice(0, visibleChars)}…`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function stringifyClaimValue(value: unknown, maxLen = 400): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}
