import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { openDb } from '../core/db.ts';
import { parseBankCsv } from '../core/csv.ts';
import { importTransactions } from '../core/importer.ts';
import * as recurring from '../core/recurring.ts';
import { listPayees, payeeDetail } from '../core/payees.ts';
import { budgetPlan, monthSummary, overview, trends, type BucketTarget } from '../core/reports.ts';
import * as splits from '../core/splits.ts';
import * as store from '../core/store.ts';
import { fromCents } from '../core/util.ts';

// stdout carries the MCP protocol; anything else must go to stderr.
console.log = console.error;

const db = openDb();
// The schema version this code knows. If newer code migrates the database while this server keeps running
// (a session that isn't on the launcher), every call would hit confusing SQL errors; say what to do instead.
const SCHEMA = db.pragma('user_version', { simple: true }) as number;
function checkSchema() {
  if ((db.pragma('user_version', { simple: true }) as number) !== SCHEMA) {
    throw new Error('The budget MCP server is out of date: the database was updated by newer code. Ask the user to run /mcp and reconnect "budget" (or restart Claude Code), then try again. Don\'t work around this.');
  }
}
const server = new McpServer(
  { name: 'budget', version: '0.1.0' },
  {
    instructions: `Local personal budgeting database (Australian dollars, Bankwest accounts).
Amounts are in dollars: negative = money out, positive = money in.
Typical month-end flow: budget_overview -> read the statement -> import_transactions (dry_run first) ->
list_transactions with category "uncategorized" -> categorize_transactions (add rules for recurring merchants) -> month_summary.
Transfers between the user's own accounts and credit card repayments belong in transfer categories so they aren't counted as spending.
Money in from people is usually a payback for their share of something you paid: after categorising, run find_paybacks and
confirm the matches so what people owe stays right.
Each transaction can link to a payee: a merchant (shop) or a person, shown by its friendly name ("merchant") next to the bank's
description. Passing a merchant name links it, creating the payee if new; set person=true when it's a person. Rules can set a
category, a payee, or both (person rules usually have no category, since what you pay a person for varies).`,
  },
);

type Json = Record<string, unknown> | unknown[];

function ok(data: Json) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function tool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  run: (args: z.infer<z.ZodObject<S>>) => Json,
  readOnly = false,
) {
  server.registerTool(
    name,
    { description, inputSchema: shape, annotations: { readOnlyHint: readOnly, destructiveHint: false } },
    // The SDK's generic callback type doesn't narrow cleanly through this wrapper.
    (async (args: z.infer<z.ZodObject<S>>) => {
      try {
        checkSchema();
        return ok(run(args));
      } catch (e) {
        return { isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] };
      }
    }) as never,
  );
}

const dollars = (c: number | null | undefined) => (c == null ? null : fromCents(c));

const txOut = (t: store.Transaction) => ({
  id: t.id, date: t.date, account: t.account, description: t.description, merchant: t.merchant,
  ...(t.payee_kind === 'person' ? { person: true } : {}),
  amount: fromCents(t.amount_cents), category: t.category, categorized_by: t.categorized_by, ...(t.memo ? { memo: t.memo } : {}), notes: t.notes,
  recurring: t.recurring, from: t.contributor,
  ...(t.split_id != null ? { split_id: t.split_id, split_ways: t.split_ways } : {}),
  ...(t.payback_split_id != null ? { payback_for: t.payback_for, payback_split_id: t.payback_split_id } : {}),
});

const month = z.string().regex(/^\d{4}-\d{2}$/).describe('Month as YYYY-MM');

// ---------- context ----------

tool('budget_overview',
  'Start here. Lists accounts, categories (with kind), rule count, data coverage and the number of uncategorised transactions.',
  {},
  () => ({
    ...overview(db),
    accounts: store.listAccounts(db).map(({ id, name, type, institution, number, tx_count }) => ({ id, name, type, institution, number, transactions: tx_count })),
    categories: (() => {
      const buckets = new Map(store.listBuckets(db).map((b) => [b.id, b.name]));
      return store.listCategories(db).map((c) => ({ name: c.name, kind: c.kind, ...(c.kind === 'expense' ? { bucket: buckets.get(c.bucket_id!) ?? null } : {}) }));
    })(),
    rules: store.listRules(db).length,
  }), true);

tool('list_rules', 'Lists rules: description pattern -> category and/or payee (merchant or person).', {},
  () => store.listRules(db).map(({ id, pattern, match_type, category, merchant, payee_kind }) => ({
    id, pattern, match_type, category, merchant, ...(payee_kind === 'person' ? { person: true } : {}),
  })), true);

// ---------- importing ----------

const incoming = z.object({
  date: z.string().describe('YYYY-MM-DD preferred; DD/MM/YYYY accepted'),
  description: z.string().describe('Transaction description exactly as printed on the statement'),
  amount: z.number().describe('Dollars. Negative = money out (purchase/fee/transfer out), positive = money in'),
  category: z.string().optional().describe('Existing category name. Omit to let rules decide'),
  merchant: z.string().optional().describe('Clean merchant name, e.g. "Woolworths"'),
  notes: z.string().optional(),
  balance: z.number().optional().describe('Running balance after this transaction, if shown'),
});

tool('import_transactions',
  `Imports transactions read from a bank statement (e.g. a Bankwest PDF). Skips exact duplicates of already-imported
transactions, and by default also skips "possible duplicates" (same account, date and amount but different text) - these
are reported so you can re-run with possible_duplicates="import" if they're genuine. Supply opening/closing balance to
verify every line was captured. Run with dry_run=true first and check the reconciliation.`,
  {
    account: z.string().describe('Account name, e.g. "Bankwest Everyday" or "Bankwest Mastercard". Created if new'),
    statement_label: z.string().optional().describe('e.g. "Everyday statement Sep 2026"'),
    transactions: z.array(incoming).min(1),
    opening_balance: z.number().optional(),
    closing_balance: z.number().optional(),
    possible_duplicates: z.enum(['skip', 'import']).optional(),
    dry_run: z.boolean().optional(),
  },
  (a) => {
    const r = importTransactions(db, {
      account: a.account, source: 'pdf', label: a.statement_label, transactions: a.transactions,
      openingBalance: a.opening_balance, closingBalance: a.closing_balance,
      possibleDuplicates: a.possible_duplicates, dryRun: a.dry_run, categorizedBy: 'ai',
    });
    const { rows, ...rest } = r;
    return {
      ...rest,
      invalid_rows: rows.filter((x) => x.status === 'invalid'),
      duplicate_rows: rows.filter((x) => x.status === 'duplicate' || x.status === 'possible_duplicate')
        .map((x) => ({ index: x.index, status: x.status, date: x.date, description: x.description, amount: x.amount_cents / 100, matches_id: x.matches_id })),
    };
  });

tool('import_csv_file',
  'Imports a CSV transaction export (Bankwest Online Banking export, or any CSV with date/description/amount or debit/credit columns) from a local file path. Rules categorise what they can.',
  {
    path: z.string().describe('Absolute path to the CSV, ~ allowed'),
    account: z.string().describe('Account name; created if new'),
    possible_duplicates: z.enum(['skip', 'import']).optional(),
    dry_run: z.boolean().optional(),
  },
  (a) => {
    const file = a.path.startsWith('~') ? path.join(os.homedir(), a.path.slice(1)) : a.path;
    const parsed = parseBankCsv(fs.readFileSync(file, 'utf8'));
    const r = importTransactions(db, {
      account: a.account, source: 'csv', label: path.basename(file), transactions: parsed.transactions,
      possibleDuplicates: a.possible_duplicates, dryRun: a.dry_run,
    });
    const { rows, ...rest } = r;
    return {
      ...rest, format: parsed.format, unreadable_rows: parsed.skippedRows,
      duplicate_rows: rows.filter((x) => x.status !== 'new').map((x) => ({ index: x.index, status: x.status, date: x.date, description: x.description, amount: x.amount_cents / 100 })),
    };
  });

tool('list_imports', 'Lists past imports (most recent first) with their ids, for review or undo.', {},
  () => store.listImports(db) as Json, true);

tool('undo_import', 'Deletes an import and every transaction it created.', { import_id: z.number().int() },
  (a) => ({ deleted_transactions: store.deleteImport(db, a.import_id) }));

// ---------- transactions ----------

tool('list_transactions',
  'Lists transactions, newest first. Use category="uncategorized" to find ones that still need a category.',
  {
    month: month.optional(),
    from: z.string().optional().describe('YYYY-MM-DD inclusive'),
    to: z.string().optional().describe('YYYY-MM-DD inclusive'),
    category: z.string().optional().describe('Category name, or "uncategorized"'),
    account: z.string().optional(),
    search: z.string().optional().describe('Text in description, merchant or notes'),
    merchant: z.string().optional().describe('Payee (merchant or person) name, or "none" for transactions with no payee'),
    bucket: z.string().optional().describe('Budget bucket name: transactions in any of its categories'),
    limit: z.number().int().max(2000).optional().describe('Default 200'),
  },
  (a) => {
    const { merchant, ...f } = a;
    const r = store.listTransactions(db, { ...f, payee: merchant, limit: a.limit ?? 200 });
    return {
      count: r.count, total_out: fromCents(r.out_cents), total_in: fromCents(r.in_cents),
      returned: r.transactions.length, transactions: r.transactions.map(txOut),
    };
  }, true);

const merchantArg = z.string().optional().describe('Friendly payee name: a shop ("Zambrero Subiaco") or person ("Riley"). Created if new');
const personArg = z.boolean().optional().describe('The payee is a person, not a shop (used when creating it)');

tool('categorize_transactions',
  'Sets category (and optionally merchant, notes, memo) on transactions by id. Optionally add rules so similar transactions are categorised and linked automatically next time.',
  {
    updates: z.array(z.object({
      id: z.number().int(),
      category: z.string().optional().describe('Existing category name'),
      merchant: merchantArg,
      person: personArg,
      notes: z.string().optional().describe('Your own commentary'),
      memo: z.string().optional().describe('What the other person wrote on it, word for word (e.g. the Beem memo from a screenshot)'),
    })),
    rules: z.array(z.object({
      pattern: z.string().describe('Text that appears in the description, e.g. "GUZMAN Y GOMEZ"'),
      match_type: z.enum(['contains', 'regex']).optional(),
      category: z.string().optional(),
      merchant: merchantArg,
      person: personArg,
    })).optional(),
  },
  (a) => {
    let updated = 0;
    db.transaction(() => {
      for (const u of a.updates) {
        store.updateTransaction(db, u.id, {
          category: u.category, merchant: u.merchant, payee_kind: u.person ? 'person' : undefined, notes: u.notes, memo: u.memo,
        }, 'ai');
        updated++;
      }
      for (const r of a.rules ?? []) store.addRule(db, { ...r, payee_kind: r.person ? 'person' : undefined });
    })();
    const hits = a.rules?.length ? store.applyRules(db) : { categorized: 0, linked: 0 };
    return { updated, rules_added: a.rules?.length ?? 0, also_categorized_by_new_rules: hits.categorized, also_linked_to_payee: hits.linked };
  });

tool('add_transaction', 'Adds a single transaction by hand (e.g. a cash purchase).',
  {
    account: z.string().optional(), date: z.string(), description: z.string(), amount: z.number(),
    category: z.string().optional(), merchant: merchantArg, person: personArg, notes: z.string().optional(),
  },
  (a) => {
    const t = store.addManualTransaction(db, { ...a, payee_kind: a.person ? 'person' : undefined });
    recurring.linkRecurring(db, [t.id]);
    return txOut(store.getTransaction(db, t.id));
  });

tool('update_transaction', 'Edits one transaction. Omitted fields are unchanged.',
  {
    id: z.number().int(), date: z.string().optional(), description: z.string().optional(), amount: z.number().optional(),
    category: z.string().nullable().optional(), notes: z.string().nullable().optional(),
    memo: z.string().nullable().optional().describe('What the other person wrote on it, word for word'),
    merchant: z.string().nullable().optional().describe('Payee name (created if new), or null to unlink'), person: personArg,
  },
  ({ id, person, ...patch }) => txOut(store.updateTransaction(db, id, { ...patch, payee_kind: person ? 'person' : undefined }, 'ai')));

tool('delete_transactions', 'Deletes transactions by id.', { ids: z.array(z.number().int()).min(1) },
  (a) => ({ deleted: store.deleteTransactions(db, a.ids) }));

// ---------- categories & rules ----------

const bucketArg = z.string().nullable().optional().describe('Budget bucket for a spending category (see get_budgets); null for none');

tool('create_category', 'Creates a category. kind: expense (counts as spending), income, or transfer (ignored in totals).',
  { name: z.string(), kind: z.enum(['expense', 'income', 'transfer']).optional(), bucket: bucketArg },
  (a) => store.createCategory(db, a.name, a.kind ?? 'expense', a.bucket) as unknown as Json);

tool('update_category', 'Renames, re-kinds, archives or moves a category to another budget bucket.',
  { category: z.string(), name: z.string().optional(), kind: z.enum(['expense', 'income', 'transfer']).optional(), archived: z.boolean().optional(), bucket: bucketArg },
  (a) => store.updateCategory(db, store.requireCategory(db, a.category).id, a) as unknown as Json);

tool('merge_categories', 'Moves all transactions and rules from one category into another, then deletes the first.',
  { from: z.string(), into: z.string() },
  (a) => store.mergeCategory(db, a.from, a.into));

tool('add_rule', 'Adds or updates a rule that sets a category, a payee (merchant or person), or both. "contains" matches whole words, case-insensitive.',
  {
    pattern: z.string(), category: z.string().optional(), merchant: merchantArg, person: personArg,
    match_type: z.enum(['contains', 'regex']).optional(),
    apply_now: z.boolean().optional().describe('Also apply it now to transactions missing a category or payee'),
  },
  (a) => {
    const rule = store.addRule(db, { ...a, payee_kind: a.person ? 'person' : undefined });
    const r = a.apply_now ? store.applyRules(db) : { categorized: 0, linked: 0 };
    return { rule, categorized: r.categorized, linked: r.linked };
  });

tool('delete_rule', 'Deletes a rule by id.', { id: z.number().int() }, (a) => { store.deleteRule(db, a.id); return { ok: true }; });

tool('apply_rules', 'Runs all rules over transactions missing a category or payee.', {},
  () => store.applyRules(db));

// ---------- payees (merchants and people) ----------

const payeeRef = (name: string) => store.requirePayee(db, name).id;

tool('list_payees',
  'Lists merchants and/or people with totals: all time, the given month, and the 12 months to it. For people, bills_owed is what they still owe for split bills on the Recurring page.',
  { kind: z.enum(['merchant', 'person']).optional(), month: month.optional(), search: z.string().optional() },
  (a) => {
    const r = listPayees(db, { kind: a.kind, month: a.month });
    const q = a.search?.toLowerCase();
    return {
      month: r.month,
      payees: r.payees
        .filter((p) => !q || p.name.toLowerCase().includes(q) || p.bank_names.some((n) => n.toLowerCase().includes(q)))
        .map((p) => ({
          name: p.name, kind: p.kind, category: p.category, bank_names: p.bank_names.slice(0, 5), rules: p.patterns,
          transactions: p.tx_count, last: p.last_date, out_total: dollars(p.out_cents), in_total: dollars(p.in_cents),
          out_month: dollars(p.month_out_cents), in_month: dollars(p.month_in_cents),
          out_12m: dollars(p.year_out_cents), in_12m: dollars(p.year_in_cents),
          ...(p.kind === 'person' ? { bills_owed: dollars(p.bills_owed_cents), shared_costs_owed: dollars(p.split_owed_cents) } : {}),
        })),
    };
  }, true);

tool('payee_detail', 'One merchant or person: monthly totals, categories, bank names, rules and recent transactions.',
  { merchant: z.string(), months: z.number().int().min(1).max(120).optional() },
  (a) => {
    const d = payeeDetail(db, payeeRef(a.merchant), { months: a.months ?? 12 });
    return {
      name: d.name, kind: d.kind, notes: d.notes,
      totals: { transactions: d.totals.tx_count, first: d.totals.first_date, last: d.totals.last_date, out: dollars(d.totals.out_cents), in: dollars(d.totals.in_cents), bills_owed: dollars(d.totals.bills_owed_cents), shared_costs_owed: dollars(d.totals.split_owed_cents) },
      shared_costs: d.splits.map(splitOut),
      months: d.months.filter((m) => m.count).map((m) => ({ month: m.month, out: dollars(m.out_cents), in: dollars(m.in_cents) })),
      categories: d.categories.map((c) => ({ category: c.category, out: dollars(c.out_cents), in: dollars(c.in_cents), count: c.count })),
      bank_names: d.bank_names, rules: d.rules.map((r) => ({ pattern: r.pattern, match_type: r.match_type, category: r.category })),
      recent: d.transactions.slice(0, 30).map(txOut),
    };
  }, true);

tool('update_payee', 'Renames a merchant or person, changes its kind, or sets notes. The new name shows on all its transactions.',
  { merchant: z.string(), name: z.string().optional(), kind: z.enum(['merchant', 'person']).optional(), notes: z.string().nullable().optional() },
  ({ merchant, ...patch }) => store.updatePayee(db, payeeRef(merchant), patch) as unknown as Json);

tool('merge_payees', 'Moves every transaction and rule from one merchant/person onto another, then deletes the first. Use for duplicates like "GYG" and "Guzman y Gomez".',
  { from: z.string(), into: z.string() },
  (a) => store.mergePayee(db, a.from, a.into));

// ---------- recurring ----------

const freq = z.enum(['weekly', 'fortnightly', 'monthly', 'quarterly', 'yearly']);
const people = z.array(z.object({
  name: z.string(),
  pattern: z.string().describe("Text in their incoming payment's description, e.g. \"Monthly Internet\""),
  match_type: z.enum(['contains', 'regex']).optional(),
  share_amount: z.number().nonnegative().optional().describe('Dollars they cover per bill; omit for an even split'),
})).describe('People who chip in. Replaces the current list.');

tool('list_recurring',
  'Recurring payments tracked as items (rent, electricity, phone, subscriptions): typical amount, last paid, next due, status (overdue/due_soon/awaiting_data), plus untracked payments that look recurring.',
  {},
  () => {
    const r = recurring.listRecurring(db);
    const spread = new Map(recurring.spreadBills(db).map((s) => [s.id, s]));
    return {
      data_through: r.data_through,
      monthly_total: dollars(r.monthly_total_cents),
      your_monthly_total: dollars(r.your_monthly_total_cents),
      owed_to_you: dollars(r.owed_to_you_cents),
      items: r.items.map((i) => ({
        name: i.name, pattern: i.pattern, frequency: i.frequency, active: !!i.active, category: i.category,
        typical: dollars(i.typical_cents), per_month: dollars(i.monthly_cents), your_share: dollars(i.your_share_cents),
        spread_monthly: spread.has(i.id) ? { amount: dollars(spread.get(i.id)!.monthly_cents), from: spread.get(i.id)!.from } : undefined,
        split_with: i.contributors.map((c) => ({ name: c.name, pattern: c.pattern, share: dollars(c.share_cents) })),
        owed_to_you: dollars(i.owed_to_you_cents),
        current_bill: i.current_cycle && {
          date: i.current_cycle.date, bill_paid: i.current_cycle.bill_paid,
          shares: i.current_cycle.shares.map((s) => ({ name: s.name, status: s.status, paid: dollars(s.paid_cents), expected: dollars(s.expected_cents) })),
        },
        last_paid: i.last_paid && { date: i.last_paid.date, amount: dollars(i.last_paid.amount_cents) },
        change_vs_previous: dollars(i.change_cents), next_due: i.next_due, status: i.status, payments: i.payment_count,
        paid_back_by_others_90d: dollars(i.credits_90d_cents),
      })),
      suggestions: r.suggestions.map((s) => ({ ...s, typical: dollars(s.typical_cents), typical_cents: undefined })),
    };
  }, true);

const recurringCategory = z.string().nullable().optional()
  .describe('Category its bills go in (needed before the first bill for quarterly/yearly ones to be spread); default: whichever its payments are in');

tool('add_recurring',
  'Tracks a recurring payment as its own item. pattern is text in the bill\'s bank description (whole words, any case). Optionally split it with people whose payments are then matched and filed under the bill. Past matches are linked automatically. Quarterly and yearly bills are spread in budgets: each month counts your monthly part instead of the bill in the month it\'s paid.',
  {
    name: z.string(), pattern: z.string(), frequency: freq, expected_amount: z.number().nonnegative().optional(),
    match_type: z.enum(['contains', 'regex']).optional(), category: recurringCategory, contributors: people.optional(),
  },
  (a) => recurring.createRecurring(db, a) as unknown as Json);

tool('update_recurring', 'Edits a recurring item (by name). Set active=false to stop tracking without deleting.',
  {
    item: z.string(), name: z.string().optional(), pattern: z.string().optional(), frequency: freq.optional(),
    expected_amount: z.number().nonnegative().nullable().optional(), active: z.boolean().optional(), category: recurringCategory, contributors: people.optional(),
  },
  ({ item, ...patch }) => recurring.updateRecurring(db, recurring.getRecurring(db, item).id, patch) as unknown as Json);

tool('delete_recurring', 'Stops tracking a recurring item (transactions are kept).', { item: z.string() },
  (a) => { recurring.deleteRecurring(db, recurring.getRecurring(db, a.item).id); return { ok: true }; });

tool('link_transaction_to_recurring', 'Links (or with item=null unlinks) a transaction to a recurring item. For a person paying their share, give from = their name on that item.',
  { id: z.number().int(), item: z.string().nullable(), from: z.string().optional() },
  (a) => {
    const item = a.item == null ? null : recurring.getRecurring(db, a.item);
    const person = a.from && item ? recurring.listContributors(db, item.id).find((c) => c.name.toLowerCase() === a.from!.toLowerCase()) : null;
    if (a.from && !person) throw new Error(`${a.from} isn't on ${a.item}`);
    return txOut(store.updateTransaction(db, a.id, { recurring_id: item?.id ?? null, contributor_id: person?.id ?? null }, 'ai'));
  });

// ---------- shared costs (splits and paybacks) ----------

const splitOut = (s: splits.Split) => ({
  split_id: s.id, purchase_id: s.transaction_id, date: s.date, merchant: s.merchant ?? s.description, amount: dollars(s.amount_cents),
  category: s.category, notes: s.notes, ways: s.ways, your_share: dollars(s.your_share_cents), still_owed: dollars(s.owed_cents),
  shares: s.shares.map((x) => ({
    share_id: x.id, person: x.person ?? '(not named yet)', share: dollars(x.amount_cents), paid: dollars(x.paid_cents), status: x.status,
    payments: x.payments.map((p) => ({ id: p.transaction_id, date: p.date, amount: dollars(p.amount_cents) })),
  })),
});

const purchaseOut = (q: { id: number; date: string; merchant: string; amount_cents: number; category: string | null; notes: string | null; already_split: boolean }) => ({
  purchase_id: q.id, purchase: `${q.date} ${q.merchant} $${(q.amount_cents / 100).toFixed(2)}`, category: q.category,
  ...(q.notes ? { notes: q.notes } : {}), ...(q.already_split ? { already_split: true } : {}),
});

tool('find_paybacks',
  `Finds money in from people that pays back their share of a purchase you made. The matcher's rules: an n-way share once at
least half the others have paid it (3-way needs 2), one person's clean half, or a group paying different amounts at the same
time / with matching notes. Each suggestion shows the payments' bank text (notes like "Breakfast" and send times are in it).
A payment's "memo" is what the sender wrote, word for word (transfer message or Beem memo): the best evidence. "notes" are
earlier commentary and can include guesses.
With wide=true, also lists every other payment in from people the matcher left alone (unnamed Beem payments too), with the
purchases each could be a share of and what else was bought around then: judge those from the notes and context.
The matcher can't see things bought for someone during your own shop (they send the item's cost, any amount under the
purchase, same or next day): pair those with ways=2, so their share is what they sent.
Then: confirm_payback what's clearly right, not_a_payback gifts and sales, and review_payback to leave a note (or pair up
something the matcher missed) for the user to check on the People page. Ask the user when unsure. Run after each import.`,
  {
    from: z.string().optional().describe('Only payments on or after this date (YYYY-MM-DD)'), person: z.string().optional(),
    wide: z.boolean().optional().describe('Also list payments the matcher skipped, with possible purchases'),
  },
  (a) => {
    const o = splits.splitsOverview(db);
    const person = a.person ? payeeRef(a.person) : undefined;
    const wide = a.wide ? splits.paybackCandidates(db, { from: a.from, payee: person }) : null;
    const list = wide?.suggestions ?? (person || a.from ? splits.suggestPaybacks(db, { from: a.from, payee: person }) : o.suggestions);
    return {
      owed_to_you: dollars(o.owed_cents), unclaimed_shares: dollars(o.unclaimed_cents),
      suggestions: list.map((g) => ({
        ...purchaseOut({ ...g.purchase, merchant: g.purchase.merchant ?? g.purchase.description, already_split: g.purchase.split_id != null }),
        ways: g.ways, ...(g.uneven ? { uneven: true, total_sent: dollars(g.payments.reduce((t, p) => t + p.amount_cents, 0)) } : { share: dollars(g.share_cents) }),
        confidence: g.confidence, reasons: g.reasons,
        payment_ids: g.payments.map((p) => p.id),
        payments: g.payments.map((p) => ({ id: p.id, date: p.date, person: p.person, amount: dollars(p.amount_cents), description: p.description, ...(p.memo ? { memo: p.memo } : {}), ...(p.notes ? { notes: p.notes } : {}) })),
        ...(g.reviews.length ? { your_reviews: g.reviews.map((r) => ({ payment_id: r.payment_id, verdict: r.verdict, note: r.note })) } : {}),
      })),
      ...(wide ? {
        unmatched: wide.unmatched.map((u) => ({
          payment_id: u.payment.id, date: u.payment.date, person: u.payment.person ?? '(unnamed)', amount: dollars(u.payment.amount_cents),
          description: u.payment.description, ...(u.payment.memo ? { memo: u.payment.memo } : {}), ...(u.payment.notes ? { notes: u.payment.notes } : {}), category: u.payment.category,
          ...(u.review ? { your_review: u.review } : {}),
          fits: u.fits.map((f) => ({ ...purchaseOut(f), ways: f.ways, share: dollars(f.share_cents), days_after_purchase: f.days_after_purchase })),
          nearby: u.nearby.map(purchaseOut),
        })),
      } : {}),
      open_splits: o.open.map(splitOut),
    };
  }, true);

tool('confirm_payback',
  'Accepts a payback: splits the purchase `ways` ways (you included) if it isn\'t split yet, gives each payer a share of what they sent (others an even share), links the payments, and files them in the purchase\'s category so it nets off. Name who unnamed (Beem) payments came from with `people`.',
  {
    purchase_id: z.number().int(), ways: z.number().int().min(2), payment_ids: z.array(z.number().int()).min(1),
    people: z.array(z.object({ payment_id: z.number().int(), person: z.string() })).optional().describe('Who unnamed payments are from'),
  },
  (a) => splitOut(splits.confirmPayback(db, a, 'ai')));

tool('review_payback',
  `Leaves your read on a payment in from someone, shown to the user on its payback suggestion (People page). verdict "likely"
when you'd confirm it but want the user to see why, "unsure" when they should decide. Give purchase_id (and ways) to pair it
with a purchase the matcher missed or got wrong; the payment moves to that suggestion. person names an unnamed (Beem) payment.
Use clear=true to remove a review. Keep the note short and specific: what in the notes, timing or amounts points to it.`,
  {
    payment_id: z.number().int(), verdict: z.enum(['likely', 'unsure']).optional(), note: z.string().optional(),
    purchase_id: z.number().int().optional(), ways: z.number().int().min(2).optional(), person: z.string().optional(),
    clear: z.boolean().optional(),
  },
  (a) => {
    if (a.clear) { splits.clearReview(db, a.payment_id); return { ok: true }; }
    if (!a.verdict || !a.note) throw new Error('Give a verdict and a note (or clear=true)');
    splits.reviewPayback(db, { payment_id: a.payment_id, verdict: a.verdict, note: a.note, purchase_id: a.purchase_id, ways: a.ways, person: a.person });
    return { ok: true };
  });

tool('split_transaction',
  'Splits a purchase (money out) with people, or reshapes an existing split. Shares without an amount are an even split; unnamed shares are filled in to reach `ways`. People are created if new.',
  {
    id: z.number().int().describe('The purchase transaction id'),
    ways: z.number().int().min(2).optional().describe('People sharing it, you included. Defaults to everyone listed plus you'),
    shares: z.array(z.object({ person: z.string().optional(), amount: z.number().positive().optional() })).optional(),
    notes: z.string().optional(),
  },
  (a) => splitOut(splits.splitTransaction(db, a.id, a)));

tool('link_payback', 'Links money in from a person to their share of a split (claiming an unnamed share, or adding one). Unlink with split_id=null. When one payment covers several purchases (e.g. two bookings), link it to each split with the dollar `amount` for that one.',
  { payment_id: z.number().int(), split_id: z.number().int().nullable(), amount: z.number().positive().optional().describe('Dollars of the payment for this split; default all of what is not yet linked') },
  (a) => {
    if (a.split_id == null) return { unlinked: splits.unlinkPayback(db, a.payment_id) };
    return splitOut(splits.linkPayback(db, a.payment_id, a.split_id, 'ai', a.amount));
  });

tool('not_a_payback', 'Marks money in from a person as not paying anything back (a gift, a sale) so find_paybacks stops suggesting it.',
  { payment_id: z.number().int(), undo: z.boolean().optional() },
  (a) => { splits.setNotPayback(db, a.payment_id, !a.undo); return { ok: true }; });

tool('settle_share', 'Marks a person\'s share of a split as settled off the bank (cash, or let go), or reopens it.',
  { share_id: z.number().int(), settled: z.boolean() },
  (a) => { splits.setShareSettled(db, a.share_id, a.settled); return { ok: true }; });

tool('delete_split', 'Removes a split (the purchase and payments are kept; their links are dropped).', { split_id: z.number().int() },
  (a) => { splits.deleteSplit(db, a.split_id); return { ok: true }; });

// ---------- budgets & reports ----------

tool('get_budgets',
  'The budget plan: planned monthly income and each bucket (a share of income, or a fixed amount) with its target and what went in it '
  + 'this month, last month and on average. Spending buckets list their categories; savings buckets fill from what is left over.',
  { month: month.optional() },
  (a) => {
    const p = budgetPlan(db, a.month);
    const pctOut = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);
    return {
      month: p.month,
      planned_income: dollars(p.income.planned_cents),
      planned_income_from: p.income.source === 'fixed' ? 'fixed amount' : p.income.source === 'average' ? `average of ${p.income.months.join(', ')}` : p.income.source,
      income_this_month: dollars(p.income.actual_cents),
      buckets: p.buckets.map((b) => ({
        bucket: b.name, kind: b.kind === 'save' ? 'savings' : 'spending',
        set_as: b.mode, percent: pctOut(b.target_percent), target: dollars(b.target_cents),
        [b.kind === 'save' ? 'saved' : 'spent']: dollars(b.actual_cents),
        last_month: dollars(b.last_month_cents), avg_3_months: dollars(b.avg3_cents),
        ...targetWhy(b),
        ...(b.kind === 'spend' ? { categories: b.categories.map((c) => ({ category: c.name, spent: dollars(c.spent_cents), avg_3_months: dollars(c.avg3_cents) })) } : {}),
      })),
      not_in_a_bucket: p.unassigned.map((c) => ({ category: c.name, spent: dollars(c.spent_cents) })),
      uncategorized_spent: dollars(p.uncategorized_cents),
      allocated_percent: pctOut(p.totals.allocated_percent),
    };
  }, true);

tool('set_bucket',
  'Creates or updates a budget bucket by name. Give percent (of planned income; follows income), amount (fixed dollars per month; '
  + "doesn't follow income) or follows_recurring: true (spending only: the target each month is what the recurring items in its "
  + 'categories come to, e.g. 4 or 5 weekly rent payments), only one; null clears the target. balances: true makes this the one bucket '
  + 'that gives or takes the difference between those and a usual month. kind: spending (holds categories) or savings (fills from '
  + "what's left over). categories moves those spending categories into it.",
  {
    bucket: z.string(), rename: z.string().optional(), kind: z.enum(['spending', 'savings']).optional(),
    percent: z.number().min(0).max(100).nullable().optional(), amount: z.number().nonnegative().nullable().optional(),
    follows_recurring: z.boolean().optional(), balances: z.boolean().optional(),
    categories: z.array(z.string()).optional(),
  },
  (a) => db.transaction(() => {
    const kind = a.kind === 'savings' ? 'save' as const : a.kind === 'spending' ? 'spend' as const : undefined;
    const existing = store.findBucket(db, a.bucket);
    const b = existing
      ? store.updateBucket(db, existing.id, { name: a.rename, kind, percent: a.percent, amount: a.amount, follows_recurring: a.follows_recurring, balances: a.balances })
      : store.createBucket(db, { name: a.rename ?? a.bucket, kind, percent: a.percent, amount: a.amount, follows_recurring: a.follows_recurring, balances: a.balances });
    if (a.categories?.length) store.assignCategories(db, b.id, a.categories);
    return { ...b, amount: dollars(b.amount_cents), created: !existing };
  })());

tool('delete_bucket', 'Deletes a budget bucket; its categories are left without one.', { bucket: z.string() },
  (a) => store.deleteBucket(db, a.bucket));

tool('set_planned_income',
  'Sets the monthly income bucket percentages are worked out from, in dollars. null goes back to the average of the last three months.',
  { amount: z.number().positive().nullable() },
  (a) => store.setPlannedIncome(db, a.amount));

/** Why a bucket's target is what it is this month: the recurring payments it follows, or what it gives up to balance them. */
const targetWhy = (b: Pick<BucketTarget, 'schedule' | 'balance_cents'>) => ({
  ...(b.schedule ? {
    follows_recurring: {
      this_month: dollars(b.schedule.cents), usual_month: dollars(b.schedule.average_cents),
      items: b.schedule.items.map((i) => ({ name: i.name, each: dollars(i.each_cents), payments: i.count ?? 'monthly average', total: dollars(i.cents) })),
    },
  } : {}),
  ...(b.balance_cents ? { balancing_recurring: dollars(b.balance_cents) } : {}),
});

tool('month_summary', 'Spending vs budget for a month: totals, pace, progress per budget bucket, per-category spend, income, top merchants.',
  { month: month.optional() },
  (a) => {
    const s = monthSummary(db, a.month);
    const t = s.totals;
    return {
      month: s.month, data_through: s.data_through, day: `${s.elapsed_days} of ${s.days_in_month}`,
      spent: dollars(t.spent_cents), budget: dollars(t.budget_cents), remaining: dollars(t.budget_cents - t.spent_cents),
      expected_by_now: dollars(t.expected_to_date_cents), projected_month_end: dollars(t.projected_cents),
      income: dollars(t.income_cents), net: dollars(t.net_cents), last_month_spent: dollars(t.prev_spent_cents),
      uncategorized: { count: s.uncategorized.count, money_out: dollars(s.uncategorized.out_cents) },
      buckets: s.buckets.map((b) => ({
        bucket: b.name, kind: b.kind === 'save' ? 'savings' : 'spending', target: dollars(b.target_cents),
        [b.kind === 'save' ? 'saved' : 'spent']: dollars(b.actual_cents),
        used_pct: b.target_cents ? Math.round((b.actual_cents / b.target_cents) * 100) : null,
        ...targetWhy(b),
      })),
      categories: s.categories.filter((c) => c.spent_cents).map((c) => ({
        category: c.name, spent: dollars(c.spent_cents), bucket: s.buckets.find((b) => b.id === c.bucket_id)?.name ?? null,
      })),
      income_breakdown: s.income.map((i) => ({ category: i.name, amount: dollars(i.amount_cents) })),
      top_merchants: s.top_merchants.map((m) => ({ name: m.name, spent: dollars(m.spent_cents), count: m.count })),
    };
  }, true);

tool('spending_trends', 'Month-by-month spending, income and budget, with per-category spend.',
  { months: z.number().int().min(1).max(60).optional(), end_month: month.optional() },
  (a) => {
    const t = trends(db, a.months ?? 6, a.end_month);
    return {
      months: t.months.map((m) => ({ month: m.month, spent: dollars(m.spent_cents), income: dollars(m.income_cents), budget: dollars(m.budget_cents) })),
      categories: t.categories.map((c) => ({
        category: c.name, average: dollars(c.average_cents),
        by_month: Object.fromEntries(Object.entries(c.values).map(([k, v]) => [k, v / 100])),
      })),
    };
  }, true);

// ---------- prompt ----------

server.registerPrompt(
  'import_statement',
  {
    description: 'Import and categorise a bank statement PDF or CSV',
    argsSchema: { file: z.string().describe('Path to the statement PDF or CSV'), account: z.string().optional() },
  },
  ({ file, account }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Import my bank statement at ${file}${account ? ` into the "${account}" account` : ''}.

1. Call budget_overview to see the accounts and categories.
2. If it's a CSV, use import_csv_file. If it's a PDF, read every page and extract every transaction
   (date, description as printed, signed amount: money out negative), plus the opening and closing balance.
   Work out which account it is from the statement (ask me if unclear).
3. Call import_transactions with dry_run=true, choosing a category for each transaction you're confident about.
   Check the reconciliation is ok; if not, find the missed or misread lines before going further.
4. Import for real. Tell me about any possible duplicates rather than importing them.
5. List uncategorised transactions and categorise them. Add rules for merchants likely to recur.
   Payments to my own accounts or the credit card are transfers, not spending. Ask me about anything ambiguous.
6. Finish with month_summary for the statement's month and a short plain summary of how I went against budget.`,
      },
    }],
  }),
);

await server.connect(new StdioServerTransport());
