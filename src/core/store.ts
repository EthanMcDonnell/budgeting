import type { DB } from './db.ts';
import { isMonth, memoFrom, normalizeDate, normalizeDescription, toCents } from './util.ts';

/** An error caused by bad input; the API maps it to HTTP 400 and MCP returns it as a tool error. */
export class UserError extends Error {}

export type CategoryKind = 'expense' | 'income' | 'transfer';
export type AccountType = 'transaction' | 'savings' | 'credit' | 'other';

export type PayeeKind = 'merchant' | 'person';

export interface Category { id: number; name: string; kind: CategoryKind; sort: number; archived: number; bucket_id: number | null }
export type BucketKind = 'spend' | 'save';
/** A share of income (`percent`) or a fixed monthly amount; spending categories belong to one. A 'save' bucket fills from what's left over. */
export interface Bucket {
  id: number; name: string; kind: BucketKind; percent: number | null; amount_cents: number | null; sort: number;
  /** 1 = the target is what its recurring payments come to each month (see `scheduledInMonth`). */
  follows_recurring: number;
  /** 1 = gives or takes the month-to-month difference in buckets that follow recurring payments. At most one. */
  balances: number;
}
export interface Account { id: number; name: string; institution: string; type: AccountType; number: string | null }
/** A shop or person money goes to or comes from. */
export interface Payee { id: number; name: string; kind: PayeeKind; notes: string | null }
/** Sets a category, a payee, or both on transactions whose description matches. `merchant` is the payee's name. */
export interface Rule {
  id: number; pattern: string; match_type: 'contains' | 'regex';
  category_id: number | null; category: string | null;
  payee_id: number | null; merchant: string | null; payee_kind: PayeeKind | null;
}
/** `merchant` is the linked payee's friendly name; `description` is the bank's text. */
export interface Transaction {
  id: number; account_id: number; account: string; date: string; description: string;
  merchant: string | null; payee_id: number | null; payee_kind: PayeeKind | null; amount_cents: number; balance_cents: number | null;
  category_id: number | null; category: string | null; category_kind: CategoryKind | null;
  categorized_by: 'rule' | 'ai' | 'user' | null; notes: string | null; source: string; import_id: number | null;
  /** What the other person wrote on it (transfer message, Beem memo), word for word. `notes` is ours. */
  memo: string | null;
  recurring_id: number | null; recurring: string | null; contributor_id: number | null; contributor: string | null;
  /** Money out shared with others: its split, how many ways, and what people still owe on it (flagged until they pay). */
  split_id: number | null; split_ways: number | null; split_owed_cents: number | null;
  /** Money in paying back a share: the split it pays and that purchase's name. */
  payback_split_id: number | null; payback_for: string | null;
}

export function dedupeKey(accountId: number, date: string, amountCents: number, description: string) {
  return `${accountId}|${date}|${amountCents}|${normalizeDescription(description)}`;
}

// ---------- categories ----------

export function listCategories(db: DB, includeArchived = false): Category[] {
  return db
    .prepare(`SELECT * FROM categories ${includeArchived ? '' : 'WHERE archived = 0'}
              ORDER BY CASE kind WHEN 'expense' THEN 0 WHEN 'income' THEN 1 ELSE 2 END, sort, name`)
    .all() as Category[];
}

export function findCategory(db: DB, ref: string | number | null | undefined): Category | null {
  if (ref == null || ref === '') return null;
  if (typeof ref === 'number') return (db.prepare('SELECT * FROM categories WHERE id = ?').get(ref) as Category) ?? null;
  return (db.prepare('SELECT * FROM categories WHERE name = ? COLLATE NOCASE').get(ref.trim()) as Category) ?? null;
}

export function requireCategory(db: DB, ref: string | number): Category {
  const c = findCategory(db, ref);
  if (!c) throw new UserError(`Unknown category: ${ref}`);
  return c;
}

export function createCategory(db: DB, name: string, kind: CategoryKind = 'expense', bucket?: string | number | null): Category {
  name = name.trim();
  if (!name) throw new UserError('Category name is required');
  if (findCategory(db, name)) throw new UserError(`Category "${name}" already exists`);
  const bucketId = bucket == null || kind !== 'expense' ? null : requireBucket(db, bucket).id;
  const sort = (db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM categories').get() as { s: number }).s;
  const id = db.prepare('INSERT INTO categories (name, kind, sort, bucket_id) VALUES (?, ?, ?, ?)').run(name, kind, sort, bucketId).lastInsertRowid;
  return findCategory(db, Number(id))!;
}

/** `bucket` (id or name, null for none) only applies to spending categories; changing kind away from spending drops it. */
export function updateCategory(db: DB, id: number, patch: { name?: string; kind?: CategoryKind; archived?: boolean; bucket?: string | number | null }) {
  const c = requireCategory(db, id);
  if (patch.name && patch.name.trim().toLowerCase() !== c.name.toLowerCase() && findCategory(db, patch.name)) {
    throw new UserError(`Category "${patch.name}" already exists`);
  }
  const kind = patch.kind ?? c.kind;
  if (patch.bucket != null && kind !== 'expense') throw new UserError(`Only spending categories go in buckets; "${c.name}" is ${kind}`);
  const bucketId = kind !== 'expense' ? null : patch.bucket === undefined ? c.bucket_id : patch.bucket === null ? null : requireBucket(db, patch.bucket).id;
  db.prepare('UPDATE categories SET name = ?, kind = ?, archived = ?, bucket_id = ? WHERE id = ?').run(
    patch.name?.trim() || c.name,
    kind,
    patch.archived == null ? c.archived : Number(patch.archived),
    bucketId,
    id,
  );
  return findCategory(db, id)!;
}

/** Deletes a category; its transactions become uncategorised, or merge into `reassignTo`. */
export function deleteCategory(db: DB, id: number, reassignTo?: number | null) {
  if (reassignTo) return mergeCategory(db, id, reassignTo);
  requireCategory(db, id);
  // Rules that also link a payee keep doing that; the rest go with the category.
  db.prepare('UPDATE rules SET category_id = NULL WHERE category_id = ? AND payee_id IS NOT NULL').run(id);
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  return { transactions: 0, rules: 0 };
}

/** Moves a category's transactions and rules into another, then deletes it. */
export function mergeCategory(db: DB, from: string | number, into: string | number) {
  const src = requireCategory(db, from);
  const dst = requireCategory(db, into);
  if (src.id === dst.id) throw new UserError('Cannot merge a category into itself');
  if (src.kind !== dst.kind) throw new UserError(`"${src.name}" is ${src.kind} but "${dst.name}" is ${dst.kind}`);
  return db.transaction(() => {
    const transactions = db.prepare('UPDATE transactions SET category_id = ? WHERE category_id = ?').run(dst.id, src.id).changes;
    const rules = db.prepare('UPDATE rules SET category_id = ? WHERE category_id = ?').run(dst.id, src.id).changes;
    db.prepare('DELETE FROM categories WHERE id = ?').run(src.id);
    return { transactions, rules };
  })();
}

// ---------- accounts ----------

export function listAccounts(db: DB): (Account & { tx_count: number })[] {
  return db
    .prepare(`SELECT a.*, (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id) AS tx_count
              FROM accounts a ORDER BY a.id`)
    .all() as (Account & { tx_count: number })[];
}

export function findAccount(db: DB, ref: string | number | null | undefined): Account | null {
  if (ref == null || ref === '') return null;
  if (typeof ref === 'number') return (db.prepare('SELECT * FROM accounts WHERE id = ?').get(ref) as Account) ?? null;
  return (db.prepare('SELECT * FROM accounts WHERE name = ? COLLATE NOCASE').get(ref.trim()) as Account) ?? null;
}

export function createAccount(
  db: DB,
  input: { name: string; type?: AccountType; institution?: string; number?: string | null },
): Account {
  const name = input.name.trim();
  if (!name) throw new UserError('Account name is required');
  if (findAccount(db, name)) throw new UserError(`Account "${name}" already exists`);
  const id = db
    .prepare('INSERT INTO accounts (name, type, institution, number) VALUES (?, ?, ?, ?)')
    .run(name, input.type ?? 'transaction', input.institution ?? 'Bankwest', input.number ?? null).lastInsertRowid;
  return findAccount(db, Number(id))!;
}

export function updateAccount(db: DB, id: number, patch: Partial<Omit<Account, 'id'>>) {
  const a = findAccount(db, id);
  if (!a) throw new UserError(`Unknown account: ${id}`);
  db.prepare('UPDATE accounts SET name = ?, type = ?, institution = ?, number = ? WHERE id = ?').run(
    patch.name?.trim() || a.name, patch.type ?? a.type, patch.institution ?? a.institution,
    patch.number === undefined ? a.number : patch.number, id,
  );
  return findAccount(db, id)!;
}

export function deleteAccount(db: DB, id: number) {
  const n = (db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?').get(id) as { n: number }).n;
  if (n > 0) throw new UserError(`Account has ${n} transactions; delete or undo those imports first`);
  db.prepare('DELETE FROM imports WHERE account_id = ?').run(id);
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
}

/** Finds an account by name, creating it if needed. Falls back to the only account, or a default one. */
export function resolveAccount(db: DB, ref: string | number | null | undefined): { account: Account; created: boolean } {
  const found = findAccount(db, ref);
  if (found) return { account: found, created: false };
  if (typeof ref === 'number') throw new UserError(`Unknown account id: ${ref}`);
  if (ref && ref.trim()) {
    const type: AccountType = /credit|card|mastercard|visa/i.test(ref) ? 'credit' : /sav/i.test(ref) ? 'savings' : 'transaction';
    return { account: createAccount(db, { name: ref, type }), created: true };
  }
  const all = listAccounts(db);
  if (all.length === 1) return { account: all[0], created: false };
  if (all.length > 1) throw new UserError(`Specify an account: ${all.map((a) => a.name).join(', ')}`);
  return { account: createAccount(db, { name: 'Bankwest Everyday' }), created: true };
}

// ---------- payees (shops and people) ----------

export function findPayee(db: DB, ref: string | number | null | undefined): Payee | null {
  if (ref == null || ref === '') return null;
  if (typeof ref === 'number') return (db.prepare('SELECT id, name, kind, notes FROM payees WHERE id = ?').get(ref) as Payee) ?? null;
  return (db.prepare('SELECT id, name, kind, notes FROM payees WHERE name = ? COLLATE NOCASE').get(ref.trim()) as Payee) ?? null;
}

export function requirePayee(db: DB, ref: string | number): Payee {
  const p = findPayee(db, ref);
  if (!p) throw new UserError(`Unknown merchant or person: ${ref}`);
  return p;
}

export function createPayee(db: DB, input: { name: string; kind?: PayeeKind; notes?: string | null }): Payee {
  const name = input.name.trim();
  if (!name) throw new UserError('A name is required');
  if (findPayee(db, name)) throw new UserError(`"${name}" already exists`);
  const id = db.prepare('INSERT INTO payees (name, kind, notes) VALUES (?, ?, ?)')
    .run(name, input.kind ?? 'merchant', input.notes?.trim() || null).lastInsertRowid;
  return findPayee(db, Number(id))!;
}

/** Finds a payee by name, creating it (as `kind`) if it doesn't exist. Blank names give null. */
export function resolvePayee(db: DB, name: string | null | undefined, kind: PayeeKind = 'merchant'): Payee | null {
  if (!name?.trim()) return null;
  return findPayee(db, name) ?? createPayee(db, { name, kind });
}

export function updatePayee(db: DB, id: number, patch: { name?: string; kind?: PayeeKind; notes?: string | null }): Payee {
  const p = requirePayee(db, id);
  const name = patch.name?.trim() || p.name;
  const clash = findPayee(db, name);
  if (clash && clash.id !== id) throw new UserError(`"${clash.name}" already exists; merge into it instead`);
  db.prepare('UPDATE payees SET name = ?, kind = ?, notes = ? WHERE id = ?').run(
    name, patch.kind ?? p.kind, patch.notes === undefined ? p.notes : patch.notes?.trim() || null, id,
  );
  return findPayee(db, id)!;
}

/** Moves a payee's transactions and rules onto another, then deletes it. */
export function mergePayee(db: DB, from: string | number, into: string | number) {
  const src = requirePayee(db, from);
  const dst = requirePayee(db, into);
  if (src.id === dst.id) throw new UserError('Cannot merge into itself');
  return db.transaction(() => {
    const transactions = db.prepare('UPDATE transactions SET payee_id = ? WHERE payee_id = ?').run(dst.id, src.id).changes;
    const rules = db.prepare('UPDATE rules SET payee_id = ? WHERE payee_id = ?').run(dst.id, src.id).changes;
    mergeShares(db, src.id, dst.id);
    db.prepare('DELETE FROM payees WHERE id = ?').run(src.id);
    return { into: dst.name, transactions, rules };
  })();
}

/** The names a person's payments open with on statements: their payee name and their rules' text ("DAVID HILL"). */
export function personNames(db: DB): Map<number, string[]> {
  const out = new Map<number, string[]>();
  const add = (id: number, name: string) => (out.get(id) ?? out.set(id, []).get(id)!).push(name);
  for (const p of db.prepare("SELECT id, name FROM payees WHERE kind = 'person'").all() as { id: number; name: string }[]) add(p.id, p.name);
  for (const r of db.prepare(`SELECT r.payee_id, r.pattern FROM rules r JOIN payees p ON p.id = r.payee_id
    WHERE p.kind = 'person' AND r.match_type = 'contains'`).all() as { payee_id: number; pattern: string }[]) add(r.payee_id, r.pattern);
  return out;
}

/** Fills in the memo, from the bank text, on transactions that don't have one yet. */
export function fillMemos(db: DB, ids?: number[]) {
  const names = personNames(db);
  const rows = db.prepare(`SELECT t.id, t.description, t.payee_id, p.kind FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id
    WHERE t.memo IS NULL`).all() as { id: number; description: string; payee_id: number | null; kind: PayeeKind | null }[];
  const only = ids ? new Set(ids) : null;
  const upd = db.prepare('UPDATE transactions SET memo = ? WHERE id = ?');
  let n = 0;
  for (const t of rows) {
    if (only && !only.has(t.id)) continue;
    const memo = memoFrom(t.description, t.kind === 'person' && t.payee_id != null ? names.get(t.payee_id) ?? [] : []);
    if (memo) { upd.run(memo, t.id); n++; }
  }
  return n;
}

/** Moves a payee's shares of split purchases onto another. */
function mergeShares(db: DB, from: number, into: number) {
  db.prepare('UPDATE OR IGNORE split_shares SET payee_id = ? WHERE payee_id = ?').run(into, from);
  // Both had a share of the same split: fold the old one into theirs.
  const clashes = db.prepare(`SELECT a.id AS src, b.id AS dst, a.amount_cents FROM split_shares a
    JOIN split_shares b ON b.split_id = a.split_id AND b.payee_id = ? WHERE a.payee_id = ?`).all(into, from) as { src: number; dst: number; amount_cents: number }[];
  for (const c of clashes) {
    db.prepare('UPDATE split_shares SET amount_cents = amount_cents + ? WHERE id = ?').run(c.amount_cents, c.dst);
    db.prepare(`INSERT INTO split_payments (share_id, transaction_id, amount_cents)
      SELECT ?, transaction_id, amount_cents FROM split_payments WHERE share_id = ? AND true
      ON CONFLICT (share_id, transaction_id) DO UPDATE SET amount_cents = amount_cents + excluded.amount_cents`).run(c.dst, c.src);
    db.prepare('DELETE FROM split_shares WHERE id = ?').run(c.src);
  }
}

/** Deletes a payee. Its transactions keep their categories; rules that only linked it are removed. */
export function deletePayee(db: DB, id: number) {
  requirePayee(db, id);
  return db.transaction(() => {
    const transactions = db.prepare('UPDATE transactions SET payee_id = NULL WHERE payee_id = ?').run(id).changes;
    db.prepare('UPDATE rules SET payee_id = NULL WHERE payee_id = ? AND category_id IS NOT NULL').run(id);
    db.prepare('DELETE FROM payees WHERE id = ?').run(id);
    return { transactions };
  })();
}

// ---------- rules ----------

export function listRules(db: DB): Rule[] {
  return db
    .prepare(`SELECT r.id, r.pattern, r.match_type, r.category_id, c.name AS category,
                r.payee_id, p.name AS merchant, p.kind AS payee_kind
              FROM rules r LEFT JOIN categories c ON c.id = r.category_id LEFT JOIN payees p ON p.id = r.payee_id
              ORDER BY c.name IS NULL, c.name, r.pattern`)
    .all() as Rule[];
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface CompiledRule extends Rule { test: (description: string) => boolean }

/** Compiles rules into matchers, most specific (longest) first. */
export function compileRules(rules: Rule[]): CompiledRule[] {
  const compiled: CompiledRule[] = [];
  for (const r of rules) {
    let re: RegExp;
    try {
      if (r.match_type === 'regex') re = new RegExp(r.pattern, 'i');
      else {
        const p = r.pattern.trim();
        const pre = /^[A-Za-z0-9]/.test(p) ? '(?<![A-Za-z0-9])' : '';
        const post = /[A-Za-z0-9]$/.test(p) ? '(?![A-Za-z0-9])' : '';
        re = new RegExp(pre + escapeRegex(p) + post, 'i');
      }
    } catch {
      continue; // an invalid regex shouldn't break imports
    }
    compiled.push({ ...r, test: (d) => re.test(d) });
  }
  return compiled.sort((a, b) =>
    a.match_type === b.match_type ? b.pattern.length - a.pattern.length : a.match_type === 'contains' ? -1 : 1,
  );
}

export function matchRule(rules: CompiledRule[], description: string): CompiledRule | null {
  return rules.find((r) => r.test(description)) ?? null;
}

/** The most specific matching rule that sets a category, and the one that sets a payee (often the same rule). */
export function matchRules(rules: CompiledRule[], description: string) {
  const hits = rules.filter((r) => r.test(description));
  return {
    category: hits.find((r) => r.category_id != null) ?? null,
    payee: hits.find((r) => r.payee_id != null) ?? null,
  };
}

export interface RuleInput {
  pattern: string; match_type?: 'contains' | 'regex';
  category?: string | number | null;
  /** Payee name; created if new (as `payee_kind`, default merchant). */
  merchant?: string | null; payee_id?: number | null; payee_kind?: PayeeKind;
}

/** Adds a rule, or replaces the category and payee of the rule with the same pattern. */
export function addRule(db: DB, input: RuleInput): Rule {
  const pattern = input.pattern.trim();
  if (!pattern) throw new UserError('Rule pattern is required');
  const matchType = input.match_type ?? 'contains';
  if (matchType === 'regex') {
    try { new RegExp(pattern); } catch (e) { throw new UserError(`Invalid regex: ${(e as Error).message}`); }
  }
  const cat = input.category != null && input.category !== '' ? requireCategory(db, input.category) : null;
  const payee = input.payee_id != null ? requirePayee(db, input.payee_id) : resolvePayee(db, input.merchant, input.payee_kind);
  if (!cat && !payee) throw new UserError('A rule needs a category, a merchant/person, or both');
  db.prepare(
    `INSERT INTO rules (pattern, match_type, category_id, payee_id) VALUES (?, ?, ?, ?)
     ON CONFLICT (pattern, match_type) DO UPDATE SET category_id = excluded.category_id, payee_id = excluded.payee_id`,
  ).run(pattern, matchType, cat?.id ?? null, payee?.id ?? null);
  return listRules(db).find((r) => r.pattern === pattern && r.match_type === matchType)!;
}

export function deleteRule(db: DB, id: number) {
  db.prepare('DELETE FROM rules WHERE id = ?').run(id);
}

/**
 * Runs rules over transactions (all, or only `ids`): fills in the category where there is none,
 * and links a payee where there is none. Never overwrites either.
 */
export function applyRules(db: DB, ids?: number[]): { categorized: number; linked: number } {
  const rules = compileRules(listRules(db));
  const rows = db
    .prepare('SELECT id, description, category_id, payee_id FROM transactions WHERE category_id IS NULL OR payee_id IS NULL')
    .all() as { id: number; description: string; category_id: number | null; payee_id: number | null }[];
  const only = ids ? new Set(ids) : null;
  const setCat = db.prepare("UPDATE transactions SET category_id = ?, categorized_by = 'rule' WHERE id = ?");
  const setPayee = db.prepare('UPDATE transactions SET payee_id = ? WHERE id = ?');
  let categorized = 0;
  let linked = 0;
  db.transaction(() => {
    for (const r of rows) {
      if (only && !only.has(r.id)) continue;
      const hit = matchRules(rules, r.description);
      if (r.category_id == null && hit.category) { setCat.run(hit.category.category_id, r.id); categorized++; }
      if (r.payee_id == null && hit.payee) { setPayee.run(hit.payee.payee_id, r.id); linked++; }
    }
  })();
  return { categorized, linked };
}

/** Applies rules (see `applyRules`) and returns how many transactions were categorised. */
export function applyRulesToUncategorized(db: DB, ids?: number[]): number {
  return applyRules(db, ids).categorized;
}

// ---------- transactions ----------

export interface TxFilter {
  month?: string; from?: string; to?: string; category?: string | number | 'uncategorized';
  account?: string | number; search?: string; kind?: CategoryKind; limit?: number; offset?: number;
  /** Payee id or name, or 'none' for transactions not linked to one. */
  payee?: string | number | 'none';
  /** Bucket id or name: transactions in any of its categories. */
  bucket?: string | number;
}

const TX_SELECT = `
  SELECT t.id, t.account_id, a.name AS account, t.date, t.description, p.name AS merchant, t.payee_id,
         p.kind AS payee_kind, t.amount_cents,
         t.balance_cents, t.category_id, c.name AS category, c.kind AS category_kind,
         t.categorized_by, t.notes, t.memo, t.source, t.import_id, t.recurring_id, r.name AS recurring,
         t.contributor_id, rc.name AS contributor,
         s.id AS split_id, (SELECT COUNT(*) + 1 FROM split_shares ss WHERE ss.split_id = s.id) AS split_ways,
         (SELECT SUM(MAX(ss.amount_cents - COALESCE((SELECT SUM(sp.amount_cents) FROM split_payments sp WHERE sp.share_id = ss.id), 0), 0))
           FROM split_shares ss WHERE ss.split_id = s.id AND ss.settled = 0) AS split_owed_cents,
         pb.split_id AS payback_split_id, pb.name AS payback_for
  FROM transactions t
  JOIN accounts a ON a.id = t.account_id
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN payees p ON p.id = t.payee_id
  LEFT JOIN recurring r ON r.id = t.recurring_id
  LEFT JOIN recurring_contributors rc ON rc.id = t.contributor_id
  LEFT JOIN splits s ON s.transaction_id = t.id
  LEFT JOIN (
    SELECT sp.transaction_id, MIN(ss.split_id) AS split_id, MIN(COALESCE(pp.name, pt.description)) AS name
    FROM split_payments sp JOIN split_shares ss ON ss.id = sp.share_id JOIN splits s2 ON s2.id = ss.split_id
    JOIN transactions pt ON pt.id = s2.transaction_id LEFT JOIN payees pp ON pp.id = pt.payee_id
    GROUP BY sp.transaction_id
  ) pb ON pb.transaction_id = t.id`;

function txWhere(db: DB, f: TxFilter) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.month) {
    if (!isMonth(f.month)) throw new UserError(`Invalid month "${f.month}" (expected YYYY-MM)`);
    where.push("strftime('%Y-%m', t.date) = ?"); params.push(f.month);
  }
  if (f.from) { where.push('t.date >= ?'); params.push(f.from); }
  if (f.to) { where.push('t.date <= ?'); params.push(f.to); }
  if (f.category === 'uncategorized') where.push('t.category_id IS NULL');
  else if (f.category != null && f.category !== '') {
    where.push('t.category_id = ?'); params.push(requireCategory(db, f.category).id);
  }
  if (f.account != null && f.account !== '') {
    const a = findAccount(db, f.account);
    if (!a) throw new UserError(`Unknown account: ${f.account}`);
    where.push('t.account_id = ?'); params.push(a.id);
  }
  if (f.kind) { where.push('c.kind = ?'); params.push(f.kind); }
  if (f.bucket != null && f.bucket !== '') { where.push('c.bucket_id = ?'); params.push(requireBucket(db, f.bucket).id); }
  if (f.payee === 'none') where.push('t.payee_id IS NULL');
  else if (f.payee != null && f.payee !== '') {
    where.push('t.payee_id = ?'); params.push(requirePayee(db, f.payee).id);
  }
  if (f.search?.trim()) {
    where.push('(t.description LIKE ? OR p.name LIKE ? OR t.notes LIKE ? OR t.memo LIKE ?)');
    const q = `%${f.search.trim()}%`;
    params.push(q, q, q, q);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export function listTransactions(db: DB, f: TxFilter = {}) {
  const { sql, params } = txWhere(db, f);
  const limit = Math.min(Math.max(f.limit ?? 500, 1), 5000);
  const rows = db
    .prepare(`${TX_SELECT} ${sql} ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, f.offset ?? 0) as Transaction[];
  const totals = db
    .prepare(`SELECT COUNT(*) AS count,
                COALESCE(SUM(CASE WHEN t.amount_cents < 0 THEN -t.amount_cents END), 0) AS out_cents,
                COALESCE(SUM(CASE WHEN t.amount_cents > 0 THEN t.amount_cents END), 0) AS in_cents
              FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
              LEFT JOIN payees p ON p.id = t.payee_id ${sql}`)
    .get(...params) as { count: number; out_cents: number; in_cents: number };
  return { transactions: rows, ...totals };
}

export function getTransaction(db: DB, id: number): Transaction {
  const t = db.prepare(`${TX_SELECT} WHERE t.id = ?`).get(id) as Transaction | undefined;
  if (!t) throw new UserError(`Unknown transaction: ${id}`);
  return t;
}

export interface ManualTxInput {
  account?: string | number; date: string; description: string; amount: number;
  category?: string | number | null; notes?: string | null;
  /** What the other person wrote on it, word for word. */
  memo?: string | null;
  /** Payee name, created if new; or `payee_id` for an existing one. */
  merchant?: string | null; payee_id?: number | null; payee_kind?: PayeeKind;
}

export function addManualTransaction(db: DB, input: ManualTxInput): Transaction {
  const date = normalizeDate(input.date);
  if (!date) throw new UserError(`Invalid date: ${input.date}`);
  if (!input.description?.trim()) throw new UserError('Description is required');
  const { account } = resolveAccount(db, input.account);
  const cents = toCents(input.amount);
  const cat = input.category != null && input.category !== '' ? requireCategory(db, input.category) : null;
  const payee = input.payee_id != null ? requirePayee(db, input.payee_id) : resolvePayee(db, input.merchant, input.payee_kind);
  const id = db
    .prepare(`INSERT INTO transactions (account_id, date, description, payee_id, amount_cents, category_id,
                categorized_by, notes, memo, source, dedupe_key)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)`)
    .run(account.id, date, input.description.trim(), payee?.id ?? null, cents, cat?.id ?? null,
      cat ? 'user' : null, input.notes?.trim() || null, input.memo?.trim() || null, dedupeKey(account.id, date, cents, input.description))
    .lastInsertRowid;
  applyRules(db, [Number(id)]);
  fillMemos(db, [Number(id)]);
  return getTransaction(db, Number(id));
}

export interface TxPatch {
  date?: string; description?: string; amount?: number;
  category?: string | number | null; notes?: string | null; account?: string | number;
  /** What the other person wrote on it, word for word (e.g. a Beem memo), or null to clear. */
  memo?: string | null;
  /** Payee name (created if new, as `payee_kind`), or null to unlink. `payee_id` links an existing one. */
  merchant?: string | null; payee_id?: number | null; payee_kind?: PayeeKind;
  /** Link to a recurring item, or null to unlink. */
  recurring_id?: number | null;
  /** For money in: which of the item's contributors it came from. */
  contributor_id?: number | null;
}

export function updateTransaction(db: DB, id: number, patch: TxPatch, by: 'user' | 'ai' = 'user'): Transaction {
  const t = getTransaction(db, id);
  const date = patch.date != null ? normalizeDate(patch.date) : t.date;
  if (!date) throw new UserError(`Invalid date: ${patch.date}`);
  const description = patch.description?.trim() || t.description;
  const amount = patch.amount != null ? toCents(patch.amount) : t.amount_cents;
  const accountId = patch.account != null ? (findAccount(db, patch.account)?.id ?? -1) : t.account_id;
  if (accountId < 0) throw new UserError(`Unknown account: ${patch.account}`);
  let categoryId = t.category_id;
  let categorizedBy = t.categorized_by;
  if (patch.category !== undefined) {
    categoryId = patch.category == null || patch.category === '' ? null : requireCategory(db, patch.category).id;
    categorizedBy = categoryId == null ? null : by;
  }
  if (patch.recurring_id != null && !db.prepare('SELECT 1 FROM recurring WHERE id = ?').get(patch.recurring_id)) {
    throw new UserError(`Unknown recurring item: ${patch.recurring_id}`);
  }
  const recurringId = patch.recurring_id === undefined ? t.recurring_id : patch.recurring_id;
  // Changing the item clears who it came from unless that's given too.
  let contributorId = patch.contributor_id !== undefined ? patch.contributor_id
    : patch.recurring_id !== undefined && patch.recurring_id !== t.recurring_id ? null : t.contributor_id;
  if (contributorId != null) {
    const c = db.prepare('SELECT recurring_id FROM recurring_contributors WHERE id = ?').get(contributorId) as { recurring_id: number } | undefined;
    if (!c || c.recurring_id !== recurringId) throw new UserError('That person isn\'t on this recurring payment');
  }
  if (recurringId == null) contributorId = null;
  const payeeId = patch.payee_id !== undefined ? (patch.payee_id == null ? null : requirePayee(db, patch.payee_id).id)
    : patch.merchant !== undefined ? resolvePayee(db, patch.merchant, patch.payee_kind)?.id ?? null
    : t.payee_id;
  db.prepare(`UPDATE transactions SET date = ?, description = ?, payee_id = ?, amount_cents = ?, account_id = ?,
                category_id = ?, categorized_by = ?, notes = ?, memo = ?, dedupe_key = ?, recurring_id = ?, contributor_id = ? WHERE id = ?`).run(
    date, description, payeeId,
    amount, accountId, categoryId, categorizedBy,
    patch.notes === undefined ? t.notes : patch.notes?.trim() || null,
    patch.memo === undefined ? t.memo : patch.memo?.trim() || null,
    dedupeKey(accountId, date, amount, description),
    recurringId,
    contributorId,
    id,
  );
  return getTransaction(db, id);
}

export function setCategoryForMany(db: DB, ids: number[], category: string | number | null, by: 'user' | 'ai' = 'user') {
  const catId = category == null || category === '' ? null : requireCategory(db, category).id;
  const stmt = db.prepare('UPDATE transactions SET category_id = ?, categorized_by = ? WHERE id = ?');
  let n = 0;
  db.transaction(() => { for (const id of ids) n += stmt.run(catId, catId ? by : null, id).changes; })();
  return n;
}

export function deleteTransactions(db: DB, ids: number[]) {
  const stmt = db.prepare('DELETE FROM transactions WHERE id = ?');
  let n = 0;
  db.transaction(() => { for (const id of ids) n += stmt.run(id).changes; })();
  return n;
}

// ---------- buckets ----------

export function listBuckets(db: DB): Bucket[] {
  return db.prepare('SELECT * FROM buckets ORDER BY sort, id').all() as Bucket[];
}

export function findBucket(db: DB, ref: string | number): Bucket | null {
  if (typeof ref === 'number') return (db.prepare('SELECT * FROM buckets WHERE id = ?').get(ref) as Bucket) ?? null;
  return (db.prepare('SELECT * FROM buckets WHERE name = ? COLLATE NOCASE').get(ref.trim()) as Bucket) ?? null;
}

export function requireBucket(db: DB, ref: string | number): Bucket {
  const b = findBucket(db, ref);
  if (!b) throw new UserError(`Unknown bucket: ${ref}`);
  return b;
}

/**
 * A bucket's target is a percentage of income (follows income), a fixed amount in dollars (doesn't), or, for a
 * spending bucket, whatever its recurring payments come to that month; only one of them. Passing one replaces the
 * others; passing null for percent or amount clears the target.
 */
interface BucketInput {
  name?: string; kind?: BucketKind; percent?: number | null; amount?: number | null;
  follows_recurring?: boolean; balances?: boolean;
}

type Target = { percent: number | null; amount_cents: number | null; follows_recurring: number };

function target(patch: BucketInput, current: Target): Target {
  const given = [patch.percent != null, patch.amount != null, !!patch.follows_recurring].filter(Boolean).length;
  if (given > 1) throw new UserError('Give only one of a percentage, an amount or follows_recurring');
  if (patch.percent != null) {
    if (!Number.isFinite(patch.percent) || patch.percent < 0 || patch.percent > 100) throw new UserError('Percentage must be between 0 and 100');
    return { percent: Math.round(patch.percent * 100) / 100, amount_cents: null, follows_recurring: 0 };
  }
  if (patch.amount != null) {
    if (patch.amount < 0) throw new UserError('Amount must be zero or more');
    return { percent: null, amount_cents: toCents(patch.amount), follows_recurring: 0 };
  }
  if (patch.follows_recurring) return { percent: null, amount_cents: null, follows_recurring: 1 };
  if (patch.percent === null || patch.amount === null || patch.follows_recurring === false) return { percent: null, amount_cents: null, follows_recurring: 0 };
  return current;
}

/** Checks the target suits the bucket, and makes this the only balancing bucket when it balances. */
function saveTargetRules(db: DB, id: number, kind: BucketKind, t: Target, balances: boolean) {
  if (t.follows_recurring && kind !== 'spend') throw new UserError('Only a spending bucket can follow its recurring payments');
  if (t.follows_recurring && balances) throw new UserError('A bucket that follows its recurring payments can’t also balance them');
  if (balances) db.prepare('UPDATE buckets SET balances = 0 WHERE id != ?').run(id);
}

function bucketName(db: DB, name: string, except?: number) {
  name = name.trim();
  if (!name) throw new UserError('Bucket name is required');
  const clash = findBucket(db, name);
  if (clash && clash.id !== except) throw new UserError(`Bucket "${name}" already exists`);
  return name;
}

export function createBucket(db: DB, input: BucketInput & { name: string }): Bucket {
  const name = bucketName(db, input.name);
  const kind = input.kind ?? 'spend';
  const t = target(input, { percent: null, amount_cents: null, follows_recurring: 0 });
  const sort = (db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM buckets').get() as { s: number }).s;
  const id = db.transaction(() => {
    const id = Number(db.prepare('INSERT INTO buckets (name, kind, percent, amount_cents, follows_recurring, balances, sort) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(name, kind, t.percent, t.amount_cents, t.follows_recurring, input.balances ? 1 : 0, sort).lastInsertRowid);
    saveTargetRules(db, id, kind, t, !!input.balances);
    return id;
  })();
  return findBucket(db, id)!;
}

export function updateBucket(db: DB, ref: string | number, patch: BucketInput): Bucket {
  const b = requireBucket(db, ref);
  const name = patch.name == null ? b.name : bucketName(db, patch.name, b.id);
  const kind = patch.kind ?? b.kind;
  const t = target(patch, b);
  const balances = patch.balances ?? !!b.balances;
  db.transaction(() => {
    saveTargetRules(db, b.id, kind, t, balances);
    db.prepare('UPDATE buckets SET name = ?, kind = ?, percent = ?, amount_cents = ?, follows_recurring = ?, balances = ? WHERE id = ?')
      .run(name, kind, t.percent, t.amount_cents, t.follows_recurring, balances ? 1 : 0, b.id);
    // A savings bucket is measured by what's left over, so it holds no spending.
    if (kind === 'save') db.prepare('UPDATE categories SET bucket_id = NULL WHERE bucket_id = ?').run(b.id);
  })();
  return findBucket(db, b.id)!;
}

/** Deletes a bucket; its categories are left without one. */
export function deleteBucket(db: DB, ref: string | number) {
  const b = requireBucket(db, ref);
  const categories = db.prepare('UPDATE categories SET bucket_id = NULL WHERE bucket_id = ?').run(b.id).changes;
  db.prepare('DELETE FROM buckets WHERE id = ?').run(b.id);
  return { deleted: b.name, categories_unassigned: categories };
}

/** Puts spending categories into a bucket (each moves out of any other). */
export function assignCategories(db: DB, bucket: string | number, categories: (string | number)[]) {
  const b = requireBucket(db, bucket);
  if (b.kind !== 'spend') throw new UserError(`"${b.name}" is a savings bucket; it fills from what's left over, so it has no categories`);
  const cats = categories.map((c) => requireCategory(db, c));
  const wrong = cats.find((c) => c.kind !== 'expense');
  if (wrong) throw new UserError(`Only spending categories go in buckets; "${wrong.name}" is ${wrong.kind}`);
  const set = db.prepare('UPDATE categories SET bucket_id = ? WHERE id = ?');
  db.transaction(() => { for (const c of cats) set.run(b.id, c.id); })();
  return { bucket: b.name, categories: cats.map((c) => c.name) };
}

/** Makes `categories` exactly the spending categories in a bucket: those listed move in, the rest of its own are left without one. */
export function setBucketCategories(db: DB, bucket: string | number, categories: (string | number)[]) {
  const b = requireBucket(db, bucket);
  return db.transaction(() => {
    const keep = new Set(categories.map((c) => requireCategory(db, c).id));
    const clear = db.prepare('UPDATE categories SET bucket_id = NULL WHERE id = ?');
    for (const { id } of db.prepare('SELECT id FROM categories WHERE bucket_id = ?').all(b.id) as { id: number }[]) {
      if (!keep.has(id)) clear.run(id);
    }
    return keep.size ? assignCategories(db, b.id, [...keep]) : { bucket: b.name, categories: [] };
  })();
}

// ---------- settings ----------

export function getSetting(db: DB, key: string): string | null {
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
}

function setSetting(db: DB, key: string, value: string | null) {
  if (value == null) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** The monthly income bucket percentages are worked out from, in dollars. null goes back to the recent average. */
export function setPlannedIncome(db: DB, amount: number | null) {
  if (amount != null && !(amount > 0)) throw new UserError('Monthly income must be more than zero');
  setSetting(db, 'planned_income_cents', amount == null ? null : String(toCents(amount)));
  return { planned_income: amount };
}

// ---------- imports ----------

export function listImports(db: DB) {
  return db
    .prepare(`SELECT i.*, a.name AS account,
                (SELECT COUNT(*) FROM transactions t WHERE t.import_id = i.id) AS tx_count
              FROM imports i LEFT JOIN accounts a ON a.id = i.account_id
              ORDER BY i.id DESC`)
    .all();
}

/** Undoes an import by deleting it and every transaction it created. */
export function deleteImport(db: DB, id: number) {
  const n = (db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE import_id = ?').get(id) as { n: number }).n;
  const changes = db.prepare('DELETE FROM imports WHERE id = ?').run(id).changes;
  if (!changes) throw new UserError(`Unknown import: ${id}`);
  return n;
}
