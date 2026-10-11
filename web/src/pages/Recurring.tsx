import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Clock, Pencil, Plus, Sparkles, TrendingDown, TrendingUp, Users, X } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { api, useApi } from '../api.ts';
import { ErrorNotice, Modal, useAction } from '../components/ui.tsx';
import { dateLabel, money, moneyWhole } from '../format.ts';
import type { BillCycle, Frequency, RecurringItem, RecurringList, RecurringSuggestion } from '../types.ts';

export const FREQ_LABEL: Record<Frequency, string> = {
  weekly: 'Weekly', fortnightly: 'Fortnightly', monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly',
};

const STATUS_ORDER = { overdue: 0, due_soon: 1, awaiting_data: 2, upcoming: 3, no_payments: 4, inactive: 5 };

export function DueBadge({ item }: { item: RecurringItem }) {
  if (item.paid_recently && item.last_paid) {
    return <span className="row good" style={{ gap: 4 }}><CheckCircle2 size={14} />Paid {dateLabel(item.last_paid.date)}</span>;
  }
  const due = item.next_due ? dateLabel(item.next_due) : '';
  switch (item.status) {
    case 'overdue':
      return <span className="row bad" style={{ gap: 4 }}><AlertTriangle size={14} />Overdue {item.days_overdue}d <span className="muted">· was due {due}</span></span>;
    case 'due_soon': {
      const d = item.days_until_due ?? 0;
      return <span className="row warn" style={{ gap: 4 }}><Clock size={14} />{d > 1 ? `Due in ${d} days` : d === 1 ? 'Due tomorrow' : d === 0 ? 'Due today' : `Due ${due}`}</span>;
    }
    case 'awaiting_data':
      return <span className="muted" title="Its due date has passed, but your imported transactions don't go that far yet">Due {due} · import to check</span>;
    case 'upcoming':
      return <span className="ink-2">Due {due}</span>;
    case 'no_payments':
      return <span className="muted">No payments yet</span>;
    case 'inactive':
      return <span className="muted">Paused</span>;
  }
}

/** Who has paid their share of one bill. Leaves out shares that aren't due yet; renders nothing if that leaves none. */
export function Shares({ cycle }: { cycle: BillCycle }) {
  const shares = cycle.shares.filter((s) => s.status !== 'waiting');
  if (shares.length === 0) return null;
  return (
    <span className="row" style={{ gap: 4, columnGap: 10, fontSize: 12.5 }}>
      {shares.map((s) => (
        <span key={s.contributor_id} className={`row ${s.status === 'paid' ? 'good' : s.status === 'owing' ? 'bad' : 'warn'}`} style={{ gap: 4 }}>
          {s.status === 'paid' && <><CheckCircle2 size={12} />{s.name} paid{s.paid_date && <span className="muted">· {dateLabel(s.paid_date)}</span>}</>}
          {s.status === 'partial' && <>{s.name} paid {money(s.paid_cents)} of {money(s.expected_cents)}</>}
          {s.status === 'owing' && <><AlertTriangle size={12} />{s.name} owes {money(s.expected_cents)}</>}
        </span>
      ))}
    </span>
  );
}

/** What each person still owes across every paid bill, or failing that, shares paid early for the next one. */
function ShareAlert({ item }: { item: RecurringItem }) {
  const owing = item.contributors.map((p) => {
    const unpaid = item.cycles.filter((c) => c.bill_paid).flatMap((c) => c.shares)
      .filter((s) => s.contributor_id === p.id && (s.status === 'owing' || s.status === 'partial'));
    return { name: p.name, bills: unpaid.length, cents: unpaid.reduce((t, s) => t + s.expected_cents - s.paid_cents, 0) };
  }).filter((o) => o.cents > 0);
  if (owing.length > 0) {
    return (
      <div className="row bad" style={{ gap: 4, columnGap: 10, marginTop: 3, fontSize: 12.5 }}>
        {owing.map((o) => (
          <span key={o.name} className="row" style={{ gap: 4 }}>
            <AlertTriangle size={12} />{o.name} owes {money(o.cents)}{o.bills > 1 && <span className="muted">· {o.bills} bills</span>}
          </span>
        ))}
      </div>
    );
  }
  const next = item.cycles.find((c) => !c.bill_paid);
  if (!next || !next.shares.some((s) => s.status !== 'waiting')) return null;
  return (
    <div className="row" style={{ gap: 6, marginTop: 3 }}>
      <span className="muted" style={{ fontSize: 12 }}>Next bill:</span>
      <Shares cycle={next} />
    </div>
  );
}

/** One person's share of one bill, as a cell in the bills table. */
function ShareCell({ share, billPaid }: { share: BillCycle['shares'][number]; billPaid: boolean }) {
  switch (share.status) {
    case 'paid':
      return <span className="row good" style={{ gap: 4 }} title={`Paid ${money(share.paid_cents)}`}><CheckCircle2 size={13} />{money(share.paid_cents)}<span className="muted">{share.paid_date && dateLabel(share.paid_date)}</span></span>;
    case 'partial':
      return <span className="warn">{money(share.paid_cents)} of {money(share.expected_cents)}</span>;
    case 'owing':
      return <span className="row bad" style={{ gap: 4 }}><AlertTriangle size={13} />Owes {money(share.expected_cents)}</span>;
    case 'waiting':
      return billPaid
        ? <span className="muted" title={`From before ${share.name} started paying a share`}>—</span>
        : <span className="muted">{money(share.expected_cents)}</span>;
  }
}

/** Bills shown before "older bills" is opened: the upcoming one and the last few paid. */
const RECENT_BILLS = 4;

/** Expanded view of one item: each bill with who's paid their share, then the linked transactions. */
function ItemDetail({ item }: { item: RecurringItem }) {
  const split = item.contributors.length > 0 && item.cycles.length > 0;
  const [showTx, setShowTx] = useState(false);
  const [allBills, setAllBills] = useState(false);
  const txOpen = !split || showTx;
  const older = Math.max(item.cycles.length - RECENT_BILLS, 0);
  const cycles = allBills ? item.cycles : item.cycles.slice(0, RECENT_BILLS);
  return (
    <div className="stack recurring-detail">
      {split && (
        <table className="detail-table">
          <thead>
            <tr>
              <th>Bill</th>
              <th className="num">Amount</th>
              {item.contributors.map((c) => <th key={c.id}>{c.name}</th>)}
              <th className="num" title="The bill less everyone else's share">Your share</th>
            </tr>
          </thead>
          <tbody>
            {cycles.map((c) => {
              const bill = c.bill_paid ? c.bill_cents : item.typical_cents;
              const yours = bill == null ? null : bill - c.shares.reduce((t, s) => t + s.expected_cents, 0);
              return (
                <tr key={c.date} className={c.bill_paid ? undefined : 'muted'}>
                  <td style={{ whiteSpace: 'nowrap' }}>{dateLabel(c.date)}{!c.bill_paid && <span className="badge" style={{ marginLeft: 8 }}>Next</span>}</td>
                  <td className="num">{bill == null ? '—' : <>{!c.bill_paid && '~'}{money(bill)}</>}</td>
                  {c.shares.map((s) => <td key={s.contributor_id} className="num-font"><ShareCell share={s} billPaid={c.bill_paid} /></td>)}
                  <td className="num">{yours == null ? '—' : <>{!c.bill_paid && '~'}{money(Math.max(yours, 0))}</>}</td>
                </tr>
              );
            })}
          </tbody>
          {older > 0 && (
            <tfoot>
              <tr><td colSpan={item.contributors.length + 3}>
                <button className="detail-toggle" onClick={() => setAllBills((v) => !v)} aria-expanded={allBills}>
                  {allBills ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{allBills ? 'Hide older bills' : `${older} older bill${older === 1 ? '' : 's'}`}
                </button>
              </td></tr>
            </tfoot>
          )}
        </table>
      )}

      {item.history.length === 0 ? <span className="muted">No payments found yet.</span> : (
        <div className="stack" style={{ gap: 6 }}>
          {split ? (
            <button className="detail-toggle" onClick={() => setShowTx((v) => !v)} aria-expanded={showTx}>
              {showTx ? <ChevronDown size={13} /> : <ChevronRight size={13} />}Linked transactions ({item.history_count})
            </button>
          ) : <span className="detail-head">Payments</span>}
          {txOpen && (
            <table className="detail-table">
              <tbody>
                {item.history.map((h) => (
                  <tr key={h.id}>
                    <td className="num-font" style={{ width: 72, whiteSpace: 'nowrap' }}>{dateLabel(h.date)}</td>
                    <td className="ink-2">{h.merchant ?? h.description}<span className="muted"> · {h.account}</span></td>
                    <td className={`num ${h.amount_cents > 0 ? 'amount-in' : ''}`}>{h.amount_cents > 0 ? '+' : '−'}{money(Math.abs(h.amount_cents))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {txOpen && item.history_count > item.history.length && (
            <span className="muted" style={{ fontSize: 12.5 }}>Latest {item.history.length} of {item.history_count}. See the rest on the Transactions page.</span>
          )}
        </div>
      )}

      <span className="muted" style={{ fontSize: 12.5 }}>
        Finds payments whose bank description {item.match_type === 'regex' ? 'matches' : 'contains'} “{item.pattern}”{item.contributors.length > 0 && ', plus each person’s payments to you'}.
        To add one it missed, edit that transaction and pick this under Recurring payment.
      </span>
    </div>
  );
}

export default function Recurring() {
  const list = useApi<RecurringList>('/recurring');
  const [editing, setEditing] = useState<RecurringItem | RecurringSuggestion | 'new' | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const data = list.data;
  const items = [...(data?.items ?? [])].sort((a, b) =>
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (a.days_until_due ?? 999) - (b.days_until_due ?? 999) || a.name.localeCompare(b.name));
  const toggle = (id: number) => setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Recurring</h1>
          <p className="sub">
            {data && data.items.length > 0 ? <>
              {moneyWhole(data.monthly_total_cents)} a month across {data.items.filter((i) => i.active).length} regular payments
              {data.your_monthly_total_cents !== data.monthly_total_cents && <> · <b className="ink-2">{moneyWhole(data.your_monthly_total_cents)} your share</b></>}
              {data.owed_to_you_cents > 0 && <> · <span className="bad">{money(data.owed_to_you_cents)} owed to you</span></>}
            </> : 'Track regular payments like rent, electricity and subscriptions one by one.'}
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={16} />Add</button>
      </div>
      <ErrorNotice error={list.error} />

      {data && data.items.length > 0 && (
        <section className="panel">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 28 }} />
                  <th>Payment</th>
                  <th className="hide-sm">How often</th>
                  <th className="num hide-sm">Amount</th>
                  <th className="num" title="What it costs you each month, after anyone you split it with pays their share">Per month</th>
                  <th className="hide-sm">Last paid</th>
                  <th className="hide-sm">Next</th>
                  <th style={{ width: 40 }}><span className="sr-only">Edit</span></th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <Fragment key={i.id}>
                    <tr style={i.active ? undefined : { opacity: 0.55 }}>
                      <td>
                        <button className="btn btn-ghost btn-icon btn-sm" onClick={() => toggle(i.id)} aria-expanded={open.has(i.id)} aria-label={`Show ${i.name} history`}>
                          {open.has(i.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      </td>
                      <td>
                        <div className="desc-main">{i.name}</div>
                        <div className="desc-sub">
                          <span className="show-sm">{FREQ_LABEL[i.frequency]} · </span>
                          {i.category ?? 'Uncategorised'}
                          {i.contributors.length > 0 && <> · split with {i.contributors.map((c) => c.name).join(', ')}</>}
                          {i.contributors.length === 0 && i.credits_90d_cents > 0 && <> · others paid {money(i.credits_90d_cents)} (90 days)</>}
                        </div>
                        <div className="show-sm" style={{ marginTop: 3, fontSize: 12.5 }}><DueBadge item={i} /></div>
                        <ShareAlert item={i} />
                      </td>
                      <td className="ink-2 hide-sm">{FREQ_LABEL[i.frequency]}</td>
                      <td className="num hide-sm">
                        {i.typical_cents == null ? '—' : <>{i.expected_cents == null && <span className="muted" title="Worked out from recent payments">~</span>}{money(i.typical_cents)}</>}
                      </td>
                      <td className="num">
                        {i.your_monthly_cents == null ? '—' : moneyWhole(i.your_monthly_cents)}
                        {i.contributors.length > 0 && i.monthly_cents != null && <div className="muted nowrap-wide" style={{ fontSize: 12 }}>your share of {moneyWhole(i.monthly_cents)}</div>}
                      </td>
                      <td className="hide-sm" style={{ whiteSpace: 'nowrap' }}>
                        {i.last_paid ? (
                          <span className="row" style={{ gap: 6 }}>
                            <span className="num">{money(i.last_paid.amount_cents)}</span>
                            <span className="muted">{dateLabel(i.last_paid.date)}</span>
                            {i.change_cents != null && i.change_cents !== 0 && (
                              <span className={`row ${i.change_cents > 0 ? 'bad' : 'good'}`} style={{ gap: 2, fontSize: 12.5 }} title="Change since the previous payment">
                                {i.change_cents > 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}{moneyWhole(Math.abs(i.change_cents))}
                              </span>
                            )}
                          </span>
                        ) : <span className="muted">—</span>}
                      </td>
                      <td className="hide-sm" style={{ whiteSpace: 'nowrap' }}><DueBadge item={i} /></td>
                      <td><button className="btn btn-ghost btn-icon btn-sm" onClick={() => setEditing(i)} aria-label={`Edit ${i.name}`}><Pencil size={14} /></button></td>
                    </tr>
                    {open.has(i.id) && (
                      <tr>
                        <td colSpan={8} className="recurring-detail-cell"><ItemDetail item={i} /></td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {data && data.suggestions.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <h2 className="row" style={{ gap: 8 }}><Sparkles size={16} style={{ color: 'var(--accent)' }} />Looks recurring</h2>
            <span className="hint">Found in your history</span>
          </div>
          <div className="panel-body table-wrap" style={{ padding: 0 }}>
            <table className="table">
              <tbody>
                {data.suggestions.map((s) => (
                  <tr key={s.name}>
                    <td>
                      <div className="desc-main">{s.name}</div>
                      <div className="desc-sub"><span className="show-sm">{FREQ_LABEL[s.frequency]} · </span>{s.count} payments, last {dateLabel(s.last_date)}{s.category ? ` · ${s.category}` : ''}</div>
                    </td>
                    <td className="ink-2 hide-sm">{FREQ_LABEL[s.frequency]}</td>
                    <td className="num">~{money(s.typical_cents)}</td>
                    <td className="right"><button className="btn btn-sm" onClick={() => setEditing(s)}>Track</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {data && data.items.length === 0 && data.suggestions.length === 0 && (
        <section className="panel"><div className="empty">
          <strong>Nothing tracked yet</strong>
          <span>Add your rent, power, internet and subscriptions to see what's due and spot price rises.</span>
        </div></section>
      )}

      {data?.data_through && <p className="muted" style={{ fontSize: 13 }}>Due dates are worked out from the last payment. Transactions imported up to {dateLabel(data.data_through, true)}.</p>}

      {editing && <RecurringEditor initial={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

export function RecurringEditor({ initial, onClose }: { initial: RecurringItem | RecurringSuggestion | 'new'; onClose: () => void }) {
  const run = useAction();
  const existing = initial !== 'new' && 'id' in initial ? initial : null;
  const seed = initial === 'new' ? null : initial;
  const [name, setName] = useState(seed?.name ?? '');
  const [pattern, setPattern] = useState(seed?.pattern ?? '');
  const [frequency, setFrequency] = useState<Frequency>(seed?.frequency ?? 'monthly');
  const [expected, setExpected] = useState(existing?.expected_cents != null ? String(existing.expected_cents / 100) : '');
  const [active, setActive] = useState(existing ? !!existing.active : true);
  const [people, setPeople] = useState<{ id?: number; name: string; pattern: string; share: string }[]>(
    existing?.contributors.map((c) => ({ id: c.id, name: c.name, pattern: c.pattern, share: c.custom_share && c.share_cents != null ? String(c.share_cents / 100) : '' })) ?? [],
  );
  const setPerson = (i: number, patch: Partial<(typeof people)[number]>) => setPeople((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const [error, setError] = useState<string | null>(null);
  const [debounced, setDebounced] = useState(pattern);
  useEffect(() => { const t = setTimeout(() => setDebounced(pattern), 250); return () => clearTimeout(t); }, [pattern]);
  const preview = useApi<{ count: number; examples: { date: string; description: string; amount_cents: number }[]; error?: string }>(
    debounced.trim() ? `/recurring/preview?${new URLSearchParams({ pattern: debounced })}` : null,
  );

  const save = async () => {
    if (!name.trim()) return setError('Give it a name');
    if (!pattern.trim()) return setError('Enter text that appears in the bank description');
    const amount = expected.trim() === '' ? null : Number(expected.replace(/[$,]/g, ''));
    if (amount != null && (!Number.isFinite(amount) || amount < 0)) return setError('Expected amount must be a positive number');
    for (const p of people) {
      if (!p.name.trim() || !p.pattern.trim()) return setError('Each person needs a name and text from their payments');
      if (p.share.trim() && !(Number(p.share) >= 0)) return setError(`${p.name}'s share must be a positive number`);
    }
    const contributors = people.map((p) => ({ id: p.id, name: p.name, pattern: p.pattern, share_amount: p.share.trim() ? Number(p.share) : null }));
    const body = { name, pattern, frequency, expected_amount: amount, active, contributors };
    const ok = await run(
      () => existing ? api(`/recurring/${existing.id}`, { method: 'PATCH', body }) : api('/recurring', { body }),
      existing ? 'Saved' : `Tracking ${name.trim()}`,
    );
    if (ok) onClose();
  };

  const remove = async () => {
    if (!existing || !confirm(`Stop tracking ${existing.name}? Its transactions are kept.`)) return;
    if (await run(() => api(`/recurring/${existing.id}`, { method: 'DELETE' }), 'Removed')) onClose();
  };

  return (
    <Modal
      title={existing ? `Edit ${existing.name}` : 'Track a recurring payment'} open onClose={onClose}
      footer={<>
        {existing && <button className="btn btn-danger" style={{ marginRight: 'auto' }} onClick={remove}>Remove</button>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save}>{existing ? 'Save' : 'Track'}</button>
      </>}
    >
      <ErrorNotice error={error} />
      <label className="field"><span>Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Electricity" /></label>
      <label className="field">
        <span>Bank description contains</span>
        <input className="input" value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="e.g. ORIGIN ENERGY" />
      </label>
      {pattern.trim() && preview.data && (
        <div className="muted" style={{ fontSize: 13, marginTop: -4 }}>
          {preview.data.error ?? (preview.data.count === 0 ? 'No transactions match yet. Future ones will be linked when imported.' : (
            <>
              Matches {preview.data.count} transaction{preview.data.count === 1 ? '' : 's'}:
              {preview.data.examples.map((e, i) => (
                <div key={i} className="num" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {dateLabel(e.date)} · {money(Math.abs(e.amount_cents))} · {e.description}
                </div>
              ))}
            </>
          ))}
        </div>
      )}
      <div className="grid-2">
        <label className="field">
          <span>How often</span>
          <select className="select" value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)}>
            {Object.entries(FREQ_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Usual amount (optional)</span>
          <input className="input num" inputMode="decimal" value={expected} onChange={(e) => setExpected(e.target.value)} placeholder="From recent payments" />
        </label>
      </div>
      <div className="stack" style={{ gap: 8 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="row" style={{ gap: 6, fontWeight: 500, fontSize: 13 }}><Users size={14} />Split with</span>
          <button className="btn btn-sm" onClick={() => setPeople((ps) => [...ps, { name: '', pattern: '', share: '' }])}><Plus size={13} />Add person</button>
        </div>
        {people.length === 0 ? (
          <span className="muted" style={{ fontSize: 13 }}>Add housemates who pay you their share. Their payments get matched to this bill and filed in the same category.</span>
        ) : (
          <>
            {people.map((p, i) => (
              <div key={p.id ?? `new-${i}`} className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
                <input className="input input-sm" style={{ width: 96 }} placeholder="Name" value={p.name} onChange={(e) => setPerson(i, { name: e.target.value })} aria-label="Person's name" />
                <input className="input input-sm grow" placeholder="Their payment contains, e.g. OLIVER CHEN" value={p.pattern} onChange={(e) => setPerson(i, { pattern: e.target.value })} aria-label={`Text in ${p.name || 'their'} payments`} />
                <input className="input input-sm num" style={{ width: 72 }} inputMode="decimal" placeholder="Even" value={p.share} onChange={(e) => setPerson(i, { share: e.target.value })} aria-label={`${p.name || 'Their'} share per bill`} title="Their share per bill (blank = even split)" />
                <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setPeople((ps) => ps.filter((_, j) => j !== i))} aria-label={`Remove ${p.name || 'person'}`}><X size={14} /></button>
              </div>
            ))}
            <SplitSummary people={people} bill={expected.trim() ? Number(expected) * 100 : existing?.typical_cents ?? null} />
          </>
        )}
      </div>
      {existing && (
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" className="check" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span>Active <span className="muted">(untick to pause it, e.g. a cancelled subscription)</span></span>
        </label>
      )}
    </Modal>
  );
}

function SplitSummary({ people, bill }: { people: { share: string }[]; bill: number | null }) {
  if (bill == null || !Number.isFinite(bill)) return <span className="muted" style={{ fontSize: 13 }}>Shares are split evenly unless you set an amount.</span>;
  const even = Math.round(bill / (people.length + 1));
  const others = people.reduce((s, p) => s + (p.share.trim() ? Math.round(Number(p.share) * 100) || 0 : even), 0);
  return (
    <span className="muted" style={{ fontSize: 13 }}>
      Bill {money(bill)} · others {money(others)} · <b className="ink-2">your share {money(Math.max(bill - others, 0))}</b>
    </span>
  );
}
