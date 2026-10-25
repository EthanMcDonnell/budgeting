import type { DB } from './db.ts';
import { addDays } from './util.ts';

/**
 * Which dates each account's imports cover, and the gaps between them. A gap where the running balances still chain
 * (the balance after the last transaction before it, plus anything stored inside it, is the balance before the first
 * transaction after it) had no activity, so it counts as covered. Otherwise it's reported: with the amount missing when
 * the bank gave balances, or unchecked when it didn't (Up's export, most PDFs).
 */

export interface CoverageGap {
  from: string;
  to: string;
  /** Net amount the balances say is missing; null when there are no balances to check. */
  missing_cents: number | null;
}

export interface AccountCoverage {
  account_id: number;
  account: string;
  /** Covered date ranges, oldest first. Gaps the balances show were quiet are merged in. */
  segments: { start: string; end: string }[];
  gaps: CoverageGap[];
  covered_to: string | null;
  /** Where the next export should start so nothing is missed (it can start earlier: duplicates are skipped). */
  next_export_from: string | null;
}

export function coverage(db: DB): AccountCoverage[] {
  const accounts = db.prepare(`SELECT id, name FROM accounts WHERE id IN (SELECT account_id FROM imports) ORDER BY name`)
    .all() as { id: number; name: string }[];
  return accounts.map((a) => accountCoverage(db, a.id, a.name));
}

export function accountCoverage(db: DB, accountId: number, name?: string): AccountCoverage {
  const account = name ?? (db.prepare('SELECT name FROM accounts WHERE id = ?').get(accountId) as { name: string }).name;
  const spans = (db.prepare(`SELECT period_start, period_end, pending_from FROM imports
                             WHERE account_id = ? AND period_start IS NOT NULL ORDER BY period_start`)
    .all(accountId) as { period_start: string; period_end: string; pending_from: string | null }[])
    .map(coveredSpan).filter((s) => s.end >= s.start).sort((a, b) => a.start.localeCompare(b.start));

  const segments: { start: string; end: string }[] = [];
  const gaps: CoverageGap[] = [];
  for (const s of spans) {
    const last = segments.at(-1);
    if (last && s.start <= addDays(last.end, 1)) {
      if (s.end > last.end) last.end = s.end;
      continue;
    }
    if (last) {
      const gap = { from: addDays(last.end, 1), to: addDays(s.start, -1) };
      const missing = missingAcross(db, accountId, gap.from, gap.to);
      if (missing === 0) { last.end = s.end; continue; }
      gaps.push({ ...gap, missing_cents: missing });
    }
    segments.push({ ...s });
  }
  const coveredTo = segments.at(-1)?.end ?? null;
  return { account_id: accountId, account, segments, gaps, covered_to: coveredTo, next_export_from: coveredTo && addDays(coveredTo, 1) };
}

/** The days an import covers: its period, up to the day before its earliest pending authorisation. */
export function coveredSpan(i: { period_start: string; period_end: string; pending_from: string | null }) {
  const end = i.pending_from && i.pending_from <= i.period_end ? addDays(i.pending_from, -1) : i.period_end;
  return { start: i.period_start, end };
}

type BalanceRow = { amount_cents: number; balance_cents: number | null };

/** Cents the running balances say are missing between `from` and `to`, or null when they can't tell. */
function missingAcross(db: DB, accountId: number, from: string, to: string): number | null {
  const before = (db.prepare('SELECT MAX(date) AS d FROM transactions WHERE account_id = ? AND date < ?').get(accountId, from) as { d: string | null }).d;
  const after = (db.prepare('SELECT MIN(date) AS d FROM transactions WHERE account_id = ? AND date > ?').get(accountId, to) as { d: string | null }).d;
  if (!before || !after) return null;
  const day = db.prepare('SELECT amount_cents, balance_cents FROM transactions WHERE account_id = ? AND date = ?');
  const close = closing(day.all(accountId, before) as BalanceRow[]);
  const open = opening(day.all(accountId, after) as BalanceRow[]);
  if (close == null || open == null) return null;
  const inside = (db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS s FROM transactions WHERE account_id = ? AND date > ? AND date < ?')
    .get(accountId, before, after) as { s: number }).s;
  return open - close - inside;
}

// A day's rows can be in any order, so follow the balances: the last row is the one no other row starts from,
// and the first is the one whose starting balance no other row ends on.
function closing(rows: BalanceRow[]): number | null {
  if (rows.some((r) => r.balance_cents == null)) return null;
  const ends = rows.filter((r) => !rows.some((s) => s !== r && s.balance_cents! - s.amount_cents === r.balance_cents));
  return ends.length === 1 ? ends[0].balance_cents : null;
}

function opening(rows: BalanceRow[]): number | null {
  if (rows.some((r) => r.balance_cents == null)) return null;
  const starts = rows.filter((r) => !rows.some((s) => s !== r && s.balance_cents === r.balance_cents! - r.amount_cents));
  return starts.length === 1 ? starts[0].balance_cents! - starts[0].amount_cents : null;
}
