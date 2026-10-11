import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/core/db.ts';
import { importTransactions } from '../src/core/importer.ts';
import { listPayees } from '../src/core/payees.ts';
import { monthSummary } from '../src/core/reports.ts';
import * as splits from '../src/core/splits.ts';
import * as store from '../src/core/store.ts';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

type Line = { date: string; description: string; amount: number; merchant?: string; category?: string };
const imp = (transactions: Line[]) => importTransactions(db, { account: 'Everyday', source: 'csv', transactions });
const tx = (d: string) => store.listTransactions(db).transactions.find((t) => t.description === d)!;
const person = (pattern: string, name: string) => store.addRule(db, { pattern, merchant: name, payee_kind: 'person' });

describe('finding paybacks', () => {
  it('matches people sending the same share of a purchase, even before it posts', () => {
    person('MARCO BIANCHI', 'Marco');
    person('BEN CARTER', 'Ben');
    imp([
      { date: '1998-06-23', description: 'PARKSIDE GOLF COMO', amount: -320, merchant: 'Parkside Golf', category: 'Fun & Travel' },
      { date: '1998-06-22', description: 'Mr MARCO BIANCHI 10:45AM 22Jun golf', amount: 80 },
      { date: '1998-06-23', description: 'MR BEN CARTER J 05:30PM 23Jun CREDIT TO ACCOUNT', amount: 80 },
    ]);
    const [g] = splits.suggestPaybacks(db);
    expect(g.purchase.merchant).toBe('Parkside Golf');
    expect(g.ways).toBe(4);
    expect(g.confidence).toBe('high');
    expect(g.payments.map((p) => p.person).sort()).toEqual(['Ben', 'Marco']);
  });

  it('ignores transfers, recurring-bill shares and payments marked as not a payback', () => {
    person('L HILL', 'Lucy');
    imp([
      { date: '1998-03-23', description: "DOMINO'S PIZZA CLAREMONT", amount: -131.2, merchant: "Domino's", category: 'Eating & Drinking Out' },
      { date: '1998-03-23', description: 'L HILL 07:13PM 21Mar', amount: 65 },
    ]);
    expect(splits.suggestPaybacks(db)).toHaveLength(1);
    splits.setNotPayback(db, tx('L HILL 07:13PM 21Mar').id);
    expect(splits.suggestPaybacks(db)).toHaveLength(0);
  });

  it('needs at least half the other people to have paid before suggesting a bigger split', () => {
    person('RILEY WEST', 'Riley');
    person('NOAH GRANT', 'Noah');
    imp([
      { date: '1997-08-20', description: 'COVERMORE TRAVEL INSURANCE', amount: -204, merchant: 'Covermore', category: 'Fun & Travel' },
      { date: '1997-08-25', description: 'RILEY WEST 05:30PM 25Aug', amount: 40.8 },
      { date: '1997-08-25', description: 'NOAH GRANT 05:30PM 25Aug', amount: 40.8 },
    ]);
    // Two of four others sent a fifth: not enough for a 5-way split (needs 3).
    expect(splits.suggestPaybacks(db)).toHaveLength(0);
  });

  it("only suggests one person's half when it is clean, prompt and has no note about something else", () => {
    person('OLIVER CHEN', 'Oliver');
    person('L HILL', 'Lucy');
    imp([
      { date: '1998-09-16', description: 'COLES CLAREMONT', amount: -38, merchant: 'Coles', category: 'Groceries' },
      { date: '1998-09-16', description: 'OLIVER CHEN 08:41PM 16Sep Poker', amount: 19 },
      { date: '1998-07-30', description: 'APPLE STORE', amount: -60, merchant: 'Apple Store', category: 'Shopping' },
      { date: '1998-07-30', description: 'L HILL 06:00PM 30Jul', amount: 20 },
    ]);
    // Poker isn't Coles; a third of a shop purchase from one person is a guess.
    expect(splits.suggestPaybacks(db)).toHaveLength(0);
  });

  it('adds people at the same table who paid a different amount', () => {
    for (const [pattern, name] of [['WEI JIE TAN', 'Wei'], ['HANNAH J WHITE', 'Hannah'], ['ZOE MARTIN', 'Zoe'], ['K R BROWN', 'Brown'], ['OLIVER CHEN', 'Oliver']]) person(pattern, name);
    imp([
      { date: '1997-08-15', description: 'THAIGER PERTH C', amount: -108.3, merchant: 'Thaiger', category: 'Eating & Drinking Out' },
      { date: '1997-08-13', description: 'WEI JIE TAN To Phone 11:27AM 13Aug Thaiger', amount: 18.4 },
      { date: '1997-08-13', description: 'Hannah J White To Phone 11:23AM 13Aug thaiger lunch _', amount: 18.45 },
      { date: '1997-08-13', description: 'ZOE MARTIN To Phone 11:54AM 13Aug Boo', amount: 21.3 },
      { date: '1997-08-13', description: 'K R BROWN To Phone 06:07PM 13Aug Lunch', amount: 16.2 },
      // Same day, hours later and about something else: not part of it.
      { date: '1997-08-13', description: 'OLIVER CHEN 08:41PM 13Aug Poker', amount: 19 },
    ]);
    const [g] = splits.suggestPaybacks(db);
    expect(g.payments.map((p) => p.person).sort()).toEqual(['Brown', 'Hannah', 'Wei', 'Zoe']);
    expect(g.ways).toBe(5); // four of them plus you
    expect(g.uneven).toBe(true);
  });

  it('pairs uneven amounts from several people when their notes agree', () => {
    person('JAMES SMITH', 'James');
    person('NOAH GRANT', 'Noah');
    person('ISABEL MORGAN', 'Isabel');
    imp([
      { date: '1998-09-21', description: 'THE PANTRY PERTH', amount: -301.4, merchant: 'The Pantry', category: 'Eating & Drinking Out' },
      { date: '1998-09-21', description: 'MR JAMES SMITH To Phone 08:42AM 20Sep Breakfast', amount: 95 },
      { date: '1998-09-21', description: 'Noah Grant To Phone 09:00AM 20Sep CREDIT TO ACCOUNT', amount: 65 },
      { date: '1998-09-21', description: 'ISABEL MORGAN To Phone 08:50AM 20Sep Breakfast', amount: 42.35 },
    ]);
    const [g] = splits.suggestPaybacks(db);
    expect(g.purchase.merchant).toBe('The Pantry');
    expect(g.ways).toBe(4);
    expect(g.payments).toHaveLength(3);
  });
});

describe('splits', () => {
  it('confirming a payback nets the purchase down and tracks who still owes', () => {
    person('LEO PARKINSON', 'Leo');
    imp([
      { date: '1997-02-10', description: 'WEMBLEY GOLF', amount: -213, merchant: 'Wembley Golf', category: 'Fun & Travel' },
      { date: '1997-02-10', description: 'MR LEO PARKINSON 9 holes', amount: 71.02, category: 'Other' },
    ]);
    const s = splits.confirmPayback(db, { purchase_id: tx('WEMBLEY GOLF').id, ways: 3, payment_ids: [tx('MR LEO PARKINSON 9 holes').id] });
    expect(s.ways).toBe(3);
    expect(s.shares.map((x) => [x.person, x.amount_cents, x.status])).toEqual([['Leo', 7102, 'paid'], [null, 7100, 'owing']]);
    expect(s.your_share_cents).toBe(21300 - 7102 - 7100);
    // The payback moves into the purchase's category so Fun & Travel nets to what you and the unnamed person cover.
    expect(tx('MR LEO PARKINSON 9 holes').category).toBe('Fun & Travel');
    expect(tx('WEMBLEY GOLF').split_ways).toBe(3);
    expect(tx('MR LEO PARKINSON 9 holes').payback_for).toBe('Wembley Golf');
    expect(monthSummary(db, '1997-02').categories.find((c) => c.name === 'Fun & Travel')!.spent_cents).toBe(21300 - 7102);
    expect(splits.unclaimedCents(db)).toBe(7100);
  });

  it('a later payment claims the unnamed share, rounding to what they sent', () => {
    person('LEO PARKINSON', 'Leo');
    person('FELIX WAGNER', 'Felix');
    imp([
      { date: '1997-02-10', description: 'WEMBLEY GOLF', amount: -213, merchant: 'Wembley Golf', category: 'Fun & Travel' },
      { date: '1997-02-10', description: 'MR LEO PARKINSON 9 holes', amount: 71.02 },
      { date: '1997-02-13', description: 'FELIX WAGNER Golf', amount: 70 },
    ]);
    const s = splits.confirmPayback(db, { purchase_id: tx('WEMBLEY GOLF').id, ways: 3, payment_ids: [tx('MR LEO PARKINSON 9 holes').id] });
    const [g] = splits.suggestPaybacks(db);
    expect(g.purchase.split_id).toBe(s.id);
    const after = splits.linkPayback(db, tx('FELIX WAGNER Golf').id, s.id);
    expect(after.shares.find((x) => x.person === 'Felix')).toMatchObject({ amount_cents: 7000, status: 'paid' });
    expect(after.owed_cents).toBe(0);
  });

  it('shows what each person owes on the People page, and settles off-bank', () => {
    imp([{ date: '1998-07-20', description: 'THE PANTRY', amount: -60, category: 'Eating & Drinking Out' }]);
    const s = splits.splitTransaction(db, tx('THE PANTRY').id, { shares: [{ person: 'Riley' }, { person: 'Ava', amount: 15 }] });
    expect(s.shares.map((x) => [x.person, x.amount_cents])).toEqual([['Ava', 1500], ['Riley', 2000]]);
    const owed = () => Object.fromEntries(listPayees(db, { kind: 'person' }).payees.map((p) => [p.name, p.split_owed_cents]));
    expect(owed()).toEqual({ Riley: 2000, Ava: 1500 });
    splits.setShareSettled(db, s.shares.find((x) => x.person === 'Ava')!.id, true);
    expect(owed()).toEqual({ Riley: 2000, Ava: 0 });
  });

  it('keeps shares when people are merged', () => {
    imp([{ date: '1998-07-20', description: 'THE PANTRY', amount: -60, category: 'Eating & Drinking Out' }]);
    splits.splitTransaction(db, tx('THE PANTRY').id, { shares: [{ person: 'Oliver' }, { person: 'Oliver Chen' }] });
    store.mergePayee(db, 'Oliver', 'Oliver Chen');
    const [s] = splits.listSplits(db);
    expect(s.shares.map((x) => [x.person, x.amount_cents])).toEqual([['Oliver Chen', 4000]]);
  });

  it('rejects splitting money in, or shares over the total', () => {
    imp([
      { date: '1998-07-20', description: 'THE PANTRY', amount: -60 },
      { date: '1998-07-20', description: 'REFUND', amount: 10 },
    ]);
    expect(() => splits.splitTransaction(db, tx('REFUND').id, { ways: 2 })).toThrow(/Only money out/);
    expect(() => splits.splitTransaction(db, tx('THE PANTRY').id, { shares: [{ person: 'A', amount: 70 }] })).toThrow(/more than the purchase/);
  });
});

describe('Claude reviewing paybacks', () => {
  it('lists what the matcher skipped, unnamed Beem payments included, with possible purchases', () => {
    imp([
      { date: '1998-09-21', description: 'THE PANTRY PERTH', amount: -301.4, merchant: 'The Pantry', category: 'Eating & Drinking Out' },
      { date: '1998-09-21', description: 'Beem Be c1d2e3f4a5 7e', amount: 39.2, category: 'Eating & Drinking Out' },
    ]);
    const { suggestions, unmatched } = splits.paybackCandidates(db);
    expect(suggestions).toHaveLength(0);
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0].payment.person).toBeNull();
    expect(unmatched[0].nearby.map((q) => q.merchant)).toEqual(['The Pantry']);
  });

  it('a review names the sender and pairs a payment the matcher missed; linking clears it', () => {
    person('LEO PARKINSON', 'Leo');
    imp([
      { date: '1998-09-21', description: 'THE PANTRY PERTH', amount: -301.4, merchant: 'The Pantry', category: 'Eating & Drinking Out' },
      { date: '1998-09-21', description: 'Beem Be c1d2e3f4a5 7e', amount: 39.2 },
      { date: '1998-09-21', description: 'MR LEO PARKINSON 09:10AM 21Sep brekky', amount: 50 },
    ]);
    const pantry = tx('THE PANTRY PERTH').id;
    splits.reviewPayback(db, { payment_id: tx('Beem Be c1d2e3f4a5 7e').id, person: 'Riley', purchase_id: pantry, ways: 4, verdict: 'likely', note: 'Riley Beems for shared breakfasts' });
    splits.reviewPayback(db, { payment_id: tx('MR LEO PARKINSON 09:10AM 21Sep brekky').id, purchase_id: pantry, verdict: 'unsure', note: '"brekky" fits, but Leo rarely joins' });
    expect(tx('Beem Be c1d2e3f4a5 7e').merchant).toBe('Riley');

    const [g] = splits.suggestPaybacks(db);
    expect(g.purchase.id).toBe(pantry);
    expect(g.ways).toBe(4);
    expect(g.payments.map((p) => p.person).sort()).toEqual(['Leo', 'Riley']);
    expect(g.confidence).toBe('medium'); // one review is unsure
    expect(g.reviews.map((r) => r.verdict).sort()).toEqual(['likely', 'unsure']);

    splits.confirmPayback(db, { purchase_id: pantry, ways: g.ways, payment_ids: g.payments.map((p) => p.id) });
    expect(db.prepare('SELECT COUNT(*) AS n FROM payback_reviews').get()).toEqual({ n: 0 });
  });

  it('confirming can name who an unnamed payment came from', () => {
    imp([
      { date: '1998-07-20', description: 'THE PANTRY', amount: -44, merchant: 'The Pantry', category: 'Eating & Drinking Out' },
      { date: '1998-07-20', description: 'Beem Be.8a7b6c5d4e 21', amount: 22 },
    ]);
    const s = splits.confirmPayback(db, { purchase_id: tx('THE PANTRY').id, ways: 2, payment_ids: [tx('Beem Be.8a7b6c5d4e 21').id], people: [{ payment_id: tx('Beem Be.8a7b6c5d4e 21').id, person: 'Riley' }] }, 'ai');
    expect(s.shares.map((x) => [x.person, x.status])).toEqual([['Riley', 'paid']]);
  });
});

describe('notes on payments', () => {
  it('a memo naming the shop pairs any amount, but the month in a time stamp or a guess in notes does not', () => {
    person('L HILL', 'Lucy');
    imp([
      { date: '1997-05-19', description: 'LANTERN BAR ADELAIDE', amount: -94.6, merchant: 'Lantern', category: 'Fun & Travel' },
      { date: '1997-05-19', description: 'RUNDLE ESPRESSO ADELAIDE', amount: -60, merchant: 'Rundle Espresso', category: 'Fun & Travel' },
      { date: '1997-05-19', description: 'Beem .5d6e7f8091ab', amount: 42 },
      { date: '1997-10-09', description: 'To Brennans 04:30PM 09Oct Pool Table', amount: -179.5, merchant: 'Brennans', category: 'Home' },
      { date: '1997-10-09', description: 'L HILL 05:48PM 09Oct', amount: 8 },
    ]);
    store.updateTransaction(db, tx('Beem .5d6e7f8091ab').id, { merchant: 'Riley', payee_kind: 'person', memo: 'Lantern payback', notes: 'Adelaide trip' });
    store.updateTransaction(db, tx('L HILL 05:48PM 09Oct').id, { notes: 'Likely Brennans pool table' });
    const list = splits.suggestPaybacks(db);
    expect(list.map((g) => g.purchase.merchant)).toEqual(['Lantern']);
    expect(list[0].payments[0].memo).toBe('Lantern payback');
    // $42 of $94.60 is what they had, not half of it
    expect([list[0].uneven, list[0].reasons]).toEqual([true, ['memo names it']]);
  });
});

