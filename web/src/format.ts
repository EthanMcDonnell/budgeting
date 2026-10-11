const aud = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });
const audWhole = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', notation: 'compact', maximumFractionDigits: 1 });

/** $1,234.56 */
export const money = (cents: number | null | undefined) => (cents == null ? '—' : aud.format(cents / 100));
/** $1,235 */
export const moneyWhole = (cents: number | null | undefined) => (cents == null ? '—' : audWhole.format(cents / 100));
/**
 * Why a bucket's target moves month to month, or null when it doesn't: "5 × $480 Rent this month (usually $2,080)"
 * for one that follows its recurring payments, "−$260 this month for Rent" for the one balancing them.
 */
export function targetNote(
  b: { schedule: { cents: number; average_cents: number; items: { name: string; each_cents: number; count: number | null }[] } | null; balance_cents: number },
  followers: string[],
) {
  if (b.schedule) {
    const weekly = b.schedule.items.filter((i) => i.count != null);
    if (!weekly.length) return null;
    const usual = b.schedule.cents !== b.schedule.average_cents ? ` (usually ${moneyWhole(b.schedule.average_cents)})` : '';
    return `${weekly.map((i) => `${i.count} × ${moneyWhole(i.each_cents)} ${i.name}`).join(', ')} this month${usual}`;
  }
  if (!b.balance_cents) return null;
  const sign = b.balance_cents < 0 ? '−' : '+';
  return `${sign}${moneyWhole(Math.abs(b.balance_cents))} this month ${b.balance_cents < 0 ? 'for' : 'back from'} ${followers.join(', ') || 'recurring'}`;
}
/** $1.2K, for axis ticks */
export const moneyCompact = (cents: number) => (Math.abs(cents) < 100000 ? audWhole.format(cents / 100) : compact.format(cents / 100));

export function monthLabel(month: string, style: 'long' | 'short' = 'long') {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-AU', { month: style, year: 'numeric' });
}

export function monthShort(month: string) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-AU', { month: 'short' });
}

export function dateLabel(iso: string, withYear = false) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) });
}

export function addMonths(month: string, delta: number) {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

export function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function todayIso() {
  const d = new Date();
  return `${thisMonth()}-${String(d.getDate()).padStart(2, '0')}`;
}

export const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/** A percentage for display and editing: up to one decimal place, no trailing ".0". */
export const percentText = (v: number | null | undefined) => (v == null ? '' : String(Math.round(v * 10) / 10));
