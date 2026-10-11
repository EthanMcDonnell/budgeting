---
name: transfer-review
description: Review money people have sent the user (bank transfers, Beem) and work out what each one is, usually a payback for their share of something the user paid for, then record it with the budget MCP tools so the People page shows who owes what. Use after categorising an import, when the user asks about paybacks, splits, who owes them, or what a transfer from someone was, or when People-page suggestions need checking.
---

# Transfer review

Money in from people is nearly always a payback: their share of a meal, a round of golf, an Uber, or something the user bought for them. The `budget` MCP server has a code matcher that finds the obvious ones; this skill is the judgement on top: read the notes, the timing and the context, record what's clear, leave notes on what isn't, and ask about the rest.

## 1. Gather

`find_paybacks {wide: true}` (add `from: "YYYY-MM-DD"` after an import to limit it to the new period). It returns:

- `suggestions`: the matcher's pairings of payments with a purchase, with reasons and any earlier `your_reviews`.
- `unmatched`: every other payment in from people the matcher left alone, unnamed Beem payments included. For each, `fits` lists purchases it could be an even share of (with `ways` and `share`), and `nearby` lists what else was bought within 3 days.
- `open_splits`: shared purchases someone still owes on.

**Read each payment's `memo` first**: what the sender wrote, word for word (a bank transfer's message, or a Beem memo transcribed from a screenshot). It is the best evidence. `notes` are commentary from the user or an earlier session and can include guesses ("Likely …", or an added "(Dad paid back $33 on 1 May)" that turned out wrong): use them as context, and never link two transactions on a note alone. Beem payments with no memo yet: ask for screenshots of Beem's Activity tab (saved in `data/beem/`) and transcribe the memo verbatim into `memo` before judging. After that, the bank text carries the rest of the evidence.

## 2. Work out what each payment is

| Pattern | What it looks like | Record as |
|---|---|---|
| Even share | ½, ⅓, ¼… of a purchase within a few days, often several people sending the same amount | `confirm_payback` with that many `ways` |
| Each paid for what they had | Several people, different amounts, sent within an hour or two of each other or with matching notes ("Breakfast", "Lunch"), adding up to most of one bill | `confirm_payback` with all their payments; `ways` = payers + 1 |
| Something bought for them during the user's own shop | One payment of any amount under a purchase, same or next day, often a note naming the item | `confirm_payback` with `ways: 2` (their share is what they sent) |
| Paying the user back in full or chipping in | Note names the thing ("Kettle", "Petrol"), amount close to or under a purchase | `confirm_payback` with `ways: 2` |
| Not a payback | Gifts ("Happy birthday!"), income (tutoring), sales, bets won, employer allowances | `not_a_payback` |
| Payback with nothing to link | The note says what it paid back, but the purchase isn't in the user's accounts (cash, another card, overseas on a trip) | Leave it: it's already categorised and labelled, so it nets off |

Context that helps:

- **Who's who** (family, housemates, which card was used on which trip) is in the user's `data/context.md`, which `CLAUDE.md` loads. Read it before judging.
- Family often pay back things the user bought for them, frequently in full, with a note naming the item. Look for the purchase within a week or so either side. Their share is what they sent, which may be the whole purchase.
- A purchase can be a payment to a person: the user paid a housemate for something that was for a parent, and the parent paid it back. Split that transfer, then `link_payback`.
- One payment can cover several purchases: two friends' "accommodation payback" can be a third each of an Airbnb plus a hotel. Split each purchase, then `link_payback` the payment to each with `amount`.
- Overseas trips may have been paid on a different card or account, so look there for the purchase; friendly names that carry the city in brackets ("Le Petit Zinc (Paris)") don't count as naming the shop.
- Housemates' rent and bill shares are handled by recurring items (`contributors`), not here.
- Notes that look like they name something else can still be paybacks: check what was bought that day before dismissing one. "Poker" can be someone's item from a supermarket shop the same day.
- Group trips are usually evened out on a spreadsheet, so a trip payback settles a running tab rather than one purchase. Link only what a note and amount clearly back; leave the rest labelled and categorised under `Fun & Travel`, where they already net off the trip's cost. Don't chase per-purchase matches or leave review notes for them.
- An unnamed Beem payment: ask who it's from, or match it against Beem screenshots from the user (by amount and date; the bank date is usually 0–3 days after the Beem date). Name the sender with `people` on `confirm_payback`, or `person` on `review_payback`.
- The user's rule for the matcher: don't call something an n-way split unless at least half the others have paid (3-way needs 2, 5-way needs 3). When a note clearly names the purchase but too few have paid, leave it as a `likely` review for the user to confirm instead of confirming it.

## 3. Record

- **Clear**: `confirm_payback {purchase_id, ways, payment_ids}`. The purchase is split, each payer's share is set to what they sent, and the payments are filed under the purchase's category so it nets down to the user's part. To change a split already made, such as the number of ways or someone's share, use `split_transaction`.
- **Not a payback**: `not_a_payback {payment_id}`. Undo with `undo: true`.
- **Probable but the user should see why**: `review_payback {payment_id, verdict: "likely", note, purchase_id?, ways?}`. The note shows on the suggestion card on the People page; `purchase_id` pairs it with a purchase the matcher missed, and the payment moves there.
- **Unsure**: the same with `verdict: "unsure"`.
- **No idea**: ask the user. Don't record anything.

Notes are one sentence on the evidence: what the note says, the timing, the fraction. For example: "Note says 'uber'; $12 is about a third of the $36.30 Uber that day."

## 4. Report

Tell the user, briefly:

- what was confirmed: each purchase, who paid, and the user's part
- what was marked as not a payback, and why
- how many notes were left for them on the People page, split into likely and unsure
- numbered questions for anything unclear, each with the amounts and dates they need to answer

When they answer, record it straight away: confirm it, dismiss it, or adjust the split.
