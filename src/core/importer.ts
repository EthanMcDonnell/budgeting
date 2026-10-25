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
  /** Earliest pending authorisation the file left out (see ParsedCsv.pending): the import covers only the days before it. */
  pendingFrom?: string | null;
}

export type RowStatus = 'new' | 'duplicate' | 'possible_duplicate' | 'invalid';

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
  /** What the account's imports cover with this one included. `gaps` are only those next to this file's dates. */
  coverage: { covered_to: string | null; next_export_from: string | null; gaps: CoverageGap[] };
}

export function importTransactions(db: DB, opts: ImportOptions): ImportResult {
  if (!Array.isArray(opts.transactions) || opts.transactions.length === 0) {
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
  const groups = new Map<string, IncomingTransaction[]>();
  for (const { accountNumber = '', ...t } of parsed.transactions) {
    if (!groups.has(accountNumber)) groups.set(accountNumber, []);
    groups.get(accountNumber)!.push(t);
  }
  const pendingFrom = (n: string) => parsed.pending.filter((p) => (p.accountNumber ?? '') === n).map((p) => p.date).sort()[0] ?? null;
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
  const run = () => [...groups].map(([n, transactions]) => {
    const target = owner(n);
    const r = importTransactions(db, { ...opts, account: target?.id ?? opts.account, source: 'csv', transactions, pendingFrom: pendingFrom(n) });
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

  const rows: (PreviewRow & { category_id: number | null; payee_id: number | null; balance_cents: number | null; notes: string | null; memo: string | null })[] =
    opts.transactions.map((t, index) => {
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
    });

  // Duplicate detection against what's already stored for this account. Each stored row can
  // absorb at most one incoming row, so two genuine identical purchases on one day both survive.
  const valid = rows.filter((r) => r.status !== 'invalid');
  const dates = valid.map((r) => r.date!).sort();
  const start = dates[0] ?? null;
  const end = dates[dates.length - 1] ?? null;
  if (start && end) {
    const existing = db
      .prepare('SELECT id, date, amount_cents, dedupe_key FROM transactions WHERE account_id = ? AND date BETWEEN ? AND ?')
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

  const importPossible = opts.possibleDuplicates === 'import';
  const toInsert = rows.filter((r) => r.status === 'new' || (importPossible && r.status === 'possible_duplicate'));

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
  const pendingFrom = opts.pendingFrom ?? null;
  // Every import is recorded, even one that adds nothing, so the history shows which dates have been checked.
  // A re-import of dates already covered adds nothing to that, so it's left out.
  const before = start && end ? accountCoverage(db, account.id, account.name) : null;
  const span = start && end ? coveredSpan({ period_start: start, period_end: end, pending_from: pendingFrom }) : null;
  const alreadyCovered = !!span && (span.end < span.start || before!.segments.some((g) => g.start <= span.start && span.end <= g.end));
  if (span && (toInsert.length > 0 || !alreadyCovered)) {
    importId = Number(
      db.prepare(`INSERT INTO imports (source, label, account_id, period_start, period_end, pending_from, inserted, skipped)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(opts.source, opts.label ?? null, account.id, start, end, pendingFrom, toInsert.length, rows.length - toInsert.length)
        .lastInsertRowid,
    );
  }
  if (toInsert.length > 0) {
    const ins = db.prepare(`INSERT INTO transactions (account_id, date, description, payee_id, amount_cents,
        balance_cents, category_id, categorized_by, notes, memo, source, import_id, dedupe_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const ids: number[] = [];
    for (const r of toInsert) {
      ids.push(Number(ins.run(account.id, r.date, r.description, r.payee_id, r.amount_cents, r.balance_cents, r.category_id,
        r.category_id == null ? null : r.category_source === 'rule' ? 'rule' : categorizedBy,
        r.notes, r.memo, opts.source, importId, dedupeKey(account.id, r.date!, r.amount_cents, r.description)).lastInsertRowid));
    }
    fillMemos(db, ids);
    linkRecurring(db, ids);
  }

  const count = (s: RowStatus) => rows.filter((r) => r.status === s).length;
  const after = accountCoverage(db, account.id, account.name);
  // Gaps that touch this file's dates: the ones it may have opened or failed to close.
  const near = span && { from: addDays(span.start, -1), to: addDays(span.end, 1) };
  const gaps = near ? after.gaps.filter((g) => g.from <= near.to && g.to >= near.from) : [];
  return {
    dry_run: !!opts.dryRun,
    import_id: opts.dryRun ? null : importId,
    account: account.name,
    account_created: created,
    inserted: toInsert.length,
    duplicates: count('duplicate'),
    possible_duplicates: count('possible_duplicate'),
    possible_duplicates_skipped: !importPossible,
    invalid: count('invalid'),
    uncategorized: toInsert.filter((r) => r.category_id == null).length,
    unknown_categories: [...unknownCategories],
    period: { start, end },
    reconciliation,
    coverage: { covered_to: after.covered_to, next_export_from: after.next_export_from, gaps },
    rows: rows.map(({ category_id: _c, payee_id: _p, balance_cents: _b, notes: _n, ...r }) => r),
  };
}

function sumOf(rows: { amount_cents: number }[]) {
  return rows.reduce((s, r) => s + r.amount_cents, 0);
}
