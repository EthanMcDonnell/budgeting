import { Pencil, Plus, Repeat, Trash2, Users, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, useApi, type Category, type Meta, type Transaction } from '../api.ts';
import { bucketColor } from '../components/charts.tsx';
import { SplitEditor, SplitMark } from '../components/splits.tsx';
import { CategorySelect, ErrorNotice, Modal, MonthPicker, useAction, useMonth } from '../components/ui.tsx';
import { dateLabel, money, todayIso } from '../format.ts';
import type { PayeeList, RecurringList } from '../types.ts';
import { payeeHref } from './Payees.tsx';

interface TxList { transactions: Transaction[]; count: number; out_cents: number; in_cents: number }

export default function Transactions({ meta }: { meta: Meta | null }) {
  const [params, setParams] = useSearchParams();
  const { month, setMonth } = useMonth();
  const [scope, setScope] = useState<'month' | 'all'>(params.has('payee') ? 'all' : 'month');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [category, setCategory] = useState<string>(params.get('category') ?? '');
  const [account, setAccount] = useState<string>('');
  const [payee, setPayee] = useState<string>(params.get('payee') ?? '');
  const [bucket, setBucket] = useState<string>(params.get('bucket') ?? '');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<Transaction | 'new' | null>(null);
  const [splitting, setSplitting] = useState<Transaction | null>(null);
  const run = useAction();

  // Deep links like /transactions?category=uncategorized&month=2026-09 or ?bucket=3 from the dashboard.
  useEffect(() => {
    const m = params.get('month');
    if (m) setMonth(m);
    if (params.has('category') || params.has('month') || params.has('payee') || params.has('bucket')) setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const query = new URLSearchParams();
  if (scope === 'month') query.set('month', month);
  if (debounced) query.set('search', debounced);
  if (category) query.set('category', category);
  if (account) query.set('account', account);
  if (payee) query.set('payee', payee);
  if (bucket) query.set('bucket', bucket);
  const list = useApi<TxList>(`/transactions?${query}`);
  const rows = list.data?.transactions ?? [];
  const categories = meta?.categories ?? [];
  const multiAccount = (meta?.accounts.length ?? 0) > 1;

  useEffect(() => setSelected(new Set()), [month, scope, debounced, category, account, payee, bucket]);
  const payeeName = payee ? rows.find((r) => String(r.payee_id) === payee)?.merchant ?? 'selected payee' : null;
  const buckets = meta?.buckets ?? [];
  const bucketIndex = buckets.findIndex((b) => String(b.id) === bucket);
  const bucketName = bucket ? buckets[bucketIndex]?.name ?? 'Bucket' : null;
  // With a bucket chosen, the category list narrows to the categories in it.
  const shownCategories = bucket ? categories.filter((c) => String(c.bucket_id) === bucket) : categories;


  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggle = (id: number) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const setCat = (t: Transaction, catId: number | null) =>
    run(() => api(`/transactions/${t.id}`, { method: 'PATCH', body: { category: catId } }));

  const bulk = (action: 'categorize' | 'delete', cat?: number | null) => {
    if (action === 'delete' && !confirm(`Delete ${selected.size} transaction${selected.size === 1 ? '' : 's'}? This can't be undone.`)) return;
    run(() => api<{ changed: number }>('/transactions/bulk', { body: { ids: [...selected], action, category: cat } }),
      (r) => `${r.changed} transaction${r.changed === 1 ? '' : 's'} ${action === 'delete' ? 'deleted' : 'updated'}`)
      .then(() => setSelected(new Set()));
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Transactions</h1>
          {list.data && (
            <p className="sub num">
              {list.data.count} transaction{list.data.count === 1 ? '' : 's'} · {money(list.data.out_cents)} out · {money(list.data.in_cents)} in
            </p>
          )}
        </div>
        <div className="row">
          {scope === 'month' && <MonthPicker />}
          <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={16} />Add</button>
        </div>
      </div>

      <div className="filters">
        <div className="segmented" role="group" aria-label="Date range">
          <button aria-pressed={scope === 'month'} onClick={() => setScope('month')}>Month</button>
          <button aria-pressed={scope === 'all'} onClick={() => setScope('all')}>All time</button>
        </div>
        <input className="input" type="search" placeholder="Search description, merchant, notes" value={search}
          onChange={(e) => setSearch(e.target.value)} aria-label="Search transactions" />
        <select className="select" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Filter by category">
          <option value="">{bucketName ? `All of ${bucketName}` : 'All categories'}</option>
          {!bucket && <option value="uncategorized">Uncategorised</option>}
          {shownCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {multiAccount && (
          <select className="select" value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Filter by account">
            <option value="">All accounts</option>
            {meta!.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        )}
        {bucketName && (
          <span className="badge filter-chip" title={shownCategories.map((c) => c.name).join(', ')}>
            <i className="swatch" style={{ background: bucketColor(Math.max(bucketIndex, 0)), borderRadius: 99 }} />
            <b>{bucketName}</b>
            <span className="muted">{shownCategories.length ? shownCategories.map((c) => c.name).join(', ') : 'no categories'}</span>
            <button className="btn btn-ghost btn-icon btn-sm" style={{ height: 18, width: 18 }} onClick={() => setBucket('')} aria-label={`Stop filtering by the ${bucketName} bucket`}><X size={12} /></button>
          </span>
        )}
        {payeeName && (
          <span className="badge filter-chip">
            {payeeName}
            <button className="btn btn-ghost btn-icon btn-sm" style={{ height: 18, width: 18 }} onClick={() => setPayee('')} aria-label={`Stop filtering by ${payeeName}`}><X size={12} /></button>
          </span>
        )}
      </div>

      <ErrorNotice error={list.error} />

      <section className="panel">
        {rows.length === 0 && !list.loading ? (
          <div className="empty">
            <strong>No transactions match</strong>
            <span>{scope === 'month' ? 'Try another month, "All time", or clear the filters.' : 'Try clearing the filters.'}</span>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table tx-table">
              <thead>
                <tr>
                  <th style={{ width: 36 }}>
                    <label className="row" style={{ gap: 10, flexWrap: 'nowrap' }}>
                      <input type="checkbox" className="check" checked={allSelected} aria-label="Select all"
                        onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))} />
                      <span className="show-sm" aria-hidden>Select all</span>
                    </label>
                  </th>
                  <th>Date</th>
                  <th>Description</th>
                  {multiAccount && <th className="hide-sm">Account</th>}
                  <th>Category</th>
                  <th className="num">Amount</th>
                  <th style={{ width: 40 }}><span className="sr-only">Edit</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td className="tx-check"><input type="checkbox" className="check" checked={selected.has(t.id)} onChange={() => toggle(t.id)} aria-label={`Select ${t.description}`} /></td>
                    <td className="num tx-date">{dateLabel(t.date, scope === 'all')}</td>
                    <td className="tx-desc">
                      <div className="desc-main">
                        {t.payee_id ? <Link to={payeeHref(t.payee_id, t.payee_kind)} className="plain-link">{t.merchant}</Link> : t.description}
                        <SplitMark t={t} />
                        {t.recurring && <Repeat size={12} className="muted" style={{ marginLeft: 6, verticalAlign: -1 }} aria-label={`Recurring: ${t.recurring}`}><title>{`Recurring: ${t.recurring}`}</title></Repeat>}
                      </div>
                      {(t.merchant || t.notes || t.memo) && (
                        <div className="desc-sub" title={t.description}>
                          {t.memo && <span className="memo">“{t.memo}”</span>}{t.memo && (t.notes || t.merchant) ? ' · ' : ''}
                          {t.notes ? `${t.notes}${t.merchant ? ' · ' : ''}` : ''}{t.merchant ? t.description : ''}
                        </div>
                      )}
                    </td>
                    {multiAccount && <td className="ink-2 hide-sm" style={{ whiteSpace: 'nowrap' }}>{t.account}</td>}
                    <td className="tx-cat">
                      <CategorySelect
                        categories={categories} value={t.category_id} onChange={(id) => setCat(t, id)}
                        className={`select-sm cat-select ${t.category_id == null ? 'unset' : ''}`} aria-label={`Category for ${t.description}`}
                      />
                      {t.categorized_by && t.categorized_by !== 'user' && (
                        <span className="by" title={t.categorized_by === 'ai' ? 'Categorised by Claude' : 'Categorised by a rule'}>{t.categorized_by === 'ai' ? 'AI' : 'rule'}</span>
                      )}
                    </td>
                    <td className={`num tx-amount ${t.amount_cents > 0 ? 'amount-in' : ''}`}>
                      {t.amount_cents > 0 ? '+' : '−'}{money(Math.abs(t.amount_cents))}
                    </td>
                    <td className="tx-edit">
                      <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setEditing(t)} aria-label={`Edit ${t.description}`}><Pencil size={14} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selected.size > 0 && (
        <div className="bulkbar" role="region" aria-label="Bulk actions">
          <b>{selected.size} selected</b>
          <CategorySelect categories={categories} value={null} noneLabel="Set category…" className="select-sm"
            onChange={(id) => id && bulk('categorize', id)} aria-label="Set category for selected" />
          <button className="btn btn-sm" onClick={() => bulk('categorize', null)}>Clear category</button>
          <button className="btn btn-sm btn-danger" onClick={() => bulk('delete')}><Trash2 size={14} />Delete</button>
          <button className="btn btn-sm btn-ghost" style={{ color: 'inherit', marginLeft: 'auto' }} onClick={() => setSelected(new Set())}>Cancel</button>
        </div>
      )}

      {editing && (
        <TxEditor tx={editing === 'new' ? null : editing} meta={meta} categories={categories} onClose={() => setEditing(null)}
          onSplit={(t) => { setEditing(null); setSplitting(t); }} />
      )}
      {splitting && <SplitEditor tx={splitting} onClose={() => setSplitting(null)} />}
    </div>
  );
}

/** Suggests a rule pattern from a raw description: the leading words, minus card/terminal numbers. */
function suggestPattern(t: { merchant: string | null; description: string }) {
  const words = t.description.toUpperCase().replace(/[^A-Z0-9&*'. -]/g, ' ').split(/\s+/)
    .filter((w) => w && !/\d{3,}/.test(w) && !['EFTPOS', 'PURCHASE', 'VISA', 'POS', 'DEBIT', 'CARD', 'AUTHORISATION', 'ONLY', '-'].includes(w));
  return words.slice(0, 2).join(' ');
}

function TxEditor({ tx, meta, categories, onClose, onSplit }: {
  tx: Transaction | null; meta: Meta | null; categories: Category[]; onClose: () => void; onSplit: (t: Transaction) => void;
}) {
  const run = useAction();
  const [date, setDate] = useState(tx?.date ?? todayIso());
  const [description, setDescription] = useState(tx?.description ?? '');
  const [merchant, setMerchant] = useState(tx?.merchant ?? '');
  const [person, setPerson] = useState(false);
  const payees = useApi<PayeeList>('/payees');
  const known = (payees.data?.payees ?? []).find((p) => p.name.toLowerCase() === merchant.trim().toLowerCase());
  const [direction, setDirection] = useState<'out' | 'in'>(tx && tx.amount_cents > 0 ? 'in' : 'out');
  const [amount, setAmount] = useState(tx ? (Math.abs(tx.amount_cents) / 100).toFixed(2) : '');
  const [categoryId, setCategoryId] = useState<number | null>(tx?.category_id ?? null);
  const [notes, setNotes] = useState(tx?.notes ?? '');
  const [memo, setMemo] = useState(tx?.memo ?? '');
  const [accountId, setAccountId] = useState<number | null>(tx?.account_id ?? meta?.accounts[0]?.id ?? null);
  const [recurringId, setRecurringId] = useState<number | null>(tx?.recurring_id ?? null);
  const [contributorId, setContributorId] = useState<number | null>(tx?.contributor_id ?? null);
  const recurring = useApi<RecurringList>('/recurring');
  const [makeRule, setMakeRule] = useState(false);
  const [pattern, setPattern] = useState('');
  const [error, setError] = useState<string | null>(null);
  const suggested = useMemo(() => suggestPattern({ merchant, description }), [merchant, description]);

  const save = async () => {
    const value = Number(amount);
    if (!description.trim()) return setError('Description is required');
    if (!Number.isFinite(value) || value < 0 || amount === '') return setError('Enter the amount as a positive number');
    const body = {
      date, description, merchant: merchant.trim() || null, payee_kind: person ? 'person' : 'merchant', notes: notes || null, memo: memo || null, category: categoryId,
      amount: direction === 'out' ? -value : value, account: accountId ?? undefined,
    };
    const ok = await run(async () => {
      if (tx) await api(`/transactions/${tx.id}`, { method: 'PATCH', body: { ...body, recurring_id: recurringId, contributor_id: recurringId ? contributorId : null } });
      else await api('/transactions', { body });
      if (makeRule && categoryId) {
        await api('/rules', { body: { pattern: pattern || suggested, category: categoryId, merchant: merchant.trim() || null, payee_kind: person ? 'person' : 'merchant', apply: true } });
      }
      return true;
    }, tx ? 'Saved' : 'Transaction added');
    if (ok) onClose();
  };

  const remove = async () => {
    if (!tx || !confirm('Delete this transaction?')) return;
    if (await run(() => api(`/transactions/${tx.id}`, { method: 'DELETE' }), 'Deleted')) onClose();
  };

  return (
    <Modal
      title={tx ? 'Edit transaction' : 'Add transaction'} open onClose={onClose}
      footer={<>
        {tx && <button className="btn btn-danger" style={{ marginRight: 'auto' }} onClick={remove}><Trash2 size={14} />Delete</button>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save}>{tx ? 'Save' : 'Add'}</button>
      </>}
    >
      <ErrorNotice error={error} />
      <div className="grid-2">
        <label className="field"><span>Date</span><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <div className="field">
          <span>Amount</span>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <div className="segmented" role="group" aria-label="Direction">
              <button aria-pressed={direction === 'out'} onClick={() => setDirection('out')}>Out</button>
              <button aria-pressed={direction === 'in'} onClick={() => setDirection('in')}>In</button>
            </div>
            <input className="input grow num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" aria-label="Amount" />
          </div>
        </div>
      </div>
      <label className="field"><span>Description</span><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="As shown on the statement" /></label>
      <div className="grid-2">
        <div className="field">
          <span>Merchant or person</span>
          <input className="input" list="payee-names" value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="Friendly name, optional" aria-label="Merchant or person" />
          <datalist id="payee-names">{(payees.data?.payees ?? []).map((p) => <option key={p.id} value={p.name}>{p.kind === 'person' ? 'Person' : p.category ?? 'Merchant'}</option>)}</datalist>
          {merchant.trim() && !known && payees.data && (
            <label className="row" style={{ gap: 6, fontSize: 12.5 }}>
              <input type="checkbox" className="check" checked={person} onChange={(e) => setPerson(e.target.checked)} />
              <span className="ink-2">New — this is a person, not a shop</span>
            </label>
          )}
        </div>
        <label className="field"><span>Category</span><CategorySelect categories={categories} value={categoryId} onChange={setCategoryId} /></label>
      </div>
      {meta && meta.accounts.length > 1 && (
        <label className="field">
          <span>Account</span>
          <select className="select" value={accountId ?? ''} onChange={(e) => setAccountId(Number(e.target.value))}>
            {meta.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
      )}
      {tx && recurring.data && recurring.data.items.length > 0 && (
        <label className="field">
          <span>Recurring payment</span>
          <select className="select" value={recurringId ?? ''} onChange={(e) => { setRecurringId(e.target.value ? Number(e.target.value) : null); setContributorId(null); }}>
            <option value="">Not recurring</option>
            {recurring.data.items.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
      )}
      {(() => {
        const people = recurring.data?.items.find((r) => r.id === recurringId)?.contributors ?? [];
        if (!tx || direction !== 'in' || people.length === 0) return null;
        return (
          <label className="field">
            <span>Their share, from</span>
            <select className="select" value={contributorId ?? ''} onChange={(e) => setContributorId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Someone else</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        );
      })()}
      <label className="field">
        <span>Their message</span>
        <input className="input" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="What they wrote on it, e.g. a Beem memo" />
      </label>
      <label className="field"><span>Notes</span><textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      {tx && tx.amount_cents < 0 && (
        <div className="field">
          <span>Shared with others</span>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-sm" onClick={() => onSplit(tx)}><Users size={13} />{tx.split_id ? `Split ${tx.split_ways} ways — edit` : 'Split…'}</button>
            <span className="muted" style={{ fontSize: 12.5 }}>Track who owes you a share</span>
          </div>
        </div>
      )}
      {tx && tx.payback_split_id != null && (
        <div className="field">
          <span>Payback</span>
          <div className="row" style={{ gap: 8 }}>
            <span className="ink-2">Their share of {tx.payback_for}</span>
            <button className="btn btn-sm btn-ghost" onClick={() => run(() => api(`/paybacks/${tx.id}`, { method: 'DELETE' }), 'Unlinked').then((ok) => ok && onClose())}>Unlink</button>
          </div>
        </div>
      )}
      {categoryId != null && (
        <div className="stack" style={{ gap: 8 }}>
          <label className="row" style={{ gap: 8 }}>
            <input type="checkbox" className="check" checked={makeRule} onChange={(e) => setMakeRule(e.target.checked)} />
            <span>Always categorise descriptions like this the same way</span>
          </label>
          {makeRule && (
            <label className="field">
              <span>When the description contains</span>
              <input className="input" value={pattern} placeholder={suggested} onChange={(e) => setPattern(e.target.value)} />
            </label>
          )}
        </div>
      )}
    </Modal>
  );
}
