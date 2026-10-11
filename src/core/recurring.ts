import type { DB } from './db.ts';
import { UserError, compileRules, listRules, matchRule, requireCategory } from './store.ts';
import { monthRange, toCents, todayIso } from './util.ts';

export type Frequency = 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'yearly';
export const FREQUENCIES: Frequency[] = ['weekly', 'fortnightly', 'monthly', 'quarterly', 'yearly'];

/** Multiply a per-payment amount by this to get a per-month figure. */
const PER_MONTH: Record<Frequency, number> = { weekly: 52 / 12, fortnightly: 26 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 };
/** Bills this far apart are spread across the months between them in budgets, not counted in the month they're paid. */
export const SPREAD: Frequency[] = ['quarterly', 'yearly'];
/** Days of slack after a due date before calling it overdue (banks post a few days late). */
const GRACE: Record<Frequency, number> = { weekly: 2, fortnightly: 3, monthly: 5, quarterly: 7, yearly: 10 };
/** Gap ranges (days) between payments that count as each frequency, used to spot recurring payments. */
const GAPS: Record<Frequency, [number, number]> = {
  weekly: [5, 9], fortnightly: [12, 16], monthly: [26, 35], quarterly: [80, 100], yearly: [350, 380],
};

export interface RecurringRow {
  id: number; name: string; pattern: string; match_type: 'contains' | 'regex';
  frequency: Frequency; expected_cents: number | null; active: number; category_id: number | null; created_at: string;
}

// ---------- dates ----------

const DAY = 86_400_000;
const toTime = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const fromTime = (t: number) => new Date(t).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((toTime(b) - toTime(a)) / DAY);

function addMonthsToDate(iso: string, months: number) {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return fromTime(target.getTime());
}

export function nextDate(iso: string, f: Frequency) {
  switch (f) {
    case 'weekly': return fromTime(toTime(iso) + 7 * DAY);
    case 'fortnightly': return fromTime(toTime(iso) + 14 * DAY);
    case 'monthly': return addMonthsToDate(iso, 1);
    case 'quarterly': return addMonthsToDate(iso, 3);
    case 'yearly': return addMonthsToDate(iso, 12);
  }
}

// ---------- CRUD ----------

function matcher(pattern: string, matchType: 'contains' | 'regex') {
  const [c] = compileRules([{ id: 0, pattern, match_type: matchType, category_id: null, category: null, payee_id: null, merchant: null, payee_kind: null }]);
  if (!c) throw new UserError(`Invalid pattern: ${pattern}`);
  return c.test;
}

export function getRecurring(db: DB, ref: number | string): RecurringRow {
  const row = (typeof ref === 'number'
    ? db.prepare('SELECT * FROM recurring WHERE id = ?').get(ref)
    : db.prepare('SELECT * FROM recurring WHERE name = ? COLLATE NOCASE').get(ref.trim())) as RecurringRow | undefined;
  if (!row) throw new UserError(`Unknown recurring item: ${ref}`);
  return row;
}

export interface ContributorInput {
  id?: number;
  name: string;
  /** Text in their incoming payment's description, e.g. "OLIVER CHEN" or "Monthly Internet". */
  pattern: string;
  match_type?: 'contains' | 'regex';
  /** Dollars they cover per bill; null/omitted = an even split. */
  share_amount?: number | null;
}

export interface ContributorRow {
  id: number; recurring_id: number; name: string; pattern: string; match_type: 'contains' | 'regex'; share_cents: number | null;
}

export interface RecurringInput {
  name: string; pattern: string; match_type?: 'contains' | 'regex'; frequency: Frequency;
  /** Dollars per payment; null/omitted = work it out from recent payments. */
  expected_amount?: number | null;
  /** Category its bills are filed under; null/omitted = whichever its payments are in. */
  category?: string | null;
  /** People who chip in. When given, replaces the item's current list. */
  contributors?: ContributorInput[];
}

function validate(input: Partial<RecurringInput>) {
  if (input.frequency && !FREQUENCIES.includes(input.frequency)) throw new UserError(`Frequency must be one of ${FREQUENCIES.join(', ')}`);
  if (input.pattern != null) {
    if (!input.pattern.trim()) throw new UserError('Match text is required');
    matcher(input.pattern.trim(), input.match_type ?? 'contains');
  }
  if (input.expected_amount != null && (!Number.isFinite(input.expected_amount) || input.expected_amount < 0)) {
    throw new UserError('Expected amount must be zero or more');
  }
  const names = new Set<string>();
  for (const c of input.contributors ?? []) {
    if (!c.name?.trim()) throw new UserError('Each person needs a name');
    if (!c.pattern?.trim()) throw new UserError(`Enter text from ${c.name.trim()}'s payments`);
    matcher(c.pattern.trim(), c.match_type ?? 'contains');
    if (c.share_amount != null && (!Number.isFinite(c.share_amount) || c.share_amount < 0)) throw new UserError('Shares must be zero or more');
    const key = c.name.trim().toLowerCase();
    if (names.has(key)) throw new UserError(`${c.name.trim()} is listed twice`);
    names.add(key);
  }
}

/** A category name to its id: undefined when not given, null to clear. */
function categoryRef(db: DB, name: string | null | undefined) {
  if (name === undefined) return undefined;
  return name == null || !name.trim() ? null : requireCategory(db, name.trim()).id;
}

export function listContributors(db: DB, recurringId: number): ContributorRow[] {
  return db.prepare('SELECT * FROM recurring_contributors WHERE recurring_id = ? ORDER BY id').all(recurringId) as ContributorRow[];
}

/** Replaces an item's contributors, keeping ids (and so payment links) for people that stay. */
function syncContributors(db: DB, recurringId: number, list: ContributorInput[]) {
  const existing = listContributors(db, recurringId);
  const keep = new Set<number>();
  const upd = db.prepare('UPDATE recurring_contributors SET name = ?, pattern = ?, match_type = ?, share_cents = ? WHERE id = ?');
  const ins = db.prepare('INSERT INTO recurring_contributors (recurring_id, name, pattern, match_type, share_cents) VALUES (?, ?, ?, ?, ?)');
  // Free up names first so renames/swaps don't trip the UNIQUE constraint.
  db.prepare("UPDATE recurring_contributors SET name = '~' || id WHERE recurring_id = ?").run(recurringId);
  for (const c of list) {
    const match = existing.find((e) => (c.id != null && e.id === c.id) || e.name.toLowerCase() === c.name.trim().toLowerCase());
    const share = c.share_amount == null ? null : toCents(c.share_amount);
    if (match && !keep.has(match.id)) {
      upd.run(c.name.trim(), c.pattern.trim(), c.match_type ?? 'contains', share, match.id);
      keep.add(match.id);
      // A changed pattern re-matches their payments from scratch.
      if (match.pattern !== c.pattern.trim() || match.match_type !== (c.match_type ?? 'contains')) {
        db.prepare('UPDATE transactions SET contributor_id = NULL, recurring_id = NULL WHERE contributor_id = ?').run(match.id);
      }
    } else {
      ins.run(recurringId, c.name.trim(), c.pattern.trim(), c.match_type ?? 'contains', share);
    }
  }
  for (const e of existing) {
    if (keep.has(e.id)) continue;
    // Their payments stop counting towards this bill.
    db.prepare('UPDATE transactions SET recurring_id = NULL WHERE contributor_id = ?').run(e.id);
    db.prepare('DELETE FROM recurring_contributors WHERE id = ?').run(e.id);
  }
}

/** Creates an item and links matching past transactions to it. */
export function createRecurring(db: DB, input: RecurringInput) {
  const name = input.name?.trim();
  if (!name) throw new UserError('Name is required');
  if (!input.frequency) throw new UserError('Frequency is required');
  validate(input);
  if (db.prepare('SELECT 1 FROM recurring WHERE name = ? COLLATE NOCASE').get(name)) throw new UserError(`"${name}" already exists`);
  return db.transaction(() => {
    const id = Number(db.prepare('INSERT INTO recurring (name, pattern, match_type, frequency, expected_cents, category_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, input.pattern.trim(), input.match_type ?? 'contains', input.frequency,
        input.expected_amount == null ? null : toCents(input.expected_amount), categoryRef(db, input.category) ?? null).lastInsertRowid);
    if (input.contributors) syncContributors(db, id, input.contributors);
    const linked = linkRecurring(db);
    return { item: getRecurring(db, id), linked };
  })();
}

export function updateRecurring(db: DB, id: number, patch: Partial<RecurringInput> & { active?: boolean }) {
  const cur = getRecurring(db, id);
  validate({ ...patch, match_type: patch.match_type ?? cur.match_type });
  const name = patch.name?.trim() || cur.name;
  if (name.toLowerCase() !== cur.name.toLowerCase() && db.prepare('SELECT 1 FROM recurring WHERE name = ? COLLATE NOCASE').get(name)) {
    throw new UserError(`"${name}" already exists`);
  }
  const pattern = patch.pattern?.trim() || cur.pattern;
  const matchType = patch.match_type ?? cur.match_type;
  const category = categoryRef(db, patch.category);
  return db.transaction(() => {
    db.prepare('UPDATE recurring SET name = ?, pattern = ?, match_type = ?, frequency = ?, expected_cents = ?, active = ?, category_id = ? WHERE id = ?').run(
      name, pattern, matchType, patch.frequency ?? cur.frequency,
      patch.expected_amount === undefined ? cur.expected_cents : patch.expected_amount == null ? null : toCents(patch.expected_amount),
      patch.active == null ? cur.active : Number(patch.active), category === undefined ? cur.category_id : category, id,
    );
    // A new pattern re-matches: drop bill links the old pattern made that no longer fit.
    if (pattern !== cur.pattern || matchType !== cur.match_type) {
      const test = matcher(pattern, matchType);
      const rows = db.prepare('SELECT id, description FROM transactions WHERE recurring_id = ? AND amount_cents < 0').all(id) as { id: number; description: string }[];
      const unlink = db.prepare('UPDATE transactions SET recurring_id = NULL WHERE id = ?');
      for (const r of rows) if (!test(r.description)) unlink.run(r.id);
    }
    if (patch.contributors) syncContributors(db, id, patch.contributors);
    const linked = linkRecurring(db);
    return { item: getRecurring(db, id), linked };
  })();
}

export function deleteRecurring(db: DB, id: number) {
  getRecurring(db, id);
  db.prepare('DELETE FROM recurring WHERE id = ?').run(id); // links are cleared by ON DELETE SET NULL
}

/** The category most of an item's bill payments are in, used to file contributors' payments alongside. */
function billCategory(db: DB, recurringId: number): number | null {
  const own = db.prepare('SELECT category_id FROM recurring WHERE id = ?').get(recurringId) as { category_id: number | null } | undefined;
  if (own?.category_id != null) return own.category_id;
  const r = db.prepare(`SELECT category_id FROM transactions WHERE recurring_id = ? AND amount_cents < 0 AND category_id IS NOT NULL
    GROUP BY category_id ORDER BY COUNT(*) DESC, MAX(date) DESC LIMIT 1`).get(recurringId) as { category_id: number } | undefined;
  return r?.category_id ?? null;
}

/**
 * Links transactions (all, or only `ids`) to recurring items: money out matching an item's pattern is a bill
 * payment; money in matching a contributor's pattern is their share, filed under the bill's category.
 */
export function linkRecurring(db: DB, ids?: number[]): number {
  const only = ids ? new Set(ids) : null;
  let n = 0;

  const items = (db.prepare('SELECT * FROM recurring WHERE active = 1').all() as RecurringRow[])
    .map((r) => ({ id: r.id, category: r.category_id, test: matcher(r.pattern, r.match_type), len: r.pattern.length }))
    .sort((a, b) => b.len - a.len);
  if (items.length) {
    const bills = db.prepare('SELECT id, description FROM transactions WHERE recurring_id IS NULL AND amount_cents < 0').all() as { id: number; description: string }[];
    // An item with its own category files uncategorised bills under it.
    const upd = db.prepare(`UPDATE transactions SET recurring_id = ?, category_id = COALESCE(category_id, ?),
      categorized_by = CASE WHEN category_id IS NULL AND ? IS NOT NULL THEN 'rule' ELSE categorized_by END WHERE id = ?`);
    for (const r of bills) {
      if (only && !only.has(r.id)) continue;
      const hit = items.find((i) => i.test(r.description));
      if (hit) { upd.run(hit.id, hit.category, hit.category, r.id); n++; }
    }
  }

  const people = (db.prepare(`SELECT c.* FROM recurring_contributors c JOIN recurring r ON r.id = c.recurring_id WHERE r.active = 1`).all() as ContributorRow[])
    .map((c) => ({ ...c, test: matcher(c.pattern, c.match_type) }))
    .sort((a, b) => b.pattern.length - a.pattern.length);
  if (people.length) {
    const credits = db.prepare(`SELECT id, description, recurring_id FROM transactions
      WHERE amount_cents > 0 AND contributor_id IS NULL`).all() as { id: number; description: string; recurring_id: number | null }[];
    const upd = db.prepare(`UPDATE transactions SET recurring_id = ?, contributor_id = ?,
      category_id = COALESCE(?, category_id), categorized_by = CASE WHEN ? IS NULL THEN categorized_by ELSE 'rule' END WHERE id = ?`);
    const cats = new Map<number, number | null>();
    for (const r of credits) {
      if (only && !only.has(r.id)) continue;
      // A payment already linked by hand to an item only matches that item's people.
      const hit = people.find((p) => (r.recurring_id == null || r.recurring_id === p.recurring_id) && p.test(r.description));
      if (!hit) continue;
      if (!cats.has(hit.recurring_id)) cats.set(hit.recurring_id, billCategory(db, hit.recurring_id));
      const cat = cats.get(hit.recurring_id)!;
      upd.run(hit.recurring_id, hit.id, cat, cat, r.id);
      n++;
    }
  }
  return n;
}

/** How many transactions a pattern would match, with a few examples (for the editor). */
export function previewPattern(db: DB, pattern: string, matchType: 'contains' | 'regex' = 'contains') {
  if (!pattern.trim()) return { count: 0, examples: [] };
  let test: (d: string) => boolean;
  try { test = matcher(pattern.trim(), matchType); } catch { return { count: 0, examples: [], error: 'Invalid pattern' }; }
  const rows = (db.prepare('SELECT date, description, amount_cents FROM transactions ORDER BY date DESC').all() as
    { date: string; description: string; amount_cents: number }[]).filter((r) => test(r.description));
  return { count: rows.length, examples: rows.slice(0, 5) };
}

// ---------- status ----------

export type RecurringStatus = 'overdue' | 'due_soon' | 'upcoming' | 'awaiting_data' | 'no_payments' | 'inactive';

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2)) : 0;
}

export function listRecurring(db: DB, today = todayIso(), { suggestions = true } = {}) {
  const items = db.prepare('SELECT * FROM recurring ORDER BY name').all() as RecurringRow[];
  const dataThrough = (db.prepare('SELECT MAX(date) AS d FROM transactions').get() as { d: string | null }).d;
  const txStmt = db.prepare(`SELECT t.id, t.date, t.description, p.name AS merchant, t.amount_cents, t.contributor_id,
      a.name AS account, c.name AS category
    FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN payees p ON p.id = t.payee_id
    WHERE t.recurring_id = ? ORDER BY t.date DESC, t.id DESC`);
  const categoryName = db.prepare('SELECT name FROM categories WHERE id = ?');

  const result = items.map((item) => {
    const txs = txStmt.all(item.id) as {
      id: number; date: string; description: string; merchant: string | null; amount_cents: number;
      contributor_id: number | null; account: string; category: string | null;
    }[];
    const payments = txs.filter((t) => t.amount_cents < 0);
    const credits = txs.filter((t) => t.amount_cents > 0);
    const last = payments[0] ?? null;
    const previous = payments[1] ?? null;
    const typical = item.expected_cents ?? (payments.length ? median(payments.slice(0, 3).map((p) => -p.amount_cents)) : null);
    const nextDue = last ? nextDate(last.date, item.frequency) : null;

    let status: RecurringStatus = 'upcoming';
    let daysOverdue = 0;
    if (!item.active) status = 'inactive';
    else if (!nextDue) status = 'no_payments';
    else {
      const late = daysBetween(nextDue, today);
      const dataPastDue = !!dataThrough && daysBetween(nextDue, dataThrough) > GRACE[item.frequency];
      if (late > GRACE[item.frequency]) {
        // Only call it overdue once imported data runs past the due date; otherwise it may just not be imported yet.
        status = dataPastDue ? 'overdue' : 'awaiting_data';
        daysOverdue = late;
      } else if (late >= -(item.frequency === 'weekly' ? 2 : 7)) status = 'due_soon';
    }

    // Its own category, or the most common one among its transactions, for grouping.
    const cats = new Map<string, number>();
    for (const t of payments) if (t.category) cats.set(t.category, (cats.get(t.category) ?? 0) + 1);
    const own = item.category_id == null ? undefined : categoryName.get(item.category_id) as { name: string } | undefined;
    const category = own?.name ?? [...cats.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    const since = fromTime(toTime(today) - 90 * DAY);
    const split = splitBill(item, typical, payments, nextDue, txs, listContributors(db, item.id));
    return {
      ...item,
      category,
      typical_cents: typical,
      monthly_cents: typical == null ? null : Math.round(typical * PER_MONTH[item.frequency]),
      ...split,
      your_monthly_cents: split.your_share_cents == null ? null : Math.round(split.your_share_cents * PER_MONTH[item.frequency]),
      last_paid: last ? { date: last.date, amount_cents: -last.amount_cents } : null,
      change_cents: last && previous ? -last.amount_cents - -previous.amount_cents : null,
      next_due: nextDue,
      days_until_due: nextDue ? daysBetween(today, nextDue) : null,
      days_overdue: daysOverdue,
      status,
      paid_recently: !!last && daysBetween(last.date, today) <= 3,
      payment_count: payments.length,
      credits_90d_cents: credits.filter((c) => c.date >= since).reduce((s, c) => s + c.amount_cents, 0),
      contributors_90d_cents: credits.filter((c) => c.date >= since && c.contributor_id != null).reduce((s, c) => s + c.amount_cents, 0),
      history: txs.slice(0, 12), history_count: txs.length,
    };
  });

  const active = result.filter((r) => r.active);
  return {
    data_through: dataThrough,
    monthly_total_cents: active.reduce((s, r) => s + (r.monthly_cents ?? 0), 0),
    your_monthly_total_cents: active.reduce((s, r) => s + (r.your_monthly_cents ?? 0), 0),
    owed_to_you_cents: active.reduce((s, r) => s + r.owed_to_you_cents, 0),
    items: result,
    suggestions: suggestions ? suggestRecurring(db) : [],
  };
}

/**
 * Recurring payments still to come in a month: each active item's due dates from its next one to the month's end,
 * at your share (after anyone chipping in). Past months have none; a future month gets every due date in it.
 */
export function upcomingInMonth(db: DB, month: string, today = todayIso()) {
  const { start, end } = monthRange(month);
  const out: { id: number; name: string; category: string | null; each_cents: number; dates: string[]; cents: number }[] = [];
  const items = listRecurring(db, today, { suggestions: false }).items;
  // Spread bills are already counted every month, so their due dates aren't still to come.
  const spread = new Set(spreadOf(db, items).map((s) => s.id));
  for (const r of items) {
    const each = r.your_share_cents ?? r.typical_cents;
    if (!r.active || !r.next_due || !each || spread.has(r.id)) continue;
    const dates: string[] = [];
    for (let d = r.next_due; d < end; d = nextDate(d, r.frequency)) if (d >= start) dates.push(d);
    if (dates.length) out.push({ id: r.id, name: r.name, category: r.category, each_cents: each, dates, cents: each * dates.length });
  }
  return out;
}

/**
 * What each active recurring item costs you in a month: your share × its payments that month for weekly and
 * fortnightly items (four or five rent Thursdays), and the monthly average for the rest (monthly bills, and the
 * spread part of quarterly and yearly ones). `average_cents` is the usual month: rent of $480 a week averages
 * $480 × 52 ÷ 12 = $2,080. Items with no amount yet are left out.
 */
export function scheduledInMonth(db: DB, month: string, today = todayIso()) {
  const { start, end } = monthRange(month);
  const out: { id: number; name: string; category: string | null; each_cents: number; count: number | null; cents: number; average_cents: number }[] = [];
  for (const r of listRecurring(db, today, { suggestions: false }).items) {
    const each = r.your_share_cents ?? r.typical_cents;
    if (!r.active || !each) continue;
    const average = Math.round(each * PER_MONTH[r.frequency]);
    const anchor = r.last_paid?.date ?? r.next_due;
    let count: number | null = null;
    if (anchor && (r.frequency === 'weekly' || r.frequency === 'fortnightly')) {
      const step = (r.frequency === 'weekly' ? 7 : 14) * DAY;
      let t = toTime(anchor);
      while (t >= toTime(start)) t -= step;
      count = 0;
      for (t += step; t < toTime(end); t += step) if (t >= toTime(start)) count++;
    }
    out.push({ id: r.id, name: r.name, category: r.category, each_cents: each, count, cents: count == null ? average : each * count, average_cents: average });
  }
  return out;
}

export interface SpreadBill { id: number; category_id: number; monthly_cents: number; from: string }

/**
 * Quarterly and yearly bills, spread across the months between them: each month their category counts your
 * monthly part (your share of a bill × 1/3 or 1/12) from the month of the first bill or when it was added,
 * whichever is earlier, in place of the bills themselves and housemates' payments towards them.
 * Only active items with a category and an amount are spread.
 */
export function spreadBills(db: DB, today = todayIso()): SpreadBill[] {
  return spreadOf(db, listRecurring(db, today, { suggestions: false }).items);
}

function spreadOf(db: DB, items: ReturnType<typeof listRecurring>['items']): SpreadBill[] {
  const first = db.prepare('SELECT MIN(date) AS d FROM transactions WHERE recurring_id = ? AND amount_cents < 0');
  const out: SpreadBill[] = [];
  for (const r of items) {
    if (!r.active || !SPREAD.includes(r.frequency)) continue;
    const category = billCategory(db, r.id);
    const each = r.your_share_cents ?? r.typical_cents;
    if (category == null || !each) continue;
    const firstBill = (first.get(r.id) as { d: string | null }).d;
    const added = r.created_at.slice(0, 10);
    const from = (firstBill != null && firstBill < added ? firstBill : added).slice(0, 7);
    out.push({ id: r.id, category_id: category, monthly_cents: Math.round(each * PER_MONTH[r.frequency]), from });
  }
  return out;
}

// ---------- splitting with other people ----------

export type ShareStatus = 'paid' | 'partial' | 'owing' | 'waiting';

/**
 * Works out each person's share, and for recent bills whether they've paid it. Each incoming payment from a
 * person is matched to the nearest bill (past or upcoming) that doesn't already have one from them, since
 * housemates pay a little before or after the bill itself.
 */
function splitBill(
  item: RecurringRow,
  typical: number | null,
  payments: { date: string; amount_cents: number }[],
  nextDue: string | null,
  txs: { date: string; amount_cents: number; contributor_id: number | null }[],
  people: ContributorRow[],
) {
  const evenShare = typical == null ? null : Math.round(typical / (people.length + 1));
  const contributors = people.map((p) => ({
    id: p.id, name: p.name, pattern: p.pattern, match_type: p.match_type,
    share_cents: p.share_cents ?? evenShare, custom_share: p.share_cents != null,
  }));
  const othersShare = contributors.reduce((s, c) => s + (c.share_cents ?? 0), 0);
  const yourShare = typical == null ? null : Math.max(typical - othersShare, 0);

  // Every bill, newest first, starting with the upcoming one, so older shares can still be checked.
  const bills: { date: string; paid: boolean; amount_cents: number | null }[] = [];
  if (nextDue && item.active) bills.push({ date: nextDue, paid: false, amount_cents: null });
  for (const p of payments) bills.push({ date: p.date, paid: true, amount_cents: -p.amount_cents });

  const window = { weekly: 7, fortnightly: 14, monthly: 31, quarterly: 92, yearly: 366 }[item.frequency];
  const assigned = bills.map(() => new Map<number, { cents: number; date: string }>());
  for (const c of contributors) {
    const theirs = txs.filter((t) => t.contributor_id === c.id && t.amount_cents > 0).sort((a, b) => a.date.localeCompare(b.date));
    for (const t of theirs) {
      const order = bills.map((b, i) => ({ i, d: Math.abs(daysBetween(b.date, t.date)) }))
        .filter((x) => x.d <= window).sort((a, b) => a.d - b.d || a.i - b.i);
      const slot = order.find((x) => !assigned[x.i].has(c.id)) ?? order[0];
      if (!slot) continue;
      const prev = assigned[slot.i].get(c.id);
      assigned[slot.i].set(c.id, { cents: (prev?.cents ?? 0) + t.amount_cents, date: t.date });
    }
  }

  // Only chase shares from bills since each person started paying (or the latest bill if they never have).
  const firstPaid = new Map(contributors.map((c) => [c.id, txs.filter((t) => t.contributor_id === c.id).map((t) => t.date).sort()[0] ?? null]));

  const cycles = bills.map((b, i) => ({
    date: b.date,
    bill_paid: b.paid,
    bill_cents: b.amount_cents,
    shares: contributors.map((c) => {
      const got = assigned[i].get(c.id);
      const expected = c.share_cents ?? 0;
      const paid = got?.cents ?? 0;
      const first = firstPaid.get(c.id);
      const counts = b.paid && (first ? daysBetween(first, b.date) >= -window / 2 : i === bills.findIndex((x) => x.paid));
      const status: ShareStatus = expected > 0 && paid >= expected ? 'paid' : paid > 0 ? 'partial' : b.paid && counts ? 'owing' : 'waiting';
      return { contributor_id: c.id, name: c.name, expected_cents: expected, paid_cents: paid, paid_date: got?.date ?? null, status };
    }),
  }));

  const owed = cycles.filter((c) => c.bill_paid)
    .reduce((s, c) => s + c.shares.reduce((x, sh) => x + (sh.status === 'owing' || sh.status === 'partial' ? Math.max(sh.expected_cents - sh.paid_cents, 0) : 0), 0), 0);
  // Show the latest paid bill while anyone still owes on it, otherwise the upcoming one.
  const lastPaid = cycles.find((c) => c.bill_paid);
  const current = contributors.length === 0 ? null
    : lastPaid && lastPaid.shares.some((s) => s.status === 'owing' || s.status === 'partial') ? lastPaid : cycles[0] ?? null;

  return { contributors, your_share_cents: yourShare, owed_to_you_cents: owed, cycles, current_cycle: current };
}

// ---------- suggestions ----------

function groupKey(t: { merchant: string | null; description: string }) {
  if (t.merchant) return t.merchant.toUpperCase();
  return t.description.toUpperCase().replace(/[^A-Z ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1).slice(0, 3).join(' ');
}

/** Words shared at the start of every description, used as the suggested match text. */
function commonPrefix(descriptions: string[]) {
  const split = descriptions.map((d) => d.toUpperCase().replace(/[^A-Z0-9&*' ]+/g, ' ').split(/\s+/).filter(Boolean));
  const out: string[] = [];
  for (let i = 0; i < split[0].length; i++) {
    const w = split[0][i];
    if (/\d/.test(w) || !split.every((s) => s[i] === w)) break;
    out.push(w);
  }
  return out.join(' ');
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/** Finds money-out payments that repeat on a regular schedule and aren't tracked yet. */
export function suggestRecurring(db: DB) {
  const rows = db.prepare(`SELECT t.date, t.description, p.name AS merchant, t.amount_cents, c.name AS category
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN payees p ON p.id = t.payee_id
    WHERE t.recurring_id IS NULL AND t.amount_cents < 0 AND (c.kind IS NULL OR c.kind = 'expense')
    ORDER BY t.date`).all() as { date: string; description: string; merchant: string | null; amount_cents: number; category: string | null }[];
  const rules = compileRules(listRules(db));
  const existing = new Set((db.prepare('SELECT name FROM recurring').all() as { name: string }[]).map((r) => r.name.toLowerCase()));

  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = groupKey(r);
    if (k) (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }

  const out = [];
  for (const [, txs] of groups) {
    // Payments on the same day are one occurrence (e.g. a split bill).
    const dates = [...new Set(txs.map((t) => t.date))];
    // Three payments at a steady gap before calling something regular; two can be a coincidence.
    if (dates.length < 3) continue;
    const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d));
    const frequency = FREQUENCIES.find((f) => gaps.every((g) => g >= GAPS[f][0] && g <= GAPS[f][1]));
    if (!frequency) continue;

    const rule = matchRule(rules, txs[0].description);
    const pattern = rule && txs.every((t) => rule.test(t.description)) ? rule.pattern : commonPrefix(txs.map((t) => t.description));
    if (pattern.length < 3) continue;
    const name = txs[0].merchant ?? titleCase(pattern);
    if (existing.has(name.toLowerCase())) continue;
    out.push({
      name, pattern, frequency,
      typical_cents: median(txs.slice(-3).map((t) => -t.amount_cents)),
      count: dates.length,
      last_date: dates[dates.length - 1],
      category: txs[txs.length - 1].category,
    });
  }
  return out.sort((a, b) => b.typical_cents * PER_MONTH[b.frequency] - a.typical_cents * PER_MONTH[a.frequency]);
}
