/**
 * Sanitizes an untrusted post-login internal redirect target.
 * Defends against open redirects including backslash-prefixed paths (/\\evil.example,
 * CVE-2025-68470 / GHSA-wrjc-x8rr-h8h6), protocol-relative URLs (//evil.example),
 * control characters, and external origins.
 */
function containsControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function sanitizeInternalRedirectPath(rawFrom: unknown): string {
  if (typeof rawFrom !== 'string') {
    return '/';
  }

  const trimmed = rawFrom.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 512 ||
    !trimmed.startsWith('/') ||
    trimmed.startsWith('//') ||
    trimmed.includes('\\') ||
    containsControlCharacters(trimmed)
  ) {
    return '/';
  }

  try {
    const parsed = new URL(trimmed, 'https://staycraft.internal');
    if (
      parsed.origin !== 'https://staycraft.internal' ||
      parsed.hostname !== 'staycraft.internal'
    ) {
      return '/';
    }
    const normalized = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    if (
      normalized === '/login' ||
      normalized.startsWith('/login?') ||
      normalized === '/forgot-password' ||
      normalized.startsWith('/forgot-password?') ||
      normalized === '/reset-password' ||
      normalized.startsWith('/reset-password?')
    ) {
      return '/';
    }
    return normalized;
  } catch {
    return '/';
  }
}
