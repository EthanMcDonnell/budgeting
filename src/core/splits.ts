import type { DB } from './db.ts';
import { daysBetween } from './recurring.ts';
import { UserError, getTransaction, requirePayee, resolvePayee, updateTransaction } from './store.ts';
import { memoFrom, toCents } from './util.ts';

/*
 * Shared costs. A split is a purchase you paid that other people share; each person's part is a
 * share (split_shares), and the money they send you is allocated to shares (split_payments). What
 * someone owes is their unsettled shares less what's been allocated to them. Paybacks are filed in
 * the purchase's category, so the purchase nets down to your part in every report.
 *
 * Paybacks are found by amount: money in from a person that's about a half, third, quarter… of a
 * purchase a few days either side. Several people sending the same share for one purchase, or a
 * memo naming the shop ("golf", "uber"), makes a match near certain.
 */

export type ShareStatus = 'owing' | 'partial' | 'paid' | 'settled';

export interface Share {
  id: number; split_id: number; payee_id: number | null; person: string | null;
  amount_cents: number; paid_cents: number; outstanding_cents: number; settled: boolean; status: ShareStatus;
  payments: { transaction_id: number; date: string; amount_cents: number; description: string }[];
}

export interface Split {
  id: number; transaction_id: number; date: string; merchant: string | null; description: string;
  amount_cents: number; category: string | null; notes: string | null;
  ways: number; your_share_cents: number; owed_cents: number; shares: Share[];
}

/** Rounding slack when someone sends a round number for their share. */
const tolerance = (shareCents: number) => Math.max(60, Math.round(shareCents * 0.04));

// ---------- reading ----------

export function listSplits(db: DB, f: { payee?: number; split?: number; transaction?: number } = {}): Split[] {
  const where: string[] = [];
  const params: number[] = [];
  if (f.split != null) { where.push('s.id = ?'); params.push(f.split); }
  if (f.transaction != null) { where.push('s.transaction_id = ?'); params.push(f.transaction); }
  if (f.payee != null) { where.push('s.id IN (SELECT split_id FROM split_shares WHERE payee_id = ?)'); params.push(f.payee); }
  const splits = db.prepare(`SELECT s.id, s.transaction_id, s.notes, t.date, t.description, -t.amount_cents AS amount_cents,
      p.name AS merchant, c.name AS category
    FROM splits s JOIN transactions t ON t.id = s.transaction_id
    LEFT JOIN payees p ON p.id = t.payee_id LEFT JOIN categories c ON c.id = t.category_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.date DESC, s.id DESC`)
    .all(...params) as Omit<Split, 'ways' | 'your_share_cents' | 'owed_cents' | 'shares'>[];
  if (!splits.length) return [];

  const ids = splits.map((s) => s.id).join(',');
  const shares = db.prepare(`SELECT ss.id, ss.split_id, ss.payee_id, p.name AS person, ss.amount_cents, ss.settled
    FROM split_shares ss LEFT JOIN payees p ON p.id = ss.payee_id WHERE ss.split_id IN (${ids})
    ORDER BY ss.payee_id IS NULL, p.name, ss.id`).all() as { id: number; split_id: number; payee_id: number | null; person: string | null; amount_cents: number; settled: number }[];
  const payments = db.prepare(`SELECT sp.share_id, sp.transaction_id, sp.amount_cents, t.date, t.description
    FROM split_payments sp JOIN transactions t ON t.id = sp.transaction_id
    WHERE sp.share_id IN (SELECT id FROM split_shares WHERE split_id IN (${ids})) ORDER BY t.date`)
    .all() as { share_id: number; transaction_id: number; amount_cents: number; date: string; description: string }[];

  const bySplit = new Map<number, Share[]>();
  for (const s of shares) {
    const pays = payments.filter((p) => p.share_id === s.id).map(({ share_id: _, ...p }) => p);
    const paid = pays.reduce((t, p) => t + p.amount_cents, 0);
    const settled = !!s.settled;
    const outstanding = settled ? 0 : Math.max(s.amount_cents - paid, 0);
    const status: ShareStatus = paid >= s.amount_cents ? 'paid' : settled ? 'settled' : paid > 0 ? 'partial' : 'owing';
    (bySplit.get(s.split_id) ?? bySplit.set(s.split_id, []).get(s.split_id)!).push({
      ...s, settled, paid_cents: paid, outstanding_cents: outstanding, status, payments: pays,
    });
  }
  return splits.map((s) => {
    const list = bySplit.get(s.id) ?? [];
    return {
      ...s,
      ways: list.length + 1,
      your_share_cents: s.amount_cents - list.reduce((t, x) => t + x.amount_cents, 0),
      owed_cents: list.reduce((t, x) => t + x.outstanding_cents, 0),
      shares: list,
    };
  });
}

/** What each person still owes from shared costs, by payee id. */
export function owedByPayee(db: DB): Map<number, number> {
  const rows = db.prepare(`SELECT ss.payee_id, SUM(MAX(ss.amount_cents -
      COALESCE((SELECT SUM(sp.amount_cents) FROM split_payments sp WHERE sp.share_id = ss.id), 0), 0)) AS owed
    FROM split_shares ss WHERE ss.settled = 0 AND ss.payee_id IS NOT NULL GROUP BY ss.payee_id`)
    .all() as { payee_id: number; owed: number }[];
  return new Map(rows.filter((r) => r.owed > 0).map((r) => [r.payee_id, r.owed]));
}

/** Open shares nobody has been named for yet (e.g. a 4-way split where only two people have paid). */
export function unclaimedCents(db: DB): number {
  const r = db.prepare(`SELECT COALESCE(SUM(ss.amount_cents), 0) AS c FROM split_shares ss
    WHERE ss.payee_id IS NULL AND ss.settled = 0 AND NOT EXISTS (SELECT 1 FROM split_payments sp WHERE sp.share_id = ss.id)`).get() as { c: number };
  return r.c;
}

// ---------- writing ----------

export interface ShareInput {
  /** Person's name (created if new) or payee id; omit for someone not named yet. */
  person?: string | number | null;
  /** Dollars they owe; omitted = an even split. */
  amount?: number | null;
}

export interface SplitInput {
  /** How many people share it, you included. Defaults to everyone listed plus you. */
  ways?: number;
  shares?: ShareInput[];
  notes?: string | null;
}

function personId(db: DB, ref: string | number | null | undefined): number | null {
  if (ref == null || ref === '') return null;
  const p = typeof ref === 'number' ? requirePayee(db, ref) : resolvePayee(db, ref, 'person')!;
  if (p.kind !== 'person') throw new UserError(`${p.name} is a merchant, not a person`);
  return p.id;
}

/**
 * Splits a purchase (money out) with other people, or reshapes an existing split. People who stay keep
 * their payments; shares that go take their payment links with them.
 */
export function splitTransaction(db: DB, transactionId: number, input: SplitInput): Split {
  const tx = getTransaction(db, transactionId);
  if (tx.amount_cents >= 0) throw new UserError('Only money out can be split; link money in as a payback instead');
  const total = -tx.amount_cents;
  const named = (input.shares ?? []).filter((s) => s.person != null && s.person !== '');
  const unnamedGiven = (input.shares ?? []).filter((s) => s.person == null || s.person === '');
  const ways = Math.trunc(input.ways ?? (input.shares?.length ?? 0) + 1);
  if (!(ways >= 2) || ways > 50) throw new UserError('A split needs at least two people (you and someone else)');
  if ((input.shares?.length ?? 0) > ways - 1) throw new UserError(`${input.shares!.length} people plus you is more than ${ways} ways`);
  const even = Math.round(total / ways);

  return db.transaction(() => {
    const wanted: { payee_id: number | null; amount_cents: number }[] = [];
    const seen = new Set<number>();
    for (const s of named) {
      const id = personId(db, s.person)!;
      if (seen.has(id)) throw new UserError('Someone is listed twice');
      seen.add(id);
      wanted.push({ payee_id: id, amount_cents: s.amount == null ? even : toCents(s.amount) });
    }
    for (const s of unnamedGiven) wanted.push({ payee_id: null, amount_cents: s.amount == null ? even : toCents(s.amount) });
    while (wanted.length < ways - 1) wanted.push({ payee_id: null, amount_cents: even });
    if (wanted.some((w) => w.amount_cents <= 0)) throw new UserError('Shares must be more than zero');
    if (wanted.reduce((t, w) => t + w.amount_cents, 0) > total) throw new UserError('Shares add up to more than the purchase');

    const existing = db.prepare('SELECT id FROM splits WHERE transaction_id = ?').get(transactionId) as { id: number } | undefined;
    const splitId = existing?.id ?? Number(db.prepare('INSERT INTO splits (transaction_id, notes) VALUES (?, ?)').run(transactionId, input.notes?.trim() || null).lastInsertRowid);
    if (existing && input.notes !== undefined) db.prepare('UPDATE splits SET notes = ? WHERE id = ?').run(input.notes?.trim() || null, splitId);

    const current = db.prepare('SELECT id, payee_id FROM split_shares WHERE split_id = ? ORDER BY id').all(splitId) as { id: number; payee_id: number | null }[];
    const keep = new Set<number>();
    const upd = db.prepare('UPDATE split_shares SET amount_cents = ? WHERE id = ?');
    const ins = db.prepare('INSERT INTO split_shares (split_id, payee_id, amount_cents) VALUES (?, ?, ?)');
    for (const w of wanted) {
      const match = current.find((c) => !keep.has(c.id) && c.payee_id === w.payee_id);
      if (match) { upd.run(w.amount_cents, match.id); keep.add(match.id); } else ins.run(splitId, w.payee_id, w.amount_cents);
    }
    for (const c of current) if (!keep.has(c.id)) db.prepare('DELETE FROM split_shares WHERE id = ?').run(c.id);
    return listSplits(db, { split: splitId })[0];
  })();
}

export function deleteSplit(db: DB, splitId: number) {
  if (!db.prepare('DELETE FROM splits WHERE id = ?').run(splitId).changes) throw new UserError(`Unknown split: ${splitId}`);
}

export function setShareSettled(db: DB, shareId: number, settled: boolean) {
  if (!db.prepare('UPDATE split_shares SET settled = ? WHERE id = ?').run(Number(settled), shareId).changes) throw new UserError(`Unknown share: ${shareId}`);
}

/**
 * Links money in from a person to their share of a split: their own share if they have one, otherwise
 * an unnamed one (which becomes theirs), otherwise a new share. The payment is filed in the purchase's
 * category so it nets off.
 */
export function linkPayback(db: DB, paymentId: number, splitId: number, by: 'user' | 'ai' = 'user', amount?: number) {
  const pay = getTransaction(db, paymentId);
  if (pay.amount_cents <= 0) throw new UserError('Only money in can be a payback');
  if (pay.payee_id == null || pay.payee_kind !== 'person') throw new UserError('Link the payment to a person first');
  const split = listSplits(db, { split: splitId })[0];
  if (!split) throw new UserError(`Unknown split: ${splitId}`);

  return db.transaction(() => {
    db.prepare('DELETE FROM split_payments WHERE transaction_id = ? AND share_id IN (SELECT id FROM split_shares WHERE split_id = ?)').run(paymentId, splitId);
    const elsewhere = (db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS c FROM split_payments WHERE transaction_id = ?').get(paymentId) as { c: number }).c;
    const cents = amount == null ? pay.amount_cents - elsewhere : toCents(amount);
    if (cents <= 0) throw new UserError('This payment is already linked in full; unlink it first');
    if (cents + elsewhere > pay.amount_cents) throw new UserError('That is more than the payment');

    let share = split.shares.find((s) => s.payee_id === pay.payee_id)
      ?? split.shares.find((s) => s.payee_id == null && s.paid_cents === 0);
    if (!share) {
      const room = split.your_share_cents - cents;
      if (room < 0) throw new UserError(`Every share of ${split.merchant ?? split.description} is taken; add another person to the split first`);
      const id = Number(db.prepare('INSERT INTO split_shares (split_id, payee_id, amount_cents) VALUES (?, ?, ?)').run(splitId, pay.payee_id, cents).lastInsertRowid);
      share = { id, payee_id: pay.payee_id, amount_cents: cents, paid_cents: 0 } as Share;
    } else if (share.payee_id == null) {
      db.prepare('UPDATE split_shares SET payee_id = ? WHERE id = ?').run(pay.payee_id, share.id);
    }
    // Someone who rounds their share ($65 for $64.75) has paid it; the share becomes what they sent.
    const others = split.shares.filter((s) => s.id !== share.id).reduce((t, s) => t + s.amount_cents, 0);
    if (share.paid_cents === 0 && cents !== share.amount_cents && Math.abs(cents - share.amount_cents) <= tolerance(share.amount_cents)
      && others + cents <= split.amount_cents) {
      db.prepare('UPDATE split_shares SET amount_cents = ? WHERE id = ?').run(cents, share.id);
    }
    db.prepare('INSERT INTO split_payments (share_id, transaction_id, amount_cents) VALUES (?, ?, ?)').run(share.id, paymentId, cents);
    db.prepare('DELETE FROM not_paybacks WHERE transaction_id = ?').run(paymentId);
    db.prepare('DELETE FROM payback_reviews WHERE transaction_id = ?').run(paymentId);

    const purchase = getTransaction(db, split.transaction_id);
    if (purchase.category_id != null && purchase.category_id !== pay.category_id) {
      db.prepare('UPDATE transactions SET category_id = ?, categorized_by = ? WHERE id = ?').run(purchase.category_id, by, paymentId);
    }
    return listSplits(db, { split: splitId })[0];
  })();
}

/** Unlinks a payment from every share (or just those of one split). */
export function unlinkPayback(db: DB, paymentId: number, splitId?: number) {
  return db.prepare(`DELETE FROM split_payments WHERE transaction_id = ?
    ${splitId != null ? 'AND share_id IN (SELECT id FROM split_shares WHERE split_id = ?)' : ''}`)
    .run(...(splitId != null ? [paymentId, splitId] : [paymentId])).changes;
}

/** Marks money in as not a payback (or clears that), so it stops being suggested. */
export function setNotPayback(db: DB, paymentId: number, notPayback = true) {
  getTransaction(db, paymentId);
  if (notPayback) {
    db.prepare('INSERT OR IGNORE INTO not_paybacks (transaction_id) VALUES (?)').run(paymentId);
    db.prepare('DELETE FROM payback_reviews WHERE transaction_id = ?').run(paymentId);
  } else db.prepare('DELETE FROM not_paybacks WHERE transaction_id = ?').run(paymentId);
}

/**
 * Accepts a suggestion: splits the purchase `ways` ways (if it isn't already) and links each payment.
 * `people` names who unnamed payments (Beem) came from first.
 */
export function confirmPayback(db: DB, input: { purchase_id: number; ways: number; payment_ids: number[]; people?: { payment_id: number; person: string }[] }, by: 'user' | 'ai' = 'user') {
  if (!input.payment_ids.length) throw new UserError('Choose at least one payment');
  return db.transaction(() => {
    for (const p of input.people ?? []) nameSender(db, p.payment_id, p.person, by);
    const existing = db.prepare('SELECT id FROM splits WHERE transaction_id = ?').get(input.purchase_id) as { id: number } | undefined;
    let splitId = existing?.id;
    if (!splitId) {
      // Name each payer's share up front at what they sent; anyone who hasn't paid yet gets an even share.
      const pays = input.payment_ids.map((id) => getTransaction(db, id));
      const people = new Map<number, number>();
      for (const p of pays) {
        if (p.payee_id == null || p.payee_kind !== 'person') throw new UserError(`Link "${p.description}" to a person first`);
        people.set(p.payee_id, (people.get(p.payee_id) ?? 0) + p.amount_cents);
      }
      splitId = splitTransaction(db, input.purchase_id, {
        ways: Math.max(input.ways, people.size + 1),
        shares: [...people].map(([person, cents]) => ({ person, amount: cents / 100 })),
      }).id;
    }
    for (const id of input.payment_ids) linkPayback(db, id, splitId, by);
    return listSplits(db, { split: splitId })[0];
  })();
}

/** Links money in to the person it came from (created if new). */
function nameSender(db: DB, paymentId: number, person: string, by: 'user' | 'ai') {
  const id = personId(db, person);
  if (id != null) updateTransaction(db, paymentId, { payee_id: id }, by);
}

export interface ReviewInput {
  payment_id: number;
  /** The purchase it pays back; omit when unsure which. */
  purchase_id?: number | null;
  /** People sharing it, you included. */
  ways?: number | null;
  verdict: 'likely' | 'unsure';
  note: string;
  /** Who it's from, for an unnamed payment (Beem). */
  person?: string | null;
}

/** Records Claude's read on a payment; it shows on the suggestion, or makes one if the matcher missed it. */
export function reviewPayback(db: DB, input: ReviewInput, by: 'user' | 'ai' = 'ai') {
  const pay = getTransaction(db, input.payment_id);
  if (pay.amount_cents <= 0) throw new UserError('Only money in can be a payback');
  if (!input.note?.trim()) throw new UserError('Say why');
  if (input.purchase_id != null) {
    const q = getTransaction(db, input.purchase_id);
    if (q.amount_cents >= 0) throw new UserError('The purchase must be money out');
  }
  if (input.ways != null && !(input.ways >= 2)) throw new UserError('ways must be 2 or more');
  return db.transaction(() => {
    if (input.person?.trim()) nameSender(db, pay.id, input.person, by);
    db.prepare(`INSERT INTO payback_reviews (transaction_id, purchase_id, ways, verdict, note) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (transaction_id) DO UPDATE SET purchase_id = excluded.purchase_id, ways = excluded.ways,
        verdict = excluded.verdict, note = excluded.note, created_at = datetime('now')`)
      .run(pay.id, input.purchase_id ?? null, input.ways ?? null, input.verdict, input.note.trim());
  })();
}

export function clearReview(db: DB, paymentId: number) {
  db.prepare('DELETE FROM payback_reviews WHERE transaction_id = ?').run(paymentId);
}

// ---------- finding paybacks ----------

export interface PaybackSuggestion {
  purchase: { id: number; date: string; merchant: string | null; description: string; amount_cents: number; category: string | null; split_id: number | null; notes: string | null };
  ways: number;
  share_cents: number;
  /** `unlinked`: the bank text names the person but the payment isn't linked to them yet; confirming links it. */
  payments: { id: number; date: string; person: string; payee_id: number; amount_cents: number; description: string; memo: string | null; notes: string | null; unlinked?: boolean }[];
  confidence: 'high' | 'medium';
  reasons: string[];
  /** People sent different amounts (each paid for what they had), so there's no single "each". */
  uneven: boolean;
  /** Claude's notes on these payments. */
  reviews: { payment_id: number; person: string; verdict: 'likely' | 'unsure'; note: string }[];
}

/** Days a payback can land after the purchase posts, and before it (card purchases post a few days late). */
const AFTER = 6;
const BEFORE = 4;
const MAX_WAYS = 6;
const WAYS_PRIOR: Record<number, number> = { 2: 1, 3: 0.85, 4: 0.75, 5: 0.55, 6: 0.45 };
/** Categories people usually split, and how much less likely the rest are. */
const SHARED = new Set(['eating & drinking out', 'fun & travel', 'transport', 'groceries', 'home']);
const categoryWeight = (category: string | null) => (category == null ? 0.9 : SHARED.has(category.toLowerCase()) ? 1 : 0.75);
const NOISE = new Set(['to', 'phone', 'credit', 'account', 'beem', 'it', 'mr', 'mrs', 'ms', 'miss', 'the', 'and', 'pty', 'ltd', 'aus', 'au', 'for', 'from',
  // words in notes that describe a payback rather than name what it was for
  'payback', 'paid', 'back', 'small', 'memo', 'likely', 'maybe', 'probably', 'same', 'day', 'trip', 'with', 'split', 'share',
  // the month in the bank's time stamp ("05:20PM 16Oct")
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']);

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !NOISE.has(w)));

const sameWord = (m: string, t: string) => t === m || (m.length >= 4 && t.length >= 4 && (t.startsWith(m) || m.startsWith(t)));

/**
 * The words a note has to use to name a purchase: the shop's friendly name without any bracketed place
 * ("Le Petit Zinc (Paris)" -> "Le Petit Zinc"), or the bank text when there's no payee. Matching the bank text of a
 * named shop would let "Kyoto dinner" name every shop in Kyoto.
 */
const shopName = (q: { merchant: string | null; description: string }) => (q.merchant ? q.merchant.replace(/\([^)]*\)/g, ' ') : q.description);

/** Does the payment's memo ("golf", "uber :)") name the purchase? */
function memoMatches(payment: string, person: string, purchase: string) {
  const own = words(person);
  const memo = [...words(payment)].filter((w) => !own.has(w));
  const target = [...words(purchase)];
  return memo.some((m) => target.some((t) => sameWord(m, t)));
}

/**
 * The note someone typed on their transfer, told apart from their name by the bank's time stamp:
 * "OLIVER CHEN 08:15PM 23Sep Poker" -> ["poker"]; "... CREDIT TO ACCOUNT" and Beem payments -> [].
 */
function noteWords(payment: { description: string; memo: string | null }): string[] {
  return [...words(payment.memo ?? memoFrom(payment.description) ?? '')];
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** When a transfer was sent, in minutes, from the bank's stamp ("11:40AM 06Aug"); null for Beem and the like. */
function sentAt(payment: string): number | null {
  const m = payment.match(/(\d{1,2}):(\d{2})([AP]M)\s+(\d{1,2})([A-Za-z]{3})/i);
  const month = m ? MONTHS.indexOf(m[5].toLowerCase()) : -1;
  if (!m || month < 0) return null;
  const hour = (Number(m[1]) % 12) + (m[3].toUpperCase() === 'PM' ? 12 : 0);
  return ((month * 31 + Number(m[4])) * 24 + hour) * 60 + Number(m[2]);
}

/** At least half the other people must have paid before an n-way split is suggested: 3 ways needs 2, 5 ways needs 3. */
const payersNeeded = (ways: number) => Math.ceil(ways / 2);

interface Payment { id: number; date: string; description: string; amount_cents: number; payee_id: number; person: string; memo: string | null; notes: string | null }

/**
 * What the sender wrote: the bank text plus the memo (a Beem message, e.g. "Lantern payback"). Notes are
 * commentary, often a guess ("Likely Grill'd same day"), so they never count as the payment naming something.
 */
const said = (p: { description: string; memo: string | null }) => [p.description, p.memo].filter(Boolean).join(' ');
interface Purchase { id: number; date: string; description: string; total: number; merchant: string | null; category: string | null; split_id: number | null; notes: string | null }
/** `own`: paired by a note whatever the amount, so `share` is just what they sent, not an even share. */
interface Candidate { payment: Payment; purchase: Purchase; ways: number; share: number; base: number; memo: boolean; existing: boolean; own: boolean; closeness: number; days: number }

/** Purchases a payment could pay back (within the window of every payment), and shares of those already split. */
function loadPurchases(db: DB, payments: { date: string }[]) {
  const dates = payments.map((p) => p.date).sort();
  const purchases = db.prepare(`SELECT t.id, t.date, t.description, -t.amount_cents AS total, p.name AS merchant, c.name AS category, s.id AS split_id, t.notes
    FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN splits s ON s.transaction_id = t.id
    WHERE t.amount_cents < 0 AND (c.kind IS NULL OR c.kind = 'expense') AND (p.kind IS NULL OR p.kind = 'merchant')
      AND t.date >= date(?, '-${AFTER + 1} day') AND t.date <= date(?, '+${BEFORE + 1} day')
    ORDER BY t.date`).all(dates[0], dates[dates.length - 1]) as Purchase[];
  const splitShares = new Map<number, Share[]>();
  for (const s of listSplits(db).filter((s) => purchases.some((p) => p.split_id === s.id))) splitShares.set(s.id, s.shares);
  return { purchases, splitShares };
}

/** Every purchase and number of ways a payment could be a share of, scored without looking at other payers. */
function candidatesFor(pay: Payment, purchases: Purchase[], splitShares: Map<number, Share[]>): Candidate[] {
  const list: Candidate[] = [];
  for (const q of purchases) {
    const days = daysBetween(q.date, pay.date);
    if (days < -BEFORE || days > AFTER || q.total <= pay.amount_cents) continue;
    const timing = days >= 0 && days <= 3 ? 1 : days < 0 ? 0.75 - 0.1 * (-days - 1) : 1 - (days - 3) * 0.15;
    const memo = memoMatches(said(pay), pay.person, shopName(q));
    const add = (ways: number, share: number, existing: boolean, own = false) => {
      const diff = Math.abs(pay.amount_cents - share);
      const closeness = 1 - diff / tolerance(share);
      if (closeness < 0) return;
      list.push({ payment: pay, purchase: q, ways, share, existing, own, memo, closeness, days, base: (0.45 * closeness + 0.3 * timing + 0.25 * (WAYS_PRIOR[ways] ?? 0.4)) * categoryWeight(q.category) });
    };
    const shares = q.split_id != null ? splitShares.get(q.split_id) : undefined;
    if (shares) {
      // Already split: only their own open share, or one nobody has claimed.
      const own = shares.find((s) => s.payee_id === pay.payee_id);
      const open = own ?? shares.find((s) => s.payee_id == null && s.paid_cents === 0);
      if (open && open.outstanding_cents > 0) add(shares.length + 1, open.outstanding_cents, true);
      continue;
    }
    for (let ways = 2; ways <= MAX_WAYS; ways++) {
      const share = Math.round(q.total / ways);
      if (share >= 200) add(ways, share, false);
    }
    // A note naming the shop ("Lantern payback") pairs them whatever the amount: they paid for what they had.
    if (memo && !list.some((c) => c.purchase.id === q.id)) add(2, pay.amount_cents, false, true);
  }
  return list;
}

/**
 * Suggests which purchase each unlinked payment from a person pays back. Only money in from people
 * (not linked to a recurring bill, not a transfer, not marked as not a payback) is considered.
 */
export function suggestPaybacks(db: DB, opts: { from?: string; payee?: number } = {}): PaybackSuggestion[] {
  const payments = db.prepare(`SELECT t.id, t.date, t.description, t.amount_cents, t.payee_id, p.name AS person, t.memo, t.notes
    FROM transactions t JOIN payees p ON p.id = t.payee_id AND p.kind = 'person'
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.amount_cents >= 200 AND t.contributor_id IS NULL AND (c.kind IS NULL OR c.kind <> 'transfer')
      AND NOT EXISTS (SELECT 1 FROM split_payments sp WHERE sp.transaction_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM not_paybacks np WHERE np.transaction_id = t.id)
      AND (@from IS NULL OR t.date >= @from) AND (@payee IS NULL OR t.payee_id = @payee)
    ORDER BY t.date`).all({ from: opts.from ?? null, payee: opts.payee ?? null }) as Payment[];

  const flagged = flaggedPaybacks(db, payments, opts);
  const rest = payments.filter((p) => !flagged.claimed.has(p.id));
  const matched = rest.length ? matchPaybacks(db, rest, flagged.taken) : [];
  return applyReviews(db, [...flagged.groups, ...matched], [...payments, ...flagged.unlinked])
    .map((g) => ({ ...g, uneven: g.payments.some((p) => Math.abs(p.amount_cents - g.share_cents) > tolerance(g.share_cents)) }))
    .sort((a, b) => b.purchase.date.localeCompare(a.purchase.date) || b.purchase.id - a.purchase.id);
}

/**
 * Payments for splits you've flagged with named people: money in from someone a share is waiting on, of
 * about what they still owe, any time from a few days before the purchase on (however late they pay). Their
 * payment can be linked to them already, or not linked to anyone yet with their name in the bank text.
 * Shares are matched oldest first, so the first payment that fits pays off the oldest debt.
 * `taken` is "split:payee" for each share matched here, so the general matcher leaves it alone.
 */
function flaggedPaybacks(db: DB, linked: Payment[], opts: { from?: string; payee?: number }) {
  const groups: PaybackSuggestion[] = [];
  const claimed = new Set<number>();
  const taken = new Set<string>();
  const unlinked: Payment[] = [];
  const open = listSplits(db, opts.payee != null ? { payee: opts.payee } : {})
    .flatMap((split) => split.shares
      .filter((s) => s.payee_id != null && s.outstanding_cents > 0 && (opts.payee == null || s.payee_id === opts.payee))
      .map((share) => ({ split, share })))
    .sort((a, b) => a.split.date.localeCompare(b.split.date) || a.split.id - b.split.id);
  if (!open.length) return { groups, claimed, taken, unlinked };

  const earliest = open[0].split.date;
  const strays = db.prepare(`SELECT t.id, t.date, t.description, t.amount_cents, t.memo, t.notes
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.payee_id IS NULL AND t.amount_cents >= 200 AND t.contributor_id IS NULL AND (c.kind IS NULL OR c.kind = 'expense')
      AND NOT EXISTS (SELECT 1 FROM split_payments sp WHERE sp.transaction_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM not_paybacks np WHERE np.transaction_id = t.id)
      AND t.date >= date(@earliest, '-${BEFORE} day') AND (@from IS NULL OR t.date >= @from)
    ORDER BY t.date`).all({ earliest, from: opts.from ?? null }) as Omit<Payment, 'payee_id' | 'person'>[];
  const names = (person: string) => [...words(person)];

  const fits = (split: Split, share: Share) => {
    const fromThem = linked.filter((p) => p.payee_id === share.payee_id).map((p) => ({ p, unlinked: false }));
    const named = strays.filter((p) => names(share.person!).some((n) => words(p.description).has(n)))
      .map((p) => ({ p: { ...p, payee_id: share.payee_id!, person: share.person! }, unlinked: true }));
    return [...fromThem, ...named].filter(({ p }) => !claimed.has(p.id) && daysBetween(split.date, p.date) >= -BEFORE
      && Math.abs(p.amount_cents - share.outstanding_cents) <= tolerance(share.outstanding_cents))
      .sort((a, b) => Number(a.unlinked) - Number(b.unlinked) || a.p.date.localeCompare(b.p.date));
  };

  for (const { split, share } of open) {
    const [best] = fits(split, share);
    if (!best) continue;
    const { p } = best;
    claimed.add(p.id);
    taken.add(`${split.id}:${share.payee_id}`);
    if (best.unlinked) unlinked.push(p);

    const reasons = [`flagged for ${share.person}`];
    if (best.unlinked) reasons.push(`bank text names ${share.person}`);
    const note = noteWords(p);
    const aboutIt = memoMatches(said(p), p.person, shopName(split));
    if (aboutIt) reasons.push('memo names it');
    else if (note.length) reasons.push(`note says "${p.memo ?? memoFrom(p.description)}"`);
    // Another flagged share of theirs it would fit as well (they owe $20 for two dinners).
    const other = open.find((o) => o.split.id !== split.id && o.share.payee_id === share.payee_id && o.share.outstanding_cents > 0
      && daysBetween(o.split.date, p.date) >= -BEFORE && Math.abs(p.amount_cents - o.share.outstanding_cents) <= tolerance(o.share.outstanding_cents));
    if (other) reasons.push(`could also be ${other.split.merchant ?? other.split.description}`);
    const sure = !best.unlinked && !other && (aboutIt || !note.length);

    const purchase = { id: split.transaction_id, date: split.date, merchant: split.merchant, description: split.description, amount_cents: split.amount_cents, category: split.category, split_id: split.id, notes: split.notes };
    let g = groups.find((x) => x.purchase.split_id === split.id);
    if (!g) {
      g = { purchase, ways: split.ways, share_cents: share.outstanding_cents, payments: [], confidence: 'high', reasons: [], uneven: false, reviews: [] };
      groups.push(g);
    }
    g.payments.push({ id: p.id, date: p.date, person: share.person!, payee_id: share.payee_id!, amount_cents: p.amount_cents, description: p.description, memo: p.memo, notes: p.notes, ...(best.unlinked ? { unlinked: true } : {}) });
    if (!sure) g.confidence = 'medium';
    for (const r of reasons) if (!g.reasons.includes(r)) g.reasons.push(r);
  }
  return { groups, claimed, taken, unlinked };
}

/** The general matcher: purchases each payment could be a share of, by amount, timing, notes and other payers. */
function matchPaybacks(db: DB, payments: Payment[], taken: Set<string>): PaybackSuggestion[] {
  const { purchases, splitShares } = loadPurchases(db, payments);
  const candidates = new Map<number, Candidate[]>();
  for (const pay of payments) {
    const list = candidatesFor(pay, purchases, splitShares);
    if (list.length) candidates.set(pay.id, list);
  }

  // Other people sending the same share for the same purchase is the strongest sign of a split.
  const payers = new Map<string, Set<number>>();
  for (const list of candidates.values()) for (const c of list) {
    const k = `${c.purchase.id}:${c.ways}`;
    (payers.get(k) ?? payers.set(k, new Set()).get(k)!).add(c.payment.payee_id);
  }
  const score = (c: Candidate) => {
    const group = (payers.get(`${c.purchase.id}:${c.ways}`)?.size ?? 1) - 1;
    return c.base + (c.memo ? 0.3 : 0) + Math.min(group, 2) * 0.3 + (c.existing ? 0.4 : 0);
  };

  // An n-way share only counts once enough people have sent it; an existing split is already confirmed.
  const enoughPayers = (c: Candidate) => c.existing || (payers.get(`${c.purchase.id}:${c.ways}`)?.size ?? 0) >= payersNeeded(c.ways);

  const chosen: { c: Candidate; confidence: 'high' | 'medium'; reasons: string[] }[] = [];
  for (const list of candidates.values()) {
    const ranked = list.filter((c) => enoughPayers(c) && !(c.existing && taken.has(`${c.purchase.split_id}:${c.payment.payee_id}`)))
      .map((c) => ({ c, s: score(c) })).sort((a, b) => b.s - a.s);
    const [best, next] = ranked;
    if (!best || best.s < 0.6) continue;
    const group = (payers.get(`${best.c.purchase.id}:${best.c.ways}`)?.size ?? 1) - 1;
    const ambiguous = !!next && next.c.purchase.id !== best.c.purchase.id && best.s - next.s < 0.15;
    // One person halving something with nothing else to go on has to be a clean, prompt half of a
    // purchase people usually share, the only one it fits, without a note about something else.
    if (!group && !best.c.existing && !best.c.memo) {
      const clean = best.c.closeness >= 0.6 && best.c.days >= -2 && best.c.days <= 4 && categoryWeight(best.c.purchase.category) >= 0.9;
      if (!clean || ambiguous || noteWords(best.c.payment).length > 0) continue;
    }
    const reasons: string[] = [];
    if (group) reasons.push(`${group} other ${group === 1 ? 'person' : 'people'} sent the same share`);
    if (best.c.memo) reasons.push('memo names it');
    if (best.c.existing) reasons.push('already split');
    if (best.c.closeness > 0.9 && !best.c.own) reasons.push('amount matches exactly');
    if (ambiguous) reasons.push(`could also be ${next.c.purchase.merchant ?? next.c.purchase.description}`);
    const strong = group > 0 || best.c.memo || best.c.existing || (best.c.closeness > 0.9 && best.c.days >= -1 && best.c.days <= 3 && best.c.ways <= 3);
    chosen.push({ c: best.c, confidence: strong && !ambiguous ? 'high' : 'medium', reasons });
  }

  const groups = new Map<string, PaybackSuggestion>();
  for (const { c, confidence, reasons } of chosen) {
    const k = `${c.purchase.id}:${c.ways}`;
    const g = groups.get(k) ?? groups.set(k, {
      purchase: { id: c.purchase.id, date: c.purchase.date, merchant: c.purchase.merchant, description: c.purchase.description, amount_cents: c.purchase.total, category: c.purchase.category, split_id: c.purchase.split_id, notes: c.purchase.notes },
      // What they sent isn't an even share when a note paired it, so the even share shows it as uneven.
      ways: c.ways, share_cents: c.own ? Math.round(c.purchase.total / c.ways) : c.share, payments: [], confidence, reasons: [], uneven: false, reviews: [],
    }).get(k)!;
    g.payments.push({ id: c.payment.id, date: c.payment.date, person: c.payment.person, payee_id: c.payment.payee_id, amount_cents: c.payment.amount_cents, description: c.payment.description, memo: c.payment.memo, notes: c.payment.notes });
    if (confidence === 'medium') g.confidence = 'medium';
    for (const r of reasons) if (!g.reasons.includes(r)) g.reasons.push(r);
  }
  for (const [k, g] of groups) {
    const people = new Set(g.payments.map((p) => p.payee_id)).size;
    // More sent than the purchase cost: these payments are for something else too.
    if (g.purchase.split_id == null && g.payments.reduce((t, p) => t + p.amount_cents, 0) > g.purchase.amount_cents) { groups.delete(k); continue; }
    // Some payers may have matched another purchase better, leaving too few for this split.
    if (g.purchase.split_id == null && people < payersNeeded(g.ways)) groups.delete(k);
    // A group of payers sending the same share is high confidence even if one alone looked shaky.
    else if (people > 1) g.confidence = 'high';
  }

  // Friends at the same table who paid a different amount (their own meal) join the group.
  const kept = [...groups.values()];
  const claimed = new Set(kept.flatMap((g) => g.payments.map((p) => p.id)));
  for (const g of kept) if (g.purchase.split_id == null) addCompanions(g, payments, claimed);
  const targets = new Set(kept.map((g) => g.purchase.id));
  const uneven = unevenGroups(payments.filter((p) => !claimed.has(p.id)), purchases.filter((q) => q.split_id == null && !targets.has(q.id)));
  for (const g of uneven) for (const p of g.payments) claimed.add(p.id);
  for (const g of uneven) addCompanions(g, payments, claimed);
  return [...kept, ...uneven];
}

/**
 * Adds people who paid you around the same time as a group (within two hours by the bank's stamp, or
 * with a note matching theirs or naming the shop) without the total passing the purchase.
 */
function addCompanions(g: PaybackSuggestion, payments: Payment[], claimed: Set<number>) {
  const names = shopName(g.purchase);
  let total = g.payments.reduce((t, p) => t + p.amount_cents, 0);
  let added = 0;
  for (const p of payments) {
    if (claimed.has(p.id) || g.payments.some((m) => m.payee_id === p.payee_id)) continue;
    if (!g.payments.some((m) => Math.abs(daysBetween(m.date, p.date)) <= 1) || total + p.amount_cents >= g.purchase.amount_cents) continue;
    const at = sentAt(p.description);
    const together = at != null && g.payments.some((m) => {
      const t = sentAt(m.description);
      return t != null && Math.abs(t - at) <= 120;
    });
    const note = noteWords(p);
    const sameNote = note.length > 0 && g.payments.some((m) => noteWords(m).some((w) => note.some((x) => sameWord(x, w))));
    if (!together && !sameNote && !memoMatches(said(p), p.person, names)) continue;
    g.payments.push({ id: p.id, date: p.date, person: p.person, payee_id: p.payee_id, amount_cents: p.amount_cents, description: p.description, memo: p.memo, notes: p.notes });
    claimed.add(p.id);
    total += p.amount_cents;
    added++;
  }
  if (!added) return;
  g.ways = Math.max(g.ways, new Set(g.payments.map((p) => p.payee_id)).size + 1);
  g.reasons.push(`${added} more paid you around the same time`);
}

/**
 * Several people paying you different amounts (each covering what they had) for one purchase. Only
 * suggested with evidence they paid for the same thing: at least two wrote the same note ("Breakfast"),
 * or a note names the shop. Payments with a note about something else are left out.
 */
function unevenGroups(payments: Payment[], purchases: Purchase[]): PaybackSuggestion[] {
  const out: PaybackSuggestion[] = [];
  const taken = new Set<number>();
  for (const first of payments) {
    if (taken.has(first.id)) continue;
    const pool = [first];
    for (const p of payments) {
      if (p.id === first.id || taken.has(p.id) || pool.some((c) => c.payee_id === p.payee_id)) continue;
      if (Math.abs(daysBetween(first.date, p.date)) <= 1) pool.push(p);
    }
    if (pool.length < 2) continue;

    const notes = new Map(pool.map((p) => [p.id, noteWords(p)]));
    const counts = new Map<string, number>();
    for (const ws of notes.values()) for (const w of new Set(ws)) counts.set(w, (counts.get(w) ?? 0) + 1);
    const shared = [...counts].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    type Match = { q: Purchase; cluster: Payment[]; memo: boolean; s: number };
    let best = null as Match | null;
    let next = null as Match | null;
    for (const q of purchases) {
      const d = daysBetween(q.date, first.date);
      if (d < -BEFORE || d > AFTER) continue;
      const names = shopName(q);
      // Keep payers with no note, or whose note is the shared one or names this shop.
      const cluster = pool.filter((p) => {
        const n = notes.get(p.id)!;
        return n.length === 0 || (shared != null && n.includes(shared)) || memoMatches(said(p), p.person, names);
      });
      const memo = cluster.some((p) => memoMatches(said(p), p.person, names));
      if (cluster.length < 2 || (!shared && !memo)) continue;
      const sum = cluster.reduce((t, p) => t + p.amount_cents, 0);
      if (q.total <= sum || sum < q.total * 0.4) continue;
      const even = cluster.length / (cluster.length + 1);
      const s = (1 - Math.abs(sum / q.total - even)) * categoryWeight(q.category) + (memo ? 0.3 : 0);
      const cand = { q, cluster, memo, s };
      if (!best || s > best.s) { next = best; best = cand; } else if (!next || s > next.s) next = cand;
    }
    if (!best || best.s < 0.8) continue;
    for (const p of best.cluster) taken.add(p.id);
    const ambiguous = !!next && best.s - next.s < 0.1;
    const sum = best.cluster.reduce((t, p) => t + p.amount_cents, 0);
    const reasons = [`${best.cluster.length} people paid you different amounts the same day`];
    if (shared) reasons.push(`notes say "${shared}"`);
    if (best.memo) reasons.push('memo names it');
    if (ambiguous) reasons.push(`could also be ${next!.q.merchant ?? next!.q.description}`);
    out.push({
      purchase: { id: best.q.id, date: best.q.date, merchant: best.q.merchant, description: best.q.description, amount_cents: best.q.total, category: best.q.category, split_id: null, notes: best.q.notes },
      ways: best.cluster.length + 1, share_cents: Math.round(sum / best.cluster.length),
      payments: best.cluster.map((p) => ({ id: p.id, date: p.date, person: p.person, payee_id: p.payee_id, amount_cents: p.amount_cents, description: p.description, memo: p.memo, notes: p.notes })),
      confidence: best.memo && !ambiguous ? 'high' : 'medium',
      reasons, uneven: true, reviews: [],
    });
  }
  return out;
}

/** Everything for the People page: what's owed, the splits still open, and paybacks to check. */
export function splitsOverview(db: DB) {
  const open = listSplits(db).filter((s) => s.owed_cents > 0);
  const owed = [...owedByPayee(db).values()].reduce((t, c) => t + c, 0);
  return { owed_cents: owed, unclaimed_cents: unclaimedCents(db), open, suggestions: suggestPaybacks(db) };
}

/**
 * Folds Claude's reviews into the suggestions: a note on the payment's suggestion, or, when Claude paired
 * it with a different purchase than the matcher (or the matcher missed it), the payment moves there.
 */
function applyReviews(db: DB, groups: PaybackSuggestion[], payments: Payment[]): PaybackSuggestion[] {
  const reviews = db.prepare('SELECT transaction_id, purchase_id, ways, verdict, note FROM payback_reviews').all() as
    { transaction_id: number; purchase_id: number | null; ways: number | null; verdict: 'likely' | 'unsure'; note: string }[];
  const byId = new Map(payments.map((p) => [p.id, p]));
  const purchase = db.prepare(`SELECT t.id, t.date, t.description, -t.amount_cents AS amount_cents, p.name AS merchant, c.name AS category, s.id AS split_id, t.notes
    FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN splits s ON s.transaction_id = t.id WHERE t.id = ?`);

  for (const r of reviews) {
    const pay = byId.get(r.transaction_id);
    if (!pay) continue; // linked, dismissed, or outside this listing
    const review = { payment_id: pay.id, person: pay.person, verdict: r.verdict, note: r.note };
    const current = groups.find((g) => g.payments.some((p) => p.id === pay.id));
    let target = current && (r.purchase_id == null || current.purchase.id === r.purchase_id) ? current : null;
    if (!target && r.purchase_id != null) {
      if (current) current.payments = current.payments.filter((p) => p.id !== pay.id);
      target = groups.find((g) => g.purchase.id === r.purchase_id) ?? null;
      if (!target) {
        const q = purchase.get(r.purchase_id) as PaybackSuggestion['purchase'] | undefined;
        if (!q) continue;
        const ways = r.ways ?? 2;
        target = { purchase: q, ways, share_cents: Math.round(q.amount_cents / ways), payments: [], confidence: 'medium', reasons: [], uneven: false, reviews: [] };
        groups.push(target);
      }
      target.payments.push({ id: pay.id, date: pay.date, person: pay.person, payee_id: pay.payee_id, amount_cents: pay.amount_cents, description: pay.description, memo: pay.memo, notes: pay.notes });
      if (!target.reasons.includes('Claude matched it')) target.reasons.push('Claude matched it');
    }
    if (!target) continue;
    if (r.ways) target.ways = Math.max(target.ways, r.ways);
    target.reviews.push(review);
  }
  // Claude's say overrides the matcher's: unsure anywhere keeps it for you to check, otherwise likely.
  for (const g of groups) if (g.reviews.length) g.confidence = g.reviews.some((r) => r.verdict === 'unsure') ? 'medium' : 'high';
  return groups.filter((g) => g.payments.length);
}

/**
 * For Claude to review: the suggestions, plus every other payment in that the matcher left alone
 * (unnamed Beem payments included) with the purchases it could be a share of and what else was
 * bought around then, so a judgement can be made from the notes and context.
 */
export function paybackCandidates(db: DB, opts: { from?: string; payee?: number } = {}) {
  const suggestions = suggestPaybacks(db, opts);
  const claimed = new Set(suggestions.flatMap((g) => g.payments.map((p) => p.id)));
  const rows = db.prepare(`SELECT t.id, t.date, t.description, t.amount_cents, t.payee_id, p.name AS person, t.memo, t.notes, c.name AS category
    FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.amount_cents >= 200 AND t.contributor_id IS NULL
      AND (p.kind = 'person' OR (t.payee_id IS NULL AND (c.kind IS NULL OR c.kind = 'expense')))
      AND (c.kind IS NULL OR c.kind <> 'transfer')
      AND NOT EXISTS (SELECT 1 FROM split_payments sp WHERE sp.transaction_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM not_paybacks np WHERE np.transaction_id = t.id)
      AND (@from IS NULL OR t.date >= @from) AND (@payee IS NULL OR t.payee_id = @payee)
    ORDER BY t.date`).all({ from: opts.from ?? null, payee: opts.payee ?? null }) as (Payment & { category: string | null; payee_id: number | null; person: string | null })[];
  const left = rows.filter((r) => !claimed.has(r.id));
  if (!left.length) return { suggestions, unmatched: [] };

  const { purchases, splitShares } = loadPurchases(db, left);
  const reviewed = new Map((db.prepare('SELECT transaction_id, verdict, note FROM payback_reviews').all() as { transaction_id: number; verdict: string; note: string }[])
    .map((r) => [r.transaction_id, r]));
  const brief = (q: Purchase) => ({ id: q.id, date: q.date, merchant: q.merchant ?? q.description, amount_cents: q.total, category: q.category, notes: q.notes, already_split: q.split_id != null });
  const unmatched = left.map((r) => {
    const pay: Payment = { ...r, payee_id: r.payee_id ?? 0, person: r.person ?? '' };
    const fits = candidatesFor(pay, purchases, splitShares)
      .sort((a, b) => b.base + (b.memo ? 0.3 : 0) - (a.base + (a.memo ? 0.3 : 0))).slice(0, 3)
      .map((c) => ({ ...brief(c.purchase), ways: c.ways, share_cents: c.share, days_after_purchase: c.days }));
    const nearby = purchases.filter((q) => Math.abs(daysBetween(q.date, r.date)) <= 3 && q.total > r.amount_cents)
      .sort((a, b) => b.total - a.total).slice(0, 6).map(brief);
    return {
      payment: { id: r.id, date: r.date, description: r.description, memo: r.memo, notes: r.notes, amount_cents: r.amount_cents, person: r.person, category: r.category },
      review: reviewed.get(r.id) ?? null,
      fits, nearby,
    };
  });
  return { suggestions, unmatched };
}
