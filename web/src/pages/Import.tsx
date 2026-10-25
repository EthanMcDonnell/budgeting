import { CalendarX, FileUp, Sparkles, Undo2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { api, useApi, type Meta } from '../api.ts';
import { CopyBlock, ErrorNotice, useAction } from '../components/ui.tsx';
import { dateLabel, money, todayIso } from '../format.ts';

interface PreviewRow {
  index: number; status: 'new' | 'duplicate' | 'possible_duplicate' | 'invalid' | 'pending' | 'still_pending' | 'settles'; date: string | null; description: string;
  amount_cents: number; category: string | null; category_source: 'given' | 'rule' | null; merchant: string | null; error?: string;
  account: string;
}
interface CsvResult {
  dry_run: boolean; account: string; accounts: { account: string; new: number }[]; inserted: number; duplicates: number; possible_duplicates: number;
  invalid: number; uncategorized: number; period: { start: string | null; end: string | null }; rows: PreviewRow[];
  format: string; skipped_rows: { line: number; reason: string }[];
  pending: { added: number; settled: number; expired: { id: number; date: string; description: string; amount_cents: number; merchant: string | null }[] };
  gaps: (Gap & { account: string })[]; next_export_from: { account: string; date: string | null }[];
}
interface Gap { from: string; to: string; missing_cents: number | null }
interface Coverage {
  account_id: number; account: string; segments: { start: string; end: string }[]; gaps: Gap[];
  covered_to: string | null; next_export_from: string | null;
}
interface ImportRow {
  id: number; source: string; label: string | null; account: string | null; period_start: string | null; period_end: string | null;
  inserted: number; skipped: number; created_at: string; tx_count: number;
}

const STATUS_LABEL = {
  new: 'New', duplicate: 'Already imported', possible_duplicate: 'Possible duplicate', invalid: 'Unreadable',
  pending: 'Pending', still_pending: 'Already imported (still pending)', settles: 'Settles a pending transaction',
};
/** Rows the import adds or changes. */
const ACTIVE = new Set<PreviewRow['status']>(['new', 'pending', 'settles']);

export default function Import({ meta }: { meta: Meta | null }) {
  const imports = useApi<ImportRow[]>('/imports');
  const run = useAction();

  const undo = (i: ImportRow) => {
    if (!confirm(i.tx_count ? `Undo "${i.label ?? 'import'}"? This deletes its ${i.tx_count} transactions.` : `Remove "${i.label ?? 'import'}" from the history? It added no transactions.`)) return;
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

      <CoveragePanel />

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
    }, (r) => `Imported ${r.inserted + r.pending.added} transactions into ${r.account}${r.pending.settled ? `, settled ${r.pending.settled} pending` : ''}${r.uncategorized ? ` — ${r.uncategorized} need a category` : ''}`);
    if (r) { setFile(null); setPreview(null); }
  };

  const shown = preview?.rows.slice(0, 200) ?? [];
  const changes = preview ? preview.inserted + preview.pending.added + preview.pending.settled + preview.pending.expired.length
    + (includePossible ? preview.possible_duplicates : 0) : 0;

  return (
    <section className="panel">
      <div className="panel-head"><h2 className="row" style={{ gap: 8 }}><FileUp size={16} style={{ color: 'var(--accent)' }} />CSV export</h2></div>
      <div className="panel-body stack">
        <p className="ink-2">In Bankwest Online Banking, export one account or all of them as CSV: rows go to the account with their account number. Exact amounts, nothing for AI to misread, and you can do it mid-month to keep the dashboard current.</p>
        <div className="grid-2">
          <label className="field">
            <span>Account <span className="muted">(for an account number not seen before)</span></span>
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
              {preview.pending.added > 0 && <span className="badge" title="Card purchases the bank hasn't settled yet. They count now, and a later import settles them"><i className="status-dot status-pending" />{preview.pending.added} pending</span>}
              {preview.pending.settled > 0 && <span className="badge"><i className="status-dot status-settles" />{preview.pending.settled} settle pending ones</span>}
              {preview.accounts.length > 1 && <span className="muted">{preview.accounts.map((a) => `${a.account}: ${a.new} new`).join(' · ')}</span>}
              {preview.period.start && <span className="muted">{dateLabel(preview.period.start, true)} – {dateLabel(preview.period.end!, true)}</span>}
            </div>
            {preview.gaps.map((g) => (
              <div key={`${g.account}-${g.from}`} className="notice warn">
                <CalendarX size={16} />
                <span>{g.account}: <GapText gap={g} />. Export from {dateLabel(g.from, true)} to fill it.</span>
              </div>
            ))}
            {preview.pending.expired.length > 0 && (
              <p className="muted" style={{ fontSize: 13 }}>
                {preview.pending.expired.length === 1 ? 'A pending purchase never settled and will be removed' : `${preview.pending.expired.length} pending purchases never settled and will be removed`}:{' '}
                {preview.pending.expired.map((e) => `${e.merchant ?? e.description} ${money(Math.abs(e.amount_cents))} (${dateLabel(e.date)})`).join(', ')}.
              </p>
            )}
            {preview.pending.added > 0 && preview.next_export_from.some((n) => n.date) && (
              <p className="muted" style={{ fontSize: 13 }}>
                So the pending ones settle, start the next export from{' '}
                {preview.next_export_from.filter((n) => n.date).map((n) => `${dateLabel(n.date!, true)}${preview.next_export_from.length > 1 ? ` (${n.account})` : ''}`).join(', ')}.
              </p>
            )}
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
                    <tr key={`${r.account}-${r.index}`} style={ACTIVE.has(r.status) ? undefined : { opacity: 0.6 }}>
                      <td className="num" style={{ whiteSpace: 'nowrap' }}>
                        <i className={`status-dot status-${r.status}`} title={STATUS_LABEL[r.status]} style={{ marginRight: 6 }} />
                        {r.date ? dateLabel(r.date) : '—'}
                      </td>
                      <td>
                        <div className="desc-main">{r.merchant ?? r.description}</div>
                        <div className={`desc-sub show-sm ${r.category ? '' : 'warn'}`}>{r.category ?? 'Uncategorised'}</div>
                        {preview.accounts.length > 1 && <div className="desc-sub">{r.account}</div>}
                        {r.status !== 'new' && <div className="desc-sub">{r.error ?? STATUS_LABEL[r.status]}</div>}
                      </td>
                      <td className={`hide-sm ${r.category ? 'ink-2' : 'warn'}`}>{r.category ?? 'Uncategorised'}</td>
                      <td className={`num ${r.amount_cents > 0 ? 'amount-in' : ''}`} style={{ whiteSpace: 'nowrap' }}>{Number.isFinite(r.amount_cents) ? `${r.amount_cents > 0 ? '+' : '−'}${money(Math.abs(r.amount_cents))}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.rows.length > shown.length && <p className="muted">Showing the first {shown.length} of {preview.rows.length} rows.</p>}
            <div className="row">
              <button className="btn btn-primary" onClick={commit} disabled={busy || changes === 0}>
                Import {changes} transaction{changes === 1 ? '' : 's'}
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

function GapText({ gap }: { gap: Gap }) {
  const range = gap.from === gap.to ? dateLabel(gap.from, true)
    : `${dateLabel(gap.from, gap.from.slice(0, 4) !== gap.to.slice(0, 4))} – ${dateLabel(gap.to, true)}`;
  if (gap.missing_cents == null) return <>{range} not imported <span className="muted">(no balances to check, so it may just have been quiet)</span></>;
  return <>{range} not imported: the balances say {money(Math.abs(gap.missing_cents))} {gap.missing_cents > 0 ? 'came in' : 'went out'} that isn't here</>;
}

const DAY = 86_400_000;
const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / DAY;

/** Each account's imported dates on one timeline, with gaps the balances can't account for flagged. */
function CoveragePanel() {
  const cov = useApi<Coverage[]>('/coverage');
  const list = cov.data ?? [];
  if (list.length === 0) return null;
  const first = Math.min(...list.flatMap((c) => c.segments.map((s) => dayNumber(s.start))));
  const last = Math.max(dayNumber(todayIso()), ...list.flatMap((c) => c.segments.map((s) => dayNumber(s.end))));
  const span = Math.max(1, last - first + 1);
  const pos = (from: string, to: string) => ({
    left: `${((dayNumber(from) - first) / span) * 100}%`,
    width: `${((dayNumber(to) - dayNumber(from) + 1) / span) * 100}%`,
  });
  const gapCount = list.reduce((n, c) => n + c.gaps.length, 0);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Coverage</h2>
        <span className="hint">{gapCount ? `${gapCount} gap${gapCount === 1 ? '' : 's'} between imports` : 'No gaps between imports'}</span>
      </div>
      <div className="panel-body stack">
        {list.map((c) => (
          <div key={c.account_id} className="coverage-row">
            <div>
              <div className="desc-main">{c.account}</div>
              {c.covered_to && <div className="desc-sub">Up to {dateLabel(c.covered_to, true)}</div>}
            </div>
            <div className="meter meter-sm coverage-track" role="img" aria-label={`${c.account}: imported ${c.segments.map((s) => `${dateLabel(s.start, true)} to ${dateLabel(s.end, true)}`).join(', ')}`}>
              {c.segments.map((s) => <span key={s.start} className="coverage-segment" style={pos(s.start, s.end)} />)}
              {c.gaps.map((g) => <span key={g.from} className={`coverage-gap ${g.missing_cents == null ? 'unchecked' : ''}`} style={pos(g.from, g.to)} />)}
            </div>
            {c.gaps.map((g) => (
              <div key={g.from} className={`coverage-note ${g.missing_cents == null ? 'warn' : 'bad'}`}><GapText gap={g} /></div>
            ))}
          </div>
        ))}
        <div className="coverage-row">
          <span />
          <div className="meter-legend" style={{ marginTop: -6 }}><span>{dateLabel(new Date(first * DAY).toISOString().slice(0, 10), true)}</span><span>Today</span></div>
        </div>
      </div>
    </section>
  );
}
