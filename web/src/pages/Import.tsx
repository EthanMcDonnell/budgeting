import { FileUp, Sparkles, Undo2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { api, useApi, type Meta } from '../api.ts';
import { CopyBlock, ErrorNotice, useAction } from '../components/ui.tsx';
import { dateLabel, money } from '../format.ts';

interface PreviewRow {
  index: number; status: 'new' | 'duplicate' | 'possible_duplicate' | 'invalid'; date: string | null; description: string;
  amount_cents: number; category: string | null; category_source: 'given' | 'rule' | null; merchant: string | null; error?: string;
}
interface CsvResult {
  dry_run: boolean; account: string; account_created: boolean; inserted: number; duplicates: number; possible_duplicates: number;
  invalid: number; uncategorized: number; period: { start: string | null; end: string | null }; rows: PreviewRow[];
  format: string; skipped_rows: { line: number; reason: string }[]; account_numbers: string[];
}
interface ImportRow {
  id: number; source: string; label: string | null; account: string | null; period_start: string | null; period_end: string | null;
  inserted: number; skipped: number; created_at: string; tx_count: number;
}

const STATUS_LABEL = { new: 'New', duplicate: 'Already imported', possible_duplicate: 'Possible duplicate', invalid: 'Unreadable' };

export default function Import({ meta }: { meta: Meta | null }) {
  const imports = useApi<ImportRow[]>('/imports');
  const run = useAction();

  const undo = (i: ImportRow) => {
    if (!confirm(`Undo "${i.label ?? 'import'}"? This deletes its ${i.tx_count} transactions.`)) return;
    run(() => api<{ deleted_transactions: number }>(`/imports/${i.id}`, { method: 'DELETE' }), (r) => `Removed ${r.deleted_transactions} transactions`);
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Import</h1>
          <p className="sub">Bring in statements with Claude, or upload a CSV export. Re-importing the same period is safe — duplicates are skipped.</p>
        </div>
      </div>

      <div className="settings-grid">
        <section className="panel">
          <div className="panel-head"><h2 className="row" style={{ gap: 8 }}><Sparkles size={16} style={{ color: 'var(--accent)' }} />With Claude (PDF statements)</h2></div>
          <div className="panel-body stack">
            <p className="ink-2">Claude reads the PDF, imports every line through the budget MCP server, checks the total against the statement's opening and closing balance, then categorises everything.</p>
            <ol className="steps">
              <li>Download the statement PDF from Bankwest Online Banking.</li>
              <li>Open a terminal in this project and start Claude:</li>
            </ol>
            <CopyBlock text="cd /path/to/budgeting && claude" />
            <ol className="steps" start={3}>
              <li>Ask it to import the file:</li>
            </ol>
            <CopyBlock text="Import ~/Downloads/statement.pdf and categorise everything" />
            <p className="muted" style={{ fontSize: 13 }}>
              Claude Desktop works too once the MCP server is added there — see the README. This page refreshes when you switch back to it.
            </p>
          </div>
        </section>

        <CsvImport meta={meta} />
      </div>

      <section className="panel">
        <div className="panel-head"><h2>History</h2><span className="hint">Undo removes everything an import added</span></div>
        <div className="panel-body" style={{ padding: 0 }}>
          {imports.data && imports.data.length === 0 ? (
            <div className="empty">Nothing imported yet.</div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th className="hide-sm">Imported</th><th>Source</th><th className="hide-sm">Account</th><th>Covers</th><th className="num">Transactions</th><th /></tr></thead>
                <tbody>
                  {imports.data?.map((i) => (
                    <tr key={i.id}>
                      <td className="hide-sm" style={{ whiteSpace: 'nowrap' }}>{new Date(`${i.created_at.replace(' ', 'T')}Z`).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' })}</td>
                      <td><div className="desc-main">{i.label ?? '—'}</div><div className="desc-sub">{i.source === 'pdf' ? 'Claude (statement)' : i.source.toUpperCase()}<span className="show-sm">{i.account && ` · ${i.account}`}</span></div></td>
                      <td className="ink-2 hide-sm">{i.account ?? '—'}</td>
                      <td className="ink-2 nowrap-wide">{i.period_start && i.period_end ? `${dateLabel(i.period_start, true)} – ${dateLabel(i.period_end, true)}` : '—'}</td>
                      <td className="num">{i.tx_count}{i.skipped ? <span className="muted"> · {i.skipped} skipped</span> : null}</td>
                      <td className="right"><button className="btn btn-sm" onClick={() => undo(i)}><Undo2 size={13} />Undo</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function CsvImport({ meta }: { meta: Meta | null }) {
  const run = useAction();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [accountChoice, setAccountChoice] = useState<string>('');
  const [newAccount, setNewAccount] = useState('Bankwest Everyday');
  const [preview, setPreview] = useState<CsvResult | null>(null);
  const [includePossible, setIncludePossible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);

  const accounts = meta?.accounts ?? [];
  const chosen = accountChoice || (accounts[0] ? String(accounts[0].id) : 'new');
  const accountRef = chosen === 'new' ? newAccount.trim() : Number(chosen);

  const send = async (f: { name: string; text: string }, commit: boolean) => {
    setError(null);
    setBusy(true);
    try {
      return await api<CsvResult>('/import/csv', {
        body: { text: f.text, filename: f.name, account: accountRef, commit, possible_duplicates: includePossible ? 'import' : 'skip' },
      });
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const load = async (f: File) => {
    const loaded = { name: f.name, text: await f.text() };
    setFile(loaded);
    setPreview(await send(loaded, false));
  };

  const commit = async () => {
    if (!file) return;
    const r = await run(async () => {
      const res = await send(file, true);
      if (!res) throw new Error(error ?? 'Import failed');
      return res;
    }, (r) => `Imported ${r.inserted} transactions into ${r.account}${r.uncategorized ? ` — ${r.uncategorized} need a category` : ''}`);
    if (r) { setFile(null); setPreview(null); }
  };

  const shown = preview?.rows.slice(0, 200) ?? [];

  return (
    <section className="panel">
      <div className="panel-head"><h2 className="row" style={{ gap: 8 }}><FileUp size={16} style={{ color: 'var(--accent)' }} />CSV export</h2></div>
      <div className="panel-body stack">
        <p className="ink-2">In Bankwest Online Banking, open the account, search the date range you want and export as CSV. Exact amounts, nothing for AI to misread, and you can do it mid-month to keep the dashboard current.</p>
        <div className="grid-2">
          <label className="field">
            <span>Account</span>
            <select className="select" value={chosen} onChange={(e) => { setAccountChoice(e.target.value); setPreview(null); }}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              <option value="new">New account…</option>
            </select>
          </label>
          {chosen === 'new' && (
            <label className="field"><span>New account name</span><input className="input" value={newAccount} onChange={(e) => setNewAccount(e.target.value)} /></label>
          )}
        </div>

        <div
          className={`dropzone ${over ? 'over' : ''}`} role="button" tabIndex={0}
          onClick={() => fileInput.current?.click()}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.current?.click(); }}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) load(f); }}
        >
          {file ? <><b>{file.name}</b><br /><span className="muted">Click to choose a different file</span></> : <>Drop a CSV here or <span style={{ color: 'var(--accent)' }}>choose a file</span></>}
          <input ref={fileInput} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) load(f); e.target.value = ''; }} />
        </div>

        <ErrorNotice error={error} />

        {preview && (
          <div className="stack">
            <div className="row" style={{ fontSize: 13 }}>
              <span className="badge"><i className="status-dot status-new" />{preview.rows.filter((r) => r.status === 'new').length} new</span>
              {preview.duplicates > 0 && <span className="badge"><i className="status-dot status-duplicate" />{preview.duplicates} already imported</span>}
              {preview.possible_duplicates > 0 && <span className="badge"><i className="status-dot status-possible_duplicate" />{preview.possible_duplicates} possible duplicates</span>}
              {preview.invalid + preview.skipped_rows.length > 0 && <span className="badge"><i className="status-dot status-invalid" />{preview.invalid + preview.skipped_rows.length} unreadable</span>}
              {preview.period.start && <span className="muted">{dateLabel(preview.period.start, true)} – {dateLabel(preview.period.end!, true)}</span>}
            </div>
            {preview.possible_duplicates > 0 && (
              <label className="row" style={{ gap: 8 }}>
                <input type="checkbox" className="check" checked={includePossible} onChange={(e) => setIncludePossible(e.target.checked)} />
                <span>Import possible duplicates too <span className="muted">(same date and amount as an existing transaction, different description)</span></span>
              </label>
            )}
            <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 8 }}>
              <table className="table">
                <thead><tr><th>Date</th><th>Description</th><th className="hide-sm">Category</th><th className="num">Amount</th></tr></thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.index} style={r.status === 'new' ? undefined : { opacity: 0.6 }}>
                      <td className="num" style={{ whiteSpace: 'nowrap' }}>
                        <i className={`status-dot status-${r.status}`} title={STATUS_LABEL[r.status]} style={{ marginRight: 6 }} />
                        {r.date ? dateLabel(r.date) : '—'}
                      </td>
                      <td>
                        <div className="desc-main">{r.merchant ?? r.description}</div>
                        <div className={`desc-sub show-sm ${r.category ? '' : 'warn'}`}>{r.category ?? 'Uncategorised'}</div>
                        {r.status !== 'new' && <div className="desc-sub">{r.error ?? STATUS_LABEL[r.status]}</div>}
                      </td>
                      <td className={`hide-sm ${r.category ? 'ink-2' : 'warn'}`}>{r.category ?? 'Uncategorised'}</td>
                      <td className={`num ${r.amount_cents > 0 ? 'amount-in' : ''}`}>{Number.isFinite(r.amount_cents) ? `${r.amount_cents > 0 ? '+' : '−'}${money(Math.abs(r.amount_cents))}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.rows.length > shown.length && <p className="muted">Showing the first {shown.length} of {preview.rows.length} rows.</p>}
            <div className="row">
              <button className="btn btn-primary" onClick={commit} disabled={busy || (preview.inserted === 0 && !(includePossible && preview.possible_duplicates))}>
                Import {preview.inserted + (includePossible ? preview.possible_duplicates : 0)} transactions
              </button>
              <button className="btn" onClick={() => { setFile(null); setPreview(null); }}>Cancel</button>
              {preview.uncategorized > 0 && <span className="muted">{preview.uncategorized} won't have a category yet — categorise after, or ask Claude.</span>}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
