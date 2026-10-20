# Budget

Local budgeting app. One SQLite DB (`data/budget.db`, gitignored, never commit or upload it) shared by the web UI and the `budget` MCP server (`.mcp.json`). Money: dollars in MCP tools (negative = money out), integer cents everywhere else.

The user's own context (their accounts, the people in their statements, category and bucket choices, local setup) is in `data/context.md`, loaded below. Like everything in `data/` it is gitignored; the README's "Tell Claude about your money" section describes what goes in it. If it's missing, ask the user about their accounts and people as they come up, and offer to start the file. When you learn something lasting (a new housemate, an account, how they want something categorised), add it there. Refer to accounts by name and never write BSBs or account numbers into it: `budget_overview` has each account's number when a CSV needs splitting by account.

@data/context.md

## Public repo: no personal information
This repo is public. Personal information goes only in gitignored files under `data/` (usually `data/context.md`), never in anything committed:
- `CLAUDE.md`, `README.md`, `docs/`, skills in `.claude/`
- code comments, UI text and placeholders, MCP tool descriptions
- tests, fixtures, `scripts/demo.ts` and screenshots (take them from the demo data with `npm run screenshots`, never from the real app on :4777)
- commit messages and PR descriptions

Personal information means real names (the user's, family, housemates, friends), account and BSB numbers, card or payment references (e.g. Beem codes), balances or amounts copied from real statements, employers, addresses and suburbs tied to the user, and local setup (hostnames, tailnet URLs, home paths like `/Users/<name>`, other private tools). When an example needs one, invent it (Sam, Priya, Acme Engineering), as the tests and demo do. When a rule you're adding comes from the user's own situation, write the general rule here and the specifics ("Sam pays $480 each Thursday") in `data/context.md`. Before committing, check the staged diff and the message for any of these.

## Running
`npm start` → http://127.0.0.1:4777 · `npm run dev` (hot reload, :5173) · `npm test` · `npm run typecheck` · `npm run demo` (fake data, `data/demo.db`). Port: `PORT` env, default in `src/server/index.ts` + `vite.config.ts`. `npm run screenshots` regenerates the README images from the demo data on port 4799 (needs Google Chrome).

## Importing (use the `budget` MCP tools, never raw SQL)
All reads and changes to the user's data go through the `budget` MCP tools; that's what they're for. If the tools are missing or fail (an "out of date" error, "no such column", or no `budget` tools at all), stop and ask the user to run `/mcp` and reconnect `budget` (or restart Claude Code if that doesn't help). Never work around it with `npx tsx` scripts calling `src/core`, the web API, or SQL. (Code changes and tests are fine to run directly.)

1. `budget_overview` → accounts, categories.
2. CSV: `import_csv_file` (path). Rows go to the account with their account number, so a multi-account export imports in one go (one result per account); `account` is only needed for a number no account has yet, and remembers it. PDF: read every page; pass each line (date, description as printed, signed amount) + opening/closing balance to `import_transactions`.
3. Always `dry_run: true` first. PDF reconciliation must be `ok` before the real import. Report possible duplicates; don't force them.
4. `list_transactions {category: "uncategorized"}` → `categorize_transactions`. Give every transaction a payee via `merchant`: a clean shop name, or the person's name with `person: true`. Reuse existing names (`list_payees`) rather than inventing variants. Add `rules` for recurring merchants and people.
5. For unrecognised Australian merchant names (e.g. "MIKROY PTY LTD" = Zambrero), look them up on https://www.bankstatementmadness.com.au: the whole table is on the homepage, so fetch it and search it locally. Then ask the user when still unsure; leave it uncategorised rather than guess.
6. Paybacks: run the `transfer-review` skill to work out what each payment from someone is and record it.
7. Finish with `month_summary`, and check `list_recurring` for overdue items or new suggestions worth tracking.

Shared costs (`splits` → `split_shares` → `split_payments`): a split is a purchase you paid that others share; each person's share is a row (`payee_id` null = not named yet), and their paybacks are allocated to it. Owed = unsettled shares less allocations. Confirming files the payback in the purchase's category so it nets off. The bank can't show what you owe others before you pay them: your transfers to a person are already your share.

Recurring items (`list_recurring`, `add_recurring`, …) track regular payments individually (rent, power, phone, subscriptions) without changing their category. Items can be split with people (`contributors`): their incoming payments are matched, filed under the bill's category, and shown per bill as paid/waiting/owing. Imports link new matches automatically; link one-off paybacks with `link_transaction_to_recurring` (`from` = person). Quarterly and yearly items are spread in budgets: their category counts your monthly part every month instead of the bill and paybacks in the month paid, so give them a `category` when adding them. Weekly items are not spread. Instead a bucket can follow its recurring payments (`set_bucket follows_recurring: true`): its target each month is what's scheduled (4 or 5 weekly payments), and the one bucket with `balances: true` gives or takes the difference from a usual month so the plan still adds up.

Never write SQL by hand. Each transaction has `description` (raw bank text), a payee (who), `memo` (what the other person wrote on it, verbatim: filled from bank transfer text on import, or from Beem screenshots) and `notes` (the user's and Claude's commentary, which may include guesses).

## Categorising conventions
- Payees (`payees` table): every shop or person is one payee with a friendly name. They have their own pages, Merchants and People. Don't put labels like "Lunch payback" or "Rent (Sam)" in `merchant`: link to the person ("Sam") and put the detail in `notes`. Own-account transfers, salary, dividends and interest get no payee. Fix duplicates with `merge_payees`, and renames with `update_payee`.
- Transfer categories (`Transfers`, `Credit Card Payment`) are excluded from spending and income. Use them for moves between the user's own accounts (`data/context.md` lists which accounts are theirs) and credit card repayments.
- Spending while travelling (eating out, drinks, local transport, city tax, and splits with travel mates) goes in `Fun & Travel`, not its usual category. Note the trip in `notes` (e.g. "Japan trip").
- A refund, or a friend paying the user back, goes in the original spend category as a positive amount, so it nets off (breakfast splits → Eating & Drinking Out).
- Use the user's existing categories (`budget_overview`) and don't add new ones without asking; detail lives in `merchant`. Every spending category belongs to one spending bucket, so a new one needs a bucket: ask which.
- Budgets are buckets (`get_budgets`, `set_bucket`, `delete_bucket`, `set_planned_income`): each is a % of planned monthly income (follows income; planned = 3-month average unless fixed) or a fixed $ amount. Savings buckets have no categories and fill from what's left over.
- Bankwest CSV `Transaction Type`: PAY salary, DEP deposit, WDC card purchase, WDL transfer out/withdrawal, TFC/TFD internal transfer, DAU pending authorisation (the parser skips it), NAR $0 note (skipped).
- Beem payments reach the bank as a reference code only, so the message must come from the Beem app: have the user send screenshots of Beem's Activity tab, save them to `data/beem/` (gitignored), and match each card by person, amount, direction and date. Record the message word for word in `memo` (`categorize_transactions` / `update_transaction`), never paraphrased, and keep any reading of it in `notes`.

## Code
`src/core/` (all logic: `db.ts` schema/migrations, `store.ts` (incl. payees and rules), `importer.ts` dedupe + reconciliation, `csv.ts`, `reports.ts`, `payees.ts` Merchants/People reports, `splits.ts` shared costs and payback matching, `recurring.ts`) · `src/server/` Express API · `src/mcp/server.ts` (stdout is the protocol; log to stderr), run by `src/mcp/launcher.ts`, which restarts it whenever `src/` changes so the tools are never stale (only a change to the launcher itself needs `/mcp`) · `web/` React + Recharts (tokens in `styles.css`) · `scripts/demo.ts` fake data for the demo and screenshots. Schema changes = append a new `MIGRATIONS` entry.
