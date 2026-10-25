import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_DB_PATH, PROJECT_ROOT, openDb } from '../core/db.ts';
import { coverage } from '../core/coverage.ts';
import { parseBankCsv } from '../core/csv.ts';
import { importCsv } from '../core/importer.ts';
import * as recurring from '../core/recurring.ts';
import { listPayees, payeeDetail } from '../core/payees.ts';
import { budgetPlan, monthSummary, overview, trends } from '../core/reports.ts';
import * as splits from '../core/splits.ts';
import * as store from '../core/store.ts';
import { UserError } from '../core/store.ts';

const db = openDb();
const app = express();
app.use(express.json({ limit: '20mb' }));

const num = (v: unknown) => (v == null || v === '' ? undefined : Number(v));
const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
const id = (req: Request) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n)) throw new UserError('Invalid id');
  return n;
};

// ---------- meta & reports ----------

app.get('/api/meta', (_req, res) => {
  res.json({
    accounts: store.listAccounts(db),
    categories: store.listCategories(db, true),
    buckets: store.listBuckets(db),
    overview: overview(db),
    db_path: DEFAULT_DB_PATH,
  });
});

app.get('/api/summary', (req, res) => res.json(monthSummary(db, str(req.query.month))));
app.get('/api/trends', (req, res) => res.json(trends(db, num(req.query.months) ?? 12, str(req.query.end))));

// ---------- transactions ----------

app.get('/api/transactions', (req, res) => {
  const q = req.query;
  res.json(store.listTransactions(db, {
    month: str(q.month), from: str(q.from), to: str(q.to), search: str(q.search),
    category: q.category === 'uncategorized' ? 'uncategorized' : num(q.category),
    payee: q.payee === 'none' ? 'none' : num(q.payee), bucket: num(q.bucket),
    account: num(q.account), limit: num(q.limit) ?? 2000, offset: num(q.offset),
  }));
});

app.post('/api/transactions', (req, res) => {
  const t = store.addManualTransaction(db, req.body);
  recurring.linkRecurring(db, [t.id]);
  res.status(201).json(store.getTransaction(db, t.id));
});
app.patch('/api/transactions/:id', (req, res) => res.json(store.updateTransaction(db, id(req), req.body)));
app.delete('/api/transactions/:id', (req, res) => res.json({ deleted: store.deleteTransactions(db, [id(req)]) }));

app.post('/api/transactions/bulk', (req, res) => {
  const { ids, action, category } = req.body as { ids: number[]; action: 'categorize' | 'delete'; category?: number | null };
  if (!Array.isArray(ids) || ids.length === 0) throw new UserError('No transactions selected');
  if (action === 'delete') return res.json({ changed: store.deleteTransactions(db, ids) });
  if (action === 'categorize') return res.json({ changed: store.setCategoryForMany(db, ids, category ?? null) });
  throw new UserError(`Unknown action: ${action}`);
});

// ---------- categories ----------

app.post('/api/categories', (req, res) => res.status(201).json(store.createCategory(db, req.body.name, req.body.kind, req.body.bucket)));
app.patch('/api/categories/:id', (req, res) => res.json(store.updateCategory(db, id(req), req.body)));
app.delete('/api/categories/:id', (req, res) => res.json(store.deleteCategory(db, id(req), num(req.query.reassign))));

// ---------- accounts ----------

app.post('/api/accounts', (req, res) => res.status(201).json(store.createAccount(db, req.body)));
app.patch('/api/accounts/:id', (req, res) => res.json(store.updateAccount(db, id(req), req.body)));
app.delete('/api/accounts/:id', (req, res) => {
  store.deleteAccount(db, id(req));
  res.json({ ok: true });
});

// ---------- payees (merchants and people) ----------

const payeeKind = (v: unknown) => (v === 'merchant' || v === 'person' ? v : undefined);

app.get('/api/payees', (req, res) => res.json(listPayees(db, { kind: payeeKind(req.query.kind), month: str(req.query.month) })));
app.get('/api/payees/:id', (req, res) => res.json(payeeDetail(db, id(req), { months: num(req.query.months), end: str(req.query.end) })));
app.post('/api/payees', (req, res) => res.status(201).json(store.createPayee(db, req.body)));
app.patch('/api/payees/:id', (req, res) => res.json(store.updatePayee(db, id(req), req.body)));
app.post('/api/payees/:id/merge', (req, res) => res.json(store.mergePayee(db, id(req), Number(req.body.into))));
app.delete('/api/payees/:id', (req, res) => res.json(store.deletePayee(db, id(req))));

// ---------- budgets (buckets) ----------

app.get('/api/budgets', (req, res) => res.json(budgetPlan(db, str(req.query.month))));
app.put('/api/budgets/income', (req, res) => res.json(store.setPlannedIncome(db, req.body.amount ?? null)));
app.get('/api/buckets', (_req, res) => res.json(store.listBuckets(db)));
// `categories`, when given, is the bucket's full list of spending categories.
app.post('/api/buckets', (req, res) => {
  const { categories, ...input } = req.body as { name: string; categories?: number[] };
  const bucket = db.transaction(() => {
    const b = store.createBucket(db, input);
    if (categories) store.setBucketCategories(db, b.id, categories);
    return b;
  })();
  res.status(201).json(bucket);
});
app.patch('/api/buckets/:id', (req, res) => {
  const { categories, ...patch } = req.body as { categories?: number[] };
  res.json(db.transaction(() => {
    const b = store.updateBucket(db, id(req), patch);
    if (categories && b.kind === 'spend') store.setBucketCategories(db, b.id, categories);
    return b;
  })());
});
app.delete('/api/buckets/:id', (req, res) => res.json(store.deleteBucket(db, id(req))));

// ---------- rules ----------

app.get('/api/rules', (_req, res) => res.json(store.listRules(db)));
app.post('/api/rules', (req, res) => {
  const rule = store.addRule(db, req.body);
  const r = req.body.apply ? store.applyRules(db) : { categorized: 0, linked: 0 };
  res.status(201).json({ rule, applied: r.categorized, linked: r.linked });
});
app.delete('/api/rules/:id', (req, res) => {
  store.deleteRule(db, id(req));
  res.json({ ok: true });
});
app.post('/api/rules/apply', (_req, res) => res.json(store.applyRules(db)));

// ---------- recurring ----------

app.get('/api/recurring', (_req, res) => res.json(recurring.listRecurring(db)));
app.get('/api/recurring/preview', (req, res) =>
  res.json(recurring.previewPattern(db, str(req.query.pattern) ?? '', req.query.match_type === 'regex' ? 'regex' : 'contains')));
app.post('/api/recurring', (req, res) => res.status(201).json(recurring.createRecurring(db, req.body)));
app.patch('/api/recurring/:id', (req, res) => res.json(recurring.updateRecurring(db, id(req), req.body)));
app.delete('/api/recurring/:id', (req, res) => {
  recurring.deleteRecurring(db, id(req));
  res.json({ ok: true });
});

// ---------- shared costs ----------

app.get('/api/splits', (_req, res) => res.json(splits.splitsOverview(db)));
app.get('/api/transactions/:id/split', (req, res) => res.json(splits.listSplits(db, { transaction: id(req) })[0] ?? null));
app.post('/api/splits', (req, res) => res.status(201).json(splits.splitTransaction(db, Number(req.body.transaction_id), req.body)));
app.delete('/api/splits/:id', (req, res) => {
  splits.deleteSplit(db, id(req));
  res.json({ ok: true });
});
app.post('/api/splits/confirm', (req, res) => res.json(splits.confirmPayback(db, req.body)));
app.post('/api/splits/:id/paybacks', (req, res) => res.json(splits.linkPayback(db, Number(req.body.transaction_id), id(req))));
app.delete('/api/paybacks/:id', (req, res) => res.json({ unlinked: splits.unlinkPayback(db, id(req)) }));
app.put('/api/paybacks/:id/not-payback', (req, res) => {
  splits.setNotPayback(db, id(req), req.body.not_payback !== false);
  res.json({ ok: true });
});
app.put('/api/shares/:id/settled', (req, res) => {
  splits.setShareSettled(db, id(req), !!req.body.settled);
  res.json({ ok: true });
});

// ---------- imports ----------

app.get('/api/imports', (_req, res) => res.json(store.listImports(db)));
app.get('/api/coverage', (_req, res) => res.json(coverage(db)));
app.delete('/api/imports/:id', (req, res) => res.json({ deleted_transactions: store.deleteImport(db, id(req)) }));

app.post('/api/import/csv', (req, res) => {
  const { text, account, filename, commit, possible_duplicates } = req.body as {
    text: string; account: number | string; filename?: string; commit?: boolean; possible_duplicates?: 'skip' | 'import';
  };
  if (!text) throw new UserError('No file contents received');
  let parsed;
  try { parsed = parseBankCsv(text); } catch (e) { throw new UserError((e as Error).message); }
  if (parsed.transactions.length === 0) throw new UserError('No transactions found in that file');
  const results = importCsv(db, parsed, {
    account, label: filename ?? 'CSV import', possibleDuplicates: possible_duplicates ?? 'skip', dryRun: !commit,
  });
  // One preview across the accounts the file covers.
  const sum = (k: 'inserted' | 'duplicates' | 'possible_duplicates' | 'invalid' | 'uncategorized') => results.reduce((s, r) => s + r[k], 0);
  const dates = results.flatMap((r) => [r.period.start, r.period.end]).filter((d): d is string => !!d).sort();
  res.json({
    dry_run: !commit, account: results.map((r) => r.account).join(' + '),
    accounts: results.map((r) => ({ account: r.account, new: r.rows.filter((x) => x.status === 'new').length })),
    inserted: sum('inserted'), duplicates: sum('duplicates'), possible_duplicates: sum('possible_duplicates'),
    invalid: sum('invalid'), uncategorized: sum('uncategorized'),
    period: { start: dates[0] ?? null, end: dates.at(-1) ?? null },
    rows: results.flatMap((r) => r.rows.map((x) => ({ ...x, account: r.account }))),
    format: parsed.format, skipped_rows: parsed.skippedRows, pending: parsed.pending.length,
    gaps: results.flatMap((r) => r.coverage.gaps.map((g) => ({ ...g, account: r.account }))),
    next_export_from: results.map((r) => ({ account: r.account, date: r.coverage.next_export_from })),
  });
});

// Full JSON backup of everything in the database.
app.get('/api/export', (_req, res) => {
  const dump: Record<string, unknown[]> = {};
  for (const t of ['accounts', 'categories', 'buckets', 'settings', 'payees', 'rules', 'recurring', 'recurring_contributors', 'imports', 'transactions']) {
    dump[t] = db.prepare(`SELECT * FROM ${t}`).all();
  }
  res.setHeader('Content-Disposition', `attachment; filename="budget-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ exported_at: new Date().toISOString(), ...dump });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// ---------- static UI ----------

const dist = path.join(PROJECT_ROOT, 'web', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof UserError) return res.status(400).json({ error: err.message });
  if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return res.status(400).json({ error: 'That record is still in use' });
  }
  console.error(err);
  res.status(500).json({ error: err.message });
});

const port = Number(process.env.PORT ?? 4777);
// Bound to localhost only: this is your financial data.
app.listen(port, '127.0.0.1', () => {
  console.log(`Budget running at http://127.0.0.1:${port}`);
  console.log(`Database: ${DEFAULT_DB_PATH}`);
});
