import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/core/db.ts';
import { importTransactions } from '../src/core/importer.ts';
import * as store from '../src/core/store.ts';
import { memoFrom } from '../src/core/util.ts';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

describe('memoFrom', () => {
  it('reads the message after the bank time stamp, in or out', () => {
    expect(memoFrom('MR JAMES SMITH To Phone 09:05AM 27Sep Breakfast')).toBe('Breakfast');
    expect(memoFrom('To Oliver Chen 04:10PM 20Sep Kettle for Unit')).toBe('Kettle for Unit');
    expect(memoFrom('L HILL 06:40PM 04Sep Pizzaa')).toBe('Pizzaa');
  });

  it('reads it after the sender when there is no stamp', () => {
    expect(memoFrom('MARGARET HILL Router', ['Margaret Hill'])).toBe('Router');
    expect(memoFrom('DAVID HILL Kettle', ['Dad', 'DAVID HILL'])).toBe('Kettle');
    expect(memoFrom('MARGARET HILL Router')).toBeNull();
  });

  it('ignores bank filler and Beem references', () => {
    expect(memoFrom('Noah Grant To Phone 09:20AM 27Sep CREDIT TO ACCOUNT')).toBeNull();
    expect(memoFrom('L HILL 07:35PM 28Mar')).toBeNull();
    expect(memoFrom('Beem Be.6b7c8d9e0f 1a', ['Beem'])).toBeNull();
  });
});

describe('memo on transactions', () => {
  it('is filled on import, kept apart from notes, and searchable', () => {
    store.addRule(db, { pattern: 'MARGARET HILL', merchant: 'Margaret Hill', payee_kind: 'person' });
    importTransactions(db, { account: 'Everyday', source: 'csv', transactions: [
      { date: '1998-09-21', description: 'MARGARET HILL Router', amount: 420, notes: 'family' },
      { date: '1996-04-29', description: 'Beem..3f4a5b6c7d8e9f0a1b', amount: -29.95, memo: 'toaster' },
    ] });
    const [router] = store.listTransactions(db, { search: 'Router' }).transactions;
    expect(router).toMatchObject({ memo: 'Router', notes: 'family' });
    const [remote] = store.listTransactions(db, { search: 'toaster' }).transactions;
    expect(remote.memo).toBe('toaster');
    expect(store.updateTransaction(db, remote.id, { memo: null }).memo).toBeNull();
  });
});
