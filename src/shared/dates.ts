const ISO_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidIsoDate(dateStr: string): boolean {
  const match = ISO_DATE_REGEX.exec(dateStr);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

export function isValidTimezone(tz: string): boolean {
  if (!tz || typeof tz !== 'string') return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function getPropertyLocalDate(timezone: string, referenceDate: Date = new Date()): string {
  const safeTz = isValidTimezone(timezone) ? timezone : 'UTC';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(referenceDate);

  const year = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

export function toUtcMidnightMs(isoDate: string): number {
  const match = ISO_DATE_REGEX.exec(isoDate);
  if (!match) {
    throw new Error(`Invalid ISO date: ${isoDate}`);
  }
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function diffDays(arrivalDate: string, departureDate: string): number {
  const msPerDay = 86_400_000;
  return Math.round((toUtcMidnightMs(departureDate) - toUtcMidnightMs(arrivalDate)) / msPerDay);
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(toUtcMidnightMs(isoDate) + days * 86_400_000);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Checks half-open interval overlap [aStart, aEnd) && [bStart, bEnd).
 * Arrival is inclusive; departure is exclusive.
 */
export function rangesOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function formatDisplayDate(isoDate: string): string {
  if (!isValidIsoDate(isoDate)) return isoDate;
  const d = new Date(toUtcMidnightMs(isoDate));
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(d);
}
