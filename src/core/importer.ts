import type { ParsedCsv } from './csv.ts';
import type { DB } from './db.ts';
import {
  UserError, compileRules, dedupeKey, findAccount, findCategory, listAccounts, listRules, matchRules, fillMemos, resolveAccount,
  resolvePayee, updateAccount,
} from './store.ts';
import { accountCoverage, coveredSpan, type CoverageGap } from './coverage.ts';
import { linkRecurring } from './recurring.ts';
import { addDays, normalizeDate, toCents } from './util.ts';

export interface IncomingTransaction {
  date: string;
  description: string;
  /** Dollars. Negative = money out (purchase, fee, transfer out); positive = money in. */
  amount: number;
  category?: string | null;
  merchant?: string | null;
  notes?: string | null;
  /** What the other person wrote on it, if known; otherwise read from the bank text where possible. */
  memo?: string | null;
  balance?: number | null;
}

export interface ImportOptions {
  account?: string | number | null;
  source: 'pdf' | 'csv' | 'mcp' | 'manual';
  label?: string | null;
  transactions: IncomingTransaction[];
  /** Rows matching an existing transaction on account, date and amount but with different text. */
  possibleDuplicates?: 'skip' | 'import';
  dryRun?: boolean;
  /** Statement balances, used to check nothing was missed or misread. */
  openingBalance?: number | null;
  closingBalance?: number | null;
  /** Who chose the categories supplied in `transactions`. */
  categorizedBy?: 'ai' | 'user';
  /**
   * The card authorisations the bank still shows as pending (see ParsedCsv.pending), when the file lists them. They're
   * stored flagged as pending. Stored pending rows are replaced by their settled version when one arrives, and dropped
   * when the file covers their date without listing them. Left out (a PDF statement), pending rows only settle.
   */
  pending?: IncomingTransaction[];
}

/** `pending`: a new pending authorisation. `still_pending`: one already stored. `settles`: the settled version of a stored pending row (`matches_id`). */
export type RowStatus = 'new' | 'duplicate' | 'possible_duplicate' | 'invalid' | 'pending' | 'still_pending' | 'settles';

export interface PreviewRow {
  index: number;
  status: RowStatus;
  date: string | null;
  description: string;
  amount_cents: number;
  category: string | null;
  category_source: 'given' | 'rule' | null;
  merchant: string | null;
  error?: string;
  matches_id?: number;
}

export interface ImportResult {
  dry_run: boolean;
  import_id: number | null;
  account: string;
  account_created: boolean;
  inserted: number;
  duplicates: number;
  possible_duplicates: number;
  possible_duplicates_skipped: boolean;
  invalid: number;
  uncategorized: number;
  unknown_categories: string[];
  period: { start: string | null; end: string | null };
  reconciliation: null | {
    opening_balance: number; closing_balance: number; expected_net: number;
    statement_net: number; difference: number; ok: boolean;
  };
  rows: PreviewRow[];
  /** Pending authorisations: added, already stored, settled by a row in this file, and dropped as they never settled. */
  pending: { added: number; still_pending: number; settled: number; expired: ExpiredPending[] };
  /** What the account's imports cover with this one included. `gaps` are only those next to this file's dates. */
  coverage: { covered_to: string | null; next_export_from: string | null; gaps: CoverageGap[] };
}

export interface ExpiredPending { id: number; date: string; description: string; amount_cents: number; category: string | null; merchant: string | null }

export function importTransactions(db: DB, opts: ImportOptions): ImportResult {
  if (!Array.isArray(opts.transactions) || opts.transactions.length + (opts.pending?.length ?? 0) === 0) {
    throw new UserError('No transactions to import');
  }
  const run = () => doImport(db, opts);
  // A dry run may still create the account; roll everything back afterwards.
  if (opts.dryRun) {
    let result!: ImportResult;
    try {
      db.transaction(() => { result = run(); throw ROLLBACK; })();
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    }
    return result;
  }
  return db.transaction(run)();
}

const ROLLBACK = Symbol('rollback');

/**
 * Imports a parsed CSV. A file covering several accounts (Bankwest's full export) is split by account number and each
 * part goes into the account with that number. `account` takes the rows whose number no account has yet (only one
 * such number per file), and remembers the number on that account for next time.
 */
export function importCsv(db: DB, parsed: ParsedCsv, opts: Omit<ImportOptions, 'source' | 'transactions'>): ImportResult[] {
  const groups = new Map<string, { transactions: IncomingTransaction[]; pending: IncomingTransaction[] }>();
  const group = (n: string) => groups.get(n) ?? groups.set(n, { transactions: [], pending: [] }).get(n)!;
  for (const { accountNumber = '', ...t } of parsed.transactions) group(accountNumber).transactions.push(t);
  for (const { accountNumber = '', line: _l, ...t } of parsed.pending) group(accountNumber).pending.push(t);
  const digits = (s: string) => s.replace(/\D/g, '');
  const accounts = listAccounts(db);
  const owner = (n: string) => (n ? accounts.find((a) => a.number && digits(a.number).endsWith(digits(n))) : undefined);
  const unknown = [...groups.keys()].filter((n) => !owner(n));
  if (unknown.length > 1) {
    throw new UserError(`No account has number ${unknown.filter(Boolean).join(' or ')} yet. Import each account's rows on their own once, so the number is remembered.`);
  }
  const chosen = findAccount(db, opts.account);
  if (unknown[0] && chosen?.number) {
    throw new UserError(`These rows are for account number ${unknown[0]}, but ${chosen.name} is ${chosen.number}. Choose another account or a new one.`);
  }
  const run = () => [...groups].map(([n, { transactions, pending }]) => {
    const target = owner(n);
    const r = importTransactions(db, { ...opts, account: target?.id ?? opts.account, source: 'csv', transactions, pending });
    const into = !target && n && !r.dry_run ? findAccount(db, r.account) : null;
    if (into && !into.number) updateAccount(db, into.id, { number: n });
    return r;
  });
  return opts.dryRun ? run() : db.transaction(run)();
}

function doImport(db: DB, opts: ImportOptions): ImportResult {
  const { account, created } = resolveAccount(db, opts.account);
  const rules = compileRules(listRules(db));
  const unknownCategories = new Set<string>();

  const prepare = (t: IncomingTransaction, index: number): Row => {
      const date = normalizeDate(String(t.date ?? ''));
      const description = String(t.description ?? '').replace(/\s+/g, ' ').trim();
      let amountCents = NaN;
      try { amountCents = toCents(Number(t.amount)); } catch { /* flagged below */ }
      const base = {
        index, date, description, amount_cents: amountCents, merchant: t.merchant?.trim() || null,
        notes: t.notes?.trim() || null, memo: t.memo?.trim() || null,
        balance_cents: t.balance == null || !Number.isFinite(Number(t.balance)) ? null : toCents(Number(t.balance)),
        category: null as string | null, category_id: null as number | null,
        category_source: null as 'given' | 'rule' | null, payee_id: null as number | null,
      };
      const error = !date ? `Invalid date "${t.date}"`
        : !description ? 'Missing description'
        : !Number.isFinite(amountCents) ? `Invalid amount "${t.amount}"`
        : undefined;
      if (error) return { ...base, status: 'invalid' as const, error };

      if (t.category?.trim()) {
        const cat = findCategory(db, t.category);
        if (cat) { base.category = cat.name; base.category_id = cat.id; base.category_source = 'given'; }
        else unknownCategories.add(t.category.trim());
      }
      const hit = matchRules(rules, description);
      if (base.category_id == null && hit.category) {
        base.category = hit.category.category; base.category_id = hit.category.category_id; base.category_source = 'rule';
      }
      // A name supplied with the row wins (and is created if new); otherwise a rule's payee.
      const payee = base.merchant ? resolvePayee(db, base.merchant) : null;
      if (payee) { base.merchant = payee.name; base.payee_id = payee.id; }
      else if (hit.payee) { base.merchant = hit.payee.merchant; base.payee_id = hit.payee.payee_id; }
      return { ...base, status: 'new' as const };
    };
  const rows = opts.transactions.map(prepare);
  // Pending rows follow the file's settled ones. Their balance is the available balance, not the running one.
  const pendingRows = (opts.pending ?? []).map((t, i) => prepare({ ...t, balance: null }, opts.transactions.length + i));
  for (const r of pendingRows) if (r.status === 'new') r.status = 'pending';

  // Duplicate detection against what's already stored for this account. Each stored row can
  // absorb at most one incoming row, so two genuine identical purchases on one day both survive.
  const valid = rows.filter((r) => r.status !== 'invalid');
  const dates = valid.map((r) => r.date!).sort();
  const start = dates[0] ?? null;
  const end = dates[dates.length - 1] ?? null;
  if (start && end) {
    const existing = db
      .prepare('SELECT id, date, amount_cents, dedupe_key FROM transactions WHERE account_id = ? AND pending = 0 AND date BETWEEN ? AND ?')
      .all(account.id, start, end) as { id: number; date: string; amount_cents: number; dedupe_key: string }[];
    const used = new Set<number>();
    const byKey = new Map<string, number[]>();
    const byLoose = new Map<string, number[]>();
    for (const e of existing) {
      (byKey.get(e.dedupe_key) ?? byKey.set(e.dedupe_key, []).get(e.dedupe_key)!).push(e.id);
      const loose = `${e.date}|${e.amount_cents}`;
      (byLoose.get(loose) ?? byLoose.set(loose, []).get(loose)!).push(e.id);
    }
    const take = (ids: number[] | undefined) => {
      const id = ids?.find((x) => !used.has(x));
      if (id != null) used.add(id);
      return id;
    };
    // Exact matches first so a loose match never steals a row that has an exact twin.
    for (const r of valid) {
      const id = take(byKey.get(dedupeKey(account.id, r.date!, r.amount_cents, r.description)));
      if (id != null) { r.status = 'duplicate'; r.matches_id = id; }
    }
    for (const r of valid) {
      if (r.status !== 'new') continue;
      const id = take(byLoose.get(`${r.date}|${r.amount_cents}`));
      if (id != null) { r.status = 'possible_duplicate'; r.matches_id = id; }
    }
  }

  // Stored pending rows: settled by a row in this file, still pending in it, or gone.
  const stored = db.prepare(`SELECT t.id, t.date, t.description, t.amount_cents, t.dedupe_key, t.category_id, t.categorized_by,
      t.payee_id, t.notes, c.name AS category, p.name AS merchant
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN payees p ON p.id = t.payee_id
    WHERE t.account_id = ? AND t.pending = 1`).all(account.id) as StoredPending[];
  const settles = matchSettled(stored, valid.filter((r) => r.status === 'new'));
  for (const [p, r] of settles) { r.status = 'settles'; r.matches_id = p.id; }
  const open = stored.filter((p) => !settles.some(([s]) => s === p));
  for (const r of pendingRows) {
    if (r.status !== 'pending') continue;
    const p = open.find((x) => x.dedupe_key === dedupeKey(account.id, r.date!, r.amount_cents, r.description));
    if (p) { r.status = 'still_pending'; r.matches_id = p.id; open.splice(open.indexOf(p), 1); }
  }
  // A pending row that has already settled (an old export imported again) isn't new.
  const fresh = pendingRows.filter((r) => r.status === 'pending');
  if (fresh.length) {
    const dates = fresh.map((r) => r.date!).sort();
    const settledRows = db.prepare('SELECT id, date, description, amount_cents FROM transactions WHERE account_id = ? AND pending = 0 AND date BETWEEN ? AND ?')
      .all(account.id, dates[0], addDays(dates[dates.length - 1], 4)) as { id: number; date: string; description: string; amount_cents: number }[];
    for (const [r, t] of matchSettled(fresh, [...settledRows, ...valid])) {
      r.status = 'duplicate';
      if ('id' in t) r.matches_id = t.id;
    }
  }
  // A file that lists what's pending and covers a stored pending row's date without it: it never settled.
  const listed = [...valid, ...pendingRows.filter((r) => r.status !== 'invalid')].map((r) => r.date!).sort();
  const expired = opts.pending ? open.filter((p) => p.date >= listed[0] && p.date <= listed[listed.length - 1]) : [];

  const importPossible = opts.possibleDuplicates === 'import';
  const toInsert = [...rows.filter((r) => r.status === 'new' || (importPossible && r.status === 'possible_duplicate')),
    ...pendingRows.filter((r) => r.status === 'pending')];

  let reconciliation: ImportResult['reconciliation'] = null;
  if (opts.openingBalance != null && opts.closingBalance != null) {
    let expected = toCents(opts.closingBalance) - toCents(opts.openingBalance);
    const net = sumOf(valid);
    // Credit card statements often show the balance owed as a positive number, so spending raises it.
    if (account.type === 'credit' && net !== expected && net === -expected) expected = -expected;
    reconciliation = {
      opening_balance: opts.openingBalance, closing_balance: opts.closingBalance,
      expected_net: expected / 100, statement_net: net / 100, difference: (net - expected) / 100, ok: net === expected,
    };
  }

  let importId: number | null = null;
  const categorizedBy = opts.categorizedBy ?? (opts.source === 'csv' ? 'user' : 'ai');
  const pendingFrom = pendingRows.filter((r) => r.status !== 'invalid').map((r) => r.date!).sort()[0] ?? null;
  // Every import is recorded, even one that adds nothing, so the history shows which dates have been checked.
  // A re-import of dates already covered adds nothing to that, so it's left out.
  const before = start && end ? accountCoverage(db, account.id, account.name) : null;
  const span = start && end ? coveredSpan({ period_start: start, period_end: end, pending_from: pendingFrom }) : null;
  const alreadyCovered = !!span && (span.end < span.start || before!.segments.some((g) => g.start <= span.start && span.end <= g.end));
  if (toInsert.length > 0 || settles.length > 0 || (span && !alreadyCovered)) {
    importId = Number(
      db.prepare(`INSERT INTO imports (source, label, account_id, period_start, period_end, pending_from, inserted, skipped)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(opts.source, opts.label ?? null, account.id, start, end, pendingFrom, toInsert.length, rows.length - toInsert.length)
        .lastInsertRowid,
    );
  }
  const ids: number[] = [];
  const by = (r: Row) => (r.category_id == null ? null : r.category_source === 'rule' ? 'rule' : categorizedBy);
  if (toInsert.length > 0) {
    const ins = db.prepare(`INSERT INTO transactions (account_id, date, description, payee_id, amount_cents,
        balance_cents, category_id, categorized_by, notes, memo, source, import_id, dedupe_key, pending)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of toInsert) {
      ids.push(Number(ins.run(account.id, r.date, r.description, r.payee_id, r.amount_cents, r.balance_cents, r.category_id, by(r),
        r.notes, r.memo, opts.source, importId, dedupeKey(account.id, r.date!, r.amount_cents, r.description),
        r.status === 'pending' ? 1 : 0).lastInsertRowid));
    }
  }
  // The settled version takes over the pending row, so its category, payee, notes, splits and links stay. A category
  // someone chose wins over what rules make of the new text.
  const settle = db.prepare(`UPDATE transactions SET date = ?, description = ?, amount_cents = ?, balance_cents = ?, dedupe_key = ?,
      pending = 0, category_id = ?, categorized_by = ?, payee_id = ?, notes = ? WHERE id = ?`);
  for (const [p, r] of settles) {
    const chosen = p.categorized_by === 'ai' || p.categorized_by === 'user' || r.category_id == null;
    settle.run(r.date, r.description, r.amount_cents, r.balance_cents, dedupeKey(account.id, r.date!, r.amount_cents, r.description),
      chosen ? p.category_id : r.category_id, chosen ? p.categorized_by : by(r), p.payee_id ?? r.payee_id, p.notes ?? r.notes, p.id);
    ids.push(p.id);
  }
  if (expired.length) db.prepare(`DELETE FROM transactions WHERE id IN (${expired.map(() => '?').join(',')})`).run(...expired.map((p) => p.id));
  fillMemos(db, ids);
  linkRecurring(db, ids);

  const count = (s: RowStatus) => [...rows, ...pendingRows].filter((r) => r.status === s).length;
  const after = accountCoverage(db, account.id, account.name);
  // Gaps that touch this file's dates: the ones it may have opened or failed to close.
  const near = span && { from: addDays(span.start, -1), to: addDays(span.end, 1) };
  const gaps = near ? after.gaps.filter((g) => g.from <= near.to && g.to >= near.from) : [];
  return {
    dry_run: !!opts.dryRun,
    import_id: opts.dryRun ? null : importId,
    account: account.name,
    account_created: created,
    inserted: toInsert.filter((r) => r.status !== 'pending').length,
    duplicates: count('duplicate'),
    possible_duplicates: count('possible_duplicate'),
    possible_duplicates_skipped: !importPossible,
    invalid: count('invalid'),
    uncategorized: toInsert.filter((r) => r.category_id == null).length,
    unknown_categories: [...unknownCategories],
    period: { start, end },
    reconciliation,
    pending: {
      added: count('pending'), still_pending: count('still_pending'), settled: settles.length,
      expired: expired.map(({ id, date, description, amount_cents, category, merchant }) => ({ id, date, description, amount_cents, category, merchant })),
    },
    coverage: { covered_to: after.covered_to, next_export_from: after.next_export_from, gaps },
    rows: [...rows, ...pendingRows].map(({ category_id: _c, payee_id: _p, balance_cents: _b, notes: _n, ...r }) => r),
  };
}

type Row = PreviewRow & { category_id: number | null; payee_id: number | null; balance_cents: number | null; notes: string | null; memo: string | null };

type Dated = { date: string | null; description: string; amount_cents: number };

type StoredPending = {
  id: number; date: string; description: string; amount_cents: number; dedupe_key: string;
  category_id: number | null; categorized_by: Row['category_source'] | 'ai' | 'user' | null; payee_id: number | null; notes: string | null;
  category: string | null; merchant: string | null;
};

/**
 * Pairs stored pending rows with their settled version among the new rows. The bank rewrites the text ("AUTHORISATION
 * ONLY - EFTPOS PURCHASE AT BWS 1234 SUBIACO WAAU" settles as "BWS 12 SUBIACO AUS"), usually under the
 * same date but sometimes a few days later, and the amount can change (tips, fuel, holds). So a pair needs the same amount
 * and a word in common (or the same day), or two words in common; exact amounts win, then more words, then the nearest date.
 */
function matchSettled<P extends Dated, R extends Dated>(stored: P[], rows: R[]): [P, R][] {
  const options: { p: P; r: R; rank: number[] }[] = [];
  for (const p of stored) {
    const pw = merchantWords(p.description);
    for (const r of rows) {
      const days = (Date.parse(r.date!) - Date.parse(p.date!)) / 86_400_000;
      if (days < 0 || days > 4 || Math.sign(r.amount_cents) !== Math.sign(p.amount_cents)) continue;
      const rw = merchantWords(r.description);
      const shared = pw.filter((w) => rw.some((x) => x === w || (Math.min(x.length, w.length) >= 4 && (x.startsWith(w) || w.startsWith(x))))).length;
      const sameAmount = r.amount_cents === p.amount_cents;
      // A changed amount needs more to go on: one word could just be the suburb.
      if (sameAmount ? shared === 0 && days > 0 : shared < 2) continue;
      options.push({ p, r, rank: [sameAmount ? 0 : 1, -shared, days] });
    }
  }
  options.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2]);
  const pairs: [P, R][] = [];
  for (const o of options) {
    if (pairs.some(([p, r]) => p === o.p || r === o.r)) continue;
    pairs.push([o.p, o.r]);
  }
  return pairs;
}

function merchantWords(description: string) {
  return description.toUpperCase().replace(/^AUTHORISATION ONLY\s*-\s*(EFTPOS PURCHASE AT\s*)?/, '')
    .split(/[^A-Z]+/).filter((w) => w.length >= 3 && !/^(QLD|NSW|VIC|TAS|ACT|WA|SA|NT)?(AUS?)?$/.test(w) && !['PTY', 'LTD', 'THE'].includes(w));
}

function sumOf(rows: { amount_cents: number }[]) {
  return rows.reduce((s, r) => s + r.amount_cents, 0);
}
