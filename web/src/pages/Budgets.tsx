import { CheckCircle2, ChevronDown, ChevronRight, Pencil, Plus } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useApi, type BucketKind } from '../api.ts';
import { CategoryDonut, bucketColor, categoryColors, type Slice } from '../components/charts.tsx';
import { ErrorNotice, Meter, Modal, MonthPicker, useAction, useMonth } from '../components/ui.tsx';
import { addMonths, money, moneyWhole, monthLabel, monthShort, percentText, targetNote, thisMonth } from '../format.ts';
import type { BudgetBucket, BudgetCategory, BudgetPlan, Reserved, Trends } from '../types.ts';

type Editing = BudgetBucket | 'new' | null;

export default function Budgets() {
  const { month } = useMonth();
  const plan = useApi<BudgetPlan>(`/budgets?month=${month}`);
  const history = useApi<Trends>(`/trends?months=12&end=${month}`);
  const [editing, setEditing] = useState<Editing>(null);
  const p = plan.data;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Budgets</h1>
          <p className="sub">Your income split into buckets. Categories in a bucket share its budget, so one can run high while another runs low.</p>
        </div>
        <MonthPicker />
      </div>
      <ErrorNotice error={plan.error} />

      {p && <BucketsPanel p={p} month={month} onEdit={setEditing} />}
      {p && <InOutPanel p={p} month={month} />}
      {p && history.data && <BreakdownPanel p={p} history={history.data} month={month} />}
      {p && <BucketModal p={p} editing={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** In the current month before the usual income has come in, savings (what's left over) aren't meaningful yet. */
const awaitingPay = (p: BudgetPlan, month: string) => month === thisMonth() && p.income.usual_cents > p.income.actual_cents;

/** How far through the month today is, for the pace tick; null for other months. */
function monthPace(month: string) {
  if (month !== thisMonth()) return null;
  const [y, m] = month.split('-').map(Number);
  return new Date().getDate() / new Date(y, m, 0).getDate();
}

function monthSpan(months: string[]) {
  if (months.length === 0) return '';
  const first = monthShort(months[0]);
  const last = monthShort(months[months.length - 1]);
  return first === last ? first : `${first}–${last}`;
}

/** Bucket ids whose categories are hidden, remembered in this browser. */
function useCollapsed() {
  const key = 'budgets.collapsed';
  const [ids, setIds] = useState<number[]>(() => {
    try { return JSON.parse(localStorage.getItem(key) ?? '[]'); } catch { return []; }
  });
  const toggle = (id: number) => setIds((cur) => {
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* storage unavailable */ }
    return next;
  });
  return [new Set(ids), toggle] as const;
}

// ---------- the plan and the month: a table on wide screens, a list on phones ----------

type TargetPatch = { percent?: number | null; amount?: number | null };

function BucketsPanel({ p, month, onEdit }: { p: BudgetPlan; month: string; onEdit: (b: Editing) => void }) {
  const run = useAction();
  const [collapsed, toggle] = useCollapsed();
  const pace = monthPace(month);
  const waiting = awaitingPay(p, month);
  const patch = (b: BudgetBucket, body: TargetPatch) => run(() => api(`/buckets/${b.id}`, { method: 'PATCH', body }));
  const setIncome = (amount: number | null) => run(() => api('/budgets/income', { method: 'PUT', body: { amount } }));
  const moveCategory = (c: BudgetCategory, bucket: number) => run(() => api(`/categories/${c.category_id}`, { method: 'PATCH', body: { bucket } }));
  const spendBuckets = p.buckets.filter((b) => b.kind === 'spend');
  const followers = p.buckets.filter((b) => b.mode === 'recurring').map((b) => b.name);
  const hasOutside = p.unassigned.length > 0 || p.uncategorized_cents > 0;
  const total = p.totals.allocated_percent == null ? '—' : `${percentText(p.totals.allocated_percent)}%`;

  const bucketSelect = (c: BudgetCategory) => spendBuckets.length > 0 && (
    <select className="select select-sm" value="" aria-label={`Bucket for ${c.name}`}
      onChange={(e) => e.target.value && moveCategory(c, Number(e.target.value))}>
      <option value="">Add to a bucket…</option>
      {spendBuckets.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
    </select>
  );

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Buckets</h2>
        <button className="btn btn-sm" onClick={() => onEdit('new')}><Plus size={14} />Add bucket</button>
      </div>
      <div className="panel-body plan-top">
        <IncomeField p={p} onSet={setIncome} />
        <AllocationBar p={p} />
      </div>

      <div className="table-wrap plan-table-wrap">
        <table className="table plan-table">
          <thead>
            <tr>
              <th>Bucket</th>
              <th className="num">Share</th>
              <th className="num">Monthly</th>
              <th className="num">3-month avg</th>
              <th className="num">{monthShort(addMonths(month, -1))}</th>
              <th>{monthShort(month)}</th>
              <th className="num">Left</th>
              <th><span className="sr-only">Edit</span></th>
            </tr>
          </thead>
          {p.buckets.map((b, i) => (
            <BucketRows
              key={b.id} b={b} color={bucketColor(i)} month={month} pace={pace} waiting={waiting} followers={followers}
              open={!collapsed.has(b.id)} onToggle={() => toggle(b.id)}
              onTarget={(body) => patch(b, body)} onEdit={() => onEdit(b)}
            />
          ))}
          {hasOutside && (
            <tbody>
              <tr className="bucket-row">
                <td colSpan={8}>
                  <div className="bucket-name static"><i className="swatch" style={{ background: 'var(--series-muted)' }} />Not in a bucket</div>
                  <div className="bucket-sub">Counts as spending, but not against any bucket</div>
                </td>
              </tr>
              {p.unassigned.map((c) => (
                <tr className="cat-row" key={c.category_id}>
                  <td><Link to={`/transactions?category=${c.category_id}&month=${month}`}>{c.name}</Link></td>
                  <td colSpan={2} className="right">{bucketSelect(c)}</td>
                  <td className="num ink-2">{dash(c.avg3_cents)}</td>
                  <td className="num ink-2">{dash(c.last_month_cents)}</td>
                  <td className="num-cell">{dash(c.spent_cents)}</td>
                  <td colSpan={2} />
                </tr>
              ))}
              {p.uncategorized_cents > 0 && (
                <tr className="cat-row">
                  <td><Link className="warn" to={`/transactions?category=uncategorized&month=${month}`}>Uncategorised</Link></td>
                  <td colSpan={4} />
                  <td className="num-cell">{moneyWhole(p.uncategorized_cents)}</td>
                  <td colSpan={2} />
                </tr>
              )}
            </tbody>
          )}
          <tfoot>
            <tr>
              <td>Total</td>
              <td className="num">{total}</td>
              <td className="num">{moneyWhole(p.totals.allocated_cents)}</td>
              <td colSpan={5} />
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="bucket-list">
        {p.buckets.map((b, i) => (
          <BucketItem
            key={b.id} b={b} color={bucketColor(i)} month={month} pace={pace} waiting={waiting} followers={followers}
            open={!collapsed.has(b.id)} onToggle={() => toggle(b.id)}
            onTarget={(body) => patch(b, body)} onEdit={() => onEdit(b)}
          />
        ))}
        {hasOutside && (
          <div className="bucket-item">
            <div className="bucket-name static"><i className="swatch" style={{ background: 'var(--series-muted)' }} />Not in a bucket</div>
            <div className="bucket-sub">Counts as spending, but not against any bucket</div>
            <div className="bi-cats">
              {p.unassigned.map((c) => (
                <div className="bi-cat" key={c.category_id}>
                  <Link to={`/transactions?category=${c.category_id}&month=${month}`}>{c.name}</Link>
                  <span className="num">{dash(c.spent_cents)}</span>
                  <div className="bi-cat-move">{bucketSelect(c)}</div>
                </div>
              ))}
              {p.uncategorized_cents > 0 && (
                <div className="bi-cat">
                  <Link className="warn" to={`/transactions?category=uncategorized&month=${month}`}>Uncategorised</Link>
                  <span className="num">{moneyWhole(p.uncategorized_cents)}</span>
                </div>
              )}
            </div>
          </div>
        )}
        <div className="bucket-list-total">
          <span>Total</span>
          <span className="num">{total} · {moneyWhole(p.totals.allocated_cents)}</span>
        </div>
      </div>

      <p className="plan-note">
        Type a percentage to follow your income, or a dollar amount to keep it fixed when income changes. The dashed figure is worked out from the other.
        A dashed stretch on a bar is recurring payments still due this month.
      </p>
    </section>
  );
}

const dash = (c: number) => (c ? signed(c) : '—');
/** Whole dollars with a true minus sign. */
const signed = (c: number) => (c < 0 ? `−${moneyWhole(-c)}` : moneyWhole(c));

/** How a bucket is doing this month: meter state, the headline figure and what's left (or to go, for savings). */
function bucketStatus(b: BudgetBucket, waiting: boolean) {
  const save = b.kind === 'save';
  const target = b.target_cents;
  const actual = b.actual_cents;
  const pending = save && waiting && actual <= 0;
  // A bucket that follows recurring payments is meant to be used up, so it only warns once it's over.
  const state: 'ok' | 'warn' | 'bad' = save || target == null ? 'ok'
    : actual > target ? 'bad' : actual >= target * 0.9 && actual > 0 && b.mode !== 'recurring' ? 'warn' : 'ok';
  const left = target == null ? null : target - actual;
  const used = !pending && target && actual >= 0 ? `${Math.round((actual / target) * 100)}%` : null;

  let leftText: React.ReactNode = '—';
  if (pending) leftText = <span className="muted">Waiting on pay</span>;
  else if (save && actual < 0) leftText = <span className="bad">Nothing saved</span>;
  else if (left != null && save) leftText = left > 0 ? <span className="ink-2">{moneyWhole(left)} to go</span> : <span className="good">Reached</span>;
  else if (left != null) leftText = left >= 0 ? `${moneyWhole(left)} left` : <span className="bad">{moneyWhole(-left)} over</span>;

  const figure = pending ? <span className="muted">—</span>
    : <b className={`num ${actual < 0 ? 'bad' : ''}`}>{signed(actual)}</b>;

  // Recurring payments still due come out of what's left.
  const reserved = save ? 0 : b.reserved.cents;
  const free = left == null ? null : left - reserved;
  const afterDue = reserved > 0 && free != null && left != null && left >= 0
    ? <span className={free < 0 ? 'bad' : undefined}>{free >= 0 ? `${moneyWhole(free)} after recurring` : `${moneyWhole(-free)} short after recurring`}</span>
    : null;
  return { save, target, actual, pending, state, left, used, leftText, figure, reserved, afterDue };
}

/** Why the bucket's target is different this month: four or five rent weeks, or balancing a bucket that has them. */
function TargetNote({ b, followers }: { b: BudgetBucket; followers: string[] }) {
  const text = targetNote(b, followers);
  if (!text) return null;
  const title = b.schedule
    ? 'The target is what its recurring payments come to this month, so a month with an extra weekly payment gets more.'
    : 'This bucket balances the ones that follow recurring payments: it gives up the extra in a month with five weekly payments and gets it back in the others.';
  return <span className="target-note" title={title}>{text}</span>;
}

/** e.g. "Still to pay: Rent $480 × 3 (15, 22, 29 Oct), Claude $34 (14 Oct)". */
function reservedTitle(r: Reserved) {
  const days = (dates: string[]) => dates.map((d) => Number(d.slice(8, 10))).join(', ');
  const month = (d: string) => monthShort(d.slice(0, 7));
  return `Still to pay: ${r.items.map((i) => `${i.name} ${moneyWhole(i.each_cents)}${i.dates.length > 1 ? ` × ${i.dates.length}` : ''} (${days(i.dates)} ${month(i.dates[0])})`).join(', ')}`;
}

/** The dashed "still due" caption under a bucket's meter. `names` lists the payments too (on phones, where there's no hover). */
function DueNote({ r, over, names }: { r: Reserved; over: boolean; names?: boolean }) {
  if (r.cents <= 0) return null;
  const list = r.items.map((i) => (i.dates.length > 1 ? `${i.name} ×${i.dates.length}` : i.name)).join(', ');
  return (
    <span className={`due-note ${over ? 'over' : ''}`} title={reservedTitle(r)}>
      {moneyWhole(r.cents)} recurring still due{names && <> · {list}</>}
    </span>
  );
}

const followsTitle = 'What its recurring payments come to this month (four or five weekly payments).';

/** The bucket's two target fields: the one you set is solid, the other (worked out from it) dashed. */
function targetFields(b: BudgetBucket, onTarget: (body: TargetPatch) => void, widths: [number, number]) {
  return [
    <NumberField
      key="percent" value={percentText(b.target_percent)} suffix="%" width={widths[0]} max={100}
      derived={b.mode !== 'percent'} label={`${b.name} share of income`}
      title={b.mode === 'recurring' ? `${followsTitle} Type a percentage to follow your income instead.`
        : b.mode === 'amount' ? 'Worked out from the fixed amount. Type a percentage to follow your income instead.' : 'Share of your monthly income'}
      onCommit={(n) => onTarget({ percent: n })}
    />,
    <NumberField
      key="amount" value={b.target_cents == null ? '' : dollarsText(b.target_cents, b.mode === 'percent')} prefix="$" width={widths[1]}
      derived={b.mode !== 'amount'} label={`${b.name} monthly amount`}
      title={b.mode === 'recurring' ? `${followsTitle} Type an amount to keep it fixed instead.`
        : b.mode === 'percent' ? 'Worked out from the percentage. Type an amount to keep it fixed instead.' : 'Fixed amount each month'}
      onCommit={(n) => onTarget({ amount: n })}
    />,
  ] as const;
}

interface BucketViewProps {
  b: BudgetBucket; color: string; month: string; pace: number | null; waiting: boolean; open: boolean;
  /** Names of the buckets that follow recurring payments, for the balancing bucket's note. */
  followers: string[];
  onToggle: () => void; onTarget: (body: TargetPatch) => void; onEdit: () => void;
}

function BucketName({ b, color, open, onToggle }: Pick<BucketViewProps, 'b' | 'color' | 'open' | 'onToggle'>) {
  const swatch = <i className="swatch" style={{ background: color }} />;
  return b.kind === 'spend' && b.categories.length > 0 ? (
    <button className="bucket-name" onClick={onToggle} aria-expanded={open}>
      {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}{swatch}<span className="nm">{b.name}</span>
    </button>
  ) : (
    <div className="bucket-name static">{swatch}<span className="nm">{b.name}</span></div>
  );
}

function BucketMeter({ b, st, pace, small }: { b: BudgetBucket; st: ReturnType<typeof bucketStatus>; pace: number | null; small?: boolean }) {
  if (st.target == null || st.target <= 0) return null;
  return (
    <Meter spent={Math.max(st.actual, 0)} budget={st.target} pace={st.save || b.mode === 'recurring' ? null : pace} state={st.state} small={small}
      reserved={st.reserved} reservedTitle={st.reserved ? reservedTitle(b.reserved) : undefined}
      label={`${b.name}: ${st.save ? 'saved' : 'spent'} against target${st.reserved ? `, ${moneyWhole(st.reserved)} recurring still due` : ''}`} />
  );
}

const overWithDue = (st: ReturnType<typeof bucketStatus>) => st.target != null && Math.max(st.actual, 0) + st.reserved > st.target;

const subline = (b: BudgetBucket) => {
  const what = b.kind === 'save' ? 'What’s left after spending' : b.categories.length === 1 ? '1 category' : `${b.categories.length} categories`;
  return b.mode === 'recurring' ? `${what} · follows recurring` : b.balances ? `${what} · balances recurring` : what;
};

/** Each category's slice of its bucket, so you can see what's using it up. */
const shareWidth = (spent: number, target: number | null) => (target && spent > 0 ? `${Math.min(spent / target, 1) * 100}%` : 0);

function BucketRows({ b, color, month, pace, waiting, open, followers, onToggle, onTarget, onEdit }: BucketViewProps) {
  const st = bucketStatus(b, waiting);
  const [percentField, amountField] = targetFields(b, onTarget, [74, 104]);
  return (
    <tbody className="bucket-group">
      <tr className="bucket-row">
        <td>
          <BucketName b={b} color={color} open={open} onToggle={onToggle} />
          <div className="bucket-sub">{subline(b)}</div>
        </td>
        <td className="num">{percentField}</td>
        <td className="num">{amountField}</td>
        <td className={`num ${b.avg3_cents < 0 ? 'bad' : 'ink-2'}`}>{signed(b.avg3_cents)}</td>
        <td className={`num ${b.last_month_cents < 0 ? 'bad' : 'ink-2'}`}>{signed(b.last_month_cents)}</td>
        <td className="progress-cell">
          <div className="progress-figs">
            {st.figure}
            {st.used && <span className="muted num">{st.used}</span>}
            {st.save && st.actual < 0 && !st.pending && <span className="muted">spent more than came in</span>}
          </div>
          <BucketMeter b={b} st={st} pace={pace} small />
          <DueNote r={st.save ? { cents: 0, items: [] } : b.reserved} over={overWithDue(st)} />
          <TargetNote b={b} followers={followers} />
        </td>
        <td className="num">{st.leftText}{st.afterDue && <span className="left-sub">{st.afterDue}</span>}</td>
        <td className="right">
          <button className="btn btn-ghost btn-icon btn-sm" onClick={onEdit} aria-label={`Edit ${b.name}`} title="Rename, change type or choose categories">
            <Pencil size={14} />
          </button>
        </td>
      </tr>
      {open && !st.save && b.categories.map((c) => (
        <tr className="cat-row" key={c.category_id}>
          <td><Link to={`/transactions?category=${c.category_id}&month=${month}`}>{c.name}</Link></td>
          <td colSpan={2} />
          <td className="num ink-2">{dash(c.avg3_cents)}</td>
          <td className="num ink-2">{dash(c.last_month_cents)}</td>
          <td className="num-cell">
            {dash(c.spent_cents)}
            <div className="cat-share" style={{ width: shareWidth(c.spent_cents, st.target), background: color }} />
          </td>
          <td colSpan={2} />
        </tr>
      ))}
      {!st.save && b.categories.length === 0 && (
        <tr className="cat-row">
          <td colSpan={8} className="muted">No categories yet. <button className="link-btn" onClick={onEdit}>Choose some</button></td>
        </tr>
      )}
    </tbody>
  );
}

/** One bucket on a phone: name and targets, a full-width meter, then its categories as name / amount rows. */
function BucketItem({ b, color, month, pace, waiting, open, followers, onToggle, onTarget, onEdit }: BucketViewProps) {
  const st = bucketStatus(b, waiting);
  const [percentField, amountField] = targetFields(b, onTarget, [74, 104]);
  return (
    <div className="bucket-item">
      <div className="bi-head">
        <div className="bi-title">
          <BucketName b={b} color={color} open={open} onToggle={onToggle} />
          <div className="bucket-sub">{subline(b)}</div>
        </div>
        <div className="bi-targets">{percentField}{amountField}</div>
      </div>

      <div className="bi-figs">
        <span>{st.figure} <span className="muted">{st.save ? (st.pending ? '' : 'saved') : 'spent'}</span></span>
        {st.used && <span className="muted num">{st.used}</span>}
      </div>
      <BucketMeter b={b} st={st} pace={pace} />
      <div className="bi-foot">
        <span>{st.leftText}{st.afterDue && <span className="muted"> · {st.afterDue}</span>}</span>
        <button className="link-btn bi-edit" onClick={onEdit}><Pencil size={12} aria-hidden />Edit</button>
      </div>
      {st.reserved > 0 && <div className="bi-due"><DueNote r={b.reserved} over={overWithDue(st)} names /></div>}
      {targetNote(b, followers) && <div className="bi-due"><TargetNote b={b} followers={followers} /></div>}

      {open && !st.save && b.categories.length > 0 && (
        <div className="bi-cats">
          {b.categories.map((c) => (
            <div className="bi-cat" key={c.category_id}>
              <Link to={`/transactions?category=${c.category_id}&month=${month}`}>{c.name}</Link>
              <span className="num">{dash(c.spent_cents)}</span>
              <div className="cat-share" style={{ width: shareWidth(c.spent_cents, st.target), background: color }} />
            </div>
          ))}
        </div>
      )}
      {!st.save && b.categories.length === 0 && (
        <p className="muted bi-empty">No categories yet. <button className="link-btn" onClick={onEdit}>Choose some</button></p>
      )}
    </div>
  );
}

/** Whole dollars when worked out, exact when typed in; with thousands separators. */
function dollarsText(cents: number, whole: boolean) {
  return (whole ? Math.round(cents / 100) : cents / 100).toLocaleString('en-AU', { maximumFractionDigits: 2 });
}

/**
 * A number field with a $ or % marker that saves on blur or Enter. Empty clears it. A derived field (worked out
 * from another) is dashed and muted; typing in it makes it the one that's set.
 */
function NumberField({ value, onCommit, prefix, suffix, derived, label, title, width, max }: {
  value: string; onCommit: (n: number | null) => void; prefix?: string; suffix?: string; derived?: boolean;
  label: string; title?: string; width: number; max?: number;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const clean = (t: string) => t.replace(/[$,%\s]/g, '');

  const commit = () => {
    const t = clean(text);
    if (t === clean(value)) { setText(value); return; }
    if (t === '') return onCommit(null);
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0 || (max != null && n > max)) { setText(value); return; }
    onCommit(n);
  };

  return (
    <label className={`affix ${derived ? 'derived' : ''}`} style={{ width }} title={title}>
      {prefix && <span className="affix-mark" aria-hidden>{prefix}</span>}
      <input
        className="affix-input" inputMode="decimal" value={text} aria-label={label}
        onChange={(e) => setText(e.target.value)} onBlur={commit} onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') { setText(value); setTimeout(() => (e.target as HTMLInputElement).blur()); }
        }}
      />
      {suffix && <span className="affix-mark" aria-hidden>{suffix}</span>}
    </label>
  );
}

function IncomeField({ p, onSet }: { p: BudgetPlan; onSet: (amount: number | null) => void }) {
  const i = p.income;
  const fixed = i.source === 'fixed';
  const note = fixed ? 'Fixed amount'
    : i.source === 'average' ? `Average of ${monthSpan(i.months)}`
    : i.source === 'this_month' ? 'This month’s income so far'
    : 'No income yet';
  return (
    <div className="plan-income">
      <span className="plan-income-label">Monthly income</span>
      <NumberField
        value={i.planned_cents ? dollarsText(i.planned_cents, !fixed) : ''} prefix="$" width={128} derived={!fixed}
        label="Monthly income" title={fixed ? 'Percentages are worked out from this amount' : 'Type an amount to use it instead of your average'}
        onCommit={(n) => onSet(n === 0 ? null : n)}
      />
      <span className="muted plan-income-note">
        {note}
        {fixed
          ? <> · <button className="link-btn" onClick={() => onSet(null)}>Use my average{i.usual_cents ? ` (${moneyWhole(i.usual_cents)})` : ''}</button></>
          : ' · type an amount to fix it'}
      </span>
    </div>
  );
}

/** Planned income as one bar, split by bucket target, with what's left unallocated or how far over it goes. */
function AllocationBar({ p }: { p: BudgetPlan }) {
  const income = p.income.planned_cents;
  const total = p.totals.allocated_cents;
  const gap = income - total;
  const segments = p.buckets.map((b, i) => ({ b, color: bucketColor(i) })).filter(({ b }) => (b.target_cents ?? 0) > 0);
  const share = (c: number) => (income > 0 ? `${percentText((c / income) * 100)}%` : '');
  // Segment sizes as percentages of the bar; raw cents make huge flex factors that lay out unreliably.
  const scale = Math.max(income, total, 1);
  const grow = (c: number) => (c / scale) * 100;

  let status: React.ReactNode;
  if (income <= 0) status = <span className="muted">Percentages turn into amounts once income comes in, or set a monthly income</span>;
  else if (Math.abs(gap) < 100) status = <span className="alloc-ok"><CheckCircle2 size={14} aria-hidden />Every dollar has a bucket</span>;
  else if (gap > 0) status = <span className="warn">{share(gap)} ({moneyWhole(gap)}) not in a bucket yet</span>;
  else status = <span className="bad">{share(-gap)} ({moneyWhole(-gap)}) more than your income</span>;

  return (
    <div className="alloc">
      <div className="alloc-track" role="img"
        aria-label={`Income split: ${segments.map(({ b }) => `${b.name} ${percentText(b.target_percent)}%`).join(', ')}`}>
        {segments.map(({ b, color }) => (
          <div key={b.id} className="alloc-seg" style={{ flexGrow: grow(b.target_cents!), background: color }}
            title={`${b.name}: ${moneyWhole(b.target_cents)} (${percentText(b.target_percent)}%)`} />
        ))}
        {gap >= 100 && <div className="alloc-seg empty" style={{ flexGrow: grow(gap) }} />}
      </div>
      <div className="alloc-foot">
        <span className="ink-2">
          To spend <b className="num">{moneyWhole(p.totals.spend_target_cents)}</b>{income > 0 && <span className="muted"> {share(p.totals.spend_target_cents)}</span>}
          <span className="alloc-sep" aria-hidden />
          To save <b className="num">{moneyWhole(p.totals.save_target_cents)}</b>{income > 0 && <span className="muted"> {share(p.totals.save_target_cents)}</span>}
        </span>
        {status}
      </div>
    </div>
  );
}

// ---------- add / edit a bucket ----------

function BucketModal({ p, editing, onClose }: { p: BudgetPlan; editing: Editing; onClose: () => void }) {
  const run = useAction();
  const bucket = editing && editing !== 'new' ? editing : null;
  const [name, setName] = useState('');
  const [kind, setKind] = useState<BucketKind>('spend');
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [percent, setPercent] = useState('');
  const [amount, setAmount] = useState('');
  const [follows, setFollows] = useState(false);
  const [balances, setBalances] = useState(false);

  useEffect(() => {
    if (!editing) return;
    setName(bucket?.name ?? '');
    setKind(bucket?.kind ?? 'spend');
    setChosen(new Set(bucket?.categories.map((c) => c.category_id) ?? []));
    setPercent('');
    setAmount('');
    setFollows(bucket?.mode === 'recurring');
    setBalances(!!bucket?.balances);
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const following = kind === 'spend' && follows;

  // Every spending category, with the bucket it's in now.
  const categories = useMemo(() => [
    ...p.buckets.flatMap((b) => b.categories.map((c) => ({ ...c, in: b }))),
    ...p.unassigned.map((c) => ({ ...c, in: null as BudgetBucket | null })),
  ].sort((a, b) => a.name.localeCompare(b.name)), [p]);

  const toggle = (id: number) => setChosen((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const submit = async () => {
    if (!name.trim()) return;
    const body: Record<string, unknown> = { name: name.trim(), kind, balances: !following && balances };
    if (kind === 'spend') body.categories = [...chosen];
    if (following && bucket?.mode !== 'recurring') body.follows_recurring = true;
    // Stopping: keep a usual month's worth as a fixed amount.
    else if (!following && bucket?.mode === 'recurring') body.amount = (bucket.schedule?.average_cents ?? 0) / 100;
    else if (!bucket && !following) {
      const pct = Number(percent.replace(/[%\s]/g, ''));
      const amt = Number(amount.replace(/[$,\s]/g, ''));
      if (percent.trim() && Number.isFinite(pct)) body.percent = pct;
      else if (amount.trim() && Number.isFinite(amt)) body.amount = amt;
    }
    const ok = await run(
      () => bucket ? api(`/buckets/${bucket.id}`, { method: 'PATCH', body }) : api('/buckets', { body }),
      bucket ? `Saved ${name.trim()}` : `Added ${name.trim()}`,
    );
    if (ok) onClose();
  };

  const remove = async () => {
    if (!bucket) return;
    const n = bucket.categories.length;
    if (!confirm(`Delete ${bucket.name}?${n ? ` Its ${n === 1 ? 'category' : `${n} categories`} will be left without a bucket.` : ''}`)) return;
    if (await run(() => api(`/buckets/${bucket.id}`, { method: 'DELETE' }), `Deleted ${bucket.name}`)) onClose();
  };

  const moving = categories.filter((c) => chosen.has(c.category_id) && c.in && c.in.id !== bucket?.id).length;

  return (
    <Modal
      title={bucket ? `Edit ${bucket.name}` : 'Add a bucket'} open={!!editing} onClose={onClose}
      footer={<>
        {bucket && <button className="btn btn-ghost btn-danger" style={{ marginRight: 'auto' }} onClick={remove}>Delete bucket</button>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={!name.trim()}>{bucket ? 'Save' : 'Add bucket'}</button>
      </>}
    >
      <label className="field">
        <span>Name</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Car, Gifts, House deposit"
          onKeyDown={(e) => e.key === 'Enter' && submit()} autoFocus />
      </label>

      <div className="field">
        <span>Type</span>
        <div className="segmented" role="group" aria-label="Bucket type">
          <button type="button" aria-pressed={kind === 'spend'} onClick={() => setKind('spend')}>Spending</button>
          <button type="button" aria-pressed={kind === 'save'} onClick={() => setKind('save')}>Savings</button>
        </div>
        <p className="muted field-help">
          {kind === 'spend'
            ? 'Holds spending categories. They share the bucket’s budget.'
            : 'Fills from what’s left after spending (income less everything spent). Several savings buckets fill in order.'}
        </p>
      </div>

      {kind === 'spend' && (
        <label className="check-item check-option">
          <input type="checkbox" className="check" checked={follows} onChange={(e) => setFollows(e.target.checked)} />
          <span>
            Follow its recurring payments
            <span className="muted field-help">
              The target is what they come to each month, like four or five weekly rent payments, instead of a set % or amount.
            </span>
          </span>
        </label>
      )}
      {!following && (
        <label className="check-item check-option">
          <input type="checkbox" className="check" checked={balances} onChange={(e) => setBalances(e.target.checked)} />
          <span>
            Balance recurring buckets
            <span className="muted field-help">
              Gives up the extra when a bucket that follows recurring payments has a fifth week, and gets it back in four-week months, so the plan still adds up. Only one bucket can.
            </span>
          </span>
        </label>
      )}

      {!bucket && !following && (
        <div className="field">
          <span>Target</span>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <label className="affix" style={{ width: 90 }}>
              <input className="affix-input" inputMode="decimal" value={percent} placeholder="10" aria-label="Share of income"
                onChange={(e) => { setPercent(e.target.value); if (e.target.value) setAmount(''); }} />
              <span className="affix-mark" aria-hidden>%</span>
            </label>
            <span className="muted">of income, or</span>
            <label className="affix" style={{ width: 120 }}>
              <span className="affix-mark" aria-hidden>$</span>
              <input className="affix-input" inputMode="decimal" value={amount} placeholder="500" aria-label="Fixed amount a month"
                onChange={(e) => { setAmount(e.target.value); if (e.target.value) setPercent(''); }} />
            </label>
            <span className="muted">a month</span>
          </div>
        </div>
      )}

      {kind === 'spend' && (
        <div className="field">
          <span>Categories {chosen.size > 0 && <span className="muted">· {chosen.size} chosen</span>}</span>
          {categories.length === 0 ? <p className="muted">No spending categories yet.</p> : (
            <div className="check-list">
              {categories.map((c) => (
                <label className="check-item" key={c.category_id}>
                  <input type="checkbox" className="check" checked={chosen.has(c.category_id)} onChange={() => toggle(c.category_id)} />
                  <span className="nm">{c.name}</span>
                  {c.in && c.in.id !== bucket?.id && <span className="from">{c.in.name}</span>}
                </label>
              ))}
            </div>
          )}
          {moving > 0 && <p className="muted field-help">{moving === 1 ? '1 category moves' : `${moving} categories move`} here from another bucket.</p>}
        </div>
      )}
      {bucket?.kind === 'spend' && kind === 'save' && bucket.categories.length > 0 && (
        <p className="muted field-help">Its categories will be left without a bucket.</p>
      )}
    </Modal>
  );
}

// ---------- in and out ----------

/**
 * Income, the spending budget and spending for the month as bars on one scale, each as a share of income.
 * In the current month, a faint extension shows usual income so a not-yet-paid salary doesn't look like a loss.
 */
function InOutPanel({ p, month }: { p: BudgetPlan; month: string }) {
  const income = p.income.actual_cents;
  const spent = p.totals.spent_cents;
  const budget = p.totals.spend_target_cents;
  const usual = p.income.usual_cents;
  const pending = awaitingPay(p, month) ? usual : null;
  const scale = Math.max(income, pending ?? 0, spent, budget, 1);
  const pct = (c: number) => `${Math.min((c / scale) * 100, 100)}%`;
  const left = income - spent;
  // Spending as a share of income; before the month's income is in, of usual income instead.
  const base = pending ?? income;
  const savings = p.buckets.filter((b) => b.kind === 'save').map((b) => b.name).join(' and ') || 'savings';
  const cats = p.income.categories;

  return (
    <section className="panel">
      <div className="panel-head"><h2>In and out</h2></div>
      <div className="panel-body in-out">
        <div className="in-out-bars">
          <span className="in-out-label">Income</span>
          <div className="in-out-track">
            {pending != null && <div className="in-out-fill pending" style={{ width: pct(pending) }} />}
            <div className="in-out-fill income" style={{ width: pct(income) }} />
          </div>
          <span className="num in-out-amount">{money(income)}</span>
          <span className="in-out-sub">
            {cats.length === 0 ? 'Nothing yet' : cats.map((c, i) => (
              <Fragment key={c.category_id}>{i > 0 && ' · '}{c.name} {moneyWhole(c.amount_cents)}{cats.length > 1 && <> <Pct of={c.amount_cents} in={income} /></>}</Fragment>
            ))}
            {pending != null && <> · <Pct of={income} in={pending} /> of the usual ~{moneyWhole(usual)}</>}
          </span>

          <span className="in-out-label">Budget</span>
          <div className="in-out-track">
            <div className="in-out-fill budget" style={{ width: pct(budget) }} />
          </div>
          <span className="num in-out-amount">{budget > 0 ? money(budget) : '—'}</span>
          <span className="in-out-sub">
            {budget === 0 ? 'No spending buckets yet'
              : base > 0 ? <><Pct of={budget} in={base} /> of {pending != null ? 'usual ' : ''}income · {budget <= base ? `leaves ${moneyWhole(base - budget)} for ${savings}` : `${moneyWhole(budget - base)} more than comes in`}</>
              : 'No income to compare with yet'}
          </span>

          <span className="in-out-label">Spent</span>
          <div className="in-out-track">
            {budget > 0 && spent > budget && <div className="in-out-fill over" style={{ width: pct(spent) }} />}
            <div className="in-out-fill spent" style={{ width: pct(budget > 0 ? Math.min(spent, budget) : spent) }} />
          </div>
          <span className="num in-out-amount">{money(spent)}</span>
          <span className="in-out-sub">
            {base > 0 && <><Pct of={spent} in={base} /> of {pending != null ? 'usual ' : ''}income · </>}
            {budget > 0 ? <><Pct of={spent} in={budget} /> of budget · {spent > budget ? `${moneyWhole(spent - budget)} over` : `${moneyWhole(budget - spent)} left`}</> : 'No budget set'}
          </span>
        </div>

        <div className="in-out-result">
          <span className="in-out-label">{pending != null ? 'Left over so far' : left >= 0 ? 'Left over' : 'Spent more than came in'}</span>
          <b className={`num ${left >= 0 ? 'good' : pending != null ? '' : 'bad'}`}>{left < 0 && '−'}{money(Math.abs(left))}</b>
          <span className="muted">
            {pending != null ? 'More income usually to come'
              : income > 0 ? <><Pct of={left} in={income} /> of income {left >= 0 ? 'kept' : ''}</> : ''}
          </span>
        </div>
      </div>
    </section>
  );
}

/** a as a whole-number percentage of b, emphasised. Tiny non-zero shares show as "<1%". */
function Pct({ of: a, in: b }: { of: number; in: number }) {
  const p = Math.round((a / b) * 100);
  return <b className="in-out-pct">{p === 0 && a > 0 ? '<1' : p < 0 ? `−${-p}` : p}%</b>;
}

// ---------- pies ----------

const SLOTS = 7;

/**
 * This month's spending by category, and where the month's money went by bucket. Each category keeps a fixed colour:
 * the seven biggest over the last 12 months get one (in category order), the rest share a grey slice.
 */
function BreakdownPanel({ p, history, month }: { p: BudgetPlan; history: Trends; month: string }) {
  const byCategory = useMemo(() => {
    const color = categoryColors(history.categories, SLOTS);
    const rows = [...p.buckets.flatMap((b) => b.categories), ...p.unassigned];
    const out: Slice[] = rows.filter((r) => color.has(r.category_id) && r.spent_cents > 0)
      .sort((a, b) => [...color.keys()].indexOf(a.category_id) - [...color.keys()].indexOf(b.category_id))
      .map((r) => ({ key: String(r.category_id), name: r.name, cents: r.spent_cents, color: color.get(r.category_id)! }));
    const rest = rows.filter((r) => !color.has(r.category_id) && r.spent_cents > 0);
    if (rest.length) out.push({ key: 'rest', name: 'Everything else', cents: rest.reduce((s, r) => s + r.spent_cents, 0), color: 'var(--series-muted)', members: rest.map((r) => r.name) });
    return out;
  }, [p, history]);

  // Once the month's income is in and some is left, savings count too, so the slices add up to income.
  const withSavings = !awaitingPay(p, month) && p.totals.saved_cents > 0;
  const byBucket = useMemo(() => {
    const out: Slice[] = p.buckets
      .map((b, i) => ({ b, color: bucketColor(i) }))
      .filter(({ b }) => b.actual_cents > 0 && (b.kind === 'spend' || withSavings))
      .map(({ b, color }) => ({ key: `b${b.id}`, name: b.kind === 'save' ? `${b.name} (saved)` : b.name, cents: b.actual_cents, color }));
    const outside = p.unassigned.reduce((s, c) => s + Math.max(c.spent_cents, 0), 0) + p.uncategorized_cents;
    if (outside > 0) out.push({ key: 'none', name: 'Not in a bucket', cents: outside, color: 'var(--series-muted)' });
    return out;
  }, [p, withSavings]);

  return (
    <section className="panel">
      <div className="panel-head"><h2>Breakdown</h2></div>
      <div className="panel-body donut-pair">
        <div>
          <h3 className="donut-title">Spent in {monthLabel(month)} by category</h3>
          {byCategory.length === 0 ? <div className="empty">Nothing spent yet.</div> : <CategoryDonut slices={byCategory} centerLabel="spent" />}
          <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>Categorised spending, net of refunds and paybacks.</p>
        </div>
        <div>
          <h3 className="donut-title">{withSavings ? `Where ${monthLabel(month)}’s income went` : `Spent in ${monthLabel(month)} by bucket`}</h3>
          {byBucket.length === 0 ? <div className="empty">Nothing spent yet.</div> : <CategoryDonut slices={byBucket} centerLabel={withSavings ? 'income' : 'spent'} />}
          <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
            {withSavings ? 'Compare the shares with each bucket’s target.' : 'Savings join in once the month’s income is in.'}
          </p>
        </div>
      </div>
    </section>
  );
}
