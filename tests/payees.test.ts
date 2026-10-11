import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/core/db.ts';
import { importTransactions } from '../src/core/importer.ts';
import { bankName, listPayees, payeeDetail } from '../src/core/payees.ts';
import { monthSummary } from '../src/core/reports.ts';
import * as store from '../src/core/store.ts';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

const imp = (transactions: { date: string; description: string; amount: number; merchant?: string }[]) =>
  importTransactions(db, { account: 'Everyday', source: 'csv', transactions });
const byDesc = (d: string) => store.listTransactions(db).transactions.find((t) => t.description === d)!;

describe('payees', () => {
  it('links imports to the payee of a matching seeded rule', () => {
    imp([{ date: '1998-09-01', description: 'WOOLWORTHS 4321 PERTH AU', amount: -20 }]);
    const t = byDesc('WOOLWORTHS 4321 PERTH AU');
    expect(t.merchant).toBe('Woolworths');
    expect(t.payee_kind).toBe('merchant');
    expect(t.category).toBe('Groceries');
  });

  it('lets a rule link a person without setting a category', () => {
    store.addRule(db, { pattern: 'To Riley', merchant: 'Riley', payee_kind: 'person' });
    imp([
      { date: '1998-09-01', description: 'To Riley 06:02AM 01Sep Rent', amount: -480 },
      { date: '1998-09-02', description: 'To Riley 08:00PM 02Sep Beers', amount: -20 },
    ]);
    const t = byDesc('To Riley 06:02AM 01Sep Rent');
    expect(t.merchant).toBe('Riley');
    expect(t.payee_kind).toBe('person');
    expect(t.category).toBeNull();
    expect(() => store.addRule(db, { pattern: 'NOTHING' })).toThrow(/needs a category/);
  });

  it('takes category and payee from different rules when the most specific one only sets one', () => {
    store.addRule(db, { pattern: 'To Riley', merchant: 'Riley', payee_kind: 'person' });
    store.addRule(db, { pattern: 'To Riley .*Rent', match_type: 'regex', category: 'Rent' });
    imp([{ date: '1998-09-01', description: 'To Riley 06:02AM 01Sep Rent', amount: -480 }]);
    const t = byDesc('To Riley 06:02AM 01Sep Rent');
    expect(t.merchant).toBe('Riley');
    expect(t.category).toBe('Rent');
  });

  it('fills in payees on existing transactions without overwriting', () => {
    imp([
      { date: '1998-09-01', description: 'MIKROY PTY LTD PERTH AUS', amount: -13.9 },
      { date: '1998-09-02', description: 'MIKROY PTY LTD PERTH AUS', amount: -14.1, merchant: 'Something Else' },
    ]);
    store.addRule(db, { pattern: 'MIKROY', category: 'Eating & Drinking Out', merchant: 'Zambrero Subiaco' });
    expect(store.applyRules(db)).toEqual({ categorized: 2, linked: 1 });
    const names = store.listTransactions(db, { search: 'MIKROY' }).transactions.map((t) => t.merchant).sort();
    expect(names).toEqual(['Something Else', 'Zambrero Subiaco']);
  });

  it('renames once for every transaction, and merges duplicates', () => {
    imp([
      { date: '1998-09-01', description: 'GYG SUBIACO', amount: -15, merchant: 'GYG' },
      { date: '1998-09-02', description: 'GUZMAN Y GOMEZ PERTH', amount: -16 },
    ]);
    const gyg = store.requirePayee(db, 'GYG');
    store.updatePayee(db, gyg.id, { name: 'GYG Subiaco' });
    expect(byDesc('GYG SUBIACO').merchant).toBe('GYG Subiaco');
    expect(() => store.updatePayee(db, gyg.id, { name: 'guzman y gomez' })).toThrow(/merge/);

    const r = store.mergePayee(db, gyg.id, 'Guzman y Gomez');
    expect(r.transactions).toBe(1);
    expect(store.listTransactions(db, { payee: 'Guzman y Gomez' }).count).toBe(2);
    expect(store.findPayee(db, 'GYG Subiaco')).toBeNull();
  });

  it('deleting a payee keeps its transactions and category rules', () => {
    imp([{ date: '1998-09-01', description: 'WOOLWORTHS METRO', amount: -10 }]);
    store.deletePayee(db, store.requirePayee(db, 'Woolworths').id);
    const t = byDesc('WOOLWORTHS METRO');
    expect(t.merchant).toBeNull();
    expect(t.category).toBe('Groceries');
    expect(store.listRules(db).find((r) => r.pattern === 'WOOLWORTHS')?.payee_id).toBeNull();
  });

  it('totals per payee for all time, the month and 12 months, plus bank names', () => {
    imp([
      { date: '1998-08-05', description: 'WOOLWORTHS 29 LEEDERVILLE AUS', amount: -40 },
      { date: '1998-09-03', description: 'WOOLWORTHS 26 SUBIACO AUS', amount: -60 },
      { date: '1998-09-04', description: 'WOOLWORTHS 29 LEEDERVILLE AUS', amount: 5 },
    ]);
    const w = listPayees(db, { month: '1998-09', kind: 'merchant' }).payees.find((p) => p.name === 'Woolworths')!;
    expect(w).toMatchObject({ tx_count: 3, out_cents: 10000, in_cents: 500, month_out_cents: 6000, month_in_cents: 500, year_out_cents: 10000, category: 'Groceries' });
    expect(w.bank_names).toEqual(['WOOLWORTHS LEEDERVILLE', 'WOOLWORTHS SUBIACO']);
    expect(w.patterns).toContain('WOOLWORTHS');

    const d = payeeDetail(db, w.id, { months: 3, end: '1998-09' });
    expect(d.months.map((m) => m.out_cents)).toEqual([0, 4000, 6000]);
    expect(d.transaction_count).toBe(3);
  });

  it('shows the payee on the dashboard top merchants', () => {
    imp([{ date: '1998-09-03', description: 'WOOLWORTHS 26 SUBIACO AUS', amount: -60 }]);
    const top = monthSummary(db, '1998-09', '1998-09-30').top_merchants[0];
    expect(top.name).toBe('Woolworths');
    expect(top.payee_id).toBe(store.requirePayee(db, 'Woolworths').id);
  });
});

describe('bankName', () => {
  it('strips times, memos, store and reference numbers', () => {
    expect(bankName('To Riley 07:15AM 01Sep Rent - 1/9')).toBe('To Riley');
    expect(bankName('MIKROY PTY LTD PERTH AUS')).toBe('MIKROY PTY LTD PERTH');
    expect(bankName('Beem Be.2f3e4d5c6b 9a')).toBe('Beem');
    expect(bankName('Beem..0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f')).toBe('Beem');
    expect(bankName('WOOLWORTHS 29 LEEDERVILLE AUS')).toBe('WOOLWORTHS LEEDERVILLE');
    expect(bankName('7-ELEVEN 4163 SUBIACO AUS')).toBe('7-ELEVEN SUBIACO');
    expect(bankName('ABC123 12 MONTH REG')).toBe('MONTH REG');
    expect(bankName('1234')).toBe('1234');
  });
});
