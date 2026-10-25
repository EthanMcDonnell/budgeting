import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/core/db.ts';
import { coverage } from '../src/core/coverage.ts';
import { parseBankCsv, parseCsv } from '../src/core/csv.ts';
import { importCsv, importTransactions } from '../src/core/importer.ts';
import { budgetPlan, monthSummary, trends } from '../src/core/reports.ts';
import { splitTransaction } from '../src/core/splits.ts';
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
    expect(p.skippedRows.map((r) => r.reason)).toEqual(['Zero amount']);
    expect(p.pending).toHaveLength(1);
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

  it('splits a multi-account CSV by account number', () => {
    const csv = [
      'BSB Number,Account Number,Transaction Date,Narration,Cheque Number,Debit,Credit,Balance,Transaction Type',
      '302-162,1111111,19/10/2026,"T",,-500.00,,100.00,TFD',
      '302-162,1111111,19/10/2026,"COLES 123 PERTH AUS",,-20.00,,600.00,WDC',
      '302-162,2222222,19/10/2026,"T",,,500.00,900.00,TFC',
    ].join('\n');
    store.createAccount(db, { name: 'Everyday', number: '302-162 1111111' });
    store.createAccount(db, { name: 'Bills', number: '302-162 2222222' });
    const r = importCsv(db, parseBankCsv(csv), { account: 'Everyday' });
    expect(r.map((x) => [x.account, x.inserted])).toEqual([['Everyday', 2], ['Bills', 1]]);
    expect(importCsv(db, parseBankCsv(csv), {}).every((x) => x.inserted === 0)).toBe(true);
  });

  it('remembers a new account number on the chosen account, and refuses a mismatched one', () => {
    const r = importCsv(db, parseBankCsv(sample()), { account: 'Everyday' });
    expect(r[0].inserted).toBe(5);
    expect(store.findAccount(db, 'Everyday')?.number).toBe('1234567');
    const other = sample().replaceAll('1234567', '7654321');
    expect(() => importCsv(db, parseBankCsv(other), { account: 'Everyday' })).toThrow(/7654321/);
    const both = `${sample().trim()}\n${other.split('\n').slice(1).join('\n')}`.replaceAll('1234567', '5555555');
    expect(() => importCsv(db, parseBankCsv(both), { account: 'New' })).toThrow(/5555555 or 7654321/);
  });

  it('undoes an import', () => {
    const r = importTransactions(db, { account: 'A', source: 'csv', transactions: parseBankCsv(sample()).transactions });
    expect(store.deleteImport(db, r.import_id!)).toBe(5);
    expect(store.listTransactions(db).count).toBe(0);
  });
});


describe('coverage', () => {
  const HEAD = 'BSB Number,Account Number,Transaction Date,Narration,Cheque Number,Debit,Credit,Balance,Transaction Type';
  // Bankwest lists newest first, with the balance after each row.
  const row = (date: string, text: string, amount: number, balance: number, type = 'WDC') =>
    `302-162,1234567,${date},"${text}",,${amount < 0 ? amount.toFixed(2) : ''},${amount > 0 ? amount.toFixed(2) : ''},${balance.toFixed(2)},${type}`;
  const csv = (...rows: string[]) => parseBankCsv([HEAD, ...rows].join('\n'));
  const imp = (...rows: string[]) => importCsv(db, csv(...rows), { account: 'Everyday' })[0];

  it('keeps pending authorisations apart and covers only the days before them', () => {
    const p = csv(
      row('05/09/2026', 'AUTHORISATION ONLY - EFTPOS PURCHASE AT CAFE', -6, 900, 'DAU'),
      row('05/09/2026', 'BAKERY', -4, 900),
      row('03/09/2026', 'GROCER', -96, 904),
    );
    expect(p.skippedRows).toEqual([]);
    expect(p.pending).toMatchObject([{ date: '2026-09-05', amount: -6, accountNumber: '1234567' }]);

    const r = importCsv(db, p, { account: 'Everyday' })[0];
    expect(r.inserted).toBe(2);
    expect(r.coverage).toEqual({ covered_to: '2026-09-04', next_export_from: '2026-09-05', gaps: [] });

    // Starting the next export on the pending date leaves no gap.
    const next = imp(row('07/09/2026', 'TRAIN', -3, 891), row('05/09/2026', 'EFTPOS PURCHASE AT CAFE', -6, 894), row('05/09/2026', 'BAKERY', -4, 900));
    expect(next.inserted).toBe(1);
    expect(next.pending.settled).toBe(1);
    expect(next.coverage.gaps).toEqual([]);
    expect(next.coverage.covered_to).toBe('2026-09-07');
  });

  it('treats a gap as quiet when the balances chain across it, and flags what they say is missing', () => {
    imp(row('03/09/2026', 'GROCER', -96, 904), row('01/09/2026', 'PAY', 1000, 1000, 'PAY'));
    // Nothing happened 4–9 Sep: the balance before the 10th is the 3rd's closing balance.
    expect(imp(row('10/09/2026', 'TRAIN', -4, 900)).coverage.gaps).toEqual([]);
    // 30 is missing between the 11th and the 19th.
    const r = imp(row('20/09/2026', 'BAKERY', -10, 860));
    expect(r.coverage.gaps).toEqual([{ from: '2026-09-11', to: '2026-09-19', missing_cents: -3000 }]);
    expect(coverage(db)[0].segments).toEqual([{ start: '2026-09-01', end: '2026-09-10' }, { start: '2026-09-20', end: '2026-09-20' }]);
  });

  it('reports a gap as unchecked when there are no balances', () => {
    importTransactions(db, { account: 'Up', source: 'csv', transactions: [{ date: '2026-09-01', description: 'A', amount: -1 }] });
    const r = importTransactions(db, { account: 'Up', source: 'csv', transactions: [{ date: '2026-09-09', description: 'B', amount: -1 }] });
    expect(r.coverage.gaps).toEqual([{ from: '2026-09-02', to: '2026-09-08', missing_cents: null }]);
  });

  it('records an import that adds nothing new, unless its dates were already covered', () => {
    store.addManualTransaction(db, { account: 'Everyday', date: '2026-09-03', description: 'GROCER', amount: -96 });
    const first = imp(row('03/09/2026', 'GROCER', -96, 904));
    expect(first.inserted).toBe(0);
    expect(first.import_id).not.toBeNull();
    expect(imp(row('03/09/2026', 'GROCER', -96, 904)).import_id).toBeNull();
    expect(store.listImports(db)).toHaveLength(1);
    // A dry run leaves no record behind.
    importCsv(db, csv(row('09/09/2026', 'TRAIN', -4, 900)), { account: 'Everyday', dryRun: true });
    expect(store.listImports(db)).toHaveLength(1);
  });
});

describe('pending', () => {
  const HEAD = 'BSB Number,Account Number,Transaction Date,Narration,Cheque Number,Debit,Credit,Balance,Transaction Type';
  const row = (date: string, text: string, amount: number, balance: number, type = 'WDC') =>
    `302-162,1234567,${date},"${text}",,${amount < 0 ? amount.toFixed(2) : ''},${amount > 0 ? amount.toFixed(2) : ''},${balance.toFixed(2)},${type}`;
  const auth = (date: string, text: string, amount: number) => row(date, `AUTHORISATION ONLY - EFTPOS PURCHASE AT ${text}`, amount, 500, 'DAU');
  const imp = (...rows: string[]) => importCsv(db, parseBankCsv([HEAD, ...rows].join('\n')), { account: 'Everyday' })[0];
  const tx = () => store.listTransactions(db).transactions;

  it('imports pending authorisations flagged, so they count straight away', () => {
    const r = imp(auth('12/10/2026', 'BWS    1234  SUBIACO      WAAU', -18.4), row('11/10/2026', 'GROCER', -50, 950));
    expect(r.inserted).toBe(1);
    expect(r.pending).toMatchObject({ added: 1, still_pending: 0, settled: 0, expired: [] });
    const p = tx().find((t) => t.pending)!;
    expect(p).toMatchObject({ amount_cents: -1840, balance_cents: null });
    expect(monthSummary(db, '2026-10').totals.spent_cents).toBe(6840);
    // The same export again changes nothing.
    const again = imp(auth('12/10/2026', 'BWS    1234  SUBIACO      WAAU', -18.4), row('11/10/2026', 'GROCER', -50, 950));
    expect(again.pending).toMatchObject({ added: 0, still_pending: 1 });
    expect(tx()).toHaveLength(2);
  });

  it('settles a pending row in place, keeping what was added to it', () => {
    imp(auth('12/10/2026', 'PRICELINE PHARMACY MT LAWMT LAWLEY   AU', -142.15), row('11/10/2026', 'GROCER', -50, 950));
    const p = tx().find((t) => t.pending)!;
    store.updateTransaction(db, p.id, { category: 'Shopping', merchant: 'Priceline', notes: 'Gift' }, 'ai');
    splitTransaction(db, p.id, { shares: [{ person: 'Sam' }] });

    // It settles a day later, under different text.
    const r = imp(row('13/10/2026', 'PRICELINE PHARMACY MT LAWLEY AUS', -142.15, 807.85), row('11/10/2026', 'GROCER', -50, 950));
    expect(r.inserted).toBe(0);
    expect(r.pending.settled).toBe(1);
    expect(r.possible_duplicates).toBe(0);
    const t = store.getTransaction(db, p.id);
    expect(t).toMatchObject({ pending: 0, date: '2026-10-13', description: 'PRICELINE PHARMACY MT LAWLEY AUS', balance_cents: 80785,
      category: 'Shopping', merchant: 'Priceline', notes: 'Gift', split_ways: 2 });
    expect(tx()).toHaveLength(2);
  });

  it('settles at a different amount when the merchant clearly matches', () => {
    imp(auth('12/10/2026', 'GUZMAN Y GOMEZ - LEELEEDERVILLE     WAAU', -24.5), auth('12/10/2026', 'BAKERY LEEDERVILLE WAAU', -5));
    // A tip changed the restaurant's amount. The other row shares only the suburb, so it isn't the bakery.
    const r = imp(row('12/10/2026', 'GUZMAN Y GOMEZ - L LEEDERVILLE AUS', -28.5, 971.5), row('12/10/2026', 'FLORIST LEEDERVILLE AUS', -9, 962.5));
    expect(r.pending.settled).toBe(1);
    expect(r.inserted).toBe(1);
    expect(tx().find((t) => t.description.startsWith('GUZMAN'))?.amount_cents).toBe(-2850);
  });

  it("doesn't bring back pending rows that have already settled", () => {
    const old = [auth('12/10/2026', 'BWS    1234  SUBIACO      WAAU', -18.4), row('11/10/2026', 'GROCER', -50, 950)];
    imp(...old);
    imp(row('12/10/2026', 'BWS 12 SUBIACO AUS', -18.4, 931.6), row('11/10/2026', 'GROCER', -50, 950));
    // The old export again: its pending row is now the settled one.
    const r = imp(...old);
    expect(r.pending).toMatchObject({ added: 0, settled: 0, expired: [] });
    expect(r.rows.find((x) => x.description.startsWith('AUTH'))?.status).toBe('duplicate');
    expect(tx()).toHaveLength(2);
  });

  it('drops a pending row that never settles once an export covers its date without it', () => {
    imp(auth('08/10/2026', 'Digital Wallet        SYDNEY       000AU', -1), row('07/10/2026', 'GROCER', -50, 950));
    // A statement doesn't list pending rows, so it can't tell.
    importTransactions(db, { account: 'Everyday', source: 'pdf', transactions: [{ date: '2026-10-09', description: 'TRAIN', amount: -3 }] });
    expect(tx().some((t) => t.pending)).toBe(true);
    const r = imp(row('09/10/2026', 'TRAIN', -3, 943.5), row('08/10/2026', 'BAKERY', -3.5, 946.5));
    expect(r.pending.settled).toBe(0);
    expect(r.pending.expired).toMatchObject([{ date: '2026-10-08', amount_cents: -100 }]);
    expect(tx().some((t) => t.pending)).toBe(false);
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

  it('filters transactions to the categories in a bucket', () => {
    const descriptions = (bucket: string) => store.listTransactions(db, { bucket }).transactions.map((t) => t.description).sort();
    expect(descriptions('Splurge')).toEqual(['GUZMAN Y GOMEZ PERTH']);
    expect(descriptions('Expenses')).toEqual(['TRANSPERTH SMARTRIDER', 'WOOLWORTHS 4321 PERTH AU']);
    expect(descriptions('Savings')).toEqual([]);
    expect(() => store.listTransactions(db, { bucket: 'Nope' })).toThrow(/bucket/i);
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
