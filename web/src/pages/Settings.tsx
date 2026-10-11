import { Download, Plus, Trash2, Wand2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useApi, type Bucket, type Category, type CategoryKind, type Meta, type Rule } from '../api.ts';
import { CategorySelect, Modal, useAction } from '../components/ui.tsx';
import { payeeHref } from './Payees.tsx';

const KINDS: { value: CategoryKind; label: string }[] = [
  { value: 'expense', label: 'Spending' },
  { value: 'income', label: 'Income' },
  { value: 'transfer', label: 'Transfer (not counted)' },
];

export default function Settings({ meta }: { meta: Meta | null }) {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="sub">Categories, auto-categorisation rules and accounts.</p>
        </div>
      </div>
      <div className="settings-grid">
        <div className="dash-col">
          <Categories categories={meta?.categories ?? []} />
        </div>
        <div className="dash-col">
          <Rules categories={meta?.categories ?? []} />
          <Accounts meta={meta} />
          <Data meta={meta} />
        </div>
      </div>
    </div>
  );
}

function Categories({ categories }: { categories: Category[] }) {
  const run = useAction();
  const buckets = (useApi<Bucket[]>('/buckets').data ?? []).filter((b) => b.kind === 'spend');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<CategoryKind>('expense');
  const [removing, setRemoving] = useState<Category | null>(null);
  const [mergeInto, setMergeInto] = useState<number | null>(null);

  const add = async () => {
    if (!name.trim()) return;
    if (await run(() => api('/categories', { body: { name, kind } }), `Added ${name.trim()}`)) setName('');
  };
  const patch = (c: Category, body: Partial<{ name: string; kind: CategoryKind; archived: boolean; bucket: number | null }>) =>
    run(() => api(`/categories/${c.id}`, { method: 'PATCH', body }));
  const remove = (c: Category) => { setRemoving(c); setMergeInto(null); };
  const confirmRemove = async () => {
    if (!removing) return;
    const target = categories.find((c) => c.id === mergeInto);
    const ok = await run(
      () => api<{ transactions: number }>(`/categories/${removing.id}${mergeInto ? `?reassign=${mergeInto}` : ''}`, { method: 'DELETE' }),
      (r) => target ? `Merged ${removing.name} into ${target.name} (${r.transactions} transactions)` : `Deleted ${removing.name}`,
    );
    if (ok) setRemoving(null);
  };

  return (
    <section className="panel">
      <div className="panel-head"><h2>Categories</h2><span className="hint">Spending goes in a <Link to="/budgets">budget bucket</Link>; transfers are left out</span></div>
      <Modal
        title={`Delete ${removing?.name ?? ''}`} open={!!removing} onClose={() => setRemoving(null)}
        footer={<>
          <button className="btn" onClick={() => setRemoving(null)}>Cancel</button>
          <button className={`btn ${mergeInto ? 'btn-primary' : 'btn-danger'}`} onClick={confirmRemove}>{mergeInto ? 'Merge and delete' : 'Delete'}</button>
        </>}
      >
        <label className="field">
          <span>Move its transactions and rules to</span>
          <CategorySelect
            categories={categories.filter((c) => c.id !== removing?.id && c.kind === removing?.kind)}
            value={mergeInto} onChange={setMergeInto} noneLabel="Nowhere: leave them uncategorised"
          />
        </label>
        <p className="muted" style={{ fontSize: 13 }}>
          {mergeInto ? 'The category is then deleted; its bucket stays as it is.' : 'Its rules are deleted. Archiving instead keeps everything and just hides it.'}
        </p>
      </Modal>
      <div className="panel-body stack">
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input className="input grow" placeholder="New category" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} aria-label="New category name" />
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value as CategoryKind)} aria-label="Kind">
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
          <button className="btn btn-primary btn-icon" onClick={add} aria-label="Add category"><Plus size={16} /></button>
        </div>
        <div className="table-wrap">
          <table className="table">
            <tbody>
              {categories.map((c) => (
                <tr key={c.id} style={c.archived ? { opacity: 0.55 } : undefined}>
                  <td style={{ paddingLeft: 0 }}>
                    <input className="input input-sm" style={{ width: '100%', border: 'none', background: 'transparent', fontWeight: 500 }}
                      defaultValue={c.name} aria-label="Category name"
                      onBlur={(e) => e.target.value.trim() && e.target.value !== c.name && patch(c, { name: e.target.value })} />
                  </td>
                  <td>
                    <select className="select select-sm" value={c.kind} onChange={(e) => patch(c, { kind: e.target.value as CategoryKind })} aria-label={`Kind of ${c.name}`}>
                      {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                    </select>
                  </td>
                  <td>
                    {c.kind === 'expense' && (
                      <select className={`select select-sm ${c.bucket_id == null ? 'unset' : ''}`} value={c.bucket_id ?? ''} aria-label={`Budget bucket for ${c.name}`}
                        onChange={(e) => patch(c, { bucket: e.target.value ? Number(e.target.value) : null })}>
                        <option value="">No bucket</option>
                        {buckets.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                      </select>
                    )}
                  </td>
                  <td className="right" style={{ whiteSpace: 'nowrap', paddingRight: 0 }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => patch(c, { archived: !c.archived })}>{c.archived ? 'Restore' : 'Archive'}</button>
                    <button className="btn btn-ghost btn-icon btn-sm" onClick={() => remove(c)} aria-label={`Delete ${c.name}`}><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function Rules({ categories }: { categories: Category[] }) {
  const rules = useApi<Rule[]>('/rules');
  const run = useAction();
  const [pattern, setPattern] = useState('');
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [merchant, setMerchant] = useState('');
  const [filter, setFilter] = useState('');

  const canAdd = !!pattern.trim() && (!!categoryId || !!merchant.trim());
  const add = async () => {
    if (!canAdd) return;
    const r = await run(() => api<{ applied: number; linked: number }>('/rules', { body: { pattern, category: categoryId, merchant: merchant.trim() || null, apply: true } }),
      (r) => `Rule added${r.applied ? ` — categorised ${r.applied}` : ''}${r.linked ? `${r.applied ? ',' : ' —'} linked ${r.linked}` : ''}`);
    if (r) { setPattern(''); setMerchant(''); }
  };

  const shown = (rules.data ?? []).filter((r) => !filter || `${r.pattern} ${r.category} ${r.merchant ?? ''}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Rules</h2>
        <button className="btn btn-sm" onClick={() => run(() => api<{ categorized: number; linked: number }>('/rules/apply', { body: {} }), (r) => `Categorised ${r.categorized}, linked ${r.linked} to a merchant or person`)}>
          <Wand2 size={13} />Apply to all
        </button>
      </div>
      <div className="panel-body stack">
        <p className="muted" style={{ fontSize: 13 }}>When a description contains the text (whole words, any case), the transaction gets that category and is linked to that merchant or person on import. A rule can set either or both. Claude adds rules as it learns your merchants.</p>
        <div className="grid-2">
          <input className="input" placeholder="Description contains…" value={pattern} onChange={(e) => setPattern(e.target.value)} aria-label="Pattern" />
          <CategorySelect categories={categories} value={categoryId} onChange={setCategoryId} noneLabel="No category" aria-label="Rule category" />
          <input className="input" placeholder="Merchant or person (optional)" value={merchant} onChange={(e) => setMerchant(e.target.value)} aria-label="Merchant or person" />
          <button className="btn btn-primary" onClick={add} disabled={!canAdd}>Add rule</button>
        </div>
        <input className="input" type="search" placeholder={`Search ${rules.data?.length ?? 0} rules`} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search rules" />
        <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
          <table className="table">
            <thead><tr><th>Contains</th><th>Category</th><th className="hide-sm">Merchant or person</th><th /></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span style={{ fontWeight: 500 }}>{r.pattern}</span>{r.match_type === 'regex' && <span className="badge" style={{ marginLeft: 6 }}>regex</span>}
                    {r.payee_id && <div className="desc-sub show-sm">{r.merchant}</div>}
                  </td>
                  <td className="ink-2">{r.category ?? <span className="muted">—</span>}</td>
                  <td className="hide-sm">{r.payee_id ? <Link to={payeeHref(r.payee_id, r.payee_kind)}>{r.merchant}</Link> : <span className="muted">—</span>}</td>
                  <td className="right"><button className="btn btn-ghost btn-icon btn-sm" aria-label={`Delete rule ${r.pattern}`} onClick={() => run(() => api(`/rules/${r.id}`, { method: 'DELETE' }))}><Trash2 size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function Accounts({ meta }: { meta: Meta | null }) {
  const run = useAction();
  const [name, setName] = useState('');
  const [type, setType] = useState('transaction');
  const add = async () => {
    if (!name.trim()) return;
    if (await run(() => api('/accounts', { body: { name, type } }), `Added ${name.trim()}`)) setName('');
  };
  return (
    <section className="panel">
      <div className="panel-head"><h2>Accounts</h2></div>
      <div className="panel-body stack">
        {meta?.accounts.length ? (
          <table className="table">
            <tbody>
              {meta.accounts.map((a) => (
                <tr key={a.id}>
                  <td style={{ paddingLeft: 0 }}>
                    <input className="input input-sm" style={{ width: '100%', border: 'none', background: 'transparent', fontWeight: 500 }}
                      defaultValue={a.name} aria-label="Account name"
                      onBlur={(e) => e.target.value.trim() && e.target.value !== a.name && run(() => api(`/accounts/${a.id}`, { method: 'PATCH', body: { name: e.target.value } }))} />
                  </td>
                  <td className="ink-2">{a.type === 'credit' ? 'Credit card' : a.type[0].toUpperCase() + a.type.slice(1)}</td>
                  <td className="num muted">{a.tx_count} txns</td>
                  <td className="right" style={{ paddingRight: 0 }}>
                    <button className="btn btn-ghost btn-icon btn-sm" aria-label={`Delete ${a.name}`} disabled={a.tx_count > 0} title={a.tx_count ? 'Undo its imports first' : 'Delete'}
                      onClick={() => confirm(`Delete ${a.name}?`) && run(() => api(`/accounts/${a.id}`, { method: 'DELETE' }))}><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted">Accounts are created automatically on import.</p>}
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input className="input grow" placeholder="e.g. Bankwest Mastercard" value={name} onChange={(e) => setName(e.target.value)} aria-label="New account name" />
          <select className="select" value={type} onChange={(e) => setType(e.target.value)} aria-label="Account type">
            <option value="transaction">Transaction</option>
            <option value="savings">Savings</option>
            <option value="credit">Credit card</option>
            <option value="other">Other</option>
          </select>
          <button className="btn btn-primary btn-icon" onClick={add} aria-label="Add account"><Plus size={16} /></button>
        </div>
      </div>
    </section>
  );
}

function Data({ meta }: { meta: Meta | null }) {
  return (
    <section className="panel">
      <div className="panel-head"><h2>Your data</h2></div>
      <div className="panel-body stack">
        <p className="ink-2">Everything lives in one SQLite file on this Mac, ignored by git. Back it up by copying the file or downloading a JSON export.</p>
        {meta && <div className="code" style={{ paddingRight: 12 }}>{meta.db_path}</div>}
        <div><a className="btn" href="/api/export" download><Download size={15} />Download JSON backup</a></div>
      </div>
    </section>
  );
}
