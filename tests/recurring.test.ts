import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/core/db.ts';
import { importTransactions } from '../src/core/importer.ts';
import * as rec from '../src/core/recurring.ts';
import { budgetPlan, monthSummary, trends } from '../src/core/reports.ts';
import { currentMonth } from '../src/core/util.ts';
import * as store from '../src/core/store.ts';

let db: DB;
const tx = (date: string, description: string, amount: number) => ({ date, description, amount });

beforeEach(() => {
  db = openDb(':memory:');
  importTransactions(db, {
    account: 'Everyday', source: 'csv', transactions: [
      tx('1998-07-12', 'ANTHROPIC* CLAUDE SAN FRANCISCO', -34), tx('1998-08-12', 'ANTHROPIC* CLAUDE SAN FRANCISCO', -34),
      tx('1998-09-12', 'ANTHROPIC* CLAUDE SAN FRANCISCO', -34),
      tx('1998-08-22', 'ORIGIN ENERGY HO 111', -250), tx('1998-09-22', 'ORIGIN ENERGY HO 222', -310),
      tx('1998-09-24', 'OLIVER CHEN Monthly Internet', 30),
      tx('1998-09-03', 'To Riley Rent', -480), tx('1998-09-10', 'To Riley Rent', -480), tx('1998-09-17', 'To Riley Rent', -480),
      tx('1998-09-05', 'GUZMAN Y GOMEZ', -15), tx('1998-09-19', 'GUZMAN Y GOMEZ', -14), tx('1998-09-20', 'GUZMAN Y GOMEZ', -16),
    ],
  });
});

describe('dates', () => {
  it('steps months without overflowing short months', () => {
    expect(rec.nextDate('1998-01-31', 'monthly')).toBe('1998-02-28');
    expect(rec.nextDate('1998-09-10', 'fortnightly')).toBe('1998-09-24');
    expect(rec.nextDate('1998-11-30', 'quarterly')).toBe('1999-02-28');
  });
});

describe('recurring items', () => {
  it('links past and future matches and works out status', () => {
    const { linked } = rec.createRecurring(db, { name: 'Electricity', pattern: 'ORIGIN ENERGY', frequency: 'monthly' });
    expect(linked).toBe(2);
    const r = rec.listRecurring(db, '1998-10-20');
    const e = r.items.find((i) => i.name === 'Electricity')!;
    expect(e).toMatchObject({
      last_paid: { date: '1998-09-22', amount_cents: 31000 }, change_cents: 6000, next_due: '1998-10-22',
      status: 'due_soon', typical_cents: 28000, monthly_cents: 28000,
    });

    importTransactions(db, { account: 'Everyday', source: 'csv', transactions: [tx('1998-10-22', 'ORIGIN ENERGY HO 333', -280)] });
    expect(rec.listRecurring(db, '1998-10-23').items[0]).toMatchObject({ last_paid: { date: '1998-10-22' }, paid_recently: true, next_due: '1998-11-22' });
  });

  it('only calls a payment overdue once imported data runs past the due date', () => {
    rec.createRecurring(db, { name: 'Claude', pattern: 'ANTHROPIC* CLAUDE', frequency: 'monthly' });
    // Due 12 Oct; data only runs to 24 Sep.
    expect(rec.listRecurring(db, '1998-10-25').items[0].status).toBe('awaiting_data');
    importTransactions(db, { account: 'Everyday', source: 'csv', transactions: [tx('1998-10-24', 'WOOLWORTHS', -10)] });
    expect(rec.listRecurring(db, '1998-10-25').items[0]).toMatchObject({ status: 'overdue', days_overdue: 13 });
  });

  it('counts paybacks linked by hand and normalises weekly costs to a month', () => {
    rec.createRecurring(db, { name: 'Rent', pattern: 'To Riley', frequency: 'weekly', expected_amount: 480 });
    const internet = rec.createRecurring(db, { name: 'Internet', pattern: 'NBN PROVIDER', frequency: 'monthly' }).item;
    const payback = store.listTransactions(db, { search: 'Monthly Internet' }).transactions[0];
    store.updateTransaction(db, payback.id, { recurring_id: internet.id });
    const r = rec.listRecurring(db, '1998-09-25');
    expect(r.items.find((i) => i.name === 'Rent')!.monthly_cents).toBe(208000);
    expect(r.items.find((i) => i.name === 'Internet')).toMatchObject({ status: 'no_payments', credits_90d_cents: 3000 });
  });

  it('re-links when the pattern changes and unlinks on delete', () => {
    const { item } = rec.createRecurring(db, { name: 'Bill', pattern: 'ORIGIN ENERGY', frequency: 'monthly' });
    expect(rec.updateRecurring(db, item.id, { pattern: 'ANTHROPIC* CLAUDE' }).linked).toBe(3);
    expect(store.listTransactions(db, { search: 'ORIGIN' }).transactions.every((t) => t.recurring_id == null)).toBe(true);
    rec.deleteRecurring(db, item.id);
    expect(store.listTransactions(db).transactions.every((t) => t.recurring_id == null)).toBe(true);
  });

  it('suggests regular payments seen at least three times, but not irregular ones', () => {
    const s = rec.suggestRecurring(db);
    const names = s.map((x) => `${x.name}:${x.frequency}`);
    expect(names).toEqual(expect.arrayContaining(['Anthropic:monthly', 'To Riley Rent:weekly']));
    expect(names.some((n) => n.startsWith('Origin'))).toBe(false); // only two bills so far
    expect(names.some((n) => n.startsWith('Guzman'))).toBe(false);
    rec.createRecurring(db, { name: 'Claude', pattern: 'ANTHROPIC', frequency: 'monthly' });
    expect(rec.suggestRecurring(db).some((x) => x.name.startsWith('Anthropic'))).toBe(false);
  });

  it('validates input', () => {
    expect(() => rec.createRecurring(db, { name: 'X', pattern: '(', match_type: 'regex', frequency: 'monthly' })).toThrow(/Invalid/);
    expect(() => rec.createRecurring(db, { name: 'X', pattern: 'A', frequency: 'daily' as never })).toThrow(/Frequency/);
  });

  describe('splitting with housemates', () => {
    const setup = () => {
      store.addRule(db, { pattern: 'ORIGIN ENERGY', category: 'Bills' });
      importTransactions(db, {
        account: 'Everyday', source: 'csv', transactions: [
          tx('1998-09-05', 'ORIGIN ENERGY HO OE-100200-0905', -90),
          tx('1998-10-05', 'ORIGIN ENERGY HO OE-100200-1005', -90),
          tx('1998-10-01', 'RILEY WEST-MOR Internet', 30),
          tx('1998-10-09', 'OLIVER CHEN 02:50PM 09Oct Boss', 120),
        ],
      });
      return rec.createRecurring(db, {
        name: 'Internet', pattern: 'OE-100200', frequency: 'monthly', expected_amount: 90,
        contributors: [{ name: 'Oliver', pattern: 'Monthly Internet' }, { name: 'Riley', pattern: 'RILEY WEST-MOR' }],
      });
    };

    it('matches contributors\' payments, files them under the bill category and works out shares', () => {
      const { item } = setup();
      const linked = store.listTransactions(db, { limit: 100 }).transactions.filter((t) => t.recurring_id === item.id && t.amount_cents > 0);
      // Oliver's 'Boss' payment isn't for the internet, so it isn't matched.
      expect(linked.map((t) => `${t.contributor}:${t.amount_cents}:${t.category}`).sort())
        .toEqual(['Oliver:3000:Bills', 'Riley:3000:Bills']);

      const i = rec.listRecurring(db, '1998-10-12').items[0];
      expect(i).toMatchObject({ your_share_cents: 3000, your_monthly_cents: 3000 });
      expect(i.contributors.map((c) => [c.name, c.share_cents])).toEqual([['Oliver', 3000], ['Riley', 3000]]);
      // 5 Oct bill: Oliver paid (24 Sep), Riley paid (1 Oct). 5 Sep bill: before either started paying, so not owed.
      const oct = i.cycles.find((c) => c.date === '1998-10-05')!;
      expect(oct.shares.map((s) => `${s.name}:${s.status}`)).toEqual(['Oliver:paid', 'Riley:paid']);
      expect(i.cycles.find((c) => c.date === '1998-09-05')!.shares.every((s) => s.status === 'waiting')).toBe(true);
      expect(i.owed_to_you_cents).toBe(0);
      expect(i.current_cycle?.date).toBe('1998-11-05');
    });

    it('shows who still owes once a bill is paid', () => {
      setup();
      importTransactions(db, { account: 'Everyday', source: 'csv', transactions: [
        tx('1998-11-04', 'OLIVER CHEN Monthly Internet', 30), tx('1998-11-05', 'ORIGIN ENERGY HO OE-100200-1105', -90),
      ] });
      const i = rec.listRecurring(db, '1998-11-08').items[0];
      expect(i.current_cycle).toMatchObject({ date: '1998-11-05', bill_paid: true });
      expect(i.current_cycle!.shares.map((s) => `${s.name}:${s.status}`)).toEqual(['Oliver:paid', 'Riley:owing']);
      expect(i.owed_to_you_cents).toBe(3000);
    });

    it('keeps every bill and still counts shares owed on older ones', () => {
      setup();
      const months = ['11', '12', '01', '02'].map((m, n) => `${n < 2 ? 1998 : 1999}-${m}`);
      importTransactions(db, { account: 'Everyday', source: 'csv', transactions: months.flatMap((m) => [
        tx(`${m}-04`, 'OLIVER CHEN Monthly Internet', 30), tx(`${m}-05`, `ORIGIN ENERGY HO OE-100200-${m}`, -90),
      ]) });
      const i = rec.listRecurring(db, '1999-02-08').items[0];
      expect(i.cycles.filter((c) => c.bill_paid).map((c) => c.date)).toEqual(
        ['1999-02-05', '1999-01-05', '1998-12-05', '1998-11-05', '1998-10-05', '1998-09-05']);
      // Riley stopped paying after October, so he owes on all four bills since, including the oldest.
      expect(i.cycles.find((c) => c.date === '1998-11-05')!.shares.map((s) => `${s.name}:${s.status}`)).toEqual(['Oliver:paid', 'Riley:owing']);
      expect(i.owed_to_you_cents).toBe(4 * 3000);
    });

    it('supports uneven shares and keeps links when people are renamed', () => {
      const { item } = setup();
      const [m, l] = rec.listContributors(db, item.id);
      rec.updateRecurring(db, item.id, { contributors: [{ id: m.id, name: 'Ollie', pattern: 'Monthly Internet', share_amount: 40 }, { id: l.id, name: 'Riley', pattern: 'RILEY WEST-MOR' }] });
      const i = rec.listRecurring(db, '1998-10-12').items[0];
      expect(i.contributors.map((c) => [c.name, c.share_cents])).toEqual([['Ollie', 4000], ['Riley', 3000]]);
      expect(i.your_share_cents).toBe(2000);
      expect(store.listTransactions(db, { search: 'Monthly Internet' }).transactions[0].contributor).toBe('Ollie');
      rec.updateRecurring(db, item.id, { contributors: [] });
      expect(store.listTransactions(db, { search: 'Monthly Internet' }).transactions[0].recurring_id).toBeNull();
    });

    it('only lets a payment come from a person on that item', () => {
      const { item } = setup();
      const other = rec.createRecurring(db, { name: 'Gym', pattern: 'GYM', frequency: 'monthly', contributors: [{ name: 'Sam', pattern: 'SAM' }] }).item;
      const sam = rec.listContributors(db, other.id)[0];
      const boss = store.listTransactions(db, { search: 'Boss' }).transactions[0];
      expect(() => store.updateTransaction(db, boss.id, { recurring_id: item.id, contributor_id: sam.id })).toThrow(/isn't on/);
    });
  });
});

describe('recurring payments still due in a month', () => {
  beforeEach(() => {
    for (const t of store.listTransactions(db, { search: 'Riley' }).transactions) store.updateTransaction(db, t.id, { category: 'Rent' });
    rec.createRecurring(db, { name: 'Rent', pattern: 'To Riley', frequency: 'weekly' });
    rec.createRecurring(db, { name: 'Claude', pattern: 'ANTHROPIC', frequency: 'monthly' }); // Subscriptions, in Splurge
  });
  const reserved = (month: string, bucket: string) => budgetPlan(db, month, '1998-09-20').buckets.find((b) => b.name === bucket)!.reserved;

  it('reserves each due date left in the month against the bucket of its category', () => {
    // Rent was last paid 17 Sep: due 24 Sep, then every Thursday in October.
    expect(reserved('1998-09', 'Expenses')).toMatchObject({ cents: 48000, items: [{ name: 'Rent', dates: ['1998-09-24'] }] });
    expect(reserved('1998-10', 'Expenses')).toMatchObject({
      cents: 5 * 48000, items: [{ name: 'Rent', each_cents: 48000, dates: ['1998-10-01', '1998-10-08', '1998-10-15', '1998-10-22', '1998-10-29'] }],
    });
    expect(reserved('1998-09', 'Splurge').cents).toBe(0); // Claude's next is 12 Oct
    expect(reserved('1998-10', 'Splurge')).toMatchObject({ cents: 3400, items: [{ name: 'Claude', dates: ['1998-10-12'] }] });
    expect(reserved('1998-08', 'Expenses').cents).toBe(0); // the past has nothing left to pay
    expect(monthSummary(db, '1998-10', '1998-09-20').totals.reserved_cents).toBe(5 * 48000 + 3400);
  });

  it('counts only your share when others chip in, and skips paused items', () => {
    const rent = rec.listRecurring(db).items.find((i) => i.name === 'Rent')!;
    rec.updateRecurring(db, rent.id, { contributors: [{ name: 'Oliver', pattern: 'OLIVER CHEN', share_amount: 190 }] });
    expect(reserved('1998-09', 'Expenses').cents).toBe(29000);
    rec.updateRecurring(db, rent.id, { active: false });
    expect(reserved('1998-09', 'Expenses').cents).toBe(0);
  });

  it('a bucket can follow its recurring payments, with another balancing it', () => {
    store.createBucket(db, { name: 'Rent', follows_recurring: true });
    store.assignCategories(db, 'Rent', ['Rent']);
    store.updateBucket(db, 'Expenses', { balances: true });
    store.setPlannedIncome(db, 6000);
    const plan = (month: string) => budgetPlan(db, month, '1998-09-20');
    const bucket = (month: string, name: string) => plan(month).buckets.find((b) => b.name === name)!;
    const expensesUsual = bucket('1998-09', 'Expenses').target_cents! - bucket('1998-09', 'Expenses').balance_cents;

    // Rent is $480 every Thursday: $2,080 in a usual month, four Thursdays in September, five in October.
    expect(bucket('1998-09', 'Rent')).toMatchObject({ mode: 'recurring', target_cents: 4 * 48000, schedule: { average_cents: 208000 } });
    expect(bucket('1998-10', 'Rent')).toMatchObject({ target_cents: 5 * 48000, schedule: { items: [{ name: 'Rent', count: 5, each_cents: 48000 }] } });
    // Expenses gives up the fifth week's $320 in October and gets $160 back in September.
    expect(bucket('1998-10', 'Expenses')).toMatchObject({ balance_cents: -32000, target_cents: expensesUsual - 32000 });
    expect(bucket('1998-09', 'Expenses')).toMatchObject({ balance_cents: 16000, target_cents: expensesUsual + 16000 });
    // So the plan adds up the same every month.
    expect(plan('1998-10').totals.allocated_cents).toBe(plan('1998-09').totals.allocated_cents);
    expect(monthSummary(db, '1998-10', '1998-09-20').buckets.find((b) => b.name === 'Rent')!.target_cents).toBe(240000);

    // Only one bucket balances, and setting a percentage stops following recurring payments.
    store.updateBucket(db, 'Splurge', { balances: true });
    expect(store.findBucket(db, 'Expenses')!.balances).toBe(0);
    store.updateBucket(db, 'Rent', { amount: 2080 });
    expect(bucket('1998-10', 'Rent')).toMatchObject({ mode: 'amount', target_cents: 208000, schedule: null });
    expect(() => store.updateBucket(db, 'Rent', { follows_recurring: true, balances: true })).toThrow();
  });

  it('counts what was paid plus what is still due when the payment day changes mid-month', () => {
    store.createBucket(db, { name: 'Rent', follows_recurring: true });
    store.assignCategories(db, 'Rent', ['Rent']);
    // Thursdays 1, 8 and 15 Oct, then Wednesday 21 Oct, with 28 Oct still to come: five, not October's four Wednesdays.
    importTransactions(db, {
      account: 'Everyday', source: 'csv',
      transactions: ['1998-09-24', '1998-10-01', '1998-10-08', '1998-10-15', '1998-10-21'].map((d) => tx(d, 'To Riley Rent', -480)),
    });
    const rent = budgetPlan(db, '1998-10', '1998-10-23').buckets.find((b) => b.name === 'Rent')!;
    expect(rent).toMatchObject({ target_cents: 5 * 48000, schedule: { items: [{ name: 'Rent', count: 5 }] } });
  });
});

describe('quarterly and yearly bills spread across months', () => {
  beforeEach(() => {
    importTransactions(db, {
      account: 'Bills', source: 'csv', transactions: [
        tx('1998-05-20', 'AGL GAS 1', -210), tx('1998-05-25', 'OLIVER CHEN 01:00PM 25May gas', 70), tx('1998-05-26', 'RILEY WEST-MOR gas', 70),
      ],
    });
    rec.createRecurring(db, {
      name: 'Gas', pattern: 'AGL GAS', frequency: 'quarterly', expected_amount: 210, category: 'Bills',
      contributors: [
        { name: 'Oliver', pattern: 'OLIVER CHEN.*gas', match_type: 'regex' },
        { name: 'Riley', pattern: 'RILEY WEST-MOR.*gas', match_type: 'regex' },
      ],
    });
  });
  const bills = (month: string) => budgetPlan(db, month, '1998-09-10').buckets.flatMap((b) => b.categories).find((c) => c.name === 'Bills')!;

  it('counts your monthly part from the first bill instead of the bill and paybacks', () => {
    expect(rec.spreadBills(db, '1998-09-10')).toEqual([expect.objectContaining({ monthly_cents: 2333, from: '1998-05' })]);
    expect(bills('1998-04').spent_cents + 0).toBe(0); // -0 when nothing's there
    expect(bills('1998-05').spent_cents).toBe(2333); // not $210 out, $140 back
    expect(bills('1998-07')).toMatchObject({ spent_cents: 2333, last_month_cents: 2333, avg3_cents: Math.round((2333 * 2) / 3) });
    const july = monthSummary(db, '1998-07', '1998-09-10');
    expect(july.categories.find((c) => c.name === 'Bills')!.spent_cents).toBe(2333);
    expect(july.daily[0].spent_cents).toBe(2333); // counted from the 1st
    expect(july.totals.spent_cents).toBe(2333 + 3400); // plus Claude
    const t = trends(db, 4, '1998-08').categories.find((c) => c.name === 'Bills')!;
    expect(t.values).toMatchObject({ '1998-05': 2333, '1998-06': 2333, '1998-07': 2333, '1998-08': 2333 });
  });

  it("isn't still due in the month of the bill, and stops when paused", () => {
    // Next bill 20 Aug would otherwise be reserved against Expenses.
    expect(budgetPlan(db, '1998-08', '1998-08-01').buckets.find((b) => b.name === 'Expenses')!.reserved.items.map((i) => i.name)).not.toContain('Gas');
    rec.updateRecurring(db, rec.getRecurring(db, 'Gas').id, { active: false });
    expect(bills('1998-05').spent_cents).toBe(210 * 100 - 140 * 100);
    expect(bills('1998-07').spent_cents + 0).toBe(0);
  });

  it('spreads a new bill with no payments yet from this month, in its own category', () => {
    rec.createRecurring(db, { name: 'Insurance', pattern: 'AAMI', frequency: 'yearly', expected_amount: 780, category: 'Bills' });
    expect(rec.listRecurring(db).items.find((i) => i.name === 'Insurance')!.category).toBe('Bills');
    const month = currentMonth();
    expect(monthSummary(db, month).categories.find((c) => c.name === 'Bills')!.spent_cents).toBe(2333 + 6500);
  });
});
