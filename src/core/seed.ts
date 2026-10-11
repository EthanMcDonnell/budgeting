import type { DB } from './db.ts';

type Kind = 'expense' | 'income' | 'transfer';

export const DEFAULT_CATEGORIES: [string, Kind][] = [
  ['Rent', 'expense'],
  ['Bills', 'expense'],
  ['Groceries', 'expense'],
  ['Eating & Drinking Out', 'expense'],
  ['Transport', 'expense'],
  ['Home', 'expense'],
  ['Shopping', 'expense'],
  ['Health & Personal', 'expense'],
  ['Subscriptions', 'expense'],
  ['Fun & Travel', 'expense'],
  ['Other', 'expense'],
  ['Salary', 'income'],
  ['Dividends', 'income'],
  ['Interest Earned', 'income'],
  ['Refunds & Other Income', 'income'],
  ['Transfers', 'transfer'],
  ['Credit Card Payment', 'transfer'],
];

// Common Australian merchants. Matching is case-insensitive "contains" on word boundaries (IGA won't match GIGABYTE).
// Claude (via MCP) and you (via the UI) add more as you categorise.
const DEFAULT_RULES: [pattern: string, category: string, merchant: string | null][] = [
  ['WOOLWORTHS', 'Groceries', 'Woolworths'],
  ['COLES', 'Groceries', 'Coles'],
  ['ALDI', 'Groceries', 'Aldi'],
  ['IGA', 'Groceries', 'IGA'],
  ['HARRIS FARM', 'Groceries', 'Harris Farm'],
  ['UBER *EATS', 'Eating & Drinking Out', 'Uber Eats'],
  ['UBER EATS', 'Eating & Drinking Out', 'Uber Eats'],
  ['MENULOG', 'Eating & Drinking Out', 'Menulog'],
  ['DOORDASH', 'Eating & Drinking Out', 'DoorDash'],
  ['MCDONALDS', 'Eating & Drinking Out', "McDonald's"],
  ['HUNGRY JACKS', 'Eating & Drinking Out', "Hungry Jack's"],
  ['GUZMAN', 'Eating & Drinking Out', 'Guzman y Gomez'],
  ['DOMINOS', 'Eating & Drinking Out', "Domino's"],
  ['DAN MURPHY', 'Eating & Drinking Out', "Dan Murphy's"],
  ['BWS', 'Eating & Drinking Out', 'BWS'],
  ['LIQUORLAND', 'Eating & Drinking Out', 'Liquorland'],
  ['TRANSPERTH', 'Transport', 'Transperth'],
  ['SMARTRIDER', 'Transport', 'SmartRider'],
  ['UBER *TRIP', 'Transport', 'Uber'],
  ['DIDI', 'Transport', 'DiDi'],
  ['AMPOL', 'Transport', 'Ampol'],
  ['CALTEX', 'Transport', 'Caltex'],
  ['BP', 'Transport', 'BP'],
  ['SHELL', 'Transport', 'Shell'],
  ['PUMA ENERGY', 'Transport', 'Puma'],
  ['7-ELEVEN', 'Transport', '7-Eleven'],
  ['SYNERGY', 'Bills', 'Synergy'],
  ['WATER CORP', 'Bills', 'Water Corporation'],
  ['ALINTA', 'Bills', 'Alinta Energy'],
  ['TELSTRA', 'Bills', 'Telstra'],
  ['OPTUS', 'Bills', 'Optus'],
  ['VODAFONE', 'Bills', 'Vodafone'],
  ['AUSSIE BROADBAND', 'Bills', 'Aussie Broadband'],
  ['NETFLIX', 'Subscriptions', 'Netflix'],
  ['SPOTIFY', 'Subscriptions', 'Spotify'],
  ['DISNEY PLUS', 'Subscriptions', 'Disney+'],
  ['STAN.COM', 'Subscriptions', 'Stan'],
  ['YOUTUBE', 'Subscriptions', 'YouTube'],
  ['APPLE.COM/BILL', 'Subscriptions', 'Apple'],
  ['CLAUDE.AI', 'Subscriptions', 'Claude'],
  ['ANTHROPIC', 'Subscriptions', 'Anthropic'],
  ['OPENAI', 'Subscriptions', 'OpenAI'],
  ['CHEMIST WAREHOUSE', 'Health & Personal', 'Chemist Warehouse'],
  ['PRICELINE', 'Health & Personal', 'Priceline'],
  ['MEDIBANK', 'Bills', 'Medibank'],
  ['HBF', 'Bills', 'HBF'],
  ['RAC INSURANCE', 'Bills', 'RAC Insurance'],
  ['BUNNINGS', 'Home', 'Bunnings'],
  ['IKEA', 'Home', 'IKEA'],
  ['KMART', 'Shopping', 'Kmart'],
  ['TARGET', 'Shopping', 'Target'],
  ['BIG W', 'Shopping', 'Big W'],
  ['JB HI-FI', 'Shopping', 'JB Hi-Fi'],
  ['AMAZON', 'Shopping', 'Amazon'],
  ['HOYTS', 'Fun & Travel', 'Hoyts'],
  ['EVENT CINEMAS', 'Fun & Travel', 'Event Cinemas'],
  ['QANTAS', 'Fun & Travel', 'Qantas'],
  ['VIRGIN AUSTRALIA', 'Fun & Travel', 'Virgin Australia'],
  ['JETSTAR', 'Fun & Travel', 'Jetstar'],
  ['AIRBNB', 'Fun & Travel', 'Airbnb'],
  ['INTEREST CHARGED', 'Other', null],
  ['ACCOUNT FEE', 'Other', null],
  ['INTEREST PAID', 'Interest Earned', null],
  ['CREDIT INTEREST', 'Interest Earned', null],
  ['ATM WITHDRAWAL', 'Other', null],
];

// Starting buckets, as shares of income. Spending categories not listed start in the first one.
export const DEFAULT_BUCKETS: { name: string; kind: 'spend' | 'save'; percent: number; categories: string[] }[] = [
  { name: 'Expenses', kind: 'spend', percent: 50, categories: ['Rent', 'Bills', 'Groceries', 'Transport', 'Home', 'Health & Personal', 'Other'] },
  { name: 'Savings', kind: 'save', percent: 30, categories: [] },
  { name: 'Splurge', kind: 'spend', percent: 10, categories: ['Eating & Drinking Out', 'Shopping', 'Subscriptions'] },
  { name: 'Travel', kind: 'spend', percent: 10, categories: ['Fun & Travel'] },
];

/** Creates the default buckets if there are none, then puts each spending category without a bucket into its default one. */
export function seedBuckets(db: DB) {
  if (!db.prepare('SELECT 1 FROM buckets LIMIT 1').get()) {
    const ins = db.prepare('INSERT INTO buckets (name, kind, percent, sort) VALUES (?, ?, ?, ?)');
    DEFAULT_BUCKETS.forEach((b, i) => ins.run(b.name, b.kind, b.percent, i));
  }
  const bucketId = db.prepare('SELECT id FROM buckets WHERE name = ?');
  const home = new Map<string, number>();
  for (const b of DEFAULT_BUCKETS) {
    const row = bucketId.get(b.name) as { id: number } | undefined;
    if (row) for (const c of b.categories) home.set(c.toLowerCase(), row.id);
  }
  const fallback = db.prepare("SELECT id FROM buckets WHERE kind = 'spend' ORDER BY sort, id LIMIT 1").get() as { id: number } | undefined;
  const cats = db.prepare("SELECT id, name FROM categories WHERE kind = 'expense' AND bucket_id IS NULL").all() as { id: number; name: string }[];
  const set = db.prepare('UPDATE categories SET bucket_id = ? WHERE id = ?');
  for (const c of cats) {
    const id = home.get(c.name.toLowerCase()) ?? fallback?.id;
    if (id) set.run(id, c.id);
  }
}

export function seedDefaults(db: DB) {
  const insCat = db.prepare('INSERT INTO categories (name, kind, sort) VALUES (?, ?, ?)');
  DEFAULT_CATEGORIES.forEach(([name, kind], i) => insCat.run(name, kind, i));

  const catId = db.prepare('SELECT id FROM categories WHERE name = ?');
  const insPayee = db.prepare('INSERT OR IGNORE INTO payees (name) VALUES (?)');
  const payeeId = db.prepare('SELECT id FROM payees WHERE name = ?');
  const insRule = db.prepare(
    "INSERT INTO rules (pattern, match_type, category_id, payee_id) VALUES (?, 'contains', ?, ?)",
  );
  for (const [pattern, category, merchant] of DEFAULT_RULES) {
    const row = catId.get(category) as { id: number };
    if (merchant) insPayee.run(merchant);
    const payee = merchant ? (payeeId.get(merchant) as { id: number }).id : null;
    insRule.run(pattern, row.id, payee);
  }
  seedBuckets(db);
}
