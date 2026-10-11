import { AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, useApi, type Meta, type PayeeKind } from '../api.ts';
import { PayeeMonthsChart } from '../components/charts.tsx';
import { PaybackSuggestions, SharedCosts, SplitMark } from '../components/splits.tsx';
import { CategorySelect, ErrorNotice, Modal, MonthPicker, useAction, useMonth } from '../components/ui.tsx';
import { dateLabel, money, moneyWhole, monthLabel } from '../format.ts';
import type { PayeeDetail, PayeeList, PayeeRow, SplitsOverview } from '../types.ts';

const LABEL: Record<PayeeKind, { one: string; many: string; path: string }> = {
  merchant: { one: 'Merchant', many: 'Merchants', path: '/merchants' },
  person: { one: 'Person', many: 'People', path: '/people' },
};

/** Where a payee's page lives. */
export const payeeHref = (id: number, kind: PayeeKind | null) => `${LABEL[kind ?? 'merchant'].path}/${id}`;

/** A sortable column: text columns sort A–Z first, numbers and dates largest/newest first. */
/** `phone: false` drops the column on narrow screens; `short` replaces the label there. */
interface Column { key: string; label: string; short?: string; title?: string; num?: boolean; text?: boolean; phone?: false; value: (p: PayeeRow) => number | string }

// ---------- list ----------

/** Cents to the dollar, or whole dollars on phones so the columns fit. */
function PhoneWhole({ cents }: { cents: number }) {
  return <><span className="hide-sm">{money(cents)}</span><span className="show-sm">{moneyWhole(cents)}</span></>;
}

export function PayeeListPage({ kind }: { kind: PayeeKind }) {
  const { month } = useMonth();
  const navigate = useNavigate();
  const list = useApi<PayeeList>(`/payees?kind=${kind}&month=${month}`);
  const shared = useApi<SplitsOverview>(kind === 'person' ? '/splits' : null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: string; desc: boolean }>({ key: kind === 'merchant' ? 'year' : 'last', desc: true });
  const [showUnused, setShowUnused] = useState(false);
  const [adding, setAdding] = useState(false);
  const isPerson = kind === 'person';

  // What a row counts as: for shops, spending net of refunds; for people, money either way.
  const amount = (p: PayeeRow, k: 'month' | 'year' | 'total') => {
    const [o, i] = k === 'month' ? [p.month_out_cents, p.month_in_cents] : k === 'year' ? [p.year_out_cents, p.year_in_cents] : [p.out_cents, p.in_cents];
    return isPerson ? o + i : o - i;
  };

  const name: Column = { key: 'name', label: isPerson ? 'Person' : 'Merchant', text: true, value: (p) => p.name };
  const last: Column = { key: 'last', label: 'Last', phone: false, value: (p) => p.last_date ?? '' };
  const columns: Column[] = isPerson ? [
    name,
    { key: 'out', label: 'You paid · 12 mo', short: 'You paid', num: true, title: 'Money you sent them in the 12 months to the selected month', value: (p) => p.year_out_cents },
    { key: 'in', label: 'They paid · 12 mo', short: 'They paid', num: true, title: 'Money they sent you in the 12 months to the selected month', value: (p) => p.year_in_cents },
    { key: 'owes', label: 'Owes you', num: true, title: 'Their unpaid share of things you paid for, plus split bills on the Recurring page', value: (p) => p.split_owed_cents + p.bills_owed_cents },
    last,
  ] : [
    name,
    { key: 'category', label: 'Category', text: true, phone: false, value: (p) => p.category ?? '' },
    { key: 'month', label: monthLabel(month, 'short'), num: true, title: `Spent in ${monthLabel(month)}`, value: (p) => amount(p, 'month') },
    { key: 'year', label: '12 months', num: true, title: 'Spent in the 12 months to the selected month', value: (p) => amount(p, 'year') },
    { key: 'avg', label: 'Per month', num: true, phone: false, title: 'Last 12 months divided by 12', value: (p) => amount(p, 'year') },
    { key: 'visits', label: 'Visits', num: true, phone: false, value: (p) => p.tx_count },
    last,
  ];
  const sortBy = (c: Column) => setSort((s) => (s.key === c.key ? { key: c.key, desc: !s.desc } : { key: c.key, desc: !c.text }));

  const all = list.data?.payees ?? [];
  const unused = all.filter((p) => p.tx_count === 0).length;
  const q = search.trim().toLowerCase();
  const col = columns.find((c) => c.key === sort.key) ?? columns[0];
  const rows = all
    .filter((p) => showUnused || p.tx_count > 0)
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.bank_names.some((n) => n.toLowerCase().includes(q)) || p.category?.toLowerCase().includes(q))
    .sort((a, b) => {
      const va = col.value(a);
      const vb = col.value(b);
      const cmp = typeof va === 'number' ? va - (vb as number) : String(va).localeCompare(String(vb));
      return (sort.desc ? -cmp : cmp) || a.name.localeCompare(b.name);
    });

  const monthSpend = all.reduce((s, p) => s + p.month_out_cents - p.month_in_cents, 0);
  const owed = all.reduce((s, p) => s + p.bills_owed_cents + p.split_owed_cents, 0);
  const unclaimed = shared.data?.unclaimed_cents ?? 0;
  const used = all.length - unused;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{LABEL[kind].many}</h1>
          {list.data && (
            <p className="sub">
              {isPerson
                ? <>{used} {used === 1 ? 'person' : 'people'} you've sent money to or received it from<span className="show-sm"> · paid columns cover 12 months</span>{owed > 0 && <> · <span className="bad">{money(owed)} owed to you</span></>}{unclaimed > 0 && <span className="muted"> · {money(unclaimed)} in shares nobody's claimed yet</span>}</>
                : <>{used} shops · {moneyWhole(monthSpend)} spent at them in {monthLabel(month)}</>}
            </p>
          )}
        </div>
        <div className="row">
          <MonthPicker />
          <button className="btn btn-primary" onClick={() => setAdding(true)}><Plus size={16} />Add</button>
        </div>
      </div>

      <div className="filters">
        <input className="input" type="search" placeholder={isPerson ? 'Search name or bank text' : 'Search name, bank text or category'}
          value={search} onChange={(e) => setSearch(e.target.value)} aria-label={`Search ${LABEL[kind].many.toLowerCase()}`} />
        {unused > 0 && (
          <label className="row" style={{ gap: 6, fontSize: 13 }}>
            <input type="checkbox" className="check" checked={showUnused} onChange={(e) => setShowUnused(e.target.checked)} />
            <span className="ink-2">Show {unused} with no transactions</span>
          </label>
        )}
      </div>

      <ErrorNotice error={list.error} />

      {isPerson && shared.data && <PaybackSuggestions suggestions={shared.data.suggestions} />}
      {isPerson && shared.data && (
        <SharedCosts splits={shared.data.open} title="Still owed to you" hint="Shared purchases where someone hasn't paid their share yet" />
      )}

      <section className="panel">
        {rows.length === 0 && !list.loading ? (
          <div className="empty">
            <strong>{search ? 'Nothing matches' : `No ${LABEL[kind].many.toLowerCase()} yet`}</strong>
            <span>{isPerson
              ? 'Add someone with the text their payments show on your statement, e.g. "To Riley".'
              : 'Merchants are added as transactions are categorised with a friendly name.'}</span>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  {columns.map((c) => {
                    const active = c.key === sort.key;
                    return (
                      <th key={c.key} className={[c.num && 'num', c.phone === false && 'hide-sm'].filter(Boolean).join(' ') || undefined} title={c.title}
                        aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
                        <button className={`th-sort ${active ? 'active' : ''}`} onClick={() => sortBy(c)}>
                          {c.short ? <><span className="hide-sm">{c.label}</span><span className="show-sm">{c.short}</span></> : c.label}
                          {active ? (sort.desc ? <ArrowDown size={12} /> : <ArrowUp size={12} />) : <ArrowDown size={12} className="th-sort-idle" />}
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="clickable" onClick={() => navigate(payeeHref(p.id, kind))}>
                    <td className="name-cell">
                      <Link to={payeeHref(p.id, kind)} className="desc-main plain-link" onClick={(e) => e.stopPropagation()}>{p.name}</Link>
                      <div className="desc-sub" title={p.bank_names.join('\n')}>
                        {p.bank_names.length ? p.bank_names.slice(0, 2).join(' · ') : 'No transactions yet'}
                        {p.bank_names.length > 2 && ` +${p.bank_names.length - 2}`}
                      </div>

                    </td>
                    {isPerson ? (
                      <>
                        <td className="num">{p.year_out_cents ? <PhoneWhole cents={p.year_out_cents} /> : <span className="muted">—</span>}</td>
                        <td className="num">{p.year_in_cents ? <PhoneWhole cents={p.year_in_cents} /> : <span className="muted">—</span>}</td>
                        <td className="num" style={{ whiteSpace: 'nowrap' }}>
                          {p.split_owed_cents + p.bills_owed_cents > 0
                            ? <span className="bad row" style={{ gap: 4, justifyContent: 'flex-end' }} title={p.bills_owed_cents ? `${money(p.bills_owed_cents)} of it for split bills` : undefined}><AlertTriangle size={12} /><PhoneWhole cents={p.split_owed_cents + p.bills_owed_cents} /></span>
                            : <span className="muted">—</span>}
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="ink-2 hide-sm">{p.category ?? <span className="muted">—</span>}</td>
                        <td className="num">{amount(p, 'month') ? <PhoneWhole cents={amount(p, 'month')} /> : <span className="muted">—</span>}</td>
                        <td className="num">{amount(p, 'year') ? <PhoneWhole cents={amount(p, 'year')} /> : <span className="muted">—</span>}</td>
                        <td className="num ink-2 hide-sm">{amount(p, 'year') ? moneyWhole(amount(p, 'year') / 12) : <span className="muted">—</span>}</td>
                        <td className="num ink-2 hide-sm">{p.tx_count}</td>
                      </>
                    )}
                    <td className="ink-2 hide-sm" style={{ whiteSpace: 'nowrap' }}>{p.last_date ? dateLabel(p.last_date, true) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {adding && <NewPayee kind={kind} onClose={() => setAdding(false)} />}
    </div>
  );
}

/** Adds a merchant or person, optionally with the bank text that identifies their transactions. */
function NewPayee({ kind, onClose }: { kind: PayeeKind; onClose: () => void }) {
  const run = useAction();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [pattern, setPattern] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (!name.trim()) return setError('Enter a name');
    const created = await run(async () => {
      const p = await api<{ id: number }>('/payees', { body: { name, kind } });
      const r = pattern.trim() ? await api<{ linked: number }>('/rules', { body: { pattern, payee_id: p.id, apply: true } }) : { linked: 0 };
      return { id: p.id, linked: r.linked };
    }, (r) => `Added ${name.trim()}${r.linked ? `, linked ${r.linked} transactions` : ''}`);
    if (created) navigate(payeeHref(created.id, kind));
  };
  return (
    <Modal title={`Add ${LABEL[kind].one.toLowerCase()}`} open onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={save}>Add</button></>}>
      <ErrorNotice error={error} />
      <label className="field"><span>Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'person' ? 'e.g. Riley' : 'e.g. Zambrero Subiaco'} /></label>
      <label className="field">
        <span>Bank description contains (optional)</span>
        <input className="input" value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder={kind === 'person' ? 'e.g. To Riley' : 'e.g. MIKROY'} />
      </label>
      <span className="muted" style={{ fontSize: 13 }}>Transactions whose description contains this text (whole words, any case) are linked now and on every import.</span>
    </Modal>
  );
}

// ---------- detail ----------

export function PayeeDetailPage({ meta }: { meta: Meta | null }) {
  const { id } = useParams();
  const { month } = useMonth();
  const run = useAction();
  const detail = useApi<PayeeDetail>(`/payees/${id}?months=24&end=${month}`);
  const [editing, setEditing] = useState(false);
  const [pattern, setPattern] = useState('');
  const [ruleCat, setRuleCat] = useState<number | null>(null);
  const d = detail.data;

  if (detail.error) return <div className="page"><ErrorNotice error={detail.error} /></div>;
  if (!d) return <div className="page" />;

  const isPerson = d.kind === 'person';
  const label = LABEL[d.kind];
  const t = d.totals;
  const year = d.months.slice(-12);
  const yearOut = year.reduce((s, m) => s + m.out_cents, 0);
  const yearIn = year.reduce((s, m) => s + m.in_cents, 0);
  const last = d.months[d.months.length - 1];

  const addRule = async () => {
    if (!pattern.trim()) return;
    const r = await run(() => api<{ linked: number; applied: number }>('/rules', { body: { pattern, payee_id: d.id, category: ruleCat, apply: true } }),
      (r) => `Rule added${r.linked ? `, linked ${r.linked} transactions` : ''}${r.applied ? `, categorised ${r.applied}` : ''}`);
    if (r) { setPattern(''); setRuleCat(null); }
  };

  return (
    <div className="page">
      <Link to={label.path} className="back-link"><ArrowLeft size={14} />{label.many}</Link>
      <div className="page-head">
        <div>
          <h1 className="row" style={{ gap: 10 }}>{d.name}<span className="badge">{label.one}</span></h1>
          <p className="sub">
            {t.tx_count} transaction{t.tx_count === 1 ? '' : 's'}
            {t.first_date && <> · {dateLabel(t.first_date, true)} to {dateLabel(t.last_date!, true)}</>}
            {d.notes && <> · {d.notes}</>}
          </p>
        </div>
        <button className="btn" onClick={() => setEditing(true)}><Pencil size={14} />Edit</button>
      </div>

      <div className="stats stats-4">
        {isPerson ? (
          <>
            <div className="stat"><div className="label">You paid them</div><div className="value">{moneyWhole(t.out_cents)}</div><div className="delta">{moneyWhole(yearOut)} in the last 12 months</div></div>
            <div className="stat"><div className="label">They paid you</div><div className="value">{moneyWhole(t.in_cents)}</div><div className="delta">{moneyWhole(yearIn)} in the last 12 months</div></div>
            <div className="stat">
              <div className="label">Shared costs</div>
              <div className={`value ${t.split_owed_cents > 0 ? 'bad' : ''}`}>{t.split_owed_cents > 0 ? `Owes ${money(t.split_owed_cents)}` : 'Up to date'}</div>
              <div className="delta">{d.splits.length ? `${d.splits.length} shared purchase${d.splits.length === 1 ? '' : 's'}` : 'Nothing split yet'}</div>
            </div>
            <div className="stat">
              <div className="label">Split bills</div>
              <div className={`value ${t.bills_owed_cents > 0 ? 'bad' : ''}`}>{t.bills_owed_cents > 0 ? `Owes ${money(t.bills_owed_cents)}` : 'Up to date'}</div>
              <div className="delta"><Link to="/recurring">Recurring payments</Link></div>
            </div>
          </>
        ) : (
          <>
            <div className="stat"><div className="label">{monthLabel(last.month)}</div><div className="value">{moneyWhole(last.out_cents - last.in_cents)}</div><div className="delta">{last.count} visit{last.count === 1 ? '' : 's'}</div></div>
            <div className="stat"><div className="label">Last 12 months</div><div className="value">{moneyWhole(yearOut - yearIn)}</div><div className="delta">{moneyWhole((yearOut - yearIn) / 12)} a month on average</div></div>
            <div className="stat"><div className="label">All time</div><div className="value">{moneyWhole(t.out_cents - t.in_cents)}</div><div className="delta">{t.in_cents > 0 ? `after ${money(t.in_cents)} refunded` : `${t.tx_count} visits`}</div></div>
            <div className="stat"><div className="label">Average visit</div><div className="value">{money(t.tx_count ? Math.round((t.out_cents - t.in_cents) / t.tx_count) : 0)}</div><div className="delta">{t.last_date ? `last on ${dateLabel(t.last_date, true)}` : ''}</div></div>
          </>
        )}
      </div>

      <section className="panel">
        <div className="panel-head"><h2>By month</h2><span className="hint">24 months to {monthLabel(month)}</span></div>
        <div className="panel-body">
          <PayeeMonthsChart months={d.months} outLabel={isPerson ? 'You paid' : 'Spent'} inLabel={isPerson ? 'They paid' : 'Refunded'} />
        </div>
      </section>

      {isPerson && (
        <>
          <PaybackSuggestions suggestions={d.payback_suggestions} hint={`${d.name}'s payments that match a share of something you paid for`} />
          <SharedCosts splits={d.splits} payee={d.id} hint={`Things you paid for that ${d.name} had a share of`}
            empty={`Nothing split with ${d.name} yet. Split a purchase from Transactions (the pencil, then Split), or confirm a payback above.`} />
        </>
      )}

      <div className="dash-grid">
        <section className="panel">
          <div className="panel-head"><h2>On your statement</h2><span className="hint">How the bank names it</span></div>
          <div className="panel-body">
            {d.bank_names.length === 0 ? <span className="muted">No transactions yet.</span> : (
              <table className="detail-table">
                <tbody>
                  {d.bank_names.map((b) => (
                    <tr key={b.name}>
                      <td className="ink-2" style={{ wordBreak: 'break-word' }}>{b.name}</td>
                      <td className="num muted" style={{ whiteSpace: 'nowrap' }}>{b.count}×</td>
                      <td className="num muted" style={{ whiteSpace: 'nowrap' }}>{dateLabel(b.last_date, true)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head"><h2>Matching rules</h2><span className="hint">Links new imports automatically</span></div>
          <div className="panel-body stack">
            {d.rules.length === 0 ? <span className="muted" style={{ fontSize: 13 }}>No rules yet, so new transactions won't be linked to {d.name} automatically.</span> : (
              <table className="detail-table">
                <tbody>
                  {d.rules.map((r) => (
                    <tr key={r.id}>
                      <td style={{ fontWeight: 500 }}>{r.pattern}{r.match_type === 'regex' && <span className="badge" style={{ marginLeft: 6 }}>regex</span>}</td>
                      <td className="ink-2">{r.category ?? <span className="muted">Any category</span>}</td>
                      <td className="right">
                        <button className="btn btn-ghost btn-icon btn-sm" aria-label={`Delete rule ${r.pattern}`} onClick={() => run(() => api(`/rules/${r.id}`, { method: 'DELETE' }), 'Rule deleted')}><Trash2 size={14} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="rule-add">
              <input className="input input-sm" placeholder="Description contains…" value={pattern} onChange={(e) => setPattern(e.target.value)} aria-label="New rule pattern"
                onKeyDown={(e) => e.key === 'Enter' && addRule()} />
              <CategorySelect categories={meta?.categories ?? []} value={ruleCat} onChange={setRuleCat} noneLabel="Any category" className="select-sm" aria-label="Category for new rule" />
              <button className="btn btn-sm" onClick={addRule} disabled={!pattern.trim()}><Plus size={13} />Add</button>
            </div>
          </div>
        </section>
      </div>

      {d.categories.length > 0 && (
        <section className="panel">
          <div className="panel-head"><h2>By category</h2></div>
          <div className="panel-body">
            <table className="detail-table">
              <thead><tr><th>Category</th><th className="num">{isPerson ? 'You paid' : 'Spent'}</th><th className="num">{isPerson ? 'They paid' : 'Refunded'}</th><th className="num">Transactions</th></tr></thead>
              <tbody>
                {d.categories.map((c) => (
                  <tr key={c.category ?? 'none'}>
                    <td>{c.category ?? <span className="muted">Uncategorised</span>}{c.kind === 'transfer' && <span className="muted"> · not counted</span>}</td>
                    <td className="num">{c.out_cents ? money(c.out_cents) : <span className="muted">—</span>}</td>
                    <td className="num">{c.in_cents ? money(c.in_cents) : <span className="muted">—</span>}</td>
                    <td className="num ink-2">{c.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panel-head">
          <h2>Transactions</h2>
          <span className="hint"><Link to={`/transactions?payee=${d.id}`}>Open in Transactions</Link></span>
        </div>
        <div className="table-wrap">
          <table className="table">
            <tbody>
              {d.transactions.map((tx) => (
                <tr key={tx.id}>
                  <td className="num" style={{ whiteSpace: 'nowrap', width: 110 }}>{dateLabel(tx.date, true)}</td>
                  <td>
                    <div className="ink-2 clip" title={tx.description}>{tx.description}<SplitMark t={tx} /></div>
                    <div className="desc-sub show-sm">{tx.category ?? 'Uncategorised'}</div>
                    {(tx.memo || tx.notes) && <div className="desc-sub">{tx.memo && <span className="memo">“{tx.memo}”</span>}{tx.memo && tx.notes ? ' · ' : ''}{tx.notes}</div>}
                  </td>
                  <td className="ink-2 hide-sm" style={{ whiteSpace: 'nowrap' }}>{tx.category ?? <span className="muted">Uncategorised</span>}</td>
                  <td className={`num ${tx.amount_cents > 0 ? 'amount-in' : ''}`} style={{ whiteSpace: 'nowrap' }}>
                    {tx.amount_cents > 0 ? '+' : '−'}{money(Math.abs(tx.amount_cents))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {d.transaction_count > d.transactions.length && (
            <p className="muted" style={{ fontSize: 13, padding: '8px 12px' }}>Latest {d.transactions.length} of {d.transaction_count}.</p>
          )}
        </div>
      </section>

      {editing && <PayeeEditor payee={d} onClose={() => setEditing(false)} />}
    </div>
  );
}

/** Rename, re-kind, add notes, merge into another payee, or delete. */
function PayeeEditor({ payee, onClose }: { payee: PayeeDetail; onClose: () => void }) {
  const run = useAction();
  const navigate = useNavigate();
  const all = useApi<PayeeList>('/payees');
  const [name, setName] = useState(payee.name);
  const [kind, setKind] = useState<PayeeKind>(payee.kind);
  const [notes, setNotes] = useState(payee.notes ?? '');
  const [mergeInto, setMergeInto] = useState('');
  const others = (all.data?.payees ?? []).filter((p) => p.id !== payee.id);
  const target = others.find((p) => p.name.toLowerCase() === mergeInto.trim().toLowerCase());

  const save = async () => {
    const ok = await run(() => api(`/payees/${payee.id}`, { method: 'PATCH', body: { name, kind, notes: notes || null } }), 'Saved');
    if (!ok) return;
    onClose();
    if (kind !== payee.kind) navigate(payeeHref(payee.id, kind), { replace: true });
  };
  const merge = async () => {
    if (!target || !confirm(`Move all of ${payee.name}'s transactions and rules to ${target.name}, and remove ${payee.name}?`)) return;
    const r = await run(() => api<{ transactions: number }>(`/payees/${payee.id}/merge`, { body: { into: target.id } }),
      (r) => `Merged ${r.transactions} transactions into ${target.name}`);
    if (r) navigate(payeeHref(target.id, target.kind), { replace: true });
  };
  const remove = async () => {
    if (!confirm(`Remove ${payee.name}? Its ${payee.totals.tx_count} transactions are kept, just no longer linked.`)) return;
    if (await run(() => api(`/payees/${payee.id}`, { method: 'DELETE' }), `Removed ${payee.name}`)) navigate(LABEL[payee.kind].path, { replace: true });
  };

  return (
    <Modal title={`Edit ${payee.name}`} open onClose={onClose}
      footer={<>
        <button className="btn btn-danger" style={{ marginRight: 'auto' }} onClick={remove}><Trash2 size={14} />Remove</button>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save}>Save</button>
      </>}>
      <label className="field"><span>Friendly name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <div className="field">
        <span>This is a</span>
        <div className="segmented" role="group" aria-label="Kind">
          <button aria-pressed={kind === 'merchant'} onClick={() => setKind('merchant')}>Merchant</button>
          <button aria-pressed={kind === 'person'} onClick={() => setKind('person')}>Person</button>
        </div>
      </div>
      <label className="field"><span>Notes</span><textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      <div className="field">
        <span>Merge into another</span>
        <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
          <input className="input grow" list="merge-targets" value={mergeInto} onChange={(e) => setMergeInto(e.target.value)} placeholder="Start typing a name" aria-label="Merge into" />
          <datalist id="merge-targets">{others.map((p) => <option key={p.id} value={p.name} />)}</datalist>
          <button className="btn" onClick={merge} disabled={!target}>Merge</button>
        </div>
        <span className="muted" style={{ fontSize: 12.5 }}>For duplicates, e.g. two names for the same café.</span>
      </div>
    </Modal>
  );
}
