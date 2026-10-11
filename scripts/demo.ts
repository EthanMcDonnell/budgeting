/**
 * Fills a throwaway database with a year of made-up transactions so you can explore the UI.
 * Usage: npm run demo   (writes data/demo.db and serves it; your real data/budget.db is untouched)
 *
 * Everyone here is invented: Alex rents in Perth with two housemates (Sam and Priya), who chip in for
 * the internet and power and pay back their share of dinners; Alex's mum Jenny pays back a gift.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, openDb } from '../src/core/db.ts';
import { importTransactions, type IncomingTransaction } from '../src/core/importer.ts';
import { createRecurring } from '../src/core/recurring.ts';
import { confirmPayback, reviewPayback, splitTransaction } from '../src/core/splits.ts';
import { addRule, applyRulesToUncategorized, assignCategories, createBucket, deleteBucket, listTransactions, updateBucket, updateTransaction } from '../src/core/store.ts';
import { addMonths, currentMonth, daysInMonth, todayIso } from '../src/core/util.ts';

const file = process.env.BUDGET_DB ?? path.join(PROJECT_ROOT, 'data', 'demo.db');
for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
const db = openDb(file);

let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
const between = (a: number, b: number) => Math.round((a + rand() * (b - a)) * 100) / 100;

const MONTHS = 12;
const today = todayIso();
const end = currentMonth();
const everyday: IncomingTransaction[] = [];
const card: IncomingTransaction[] = [];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A bank transfer as Bankwest shows it: sender, time stamp, then their message. */
const transfer = (from: string, date: string, memo: string, time = pick(['07:12PM', '08:41PM', '12:05PM', '06:30PM', '09:15AM'])) =>
  `${from} ${time} ${date.slice(8)}${MON[Number(date.slice(5, 7)) - 1]} ${memo}`.trim();

/** Purchases that housemates and friends pay a share of: [date, description, amount, payers, ways, memo]. */
type Shared = {
  date: string; description: string; amount: number; payers: [string, number, string][]; ways: number; memo: string; confirm: boolean;
  /** People who haven't paid their share yet. */
  owing?: string[];
};
const shared: Shared[] = [];

for (let i = MONTHS - 1; i >= 0; i--) {
  const month = addMonths(end, -i);
  const days = daysInMonth(month);
  const d = (day: number) => `${month}-${String(Math.min(day, days)).padStart(2, '0')}`;
  const add = (list: IncomingTransaction[], day: number, description: string, amount: number) => {
    if (d(day) <= today) list.push({ date: d(day), description, amount });
  };
  const m = Number(month.slice(5, 7));

  add(everyday, 1, 'SALARY ACME ENGINEERING PTY LTD', 6825);
  // Rent every Thursday: four or five a month.
  for (let day = 1; day <= days; day++) {
    if (new Date(`${d(day)}T12:00:00Z`).getUTCDay() === 4) add(everyday, day, 'TFR RAY WHITE LEEDERVILLE RENT', -480);
  }
  add(everyday, 16, 'TRANSFER TO SAVINGS', -1500);
  add(everyday, 20, 'HBF HEALTH INSURANCE DD', -152.4);
  add(everyday, 27, 'PAYMENT BANKWEST MASTERCARD', -between(900, 1400));
  add(everyday, 28, 'CREDIT INTEREST', between(0.5, 3));

  // Internet, split three ways; Priya hasn't paid this month's yet.
  add(everyday, 6, 'AUSSIE BROADBAND BPAY', -90);
  add(everyday, 8, transfer('SAM NGUYEN', d(8), 'Internet'), 30);
  if (i > 0) add(everyday, 9, transfer('PRIYA SHARMA', d(9), 'wifi'), 30);
  // Power every quarter, also split three ways.
  if (m % 3 === 1) {
    const bill = pick([264, 291, 318]);
    add(everyday, 12, 'SYNERGY BPAY 1234567', -bill);
    const share = bill / 3;
    add(everyday, 13, transfer('SAM NGUYEN', d(13), 'Power bill'), share);
    add(everyday, 14, transfer('PRIYA SHARMA', d(14), 'Synergy'), share);
  }

  for (let day = 1; day <= days; day++) {
    if (rand() < 0.3) add(card, day, pick(['WOOLWORTHS 4321 PERTH', 'COLES 0832 SUBIACO', 'ALDI STORES MIDLAND']), -between(25, 165));
    if (rand() < 0.35) add(card, day, pick(['COMMUNE CAFE LEEDERVILLE', 'MISCHIEF CAFE NORTHBRIDGE']), -between(4.5, 12));
    if (rand() < 0.16) add(card, day, pick(['UBER *EATS HELP.UBER.COM', 'GUZMAN Y GOMEZ PERTH', 'MCDONALDS SUBIACO', 'SQ *SOUTH OF NORTH']), -between(14, 68));
    if (rand() < 0.15) add(card, day, 'TRANSPERTH SMARTRIDER AUTOLOAD', -30);
    if (rand() < 0.06) add(card, day, pick(['AMPOL WEMBLEY', 'BP CONNECT CLAREMONT', 'SHELL WEMBLEY']), -between(55, 95));
    if (rand() < 0.05) add(card, day, pick(['KMART INNALOO', 'AMAZON MKTPLC AU', 'BUNNINGS OSBORNE PARK', 'IKEA PERTH']), -between(15, 240));
    if (rand() < 0.04) add(card, day, pick(['DAN MURPHYS SUBIACO', 'BWS LEEDERVILLE']), -between(25, 80));
  }
  add(card, 4, 'NETFLIX.COM', -18.99);
  add(card, 9, 'SPOTIFY P1234567', -13.99);
  add(card, 14, 'CLAUDE.AI SUBSCRIPTION', -32);
  add(card, 22, 'REVO FITNESS PERTH', -39.98);
  add(card, 27, 'PAYMENT RECEIVED THANK YOU', between(900, 1400));

  // A house dinner each month; the housemates pay back a third each a day or two later.
  const dinnerDay = 3 + Math.floor(rand() * 5);
  if (d(dinnerDay + 2) <= today) {
    const amount = between(120, 190);
    const third = Math.round((amount / 3) * 100) / 100;
    const payers: [string, number, string][] = [['SAM NGUYEN', third, pick(['Dinner', 'dinner thx', 'Thai'])]];
    if (i > 0) payers.push(['PRIYA SHARMA', third, pick(['Dinner', 'yum', 'food'])]);
    shared.push({
      date: d(dinnerDay), description: pick(['LALLA ROOKH PERTH', 'LONG CHIM PERTH', 'SUSHI TEI CLAREMONT']), amount: -amount, payers, ways: 3,
      memo: 'dinner', confirm: true, owing: i > 0 ? [] : ['Priya'],
    });
  }
  // Now and then Alex pays a friend back for tickets they bought.
  if (i % 4 === 2) add(everyday, 19, transfer('To Tom Baker', d(19), pick(['Footy tix', 'Gig tickets'])), -between(55, 95));
  if (i === 1) add(everyday, 23, transfer('To Sam Nguyen', d(23), 'Bunnings'), -64.5);
}

// Bought headphones for Mum; she paid it all back.
const gift = addMonths(end, -3);
shared.push({ date: `${gift}-11`, description: 'JB HI-FI PERTH', amount: -449, payers: [['JENNY HILL', 449, 'Headphones']], ways: 2, memo: 'gift', confirm: true });
// A long weekend in Margaret River with Priya and a friend, Tom.
const trip = addMonths(end, -4);
card.push({ date: `${trip}-02`, description: 'VIRGIN AUSTRALIA PERTH', amount: -312.6, notes: 'Margaret River trip' });
shared.push({ date: `${trip}-03`, description: 'AIRBNB * HM4K2PZQ', amount: -720, payers: [['PRIYA SHARMA', 240, 'Airbnb'], ['TOM BAKER', 240, 'margs airbnb']], ways: 3, memo: 'trip', confirm: true });
for (const [day, desc, amt] of [[4, 'VOYAGER ESTATE MARGARET RIVER', -96], [5, 'SETTLERS TAVERN MARGARET RIVER', -74.5], [5, 'MARGARET RIVER BAKERY', -18.4]] as const) {
  card.push({ date: `${trip}-0${day}`, description: desc, amount: amt, category: 'Fun & Travel', notes: 'Margaret River trip' });
}
// A Beem payment from Priya last week that Claude hasn't been told about yet.
shared.push({ date: addDays(today, -6), description: 'THE BEAUFORT ST MERCHANT', amount: -86, payers: [['Beem Be.7c41e09a2d 5f', 43, '']], ways: 2, memo: 'brunch', confirm: false });

for (const s of shared) {
  card.push({ date: s.date, description: s.description, amount: s.amount, notes: s.memo === 'trip' ? 'Margaret River trip' : null });
  s.payers.forEach(([from, amount, memo], k) => {
    const date = addDays(s.date, 1 + k);
    if (date > today) return;
    everyday.push({ date, description: from.startsWith('Beem') ? from : transfer(from, date, memo), amount });
  });
}
// A few with nothing to go on, for the Transactions page's review queue.
for (const [ago, desc, amt] of [[1, 'SQ *KAFFEINE PERTH', -6.5], [2, 'PAYPAL *STEAMGAMES', -24.95], [3, 'ZLR*WATERTOWN BRAND', -58]] as const) {
  const date = addDays(today, -ago);
  card.push({ date, description: desc, amount: amt });
}

function addDays(iso: string, n: number) {
  const t = new Date(`${iso}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

// Rules the defaults don't cover, as Claude would add them while categorising.
for (const [pattern, category, merchant] of [
  ['RAY WHITE LEEDERVILLE', 'Rent', 'Ray White Leederville'], ['COMMUNE CAFE', 'Eating & Drinking Out', 'Commune'], ['MISCHIEF CAFE', 'Eating & Drinking Out', 'Mischief'],
  ['LALLA ROOKH', 'Eating & Drinking Out', 'Lalla Rookh'], ['LONG CHIM', 'Eating & Drinking Out', 'Long Chim'], ['SUSHI TEI', 'Eating & Drinking Out', 'Sushi Tei'],
  ['BEAUFORT ST MERCHANT', 'Eating & Drinking Out', 'The Beaufort St Merchant'], ['SOUTH OF NORTH', 'Eating & Drinking Out', 'South of North'],
  ['SALARY', 'Salary', 'Acme Engineering'], ['TRANSFER TO SAVINGS', 'Transfers', null], ['PAYMENT BANKWEST MASTERCARD', 'Credit Card Payment', null],
  ['PAYMENT RECEIVED', 'Credit Card Payment', null], ['REVO FITNESS', 'Health & Personal', 'Revo Fitness'], ['HBF', 'Bills', 'HBF'],
] as const) addRule(db, { pattern, category, merchant });
for (const [pattern, name] of [['SAM NGUYEN', 'Sam'], ['PRIYA SHARMA', 'Priya'], ['JENNY HILL', 'Mum'], ['TOM BAKER', 'Tom']]) {
  addRule(db, { pattern, merchant: name, payee_kind: 'person' });
}

importTransactions(db, { account: 'Bankwest Everyday', source: 'csv', label: 'Everyday export', transactions: everyday });
importTransactions(db, { account: 'Bankwest Mastercard', source: 'csv', label: 'Mastercard export', transactions: card });
applyRulesToUncategorized(db);

// Recurring items: weekly rent, and two bills the housemates chip in for.
createRecurring(db, { name: 'Rent', pattern: 'RAY WHITE LEEDERVILLE', frequency: 'weekly', expected_amount: 480, category: 'Rent' });
createRecurring(db, {
  name: 'Internet', pattern: 'AUSSIE BROADBAND', frequency: 'monthly', expected_amount: 90, category: 'Bills',
  contributors: [{ name: 'Sam', pattern: 'SAM NGUYEN.*Internet', match_type: 'regex' }, { name: 'Priya', pattern: 'PRIYA SHARMA.*wifi', match_type: 'regex' }],
});
createRecurring(db, {
  name: 'Power', pattern: 'SYNERGY', frequency: 'quarterly', category: 'Bills',
  contributors: [{ name: 'Sam', pattern: 'SAM NGUYEN.*Power', match_type: 'regex' }, { name: 'Priya', pattern: 'PRIYA SHARMA.*Synergy', match_type: 'regex' }],
});
for (const [name, pattern] of [['Netflix', 'NETFLIX'], ['Spotify', 'SPOTIFY'], ['Health insurance', 'HBF']]) {
  createRecurring(db, { name, pattern, frequency: 'monthly' });
}

// Paybacks, as the transfer-review skill would record them.
const find = (text: string) => listTransactions(db, { search: text, limit: 500 }).transactions;
for (const s of shared) {
  const purchase = find(s.description).find((t) => t.date === s.date);
  if (!purchase) continue;
  const payments = s.payers.flatMap(([from, amount]) => find(from)
    .filter((t) => t.amount_cents === Math.round(amount * 100) && t.date > s.date && t.date <= addDays(s.date, 3)));
  if (!s.confirm) {
    for (const p of payments) {
      updateTransaction(db, p.id, { memo: 'brunch 🥞' });
      reviewPayback(db, { payment_id: p.id, person: 'Priya', purchase_id: purchase.id, ways: 2, verdict: 'likely', note: 'Beem memo says "brunch"; $43 is half the $86 at The Beaufort St Merchant the day before.' });
    }
  } else if (payments.length) {
    const split = confirmPayback(db, { purchase_id: purchase.id, ways: s.ways, payment_ids: payments.map((p) => p.id) }, 'ai');
    if (s.owing?.length) {
      splitTransaction(db, purchase.id, { ways: s.ways, shares: [...split.shares.filter((x) => x.person).map((x) => ({ person: x.person })), ...s.owing.map((person) => ({ person }))] });
    }
  }
}
// Pizza night that Sam hasn't paid his half of yet.
const pizza = { date: addDays(today, -2), description: 'DOMINOS PIZZA LEEDERVILLE', amount: -46 };
importTransactions(db, { account: 'Bankwest Mastercard', source: 'csv', label: 'Mastercard export', transactions: [pizza] });
splitTransaction(db, find('DOMINOS PIZZA')[0].id, { shares: [{ person: 'Sam' }], notes: 'Pizza night' });

// Buckets: rent follows its weekly payments, everything else is a share of income.
deleteBucket(db, 'Expenses');
createBucket(db, { name: 'Rent', kind: 'spend', follows_recurring: true });
assignCategories(db, 'Rent', ['Rent']);
createBucket(db, { name: 'Expenses', kind: 'spend', percent: 19.53, balances: true });
assignCategories(db, 'Expenses', ['Bills', 'Groceries', 'Transport', 'Home', 'Health & Personal', 'Other']);
for (const [name, sort] of [['Rent', 0], ['Expenses', 1], ['Savings', 2], ['Splurge', 3], ['Travel', 4]] as const) {
  db.prepare('UPDATE buckets SET sort = ? WHERE name = ?').run(sort, name);
}
updateBucket(db, 'Savings', { percent: 30 });

const n = (db.prepare('SELECT COUNT(*) n FROM transactions').get() as { n: number }).n;
console.error(`Demo database written to ${file} (${n} transactions)`);
