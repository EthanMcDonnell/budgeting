import type { DB } from './db.ts';
import { listRecurring } from './recurring.ts';
import { listSplits, owedByPayee, suggestPaybacks } from './splits.ts';
import { UserError, listRules, listTransactions, requirePayee, type PayeeKind } from './store.ts';
import { addMonths, currentMonth, isMonth, monthRange } from './util.ts';

/*
 * Reports for the Merchants and People pages. Every transaction linked to a payee counts,
 * whatever its category: money out is what you paid them, money in is what they paid you
 * (refunds from a shop, paybacks from a person).
 */

/** A bank description cut down to the part that names the payee: no times, memos, card or reference numbers. */
export function bankName(description: string) {
  // Beem payments carry only a random reference ("Beem Be.2f3e4d5c6b 9a", "Beem..0b1c2d3e4…").
  if (/^Beem\b/i.test(description)) return 'Beem';
  return description
    .replace(/\s*\([\d.,]+ [A-Z]{3}\)\s*$/, '') // the foreign amount on overseas card purchases: "(7.2 EUR)"
    .replace(/\s+\d{1,2}:\d{2}[AP]M\b.*$/i, '') // "To Riley 06:45AM 08Oct Rent" -> "To Riley"
    // Store numbers and references: words with 2+ digits, or short ones with any ("2b"). Keeps "7-ELEVEN".
    .replace(/(^|\s)(?:\S*\d\S*\d\S*|\S{0,1}\d\S{0,1})(?=\s|$)/g, ' ')
    .replace(/\s+(AUS|AU)$/i, '')
    .replace(/\s+/g, ' ')
    .trim() || description.trim();
}

interface Totals { tx_count: number; out_cents: number; in_cents: number; first_date: string | null; last_date: string | null }

/** Bank names per payee, most frequent first. */
function bankNames(db: DB, payeeId?: number) {
  const rows = db
    .prepare(`SELECT payee_id, description, COUNT(*) AS n, MAX(date) AS last
              FROM transactions WHERE payee_id IS NOT NULL ${payeeId != null ? 'AND payee_id = ?' : ''}
              GROUP BY payee_id, description`)
    .all(...(payeeId != null ? [payeeId] : [])) as { payee_id: number; description: string; n: number; last: string }[];
  const out = new Map<number, Map<string, { name: string; count: number; last_date: string }>>();
  for (const r of rows) {
    const name = bankName(r.description);
    const names = out.get(r.payee_id) ?? out.set(r.payee_id, new Map()).get(r.payee_id)!;
    const e = names.get(name.toUpperCase()) ?? { name, count: 0, last_date: r.last };
    e.count += r.n;
    if (r.last > e.last_date) e.last_date = r.last;
    names.set(name.toUpperCase(), e);
  }
  return new Map([...out].map(([id, names]) => [id, [...names.values()].sort((a, b) => b.count - a.count)]));
}

/** What each person still owes for split bills on the Recurring page, by lowercase contributor name. */
function billsOwed(db: DB) {
  const owed = new Map<string, number>();
  for (const item of listRecurring(db, undefined, { suggestions: false }).items) {
    for (const c of item.contributors) {
      const cents = item.cycles.filter((cy) => cy.bill_paid).flatMap((cy) => cy.shares)
        .filter((s) => s.contributor_id === c.id && (s.status === 'owing' || s.status === 'partial'))
        .reduce((t, s) => t + s.expected_cents - s.paid_cents, 0);
      if (cents > 0) owed.set(c.name.toLowerCase(), (owed.get(c.name.toLowerCase()) ?? 0) + cents);
    }
  }
  return owed;
}

/** Contributor names are usually first names ("Oliver"), people may be fuller ("Oliver Chen"). */
function owedTo(owed: Map<string, number>, payeeName: string) {
  const n = payeeName.toLowerCase();
  let cents = 0;
  for (const [name, c] of owed) if (n === name || n.startsWith(`${name} `)) cents += c;
  return cents;
}

export interface PayeeRow extends Totals {
  id: number; name: string; kind: PayeeKind; notes: string | null;
  category: string | null;
  bank_names: string[];
  patterns: string[];
  month_out_cents: number; month_in_cents: number;
  year_out_cents: number; year_in_cents: number;
  bills_owed_cents: number;
  /** Still owed from shared purchases (splits). */
  split_owed_cents: number;
}

/** Every payee (optionally one kind) with totals for all time, `month`, and the 12 months ending with it. */
export function listPayees(db: DB, opts: { kind?: PayeeKind; month?: string } = {}) {
  const month = opts.month ?? currentMonth();
  if (!isMonth(month)) throw new UserError(`Invalid month "${month}" (expected YYYY-MM)`);
  const { start, end } = monthRange(month);
  const yearStart = monthRange(addMonths(month, -11)).start;
  const rows = db
    .prepare(`SELECT p.id, p.name, p.kind, p.notes,
                COUNT(t.id) AS tx_count, MIN(t.date) AS first_date, MAX(t.date) AS last_date,
                COALESCE(SUM(CASE WHEN t.amount_cents < 0 THEN -t.amount_cents END), 0) AS out_cents,
                COALESCE(SUM(CASE WHEN t.amount_cents > 0 THEN t.amount_cents END), 0) AS in_cents,
                COALESCE(SUM(CASE WHEN t.date >= @start AND t.date < @end AND t.amount_cents < 0 THEN -t.amount_cents END), 0) AS month_out_cents,
                COALESCE(SUM(CASE WHEN t.date >= @start AND t.date < @end AND t.amount_cents > 0 THEN t.amount_cents END), 0) AS month_in_cents,
                COALESCE(SUM(CASE WHEN t.date >= @yearStart AND t.date < @end AND t.amount_cents < 0 THEN -t.amount_cents END), 0) AS year_out_cents,
                COALESCE(SUM(CASE WHEN t.date >= @yearStart AND t.date < @end AND t.amount_cents > 0 THEN t.amount_cents END), 0) AS year_in_cents
              FROM payees p LEFT JOIN transactions t ON t.payee_id = p.id
              WHERE @kind IS NULL OR p.kind = @kind
              GROUP BY p.id ORDER BY p.name`)
    .all({ start, end, yearStart, kind: opts.kind ?? null }) as Omit<PayeeRow, 'category' | 'bank_names' | 'patterns' | 'bills_owed_cents' | 'split_owed_cents'>[];

  // Most common category per payee.
  const cats = db
    .prepare(`SELECT t.payee_id, c.name, COUNT(*) AS n FROM transactions t JOIN categories c ON c.id = t.category_id
              WHERE t.payee_id IS NOT NULL GROUP BY t.payee_id, t.category_id ORDER BY n DESC`)
    .all() as { payee_id: number; name: string; n: number }[];
  const topCat = new Map<number, string>();
  for (const c of cats) if (!topCat.has(c.payee_id)) topCat.set(c.payee_id, c.name);

  const names = bankNames(db);
  const patterns = new Map<number, string[]>();
  for (const r of listRules(db)) if (r.payee_id != null) (patterns.get(r.payee_id) ?? patterns.set(r.payee_id, []).get(r.payee_id)!).push(r.pattern);
  const owed = opts.kind === 'merchant' ? new Map<string, number>() : billsOwed(db);
  const splitOwed = owedByPayee(db);

  const payees: PayeeRow[] = rows.map((r) => ({
    ...r,
    category: topCat.get(r.id) ?? null,
    bank_names: (names.get(r.id) ?? []).map((n) => n.name),
    patterns: patterns.get(r.id) ?? [],
    bills_owed_cents: r.kind === 'person' ? owedTo(owed, r.name) : 0,
    split_owed_cents: splitOwed.get(r.id) ?? 0,
  }));
  return { month, payees };
}

/** One payee in detail: month-by-month totals, categories, bank names, rules and transactions. */
export function payeeDetail(db: DB, id: number, opts: { months?: number; end?: string } = {}) {
  const payee = requirePayee(db, id);
  const endMonth = opts.end ?? currentMonth();
  if (!isMonth(endMonth)) throw new UserError(`Invalid month "${endMonth}"`);
  const months = Math.min(Math.max(Math.trunc(opts.months ?? 24), 1), 120);
  const list = Array.from({ length: months }, (_, i) => addMonths(endMonth, i - months + 1));

  const perMonth = db
    .prepare(`SELECT strftime('%Y-%m', date) AS month,
                COALESCE(SUM(CASE WHEN amount_cents < 0 THEN -amount_cents END), 0) AS out_cents,
                COALESCE(SUM(CASE WHEN amount_cents > 0 THEN amount_cents END), 0) AS in_cents,
                COUNT(*) AS count
              FROM transactions WHERE payee_id = ? AND date >= ? AND date < ? GROUP BY 1`)
    .all(id, `${list[0]}-01`, monthRange(endMonth).end) as { month: string; out_cents: number; in_cents: number; count: number }[];
  const byMonth = new Map(perMonth.map((m) => [m.month, m]));

  const totals = db
    .prepare(`SELECT COUNT(*) AS tx_count, MIN(date) AS first_date, MAX(date) AS last_date,
                COALESCE(SUM(CASE WHEN amount_cents < 0 THEN -amount_cents END), 0) AS out_cents,
                COALESCE(SUM(CASE WHEN amount_cents > 0 THEN amount_cents END), 0) AS in_cents
              FROM transactions WHERE payee_id = ?`)
    .get(id) as Totals;

  const categories = db
    .prepare(`SELECT c.name AS category, c.kind,
                COALESCE(SUM(CASE WHEN t.amount_cents < 0 THEN -t.amount_cents END), 0) AS out_cents,
                COALESCE(SUM(CASE WHEN t.amount_cents > 0 THEN t.amount_cents END), 0) AS in_cents,
                COUNT(*) AS count
              FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
              WHERE t.payee_id = ? GROUP BY t.category_id ORDER BY out_cents + in_cents DESC`)
    .all(id) as { category: string | null; kind: string | null; out_cents: number; in_cents: number; count: number }[];

  const isPerson = payee.kind === 'person';
  const owed = isPerson ? owedTo(billsOwed(db), payee.name) : 0;
  const tx = listTransactions(db, { payee: id, limit: 1000 });

  return {
    ...payee,
    totals: { ...totals, bills_owed_cents: owed, split_owed_cents: isPerson ? owedByPayee(db).get(id) ?? 0 : 0 },
    // Shared purchases they're part of, and their payments that look like paybacks.
    splits: isPerson ? listSplits(db, { payee: id }) : [],
    payback_suggestions: isPerson ? suggestPaybacks(db, { payee: id }) : [],
    months: list.map((m) => ({ month: m, out_cents: byMonth.get(m)?.out_cents ?? 0, in_cents: byMonth.get(m)?.in_cents ?? 0, count: byMonth.get(m)?.count ?? 0 })),
    categories,
    bank_names: bankNames(db, id).get(id) ?? [],
    rules: listRules(db).filter((r) => r.payee_id === id),
    transactions: tx.transactions,
    transaction_count: tx.count,
  };
}
