import type { DB } from './db.ts';
import { getSetting, listBuckets, UserError, type Bucket, type CategoryKind } from './store.ts';
import { scheduledInMonth, spreadBills, upcomingInMonth, type SpreadBill } from './recurring.ts';
import { addMonths, currentMonth, daysInMonth, isMonth, monthRange, todayIso } from './util.ts';

/*
 * How money is counted:
 *  - Spending = money out in expense categories, net of refunds in the same category,
 *    plus money out that hasn't been categorised yet.
 *  - Income = money in, in income categories.
 *  - Transfer categories (moving money between accounts, paying the credit card) are
 *    ignored so nothing is counted twice.
 *  - Quarterly and yearly bills are spread: their category counts your monthly part every month
 *    instead of the bill (and housemates' payments towards it) in the month it's paid.
 *
 * Budgets are buckets: each takes a percentage of planned monthly income, or a fixed amount. Spending
 * categories belong to a spending bucket and trade off freely inside it. Savings buckets have no
 * categories; they fill, in order, from what's left over (income less all spending).
 *
 * A spending bucket can instead follow its recurring payments: its target is what they come to that month
 * (rent of $480 a week is $1,920 in a month with four Thursdays, $2,400 with five). One bucket can balance
 * those, giving up the extra in a five-Thursday month and getting it back in the others.
 */

interface CategoryRow { id: number; name: string; kind: CategoryKind; sort: number; archived: number; bucket_id: number | null }

/** Spread bills (see `spreadBills`): their transactions are left out and their monthly parts counted instead. */
interface Spreading { bills: SpreadBill[] }
const NO_SPREAD: Spreading = { bills: [] };
const spreading = (db: DB, today = todayIso()): Spreading => ({ bills: spreadBills(db, today) });

/** SQL that leaves out transactions belonging to spread bills (ids are integers from the database). */
const notSpread = (s: Spreading, t = 't') =>
  s.bills.length ? ` AND (${t}.recurring_id IS NULL OR ${t}.recurring_id NOT IN (${s.bills.map((b) => b.id).join(', ')}))` : '';

/** Each spread bill's monthly part for every month in [start, end) it covers, by category (cents spent). */
function spreadIn(s: Spreading, start: string, end: string) {
  const out = new Map<number, number>();
  for (const b of s.bills) {
    for (let m = start.slice(0, 7); `${m}-01` < end; m = addMonths(m, 1)) {
      if (m >= b.from) out.set(b.category_id, (out.get(b.category_id) ?? 0) + b.monthly_cents);
    }
  }
  return out;
}

function spendByCategory(db: DB, start: string, end: string, s: Spreading) {
  const rows = db
    .prepare(`SELECT t.category_id, SUM(t.amount_cents) AS net, COUNT(*) AS n
              FROM transactions t WHERE t.date >= ? AND t.date < ? AND t.category_id IS NOT NULL${notSpread(s)}
              GROUP BY t.category_id`)
    .all(start, end) as { category_id: number; net: number; n: number }[];
  for (const [category_id, cents] of spreadIn(s, start, end)) {
    const r = rows.find((x) => x.category_id === category_id);
    if (r) { r.net -= cents; r.n++; } else rows.push({ category_id, net: -cents, n: 1 });
  }
  return rows;
}

function uncategorized(db: DB, start: string, end: string, s: Spreading) {
  return db
    .prepare(`SELECT COUNT(*) AS count,
                COALESCE(SUM(CASE WHEN amount_cents < 0 THEN -amount_cents END), 0) AS out_cents,
                COALESCE(SUM(CASE WHEN amount_cents > 0 THEN amount_cents END), 0) AS in_cents
              FROM transactions t WHERE date >= ? AND date < ? AND category_id IS NULL${notSpread(s)}`)
    .get(start, end) as { count: number; out_cents: number; in_cents: number };
}

function monthTotals(db: DB, month: string, s: Spreading = NO_SPREAD) {
  const { start, end } = monthRange(month);
  const cats = new Map((db.prepare('SELECT id, kind FROM categories').all() as { id: number; kind: CategoryKind }[])
    .map((c) => [c.id, c.kind]));
  let spent = 0;
  let income = 0;
  for (const r of spendByCategory(db, start, end, s)) {
    const kind = cats.get(r.category_id);
    if (kind === 'expense') spent += -r.net;
    else if (kind === 'income') income += r.net;
  }
  const u = uncategorized(db, start, end, s);
  return { spent: spent + u.out_cents, income };
}

/** Months among `months` that have any transactions, so months before you started importing don't count as zero. */
function monthsWithData(db: DB, months: string[]) {
  const have = new Set((db.prepare("SELECT DISTINCT strftime('%Y-%m', date) AS m FROM transactions").all() as { m: string }[]).map((r) => r.m));
  return months.filter((m) => have.has(m));
}

/** Average monthly income over the three months before `month` that have data. */
function averageIncome(db: DB, month: string) {
  const months = monthsWithData(db, [3, 2, 1].map((i) => addMonths(month, -i)));
  const cents = months.length ? Math.round(months.reduce((s, m) => s + monthTotals(db, m).income, 0) / months.length) : 0;
  return { cents, months };
}

export type IncomeSource = 'fixed' | 'average' | 'this_month' | 'none';

/**
 * The monthly income bucket percentages apply to: a fixed amount you've set, otherwise your average over
 * the three months before (so a raise flows through), otherwise this month's income while there's no history.
 */
export function plannedIncome(db: DB, month: string): { cents: number; source: IncomeSource; months: string[] } {
  const fixed = getSetting(db, 'planned_income_cents');
  if (fixed != null) return { cents: Number(fixed), source: 'fixed', months: [] };
  const avg = averageIncome(db, month);
  if (avg.cents > 0) return { ...avg, source: 'average' };
  const own = monthTotals(db, month).income;
  return own > 0 ? { cents: own, source: 'this_month', months: [month] } : { cents: 0, source: 'none', months: [] };
}

/** The recurring payments behind a bucket that follows them, this month and in a usual month. */
export interface Schedule {
  cents: number; average_cents: number;
  items: { name: string; each_cents: number; count: number | null; cents: number; average_cents: number }[];
}

export interface BucketTarget extends Bucket {
  /** Which way the target is set: a percentage (follows income), an amount (fixed), or recurring payments. null = no target yet. */
  mode: 'percent' | 'amount' | 'recurring' | null;
  target_cents: number | null;
  /** The target as a share of planned income, whichever way it was set. */
  target_percent: number | null;
  /** For a bucket that follows its recurring payments: what they come to. */
  schedule: Schedule | null;
  /** For the balancing bucket: what it gives up (negative) or gets back this month, already in target_cents. */
  balance_cents: number;
}

/** Every bucket with its target in dollars and as a percentage, against the month's planned income. */
export function bucketTargets(db: DB, month: string, today = todayIso()) {
  const income = plannedIncome(db, month);
  const list = listBuckets(db);
  const schedules = list.some((b) => b.follows_recurring) ? schedulesByBucket(db, month, today) : new Map<number, Schedule>();
  const buckets: BucketTarget[] = list.map((b) => {
    const schedule = b.follows_recurring ? schedules.get(b.id) ?? { cents: 0, average_cents: 0, items: [] } : null;
    const cents = schedule ? schedule.cents : b.amount_cents ?? (b.percent != null ? Math.round((income.cents * b.percent) / 100) : null);
    return {
      ...b,
      mode: schedule ? 'recurring' : b.percent != null ? 'percent' : b.amount_cents != null ? 'amount' : null,
      target_cents: cents,
      target_percent: b.percent ?? (cents != null && income.cents > 0 ? (cents / income.cents) * 100 : null),
      schedule,
      balance_cents: 0,
    };
  });
  // The balancing bucket takes the difference between this month's recurring payments and a usual month's.
  const balancer = buckets.find((b) => b.balances && !b.schedule && b.target_cents != null);
  if (balancer) {
    const diff = buckets.reduce((s, b) => s + (b.schedule ? b.schedule.cents - b.schedule.average_cents : 0), 0);
    const target = Math.max(balancer.target_cents! - diff, 0);
    balancer.balance_cents = target - balancer.target_cents!;
    balancer.target_cents = target; // target_percent stays the one you set
  }
  return { income, buckets };
}

/** Recurring payments in the month, by the bucket their category is in (buckets that follow them). */
function schedulesByBucket(db: DB, month: string, today: string) {
  const cats = db.prepare("SELECT name, bucket_id FROM categories WHERE kind = 'expense'").all() as { name: string; bucket_id: number | null }[];
  const bucketOf = new Map(cats.map((c) => [c.name.toLowerCase(), c.bucket_id]));
  const out = new Map<number, Schedule>();
  for (const x of scheduledInMonth(db, month, today)) {
    const bucket = x.category == null ? null : bucketOf.get(x.category.toLowerCase());
    if (bucket == null) continue;
    const s = out.get(bucket) ?? { cents: 0, average_cents: 0, items: [] };
    s.cents += x.cents;
    s.average_cents += x.average_cents;
    s.items.push({ name: x.name, each_cents: x.each_cents, count: x.count, cents: x.cents, average_cents: x.average_cents });
    out.set(bucket, s);
  }
  return out;
}

/** The month's spending budget: every spending bucket's target added up. */
function spendingBudget(buckets: BucketTarget[]) {
  return buckets.filter((b) => b.kind === 'spend').reduce((s, b) => s + (b.target_cents ?? 0), 0);
}

export interface Reserved { cents: number; items: { name: string; each_cents: number; dates: string[]; cents: number }[] }

/**
 * Recurring payments still due in the month, grouped by the bucket of the category they're filed under, so a
 * bucket can show that part of it is spoken for. `total` covers every spending category, in a bucket or not.
 */
function reservedByBucket(db: DB, month: string, today: string) {
  const cats = db.prepare("SELECT name, bucket_id FROM categories WHERE kind = 'expense'").all() as { name: string; bucket_id: number | null }[];
  const bucketOf = new Map(cats.map((c) => [c.name.toLowerCase(), c.bucket_id]));
  const byBucket = new Map<number, Reserved>();
  let total = 0;
  for (const u of upcomingInMonth(db, month, today)) {
    const key = u.category?.toLowerCase();
    if (key == null || !bucketOf.has(key)) continue;
    total += u.cents;
    const bucket = bucketOf.get(key);
    if (bucket == null) continue;
    const r = byBucket.get(bucket) ?? { cents: 0, items: [] };
    r.cents += u.cents;
    r.items.push({ name: u.name, each_cents: u.each_cents, dates: u.dates, cents: u.cents });
    byBucket.set(bucket, r);
  }
  return { byBucket, total };
}

const noneReserved: Reserved = { cents: 0, items: [] };

/** Splits what was saved across savings buckets in order: each fills to its target, the last takes the rest (or a shortfall goes to the first). */
function allocateSaved(saved: number, buckets: BucketTarget[]) {
  const out = new Map<number, number>();
  const save = buckets.filter((b) => b.kind === 'save');
  let left = saved;
  save.forEach((b, i) => {
    const take = i === save.length - 1 || left <= 0 ? left : Math.min(left, b.target_cents ?? 0);
    out.set(b.id, take);
    left -= take;
  });
  return out;
}

export function monthSummary(db: DB, month: string = currentMonth(), today = todayIso()) {
  if (!isMonth(month)) throw new UserError(`Invalid month "${month}" (expected YYYY-MM)`);
  const { start, end } = monthRange(month);
  const days = daysInMonth(month);
  const thisMonth = today.slice(0, 7);
  const elapsedDays = month < thisMonth ? days : month > thisMonth ? 0 : Number(today.slice(8, 10));

  const categories = db.prepare('SELECT * FROM categories').all() as CategoryRow[];
  const spread = spreading(db, today);
  const spend = new Map(spendByCategory(db, start, end, spread).map((r) => [r.category_id, r]));
  const plan = bucketTargets(db, month, today);
  const spendBuckets = new Set(plan.buckets.filter((b) => b.kind === 'spend').map((b) => b.id));

  const expense = categories
    .filter((c) => c.kind === 'expense')
    .map((c) => {
      const s = spend.get(c.id);
      return {
        id: c.id, name: c.name, sort: c.sort,
        spent_cents: s ? -s.net : 0,
        count: s?.n ?? 0,
        bucket_id: c.bucket_id != null && spendBuckets.has(c.bucket_id) ? c.bucket_id : null,
      };
    })
    .filter((c) => c.count > 0 || !categories.find((x) => x.id === c.id)?.archived);

  const income = categories
    .filter((c) => c.kind === 'income')
    .map((c) => ({ id: c.id, name: c.name, amount_cents: spend.get(c.id)?.net ?? 0, count: spend.get(c.id)?.n ?? 0 }))
    .filter((c) => c.count > 0);

  const unc = uncategorized(db, start, end, spread);
  const spentCents = expense.reduce((s, c) => s + c.spent_cents, 0) + unc.out_cents;
  const incomeCents = income.reduce((s, c) => s + c.amount_cents, 0);
  const budgetCents = spendingBudget(plan.buckets);
  const budgetedSpent = expense.filter((c) => c.bucket_id != null).reduce((s, c) => s + c.spent_cents, 0);
  const saved = allocateSaved(incomeCents - spentCents, plan.buckets);
  const reserved = reservedByBucket(db, month, today);
  const buckets = plan.buckets.map((b) => ({
    id: b.id, name: b.name, kind: b.kind, target_cents: b.target_cents, target_percent: b.target_percent,
    actual_cents: b.kind === 'save' ? saved.get(b.id) ?? 0 : expense.filter((c) => c.bucket_id === b.id).reduce((s, c) => s + c.spent_cents, 0),
    reserved: b.kind === 'spend' ? reserved.byBucket.get(b.id) ?? noneReserved : noneReserved,
    schedule: b.schedule, balance_cents: b.balance_cents,
  }));

  // Running spend through the month, one point per day.
  const daily = db
    .prepare(`SELECT t.date, SUM(-t.amount_cents) AS spent
              FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
              WHERE t.date >= ? AND t.date < ?
                AND (c.kind = 'expense' OR (t.category_id IS NULL AND t.amount_cents < 0))${notSpread(spread)}
              GROUP BY t.date`)
    .all(start, end) as { date: string; spent: number }[];
  const byDay = new Map(daily.map((d) => [Number(d.date.slice(8, 10)), d.spent]));
  // Spread bills count from the first of the month.
  const spreadCents = [...spreadIn(spread, start, end).values()].reduce((a, b) => a + b, 0);
  if (spreadCents) byDay.set(1, (byDay.get(1) ?? 0) + spreadCents);
  let running = 0;
  const cumulative = Array.from({ length: days }, (_, i) => {
    const day = i + 1;
    running += byDay.get(day) ?? 0;
    return {
      day,
      spent_cents: byDay.get(day) ?? 0,
      cumulative_cents: day <= Math.max(elapsedDays, lastDay(db, start, end)) ? running : null,
      pace_cents: Math.round((budgetCents * day) / days),
    };
  });

  const topMerchants = db
    .prepare(`SELECT COALESCE(p.name, t.description) AS name, t.payee_id, p.kind AS payee_kind,
                SUM(-t.amount_cents) AS spent_cents, COUNT(*) AS count
              FROM transactions t LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN payees p ON p.id = t.payee_id
              WHERE t.date >= ? AND t.date < ? AND t.amount_cents < 0
                AND (c.kind = 'expense' OR t.category_id IS NULL)
              GROUP BY COALESCE('p' || t.payee_id, 'd' || t.description) ORDER BY spent_cents DESC LIMIT 8`)
    .all(start, end) as { name: string; payee_id: number | null; payee_kind: 'merchant' | 'person' | null; spent_cents: number; count: number }[];

  const latest = db.prepare('SELECT MAX(date) AS d FROM transactions').get() as { d: string | null };
  const latestInMonth = db
    .prepare('SELECT MAX(date) AS d FROM transactions WHERE date >= ? AND date < ?')
    .get(start, end) as { d: string | null };

  const prev = monthTotals(db, addMonths(month, -1), spread);
  const expectedToDate = Math.round((budgetCents * elapsedDays) / days);
  // Projection only makes sense mid-month with data reasonably up to date.
  const dataDay = latestInMonth.d ? Number(latestInMonth.d.slice(8, 10)) : 0;
  const projected = month === thisMonth && dataDay >= 5 ? Math.round((spentCents / dataDay) * days) : null;

  return {
    month,
    days_in_month: days,
    elapsed_days: elapsedDays,
    is_current: month === thisMonth,
    data_through: latestInMonth.d,
    latest_transaction: latest.d,
    totals: {
      spent_cents: spentCents,
      income_cents: incomeCents,
      net_cents: incomeCents - spentCents,
      budget_cents: budgetCents,
      save_target_cents: plan.buckets.filter((b) => b.kind === 'save').reduce((s, b) => s + (b.target_cents ?? 0), 0),
      planned_income_cents: plan.income.cents,
      /** Recurring payments still due this month in spending categories. */
      reserved_cents: reserved.total,
      budgeted_spent_cents: budgetedSpent,
      unbudgeted_spent_cents: spentCents - budgetedSpent,
      expected_to_date_cents: expectedToDate,
      projected_cents: projected,
      prev_spent_cents: prev.spent,
      prev_income_cents: prev.income,
    },
    uncategorized: unc,
    buckets,
    categories: expense.sort((a, b) => b.spent_cents - a.spent_cents || a.sort - b.sort),
    income,
    daily: cumulative,
    top_merchants: topMerchants,
  };
}

function lastDay(db: DB, start: string, end: string) {
  const r = db.prepare('SELECT MAX(date) AS d FROM transactions WHERE date >= ? AND date < ?').get(start, end) as { d: string | null };
  return r.d ? Number(r.d.slice(8, 10)) : 0;
}

/** Month-by-month spending, income and budget, plus per-category spend for each month. */
export function trends(db: DB, months = 12, endMonth: string = currentMonth()) {
  if (!isMonth(endMonth)) throw new UserError(`Invalid month "${endMonth}"`);
  months = Math.min(Math.max(Math.trunc(months), 1), 60);
  const list = Array.from({ length: months }, (_, i) => addMonths(endMonth, i - months + 1));
  const start = `${list[0]}-01`;
  const end = monthRange(endMonth).end;
  const spread = spreading(db);

  const rows = db
    .prepare(`SELECT strftime('%Y-%m', t.date) AS month, t.category_id, c.name, c.kind, c.sort,
                SUM(t.amount_cents) AS net,
                SUM(CASE WHEN t.amount_cents < 0 THEN -t.amount_cents ELSE 0 END) AS out_cents
              FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
              WHERE t.date >= ? AND t.date < ?${notSpread(spread)}
              GROUP BY 1, 2`)
    .all(start, end) as { month: string; category_id: number | null; name: string | null; kind: CategoryKind | null; sort: number | null; net: number; out_cents: number }[];
  const catInfo = new Map((db.prepare('SELECT id, name, kind, sort FROM categories').all() as { id: number; name: string; kind: CategoryKind; sort: number }[]).map((c) => [c.id, c]));
  for (const m of list) {
    const { start: ms, end: me } = monthRange(m);
    for (const [id, cents] of spreadIn(spread, ms, me)) {
      const c = catInfo.get(id)!;
      const r = rows.find((x) => x.month === m && x.category_id === id);
      if (r) r.net -= cents;
      else rows.push({ month: m, category_id: id, name: c.name, kind: c.kind, sort: c.sort, net: -cents, out_cents: 0 });
    }
  }

  const perMonth = new Map(list.map((m) => [m, { month: m, spent_cents: 0, income_cents: 0, budget_cents: spendingBudget(bucketTargets(db, m).buckets) }]));
  const perCat = new Map<string, { id: number | null; name: string; sort: number; values: Record<string, number> }>();
  for (const r of rows) {
    const m = perMonth.get(r.month);
    if (!m) continue;
    let value = 0;
    if (r.category_id == null) value = r.out_cents;
    else if (r.kind === 'expense') value = -r.net;
    else if (r.kind === 'income') { m.income_cents += r.net; continue; }
    else continue;
    m.spent_cents += value;
    const key = r.category_id == null ? 'uncategorized' : String(r.category_id);
    const entry = perCat.get(key) ?? { id: r.category_id, name: r.name ?? 'Uncategorised', sort: r.sort ?? Number.MAX_SAFE_INTEGER, values: {} };
    entry.values[r.month] = (entry.values[r.month] ?? 0) + value;
    perCat.set(key, entry);
  }

  // Average over months that have data, leaving out the month in progress when there are complete ones,
  // so empty months before you started importing don't drag the numbers down.
  const withData = [...perMonth.values()].filter((m) => m.spent_cents || m.income_cents).map((m) => m.month);
  const complete = withData.filter((m) => m < currentMonth());
  const averaged = new Set(complete.length ? complete : withData);
  const average = (values: Record<string, number>) =>
    averaged.size ? Math.round([...averaged].reduce((s, m) => s + (values[m] ?? 0), 0) / averaged.size) : 0;

  const categories = [...perCat.values()]
    .map((c) => ({ ...c, total_cents: Object.values(c.values).reduce((s, v) => s + v, 0), average_cents: average(c.values) }))
    .sort((a, b) => b.average_cents - a.average_cents || b.total_cents - a.total_cents);

  const monthRows = [...perMonth.values()];
  return {
    months: monthRows,
    categories,
    averaged_months: [...averaged].sort(),
    average_spent_cents: average(Object.fromEntries(monthRows.map((m) => [m.month, m.spent_cents]))),
    average_income_cents: average(Object.fromEntries(monthRows.map((m) => [m.month, m.income_cents]))),
  };
}

/**
 * The budget plan for a month: planned income, each bucket's target and what went in it, with each category's
 * spending (this month, last month, 3-month average) under its bucket.
 */
export function budgetPlan(db: DB, month: string = currentMonth(), today = todayIso()) {
  if (!isMonth(month)) throw new UserError(`Invalid month "${month}"`);
  const plan = bucketTargets(db, month, today);
  const range = (m: string) => monthRange(m);
  const prevMonth = addMonths(month, -1);
  const avgStart = range(addMonths(month, -3)).start;
  const spread = spreading(db, today);
  const net = (start: string, end: string) => new Map(spendByCategory(db, start, end, spread).map((r) => [r.category_id, r.net]));
  const current = net(range(month).start, range(month).end);
  const prev = net(range(prevMonth).start, range(prevMonth).end);
  const avg = net(avgStart, range(month).start);

  const cats = db.prepare("SELECT * FROM categories WHERE kind = 'expense' ORDER BY sort, name").all() as CategoryRow[];
  const rows = cats
    .filter((c) => !c.archived || current.has(c.id))
    .map((c) => ({
      category_id: c.id,
      name: c.name,
      bucket_id: c.bucket_id,
      spent_cents: -(current.get(c.id) ?? 0),
      last_month_cents: -(prev.get(c.id) ?? 0),
      avg3_cents: Math.round(-(avg.get(c.id) ?? 0) / 3),
    }));

  // Saving is income less all spending, including categories outside a bucket and uncategorised money out.
  const totals = (m: string) => monthTotals(db, m, spread);
  const now = totals(month);
  const last = totals(prevMonth);
  const before = [1, 2, 3].map((i) => totals(addMonths(month, -i)));
  const savedNow = allocateSaved(now.income - now.spent, plan.buckets);
  const savedLast = allocateSaved(last.income - last.spent, plan.buckets);
  const savedAvg = allocateSaved(Math.round(before.reduce((s, t) => s + t.income - t.spent, 0) / 3), plan.buckets);

  const sum = (list: typeof rows, k: 'spent_cents' | 'last_month_cents' | 'avg3_cents') => list.reduce((s, r) => s + r[k], 0);
  const reserved = reservedByBucket(db, month, today);
  const buckets = plan.buckets.map((b) => {
    const mine = b.kind === 'spend' ? rows.filter((r) => r.bucket_id === b.id) : [];
    const actual = b.kind === 'save' ? savedNow.get(b.id) ?? 0 : sum(mine, 'spent_cents');
    return {
      ...b,
      actual_cents: actual,
      last_month_cents: b.kind === 'save' ? savedLast.get(b.id) ?? 0 : sum(mine, 'last_month_cents'),
      avg3_cents: b.kind === 'save' ? savedAvg.get(b.id) ?? 0 : sum(mine, 'avg3_cents'),
      /** What went in the bucket as a share of the month's actual income. */
      actual_percent: now.income > 0 ? (actual / now.income) * 100 : null,
      /** Recurring payments filed under its categories that are still due this month. */
      reserved: b.kind === 'spend' ? reserved.byBucket.get(b.id) ?? noneReserved : noneReserved,
      categories: mine.map(({ bucket_id: _, ...r }) => r),
    };
  });
  const placed = new Set(plan.buckets.filter((b) => b.kind === 'spend').map((b) => b.id));
  const unassigned = rows.filter((r) => r.bucket_id == null || !placed.has(r.bucket_id)).map(({ bucket_id: _, ...r }) => r);

  const { start, end } = range(month);
  const incomeCats = db.prepare("SELECT * FROM categories WHERE kind = 'income' ORDER BY sort, name").all() as CategoryRow[];
  const income = incomeCats.map((c) => ({ category_id: c.id, name: c.name, amount_cents: current.get(c.id) ?? 0 }))
    .filter((c) => c.amount_cents !== 0).sort((a, b) => b.amount_cents - a.amount_cents);
  const allocated = buckets.reduce((s, b) => s + (b.target_cents ?? 0), 0);

  return {
    month,
    income: {
      ...plan.income,
      planned_cents: plan.income.cents,
      actual_cents: now.income,
      /** Average over the three months before, even when a fixed amount is set, to tell whether this month's pay is in yet. */
      usual_cents: averageIncome(db, month).cents,
      categories: income,
    },
    buckets,
    unassigned,
    uncategorized_cents: uncategorized(db, start, end, spread).out_cents,
    totals: {
      allocated_cents: allocated,
      allocated_percent: plan.income.cents > 0 ? (allocated / plan.income.cents) * 100 : null,
      spend_target_cents: spendingBudget(plan.buckets),
      save_target_cents: allocated - spendingBudget(plan.buckets),
      spent_cents: now.spent,
      saved_cents: now.income - now.spent,
      reserved_cents: reserved.total,
    },
  };
}

export function overview(db: DB) {
  const r = db
    .prepare(`SELECT COUNT(*) AS count, MIN(date) AS first, MAX(date) AS last,
                SUM(category_id IS NULL) AS uncategorized FROM transactions`)
    .get() as { count: number; first: string | null; last: string | null; uncategorized: number | null };
  const months = db
    .prepare("SELECT DISTINCT strftime('%Y-%m', date) AS m FROM transactions ORDER BY m DESC")
    .all() as { m: string }[];
  return {
    transaction_count: r.count,
    first_date: r.first,
    last_date: r.last,
    uncategorized: r.uncategorized ?? 0,
    months: months.map((m) => m.m),
  };
}
