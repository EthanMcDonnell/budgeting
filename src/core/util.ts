export function toCents(dollars: number): number {
  if (!Number.isFinite(dollars)) throw new Error(`Invalid amount: ${dollars}`);
  return Math.round(dollars * 100);
}

export function fromCents(cents: number): number {
  return cents / 100;
}

/** Parses "$1,234.50", "(12.00)", "-12", "12.00 DR" style strings. Returns null for blanks. */
export function parseMoney(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (/\bDR$/i.test(s)) { negative = true; s = s.replace(/\s*DR$/i, ''); }
  s = s.replace(/\s*CR$/i, '');
  s = s.replace(/[$,\s]/g, '');
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1); }
  if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  return negative ? -n : n;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function validYmd(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * Normalises a date to YYYY-MM-DD. Accepts ISO dates, Australian day-first
 * dates (DD/MM/YYYY, DD-MM-YY) and "12 Oct 2026" / "12 October 2026".
 */
export function normalizeDate(raw: string): string | null {
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return validYmd(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return validYmd(y, +m[2], +m[1]);
  }
  m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3})[A-Za-z]*[\s-]+(\d{2}|\d{4})$/);
  if (m) {
    const mi = MONTHS.indexOf(m[2].toLowerCase());
    if (mi < 0) return null;
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return validYmd(y, mi + 1, +m[1]);
  }
  return null;
}

export function isMonth(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

export function todayIso(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function currentMonth(now = new Date()): string {
  return todayIso(now).slice(0, 7);
}

export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}`;
}

/** A YYYY-MM-DD date moved by `delta` days. */
export function addDays(date: string, delta: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

export function monthRange(month: string): { start: string; end: string } {
  return { start: `${month}-01`, end: `${addMonths(month, 1)}-01` };
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Uppercased, punctuation-collapsed description used for duplicate detection. */
export function normalizeDescription(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

const STAMP = /\b\d{1,2}:\d{2}[AP]M\s+\d{1,2}[A-Za-z]{3}\b\s*(.*)$/i;
/** Bank defaults that aren't a message anyone wrote. */
const FILLER = /^(credit to account|transfer|t)$/i;

/**
 * The message someone wrote on a transfer, as the bank shows it: the text after the bank's time stamp
 * ("MR JAMES SMITH To Phone 09:05AM 27Sep Breakfast" -> "Breakfast"), or after the sender's name when
 * there's no stamp ("MARGARET HILL Router" -> "Router", given "MARGARET HILL"). Beem payments carry
 * only a reference, so their message has to come from the Beem app. Null when there's none.
 */
export function memoFrom(description: string, names: string[] = []): string | null {
  if (/^beem\b/i.test(description)) return null;
  let rest: string | null = null;
  const stamped = description.match(STAMP);
  if (stamped) rest = stamped[1];
  else {
    const upper = description.toUpperCase();
    for (const name of [...names].filter((n) => n.trim()).sort((a, b) => b.length - a.length)) {
      const at = upper.indexOf(name.toUpperCase());
      // The name opens the description (allowing "Mr", "To" and the like before it).
      if (at >= 0 && at <= 3) { rest = description.slice(at + name.length); break; }
    }
  }
  if (rest == null) return null;
  rest = rest.replace(/^\s*to phone\b/i, '').replace(/\s+/g, ' ').trim();
  return rest && !FILLER.test(rest) && /[a-z]{2}/i.test(rest) ? rest : null;
}
