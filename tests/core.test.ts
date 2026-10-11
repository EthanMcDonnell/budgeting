import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/core/db.ts';
import { parseBankCsv, parseCsv } from '../src/core/csv.ts';
import { importTransactions } from '../src/core/importer.ts';
import { budgetPlan, monthSummary, trends } from '../src/core/reports.ts';
import * as store from '../src/core/store.ts';
import { normalizeDate, parseMoney } from '../src/core/util.ts';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

const sample = () => fs.readFileSync(path.join(import.meta.dirname, 'fixtures/bankwest-sample.csv'), 'utf8');

describe('util', () => {
  it('parses Australian dates', () => {
    expect(normalizeDate('03/09/2026')).toBe('2026-09-03');
    expect(normalizeDate('3-9-26')).toBe('2026-09-03');
    expect(normalizeDate('12 Oct 2026')).toBe('2026-10-12');
    expect(normalizeDate('2026-02-30')).toBeNull();
  });
  it('parses money', () => {
    expect(parseMoney('$1,234.50')).toBe(1234.5);
    expect(parseMoney('(12.00)')).toBe(-12);
    expect(parseMoney('45.00 DR')).toBe(-45);
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('abc')).toBeNull();
  });
});

describe('csv', () => {
  it('handles quotes and embedded commas', () => {
    expect(parseCsv('a,"b, c","d ""e"""\r\n1,2,3')).toEqual([['a', 'b, c', 'd "e"'], ['1', '2', '3']]);
  });
  it('reads a Bankwest export', () => {
    const p = parseBankCsv(sample());
    expect(p.format).toBe('bankwest');
    expect(p.accountNumbers).toEqual(['1234567']);
    expect(p.transactions).toHaveLength(5);
    expect(p.transactions[0]).toMatchObject({ date: '2026-09-01', amount: -84.2, description: 'WOOLWORTHS 4321 PERTH AU' });
    expect(p.transactions[1].amount).toBe(3200);
  });
  it('skips pending authorisations and $0 note rows', () => {
    const p = parseBankCsv([
      'BSB Number,Account Number,Transaction Date,Narration,Cheque,Debit,Credit,Balance,Transaction Type',
      '302-162,1234567,12/10/2026,"AUTHORISATION ONLY - EFTPOS PURCHASE AT SHOP","",280.00,,1609.72,DAU',
      '302-162,1234567,14/09/2026,"FEES INCLUDED IN TRAN AUD34.00  IS WAIVED","",,0.00,1581.33,NAR',
      '302-162,1234567,14/09/2026,"ANTHROPIC* CLAUDE SAN FRANCISCO CA USA","",34.00,,1547.33,WDC',
    ].join('\n'));
    expect(p.format).toBe('bankwest');
    expect(p.transactions).toHaveLength(1);
    expect(p.skippedRows.map((r) => r.reason)).toEqual(['Pending authorisation; imported once it settles', 'Zero amount']);
  });

  it('reads an Up Bank export', () => {
    const p = parseBankCsv([
      '\uFEFFTime,BSB / Account Number,Account Name,Transaction Type,Payee,Description,Category,Tags,Subtotal (AUD),Currency,Subtotal (Transaction Currency),Round Up (AUD),Total (AUD),Payment Method,Settled Date',
      '2026-10-02T03:23:23+10:00,633-123 / 123456789,Spending,International Purchase,Hamleys,"Hamleys Regent Street, London",Children & Family,"",-54.95,GBP,-27.0,0.00,-54.95,"",2026-10-04',
      '2026-08-03T19:12:05+10:00,633-123 / 123456789,Spending,Osko Payment Received,A CITIZEN,Pizza,"","",12.50,AUD,12.50,0.00,12.50,Osko,2026-08-03',
    ].join('\n'));
    expect(p.transactions).toEqual([
      { date: '2026-10-02', description: 'Hamleys Regent Street, London', amount: -54.95, balance: null, merchant: 'Hamleys' },
      { date: '2026-08-03', description: 'Pizza', amount: 12.5, balance: null, merchant: 'A CITIZEN' },
    ]);
  });

  it('treats unsigned debits as money out', () => {
    const p = parseBankCsv('Transaction Date,Narration,Debit,Credit\n01/09/2026,COFFEE,4.50,\n');
    expect(p.transactions[0].amount).toBe(-4.5);
  });
  it('reads a headerless CommBank-style file', () => {
    const p = parseBankCsv('01/09/2026,"-12.50","COLES 123 PERTH","+100.00"\n02/09/2026,"+50.00","TRANSFER FROM SAVINGS","+150.00"\n');
    expect(p.format).toBe('headerless');
    expect(p.transactions[0]).toMatchObject({ amount: -12.5, description: 'COLES 123 PERTH', balance: 100 });
  });
});

describe('import', () => {
  it('applies rules on word boundaries and skips re-imported rows', () => {
    const tx = parseBankCsv(sample()).transactions;
    const first = importTransactions(db, { account: 'Everyday', source: 'csv', transactions: tx });
    expect(first.inserted).toBe(5);
    const rows = store.listTransactions(db).transactions;
    expect(rows.find((r) => r.description.startsWith('WOOLWORTHS'))?.category).toBe('Groceries');
    expect(rows.find((r) => r.description.startsWith('GIGABYTE'))?.category).toBeNull();

    const again = importTransactions(db, { account: 'Everyday', source: 'csv', transactions: tx });
    expect(again.inserted).toBe(0);
    expect(again.duplicates).toBe(5);
  });

  it('keeps genuine same-day identical purchases', () => {
    const t = { date: '2026-09-05', description: 'COFFEE CLUB', amount: -5.5 };
    importTransactions(db, { account: 'A', source: 'pdf', transactions: [t] });
    const r = importTransactions(db, { account: 'A', source: 'pdf', transactions: [t, t] });
    expect(r.duplicates).toBe(1);
    expect(r.inserted).toBe(1);
  });

  it('flags possible duplicates when the same transaction is worded differently', () => {
    importTransactions(db, { account: 'A', source: 'csv', transactions: [{ date: '2026-09-05', description: 'WOOLWORTHS 4321', amount: -20 }] });
    const r = importTransactions(db, { account: 'A', source: 'pdf', transactions: [{ date: '05/09/2026', description: 'Woolworths Perth', amount: -20 }] });
    expect(r.possible_duplicates).toBe(1);
    expect(r.inserted).toBe(0);
    const forced = importTransactions(db, { account: 'A', source: 'pdf', possibleDuplicates: 'import', transactions: [{ date: '05/09/2026', description: 'Woolworths Perth', amount: -20 }] });
    expect(forced.inserted).toBe(1);
  });

  it('reconciles against statement balances', () => {
    const r = importTransactions(db, {
      account: 'A', source: 'pdf', dryRun: true, openingBalance: 100, closingBalance: 75.5,
      transactions: [{ date: '2026-09-01', description: 'X', amount: -30 }, { date: '2026-09-02', description: 'Y', amount: 5.5 }],
    });
    expect(r.reconciliation).toMatchObject({ ok: true, difference: 0 });
    expect(store.listTransactions(db).count).toBe(0);
    expect(store.listAccounts(db)).toHaveLength(0); // dry run rolled back the new account
  });

  it('reports invalid rows and unknown categories', () => {
    const r = importTransactions(db, {
      account: 'A', source: 'pdf',
      transactions: [{ date: 'nope', description: 'X', amount: -1 }, { date: '2026-09-01', description: 'Y', amount: -2, category: 'Nonsense' }],
    });
    expect(r.invalid).toBe(1);
    expect(r.unknown_categories).toEqual(['Nonsense']);
    expect(r.uncategorized).toBe(1);
  });

  it('undoes an import', () => {
    const r = importTransactions(db, { account: 'A', source: 'csv', transactions: parseBankCsv(sample()).transactions });
    expect(store.deleteImport(db, r.import_id!)).toBe(5);
    expect(store.listTransactions(db).count).toBe(0);
  });
});


describe('reports', () => {
  beforeEach(() => {
    importTransactions(db, { account: 'Everyday', source: 'csv', transactions: parseBankCsv(sample()).transactions });
    store.addRule(db, { pattern: 'SALARY', category: 'Salary' });
    store.applyRulesToUncategorized(db);
  });

  it('summarises a month against its buckets', () => {
    // No earlier months, so percentages work off September's own $3,200: Expenses 50%, Splurge 10%, Travel 10% to spend.
    const s = monthSummary(db, '2026-09', '2026-10-10');
    expect(s.totals.budget_cents).toBe(224000);
    expect(s.totals.save_target_cents).toBe(96000);
    expect(s.totals.spent_cents).toBe(8420 + 1850 + 3000 + 1200); // includes uncategorised GIGABYTE
    expect(s.totals.income_cents).toBe(320000);
    expect(s.uncategorized.count).toBe(1);
    expect(s.elapsed_days).toBe(30);
    const bucket = (name: string) => s.buckets.find((b) => b.name === name)!;
    expect(bucket('Expenses')).toMatchObject({ target_cents: 160000, actual_cents: 8420 + 3000 });
    expect(bucket('Splurge')).toMatchObject({ target_cents: 32000, actual_cents: 1850 });
    expect(bucket('Savings').actual_cents).toBe(320000 - 14470);
    expect(s.categories.find((c) => c.name === 'Groceries')).toMatchObject({ spent_cents: 8420, bucket_id: bucket('Expenses').id });
    expect(s.daily[2].cumulative_cents).toBe(8420 + 1850 + 3000 + 1200);
  });

  it('excludes transfers and nets refunds', () => {
    importTransactions(db, {
      account: 'Everyday', source: 'pdf', transactions: [
        { date: '2026-09-10', description: 'PAYMENT TO CREDIT CARD', amount: -650, category: 'Credit Card Payment' },
        { date: '2026-09-11', description: 'WOOLWORTHS REFUND', amount: 20.2, category: 'Groceries' },
      ],
    });
    const s = monthSummary(db, '2026-09', '2026-10-10');
    expect(s.categories.find((c) => c.name === 'Groceries')!.spent_cents).toBe(6400);
    expect(s.totals.spent_cents).toBe(6400 + 1850 + 3000 + 1200);
  });

  it('builds month-by-month trends', () => {
    const t = trends(db, 3, '2026-10');
    expect(t.months.map((m) => m.month)).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(t.months[1].spent_cents).toBe(14470);
    expect(t.months[2].budget_cents).toBe(224000);
  });

  it('merges categories, moving transactions and rules', () => {
    store.createCategory(db, 'Coffee');
    store.addRule(db, { pattern: 'GUZMAN', category: 'Coffee' });
    store.updateTransaction(db, store.listTransactions(db, { search: 'GUZMAN' }).transactions[0].id, { category: 'Coffee' });
    expect(store.mergeCategory(db, 'Coffee', 'Eating & Drinking Out')).toEqual({ transactions: 1, rules: 1 });
    expect(store.findCategory(db, 'Coffee')).toBeNull();
    expect(store.listRules(db).find((r) => r.pattern === 'GUZMAN')?.category).toBe('Eating & Drinking Out');
    expect(() => store.mergeCategory(db, 'Salary', 'Groceries')).toThrow(/income/);
  });
});

describe('buckets', () => {
  beforeEach(() => {
    importTransactions(db, { account: 'Everyday', source: 'csv', transactions: parseBankCsv(sample()).transactions });
    store.addRule(db, { pattern: 'SALARY', category: 'Salary' });
    store.applyRulesToUncategorized(db);
  });
  const bucket = (month: string, name: string) => budgetPlan(db, month).buckets.find((b) => b.name === name)!;

  it('starts with the default buckets and puts every spending category in one', () => {
    expect(store.listBuckets(db).map((b) => [b.name, b.kind, b.percent])).toEqual([
      ['Expenses', 'spend', 50], ['Savings', 'save', 30], ['Splurge', 'spend', 10], ['Travel', 'spend', 10],
    ]);
    expect(store.listCategories(db).filter((c) => c.kind === 'expense' && c.bucket_id == null)).toEqual([]);
    expect(budgetPlan(db, '2026-10').totals.allocated_percent).toBe(100);
  });

  it('works percentages off the average income of the months before, or a fixed income', () => {
    importTransactions(db, { account: 'Everyday', source: 'pdf', transactions: [
      { date: '2026-10-02', description: 'SALARY ACME PTY LTD', amount: 4000, category: 'Salary' },
    ] });
    // November averages September and October (months before September have no data).
    const p = budgetPlan(db, '2026-11');
    expect(p.income).toMatchObject({ source: 'average', months: ['2026-09', '2026-10'], planned_cents: 360000 });
    expect(bucket('2026-11', 'Savings')).toMatchObject({ mode: 'percent', target_cents: 108000, target_percent: 30 });

    store.setPlannedIncome(db, 5000);
    expect(budgetPlan(db, '2026-11').income).toMatchObject({ source: 'fixed', planned_cents: 500000, usual_cents: 360000 });
    expect(bucket('2026-11', 'Savings').target_cents).toBe(150000);
    store.setPlannedIncome(db, null);
    expect(budgetPlan(db, '2026-11').income.source).toBe('average');
  });

  it('keeps a fixed amount when income changes, and shows it as a percentage', () => {
    store.updateBucket(db, 'Travel', { amount: 400 });
    expect(bucket('2026-09', 'Travel')).toMatchObject({ mode: 'amount', percent: null, target_cents: 40000, target_percent: 12.5 });
    store.setPlannedIncome(db, 8000);
    expect(bucket('2026-09', 'Travel')).toMatchObject({ target_cents: 40000, target_percent: 5 });
    store.updateBucket(db, 'Travel', { percent: 7.5 });
    expect(bucket('2026-09', 'Travel')).toMatchObject({ mode: 'percent', amount_cents: null, target_cents: 60000 });
    store.updateBucket(db, 'Travel', { percent: null });
    expect(bucket('2026-09', 'Travel')).toMatchObject({ mode: null, target_cents: null });
    expect(() => store.updateBucket(db, 'Travel', { percent: 10, amount: 100 })).toThrow(/only one/);
    expect(() => store.updateBucket(db, 'Travel', { percent: 120 })).toThrow(/between 0 and 100/);
  });

  it('adds buckets, moves categories between them and deletes them', () => {
    const fun = store.createBucket(db, { name: 'Fun', percent: 5 });
    store.assignCategories(db, fun.id, ['Eating & Drinking Out']);
    expect(bucket('2026-09', 'Fun')).toMatchObject({ actual_cents: 1850, target_cents: 16000 });
    expect(bucket('2026-09', 'Splurge').actual_cents).toBe(0);
    expect(() => store.assignCategories(db, 'Savings', ['Groceries'])).toThrow(/savings bucket/);
    expect(() => store.assignCategories(db, fun.id, ['Salary'])).toThrow(/spending categories/);
    expect(() => store.createBucket(db, { name: 'fun' })).toThrow(/already exists/);

    store.deleteBucket(db, fun.id);
    const p = budgetPlan(db, '2026-09');
    expect(p.unassigned.map((c) => c.name)).toEqual(['Eating & Drinking Out']);
    expect(p.totals.spent_cents).toBe(14470); // still counts as spending
  });

  it('fills savings buckets in order from what is left over', () => {
    store.createBucket(db, { name: 'House deposit', kind: 'save', amount: 500 });
    // Left over in September: 3,200 − 144.70. Savings fills to its 30% ($960) first, then the last bucket takes the rest.
    expect(bucket('2026-09', 'Savings').actual_cents).toBe(96000);
    expect(bucket('2026-09', 'House deposit').actual_cents).toBe(320000 - 14470 - 96000);
  });
});
