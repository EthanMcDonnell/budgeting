import { AlertTriangle, CheckCircle2, Clock, Tag, TrendingDown, TrendingUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useApi, type Meta } from '../api.ts';
import { MonthBars, PaceChart, bucketColor } from '../components/charts.tsx';
import { ErrorNotice, Meter, MonthPicker, meterState, useMonth } from '../components/ui.tsx';
import { dateLabel, money, moneyWhole, monthLabel, pct, targetNote, todayIso } from '../format.ts';
import type { RecurringList, Summary, Trends } from '../types.ts';
import { payeeHref } from './Payees.tsx';
import { DueBadge, Shares } from './Recurring.tsx';

function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

export default function Dashboard({ meta }: { meta: Meta | null }) {
  const { month, setMonth } = useMonth();
  const summary = useApi<Summary>(`/summary?month=${month}`);
  const trends = useApi<Trends>(`/trends?months=12&end=${month}`);
  const recurring = useApi<RecurringList>('/recurring');
  const s = summary.data;

  if (meta && meta.overview.transaction_count === 0) return <Welcome />;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{monthLabel(month)}</h1>
          {s && <p className="sub">{subline(s)}</p>}
        </div>
        <MonthPicker />
      </div>
      <ErrorNotice error={summary.error} />
      {s && <Notices s={s} />}
      {s && <Hero s={s} />}
      {s && (
        <div className="dash-grid">
          <div className="dash-col">
            {recurring.data && <ComingUp list={recurring.data} />}
            <BudgetPanel s={s} />
          </div>
          <div className="dash-col">
            <section className="panel">
              <div className="panel-head"><h2>Spending through the month</h2></div>
              <div className="panel-body"><PaceChart s={s} /></div>
            </section>
            <section className="panel">
              <div className="panel-head">
                <h2>Month by month</h2>
                <span className="hint">Click a month to open it</span>
              </div>
              <div className="panel-body">
                {trends.data ? <MonthBars t={trends.data} selected={month} onSelect={setMonth} /> : <div style={{ height: 220 }} />}
              </div>
            </section>
            <TopMerchants s={s} />
          </div>
        </div>
      )}
    </div>
  );
}

function subline(s: Summary) {
  if (s.is_current) return `Day ${s.elapsed_days} of ${s.days_in_month}`;
  if (s.elapsed_days === 0) return 'Upcoming month';
  return 'Full month';
}

function Notices({ s }: { s: Summary }) {
  const today = todayIso();
  const stale = s.is_current && (!s.data_through || daysBetween(s.data_through, today) > 6);
  return (
    <>
      {stale && (
        <div className="notice warn">
          <Clock size={16} />
          <span>
            {s.data_through ? `Transactions only go up to ${dateLabel(s.data_through)}` : 'No transactions imported for this month yet'}
            , so spending looks lower than it is. <Link to="/import">Import a recent CSV export</Link> to see where you're really at.
          </span>
        </div>
      )}
      {s.uncategorized.count > 0 && (
        <div className="notice warn">
          <Tag size={16} />
          <span>
            {s.uncategorized.count} transaction{s.uncategorized.count === 1 ? '' : 's'} ({money(s.uncategorized.out_cents)} out) need a category.{' '}
            <Link to={`/transactions?category=uncategorized&month=${s.month}`}>Categorise them</Link> or ask Claude to.
          </span>
        </div>
      )}
    </>
  );
}

function Hero({ s }: { s: Summary }) {
  const t = s.totals;
  const pace = s.is_current ? s.elapsed_days / s.days_in_month : null;
  const state = meterState(t.spent_cents, t.budget_cents, s.is_current ? t.expected_to_date_cents : null);

  let line: React.ReactNode;
  if (t.budget_cents === 0) {
    line = <>No budget set for this month. <Link to="/budgets">Set up buckets</Link></>;
  } else if (s.is_current) {
    const diff = t.expected_to_date_cents - t.spent_cents;
    line = t.spent_cents > t.budget_cents
      ? <><AlertTriangle size={16} className="bad" /> <span className="bad">{moneyWhole(-(t.budget_cents - t.spent_cents))} over the month's budget</span></>
      : diff >= 0
        ? <><CheckCircle2 size={16} className="good" /> <span><b className="good">{moneyWhole(diff)} under pace</b> — even spending would put you at {moneyWhole(t.expected_to_date_cents)} by today</span></>
        : <><AlertTriangle size={16} className="warn" /> <span><b className="warn">{moneyWhole(-diff)} ahead of pace</b> — even spending would put you at {moneyWhole(t.expected_to_date_cents)} by today</span></>;
  } else if (s.elapsed_days === 0) {
    line = <>{moneyWhole(t.budget_cents)} budgeted for this month.</>;
  } else {
    const left = t.budget_cents - t.spent_cents;
    line = left >= 0
      ? <><CheckCircle2 size={16} className="good" /> <span>Finished <b className="good">{moneyWhole(left)} under budget</b></span></>
      : <><AlertTriangle size={16} className="bad" /> <span>Finished <b className="bad">{moneyWhole(-left)} over budget</b></span></>;
  }

  const prevDelta = t.spent_cents - t.prev_spent_cents;
  return (
    <section className="hero" aria-label="Month at a glance">
      <div>
        <div className="hero-figure">
          {moneyWhole(t.spent_cents)}
          <span className="of">{t.budget_cents > 0 ? `spent of ${moneyWhole(t.budget_cents)}` : 'spent'}</span>
        </div>
        <p className="hero-line">{line}</p>
        {t.budget_cents > 0 && (
          <div className="hero-meter">
            <Meter spent={t.spent_cents} budget={t.budget_cents} pace={pace} reserved={t.reserved_cents}
              reservedTitle={t.reserved_cents ? `${moneyWhole(t.reserved_cents)} of recurring payments still due this month` : undefined}
              label="Total spending against budget" />
            <div className="meter-legend">
              <span>
                {pct(t.spent_cents, t.budget_cents)}% used{state === 'bad' ? ' — over budget' : ''}
                {t.reserved_cents > 0 && <> · <span className={`due-note ${t.spent_cents + t.reserved_cents > t.budget_cents ? 'over' : ''}`}>{moneyWhole(t.reserved_cents)} recurring still due</span></>}
              </span>
              <span>{t.budget_cents >= t.spent_cents ? `${moneyWhole(t.budget_cents - t.spent_cents)} left` : `${moneyWhole(t.spent_cents - t.budget_cents)} over`}</span>
            </div>
          </div>
        )}
      </div>
      <div className="stats">
        <div className="stat">
          <div className="label">Income</div>
          <div className="value">{moneyWhole(t.income_cents)}</div>
          <div className="delta">{t.prev_income_cents ? `${moneyWhole(t.prev_income_cents)} last month` : ' '}</div>
        </div>
        <div className="stat">
          <div className="label">Net (income − spending)</div>
          <div className={`value ${t.net_cents < 0 ? 'bad' : ''}`}>{moneyWhole(t.net_cents)}</div>
          <div className="delta">
            {t.income_cents > 0 ? `${pct(Math.max(t.net_cents, 0), t.income_cents)}% saved` : ' '}
            {t.income_cents > 0 && t.save_target_cents > 0 && t.planned_income_cents > 0 && <span className="muted"> · aim for {pct(t.save_target_cents, t.planned_income_cents)}%</span>}
          </div>
        </div>
        <div className="stat">
          <div className="label">vs last month</div>
          <div className="value" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {prevDelta > 0 ? <TrendingUp size={18} className="bad" aria-hidden /> : <TrendingDown size={18} className="good" aria-hidden />}
            {moneyWhole(Math.abs(prevDelta))} {prevDelta > 0 ? 'more' : 'less'}
          </div>
          <div className="delta">{moneyWhole(t.prev_spent_cents)} spent last month</div>
        </div>
        <div className="stat">
          {t.projected_cents != null ? (
            <>
              <div className="label">Projected month end</div>
              <div className={`value ${t.budget_cents && t.projected_cents > t.budget_cents ? 'bad' : ''}`}>{moneyWhole(t.projected_cents)}</div>
              <div className="delta">At your current daily rate</div>
            </>
          ) : (
            <>
              <div className="label">Average per day</div>
              <div className="value">{moneyWhole(s.elapsed_days ? t.spent_cents / s.elapsed_days : 0)}</div>
              <div className="delta">{s.elapsed_days ? `Over ${s.elapsed_days} days` : ' '}</div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** e.g. "Still to pay: Rent $480 × 3, Claude $34". */
const dueTitle = (r: Summary['buckets'][number]['reserved']) =>
  r.cents ? `Still to pay: ${r.items.map((i) => `${i.name} ${moneyWhole(i.each_cents)}${i.dates.length > 1 ? ` × ${i.dates.length}` : ''}`).join(', ')}` : undefined;

function BudgetPanel({ s }: { s: Summary }) {
  const pace = s.is_current ? s.elapsed_days / s.days_in_month : null;
  const outside = s.categories.filter((c) => c.bucket_id == null && c.spent_cents !== 0);
  // Before this month's pay is in, what's left over (savings) isn't meaningful yet.
  const waiting = s.is_current && s.totals.income_cents < s.totals.prev_income_cents;
  const hasTargets = s.buckets.some((b) => b.target_cents);
  const followers = s.buckets.filter((b) => b.schedule).map((b) => b.name);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Buckets</h2>
        <span className="hint">{pace != null ? 'The tick marks even spending to today' : <Link to="/budgets">Edit</Link>}</span>
      </div>
      <div className="panel-body">
        {!hasTargets ? (
          <div className="empty">
            <strong>No budget yet</strong>
            <span>Split your income into buckets to track progress here.</span>
            <Link className="btn btn-primary" to="/budgets">Set up buckets</Link>
          </div>
        ) : (
          <div className="budget-list">
            {s.buckets.map((b, i) => {
              const target = b.target_cents ?? 0;
              const save = b.kind === 'save';
              const note = targetNote(b, followers);
              const pending = save && waiting && b.actual_cents <= 0;
              const state = save ? 'ok' : b.actual_cents > target ? 'bad' : b.actual_cents >= target * 0.9 && b.actual_cents > 0 ? 'warn' : 'ok';
              const left = target - b.actual_cents;
              return (
                <div className="budget-item" key={b.id}>
                  <div className="name"><i className="swatch" style={{ background: bucketColor(i), borderRadius: 99 }} />{b.name}</div>
                  <div className="figures">
                    {pending ? <span className="muted">Waiting on pay</span>
                      : <>{b.actual_cents < 0 && '−'}{moneyWhole(Math.abs(b.actual_cents))} <span className="muted">/ {moneyWhole(target)}</span></>}
                  </div>
                  {target > 0 && (
                    <Meter spent={Math.max(b.actual_cents, 0)} budget={target} pace={save ? null : pace} state={state} small
                      reserved={b.reserved.cents} reservedTitle={dueTitle(b.reserved)} label={`${b.name} against its target`} />
                  )}
                  <div className="state">
                    <span className="state-left">{save ? (
                      pending ? <span className="muted">Savings are what’s left once income is in</span>
                        : b.actual_cents < 0 ? <><AlertTriangle size={13} className="bad" /><span className="bad">Nothing saved: spent {moneyWhole(-b.actual_cents)} more than came in</span></>
                        : left > 0 ? <span className="muted">{moneyWhole(left)} to go</span>
                        : <><CheckCircle2 size={13} className="good" /><span className="good">Target reached</span></>
                    ) : state === 'bad' ? (
                      <><AlertTriangle size={13} className="bad" /><span className="bad">{moneyWhole(-left)} over</span></>
                    ) : state === 'warn' ? (
                      <><AlertTriangle size={13} className="warn" /><span className="warn">{moneyWhole(left)} left — nearly used</span></>
                    ) : (
                      <span className="muted">{moneyWhole(left)} left</span>
                    )}</span>
                    {b.reserved.cents > 0 && (
                      <span className={`due-note ${Math.max(b.actual_cents, 0) + b.reserved.cents > target ? 'over' : ''}`} title={dueTitle(b.reserved)}>
                        {moneyWhole(b.reserved.cents)} recurring due
                      </span>
                    )}
                  </div>
                  {note && <span className="target-note">{note}</span>}
                </div>
              );
            })}
          </div>
        )}
        {(outside.length > 0 || s.uncategorized.out_cents > 0) && (
          <div className="unbudgeted">
            <span className="muted" style={{ fontSize: 13 }}>Not in a bucket · {moneyWhole(s.totals.unbudgeted_spent_cents)}</span>
            {outside.map((c) => (
              <div className="row" key={c.id}>
                <Link to={`/transactions?category=${c.id}&month=${s.month}`} style={{ color: 'var(--ink)' }}>{c.name}</Link>
                <span className="num">{money(c.spent_cents)}</span>
              </div>
            ))}
            {s.uncategorized.out_cents > 0 && (
              <div className="row">
                <Link to={`/transactions?category=uncategorized&month=${s.month}`} className="warn">Uncategorised</Link>
                <span className="num">{money(s.uncategorized.out_cents)}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** Recurring payments that are overdue or due in the next week. */
function ComingUp({ list }: { list: RecurringList }) {
  const items = list.items
    .filter((i) => i.active && (i.status === 'overdue' || i.status === 'due_soon' || i.paid_recently || i.owed_to_you_cents > 0))
    .sort((a, b) => (a.status === 'overdue' ? -1 : 0) - (b.status === 'overdue' ? -1 : 0) || (a.days_until_due ?? 0) - (b.days_until_due ?? 0));
  if (list.items.length === 0) return null;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Coming up</h2>
        <span className="hint">
          {list.owed_to_you_cents > 0 && <span className="bad">{money(list.owed_to_you_cents)} owed to you · </span>}
          <Link to="/recurring">All recurring</Link>
        </span>
      </div>
      <div className="panel-body merchant-list">
        {items.length === 0 ? <span className="muted">Nothing due in the next week.</span> : items.map((i) => (
          <div key={i.id}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span>
                <span style={{ fontWeight: 500 }}>{i.name}</span>{' '}
                <span className="muted num">
                  {i.typical_cents != null ? `~${moneyWhole(i.typical_cents)}` : ''}
                  {i.contributors.length > 0 && i.your_share_cents != null ? ` · yours ${moneyWhole(i.your_share_cents)}` : ''}
                </span>
              </span>
              <span style={{ fontSize: 13 }}><DueBadge item={i} /></span>
            </div>
            {i.current_cycle && <Shares cycle={i.current_cycle} />}
          </div>
        ))}
      </div>
    </section>
  );
}

function TopMerchants({ s }: { s: Summary }) {
  if (s.top_merchants.length === 0) return null;
  const max = s.top_merchants[0].spent_cents;
  return (
    <section className="panel">
      <div className="panel-head"><h2>Where it went</h2><span className="hint"><Link to="/merchants">All merchants</Link></span></div>
      <div className="panel-body merchant-list">
        {s.top_merchants.map((m) => (
          <div className="merchant" key={`${m.payee_id ?? ''}${m.name}`}>
            <span className="nm" title={m.name}>
              {m.payee_id ? <Link to={payeeHref(m.payee_id, m.payee_kind)} className="plain-link">{m.name}</Link> : m.name} <span className="muted">· {m.count}×</span>
            </span>
            <span className="num">{money(m.spent_cents)}</span>
            <div className="bar" style={{ width: `${Math.max((m.spent_cents / max) * 100, 1)}%` }} />
          </div>
        ))}
      </div>
    </section>
  );
}

function Welcome() {
  return (
    <div className="page">
      <div className="page-head"><h1>Welcome</h1></div>
      <section className="panel">
        <div className="panel-body stack" style={{ padding: 24 }}>
          <h2 style={{ fontSize: 18 }}>No transactions yet</h2>
          <p className="ink-2">Get your first month in, then see how it splits across your budget buckets.</p>
          <ol className="steps">
            <li><b>Import with Claude:</b> in this folder run <code>claude</code> and say “import ~/Downloads/statement.pdf”.</li>
            <li><b>Or import a CSV</b> exported from Bankwest Online Banking on the Import page.</li>
            <li><b>Adjust your buckets</b> on the Budgets page. Income starts split 50% expenses, 30% savings, 10% splurge and 10% travel.</li>
          </ol>
          <div className="row">
            <Link className="btn btn-primary" to="/import">Import transactions</Link>
            <Link className="btn" to="/budgets">Budgets</Link>
          </div>
        </div>
      </section>
    </div>
  );
}
