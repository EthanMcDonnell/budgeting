import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedBuckets, seedDefaults } from './seed.ts';
import { fillMemos } from './store.ts';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_DB_PATH = process.env.BUDGET_DB ?? path.join(PROJECT_ROOT, 'data', 'budget.db');

export type DB = Database.Database;

// Each entry runs once, in order; PRAGMA user_version tracks progress. An entry is SQL, or a function
// for data changes SQL can't express.
const MIGRATIONS: (string | ((db: DB) => void))[] = [
  `
  CREATE TABLE accounts (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    institution TEXT NOT NULL DEFAULT 'Bankwest',
    type        TEXT NOT NULL DEFAULT 'transaction'
                CHECK (type IN ('transaction', 'savings', 'credit', 'other')),
    number      TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE categories (
    id       INTEGER PRIMARY KEY,
    name     TEXT NOT NULL UNIQUE COLLATE NOCASE,
    kind     TEXT NOT NULL CHECK (kind IN ('expense', 'income', 'transfer')),
    sort     INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE imports (
    id           INTEGER PRIMARY KEY,
    source       TEXT NOT NULL,
    label        TEXT,
    account_id   INTEGER REFERENCES accounts(id),
    period_start TEXT,
    period_end   TEXT,
    inserted     INTEGER NOT NULL DEFAULT 0,
    skipped      INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE transactions (
    id             INTEGER PRIMARY KEY,
    account_id     INTEGER NOT NULL REFERENCES accounts(id),
    date           TEXT NOT NULL,              -- YYYY-MM-DD
    description    TEXT NOT NULL,              -- raw text from the bank
    merchant       TEXT,                       -- cleaned display name
    amount_cents   INTEGER NOT NULL,           -- negative = money out
    balance_cents  INTEGER,
    category_id    INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    categorized_by TEXT CHECK (categorized_by IN ('rule', 'ai', 'user')),
    notes          TEXT,
    source         TEXT NOT NULL DEFAULT 'manual',
    import_id      INTEGER REFERENCES imports(id) ON DELETE CASCADE,
    dedupe_key     TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_tx_date ON transactions(date);
  CREATE INDEX idx_tx_category ON transactions(category_id);
  CREATE INDEX idx_tx_match ON transactions(account_id, date, amount_cents);

  -- month = 'YYYY-MM' for a one-month override, '*' for the default every month
  CREATE TABLE budgets (
    category_id  INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    month        TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
    PRIMARY KEY (category_id, month)
  );

  CREATE TABLE rules (
    id          INTEGER PRIMARY KEY,
    pattern     TEXT NOT NULL,
    match_type  TEXT NOT NULL DEFAULT 'contains' CHECK (match_type IN ('contains', 'regex')),
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    merchant    TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (pattern, match_type)
  );
  `,
  `
  -- Regular payments (rent, electricity, phone, subscriptions) tracked as individual items.
  CREATE TABLE recurring (
    id             INTEGER PRIMARY KEY,
    name           TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pattern        TEXT NOT NULL,                -- matched against descriptions, like rules
    match_type     TEXT NOT NULL DEFAULT 'contains' CHECK (match_type IN ('contains', 'regex')),
    frequency      TEXT NOT NULL CHECK (frequency IN ('weekly', 'fortnightly', 'monthly', 'quarterly', 'yearly')),
    expected_cents INTEGER CHECK (expected_cents >= 0),  -- typical payment; null = use recent payments
    active         INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  ALTER TABLE transactions ADD COLUMN recurring_id INTEGER REFERENCES recurring(id) ON DELETE SET NULL;
  CREATE INDEX idx_tx_recurring ON transactions(recurring_id);
  `,
  `
  -- One-month budget overrides were removed; budgets are now just monthly amounts.
  DELETE FROM budgets WHERE month <> '*';
  `,
  `
  -- People who chip in for a recurring payment (e.g. housemates splitting the internet bill).
  CREATE TABLE recurring_contributors (
    id           INTEGER PRIMARY KEY,
    recurring_id INTEGER NOT NULL REFERENCES recurring(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    pattern      TEXT NOT NULL,              -- matched against their incoming payment descriptions
    match_type   TEXT NOT NULL DEFAULT 'contains' CHECK (match_type IN ('contains', 'regex')),
    share_cents  INTEGER CHECK (share_cents >= 0),  -- null = an even split of the bill
    UNIQUE (recurring_id, name)
  );
  ALTER TABLE transactions ADD COLUMN contributor_id INTEGER REFERENCES recurring_contributors(id) ON DELETE SET NULL;
  `,
  `
  -- Shops and people money goes to or comes from. Transactions and rules link to one instead of
  -- each carrying its own copy of the name, so a rename or merge happens in one place.
  CREATE TABLE payees (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    kind       TEXT NOT NULL DEFAULT 'merchant' CHECK (kind IN ('merchant', 'person')),
    notes      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT OR IGNORE INTO payees (name)
    SELECT TRIM(merchant) FROM transactions WHERE TRIM(COALESCE(merchant, '')) <> ''
    UNION SELECT TRIM(merchant) FROM rules WHERE TRIM(COALESCE(merchant, '')) <> '';

  ALTER TABLE transactions ADD COLUMN payee_id INTEGER REFERENCES payees(id) ON DELETE SET NULL;
  UPDATE transactions SET payee_id = (SELECT p.id FROM payees p WHERE p.name = TRIM(transactions.merchant));
  ALTER TABLE transactions DROP COLUMN merchant;
  CREATE INDEX idx_tx_payee ON transactions(payee_id);

  -- A rule now sets a category, a payee, or both (people's payments vary in category).
  CREATE TABLE rules_new (
    id          INTEGER PRIMARY KEY,
    pattern     TEXT NOT NULL,
    match_type  TEXT NOT NULL DEFAULT 'contains' CHECK (match_type IN ('contains', 'regex')),
    category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
    payee_id    INTEGER REFERENCES payees(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (pattern, match_type),
    CHECK (category_id IS NOT NULL OR payee_id IS NOT NULL)
  );
  INSERT INTO rules_new (id, pattern, match_type, category_id, payee_id, created_at)
    SELECT r.id, r.pattern, r.match_type, r.category_id,
           (SELECT p.id FROM payees p WHERE p.name = TRIM(r.merchant)), r.created_at
    FROM rules r;
  DROP TABLE rules;
  ALTER TABLE rules_new RENAME TO rules;
  `,
  `
  -- A purchase you paid that other people share (dinner, golf, a booking). Each person's part is a
  -- share; payments they send you are allocated to shares, so what's still owed is a share less its
  -- allocations. Your own part is the purchase less everyone's shares.
  CREATE TABLE splits (
    id             INTEGER PRIMARY KEY,
    transaction_id INTEGER NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
    notes          TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE split_shares (
    id           INTEGER PRIMARY KEY,
    split_id     INTEGER NOT NULL REFERENCES splits(id) ON DELETE CASCADE,
    payee_id     INTEGER REFERENCES payees(id) ON DELETE SET NULL,  -- null = someone not named yet
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),         -- what they owe you
    settled      INTEGER NOT NULL DEFAULT 0,                        -- squared up off the bank (cash) or let go
    UNIQUE (split_id, payee_id)
  );
  CREATE INDEX idx_share_split ON split_shares(split_id);
  CREATE INDEX idx_share_payee ON split_shares(payee_id);

  CREATE TABLE split_payments (
    share_id       INTEGER NOT NULL REFERENCES split_shares(id) ON DELETE CASCADE,
    transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    amount_cents   INTEGER NOT NULL CHECK (amount_cents > 0),
    PRIMARY KEY (share_id, transaction_id)
  );
  CREATE INDEX idx_split_payment_tx ON split_payments(transaction_id);

  -- Money in from people that you've said isn't a payback (a gift, a sale), so it stops being suggested.
  CREATE TABLE not_paybacks (
    transaction_id INTEGER PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE
  );
  `,
  `
  -- Claude's read on money in from someone: the purchase it pays back (and how many ways), how sure,
  -- and why. Shown on the payback suggestion; a review can also pair up what the matcher missed.
  CREATE TABLE payback_reviews (
    transaction_id INTEGER PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
    purchase_id    INTEGER REFERENCES transactions(id) ON DELETE CASCADE,
    ways           INTEGER CHECK (ways >= 2),
    verdict        TEXT NOT NULL CHECK (verdict IN ('likely', 'unsure')),
    note           TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  `
  -- What the other person wrote on a payment, word for word: the message on a bank transfer, or a Beem
  -- memo (which never reaches the bank). Kept apart from notes, which are the user's and Claude's own.
  ALTER TABLE transactions ADD COLUMN memo TEXT;
  `,
  (db) => fillMemos(db),
  `
  -- Budgets are buckets now: each takes a share of income, or a fixed amount, and spending categories are grouped
  -- into them so they can trade off against each other. A savings bucket is measured by what's left over.
  CREATE TABLE buckets (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    kind         TEXT NOT NULL DEFAULT 'spend' CHECK (kind IN ('spend', 'save')),
    percent      REAL CHECK (percent >= 0 AND percent <= 100),  -- share of monthly income; follows income
    amount_cents INTEGER CHECK (amount_cents >= 0),             -- fixed amount; doesn't
    sort         INTEGER NOT NULL DEFAULT 0,
    CHECK (percent IS NULL OR amount_cents IS NULL)
  );
  ALTER TABLE categories ADD COLUMN bucket_id INTEGER REFERENCES buckets(id) ON DELETE SET NULL;
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  DROP TABLE budgets;
  `,
  (db) => seedBuckets(db),
  `
  -- The category a recurring item's bills are filed under, for items with no payments yet (and quarterly or
  -- yearly ones, which are spread across the months in it).
  ALTER TABLE recurring ADD COLUMN category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL;
  `,
  `
  -- A bucket can follow its recurring payments: its target each month is what's scheduled in its categories
  -- (four or five rent Thursdays), with no percent or amount. One bucket can balance those, giving or taking the
  -- difference from their usual month so the plan still adds up.
  ALTER TABLE buckets ADD COLUMN follows_recurring INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE buckets ADD COLUMN balances INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- The earliest pending card authorisation in the file. They're skipped and settle under their own date, so an import
  -- only covers the days before it.
  ALTER TABLE imports ADD COLUMN pending_from TEXT;
  `,
  `
  -- A card authorisation the bank hasn't settled yet. It counts like any other transaction; a later import replaces
  -- it with the settled version (keeping its category, payee, notes and links) or drops it if it never settles.
  ALTER TABLE transactions ADD COLUMN pending INTEGER NOT NULL DEFAULT 0;
  `,
];

export function openDb(file: string = DEFAULT_DB_PATH): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current >= MIGRATIONS.length) return;
  db.transaction(() => {
    for (let v = current; v < MIGRATIONS.length; v++) {
      const m = MIGRATIONS[v];
      if (typeof m === 'string') db.exec(m); else m(db);
    }
    if (current === 0) seedDefaults(db);
    db.pragma(`user_version = ${MIGRATIONS.length}`);
  })();
}
