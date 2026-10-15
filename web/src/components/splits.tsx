import { AlertTriangle, Check, CheckCircle2, Plus, Sparkles, Trash2, Users, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useApi, type Transaction } from '../api.ts';
import { dateLabel, money } from '../format.ts';
import { payeeHref } from '../pages/Payees.tsx';
import type { PayeeList, PaybackSuggestion, Split, SplitShare } from '../types.ts';
import { ErrorNotice, Modal, useAction } from './ui.tsx';

const purchaseName = (p: { merchant: string | null; description: string }) => p.merchant ?? p.description;

/** "Split 2 ways · $64.75 each", or for different amounts "Split 6 ways · $90.52 from 5 people · your part $15.88". */
function splitLabel(g: PaybackSuggestion) {
  if (g.purchase.split_id) return `Split ${g.ways} ways · waiting on ${[...new Set(g.payments.map((p) => p.person))].join(', ')}`;
  if (!g.uneven) return `Split ${g.ways} ways · ${money(g.share_cents)} each`;
  const sent = g.payments.reduce((t, p) => t + p.amount_cents, 0);
  const people = new Set(g.payments.map((p) => p.payee_id)).size;
  const waiting = Math.max(g.ways - 1 - people, 0) * g.share_cents;
  return `Split ${g.ways} ways · ${money(sent)} from ${people} ${people === 1 ? 'person' : 'people'} · your part ${money(g.purchase.amount_cents - sent - waiting)}`;
}

/** "Owes $20" / "Paid" / "Settled" for one person's share, coloured and with an icon so it isn't colour alone. */
export function ShareStatus({ s, name = true }: { s: SplitShare; name?: boolean }) {
  const who = name ? `${s.person ?? 'Someone'} ` : '';
  if (s.status === 'paid') return <span className="row good" style={{ gap: 4 }}><CheckCircle2 size={12} />{who}paid {money(s.paid_cents)}</span>;
  if (s.status === 'settled') return <span className="row muted" style={{ gap: 4 }}><Check size={12} />{who}settled</span>;
  return (
    <span className={`row ${s.status === 'partial' ? 'warn' : 'bad'}`} style={{ gap: 4, whiteSpace: 'nowrap' }}>
      <AlertTriangle size={12} />{who}owes {money(s.outstanding_cents)}{s.status === 'partial' && <span className="muted"> of {money(s.amount_cents)}</span>}
    </span>
  );
}

/**
 * Money in from people that looks like their share of something you paid for, with one click to confirm
 * (split the purchase and link the payments) or dismiss.
 */
export function PaybackSuggestions({ suggestions, hint }: { suggestions: PaybackSuggestion[]; hint?: string }) {
  const run = useAction();
  const [all, setAll] = useState(false);
  if (suggestions.length === 0) return null;
  const likely = suggestions.filter((g) => g.confidence === 'high');
  const shown = all ? suggestions : suggestions.slice(0, 6);

  const confirm = (g: PaybackSuggestion) => api('/splits/confirm', { body: {
    purchase_id: g.purchase.id, ways: g.ways, payment_ids: g.payments.map((p) => p.id),
    people: g.payments.filter((p) => p.unlinked).map((p) => ({ payment_id: p.id, person: p.person })),
  } });
  const dismiss = (g: PaybackSuggestion) => run(
    () => Promise.all(g.payments.map((p) => api(`/paybacks/${p.id}/not-payback`, { method: 'PUT', body: { not_payback: true } }))),
    `Won't suggest ${g.payments.length === 1 ? 'that payment' : 'those payments'} again`,
  );
  const confirmLikely = () => run(async () => { for (const g of likely) await confirm(g); }, `Linked ${likely.length} paybacks`);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Paybacks to check</h2>
        <span className="hint">{hint ?? 'Money from people that matches a share of something you paid for'}</span>
        {likely.length > 1 && <button className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={confirmLikely}><Check size={13} />Confirm {likely.length} likely</button>}
      </div>
      <div className="suggest-list">
        {shown.map((g) => (
          <div key={`${g.purchase.id}:${g.ways}`} className="suggest">
            <div className="suggest-main">
              <div className="row" style={{ gap: 8 }}>
                <b>{purchaseName(g.purchase)}</b>
                <span className="num">{money(g.purchase.amount_cents)}</span>
                <span className="muted">{dateLabel(g.purchase.date, true)}</span>
                <span className={`badge ${g.confidence === 'high' ? 'badge-good' : ''}`}>{g.confidence === 'high' ? 'Likely' : 'Check'}</span>
              </div>
              <div className="desc-sub">
                {splitLabel(g)}
                {g.purchase.category && <> · {g.purchase.category}</>}
                {g.reasons.length > 0 && <> · {g.reasons.join(', ')}</>}
              </div>
              {g.reviews.map((r) => (
                <div key={r.payment_id} className="review-note">
                  <Sparkles size={12} aria-hidden /><span><b>Claude{g.reviews.length > 1 ? ` on ${r.person}` : ''}{r.verdict === 'unsure' ? ' (unsure)' : ''}:</b> {r.note}</span>
                </div>
              ))}
              <div className="suggest-pays">
                {g.payments.map((p) => (
                  <span key={p.id} className="badge" title={[p.unlinked && `Not linked to ${p.person} yet (their name is in the bank text); confirming links it`, p.memo && `“${p.memo}”`, p.notes, p.description].filter(Boolean).join('\n')}>
                    <Link to={payeeHref(p.payee_id, 'person')} className="plain-link">{p.person}</Link>
                    <span className="amount-in num">+{money(p.amount_cents)}</span>
                    <span className="muted">{dateLabel(p.date)}</span>
                  </span>
                ))}
              </div>
            </div>
            <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
              <button className="btn btn-sm btn-primary" onClick={() => run(() => confirm(g), `Linked to ${purchaseName(g.purchase)}`)}>Confirm</button>
              <button className="btn btn-sm btn-ghost" onClick={() => dismiss(g)} title="Not a payback (a gift, a sale…)">Not a payback</button>
            </div>
          </div>
        ))}
      </div>
      {suggestions.length > shown.length && (
        <div className="panel-body" style={{ paddingTop: 0 }}><button className="link-btn" onClick={() => setAll(true)}>Show all {suggestions.length}</button></div>
      )}
    </section>
  );
}

/** Shared purchases and where each person's share stands. With `payee`, focuses on that person's share. */
export function SharedCosts({ splits, payee, title = 'Shared costs', hint, empty }: {
  splits: Split[]; payee?: number; title?: string; hint?: string; empty?: string;
}) {
  const run = useAction();
  const settle = (s: SplitShare, settled: boolean) =>
    run(() => api(`/shares/${s.id}/settled`, { method: 'PUT', body: { settled } }), settled ? 'Marked as settled' : 'Reopened');
  if (splits.length === 0 && !empty) return null;

  return (
    <section className="panel">
      <div className="panel-head"><h2>{title}</h2>{hint && <span className="hint">{hint}</span>}</div>
      {splits.length === 0 ? <div className="panel-body muted" style={{ fontSize: 13 }}>{empty}</div> : (
        <div className="table-wrap">
          <table className="table shared-table">
            <thead>
              <tr>
                <th className="hide-sm">Date</th><th>Purchase</th><th className="num">Total</th><th className="num hide-sm">Your part</th>
                <th>{payee ? 'Their share' : 'Who owes'}</th><th style={{ width: 1 }}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {splits.map((s) => {
                const shares = payee ? s.shares.filter((x) => x.payee_id === payee) : s.shares.filter((x) => x.outstanding_cents > 0 || x.status === 'partial');
                const open = shares.filter((x) => x.outstanding_cents > 0);
                return (
                  <tr key={s.id}>
                    <td className="num hide-sm" style={{ whiteSpace: 'nowrap' }}>{dateLabel(s.date, true)}</td>
                    <td className="sc-desc">
                      <div className="desc-main">{purchaseName(s)}</div>
                      <div className="desc-sub"><span className="show-sm">{dateLabel(s.date, true)} · </span>Split {s.ways} ways{s.category && ` · ${s.category}`}{s.notes && ` · ${s.notes}`}</div>
                    </td>
                    <td className="num sc-total">{money(s.amount_cents)}</td>
                    <td className="num ink-2 hide-sm">{money(s.your_share_cents)}</td>
                    <td className="sc-owes">
                      <div className="stack" style={{ gap: 2, fontSize: 13 }}>
                        {shares.map((x) => (
                          <span key={x.id} className="row" style={{ gap: 6 }}>
                            <ShareStatus s={x} name={!payee} />
                            {payee && <span className="muted">of {money(x.amount_cents)}</span>}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="sc-act">
                      {open.length > 0 && (
                        <button className="btn btn-sm btn-ghost" title="Paid in cash, or let it go" onClick={() => Promise.all(open.map((x) => settle(x, true)))}>Settled</button>
                      )}
                      {payee && shares.some((x) => x.status === 'settled') && (
                        <button className="btn btn-sm btn-ghost" onClick={() => Promise.all(shares.map((x) => settle(x, false)))}>Reopen</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Split a purchase with people: how many ways, and who (amounts optional, blank = even). */
export function SplitEditor({ tx, onClose }: { tx: Transaction; onClose: () => void }) {
  const run = useAction();
  const existing = useApi<Split | null>(`/transactions/${tx.id}/split`);
  const payees = useApi<PayeeList>('/payees?kind=person');
  const [ways, setWays] = useState(2);
  const [people, setPeople] = useState<{ name: string; amount: string }[]>([{ name: '', amount: '' }]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const total = -tx.amount_cents;

  useEffect(() => {
    if (loaded || existing.loading) return;
    const s = existing.data;
    if (s) {
      setWays(s.ways);
      setPeople(s.shares.filter((x) => x.person).map((x) => ({ name: x.person!, amount: (x.amount_cents / 100).toFixed(2) })));
    }
    setLoaded(true);
  }, [existing, loaded]);

  const even = Math.round(total / Math.max(ways, 1));
  const named = people.filter((p) => p.name.trim());
  const shareSum = named.reduce((t, p) => t + (p.amount ? Math.round(Number(p.amount) * 100) : even), 0) + Math.max(ways - 1 - named.length, 0) * even;

  const save = async () => {
    if (named.length > ways - 1) return setError(`${named.length} people plus you is more than ${ways} ways`);
    if (named.some((p) => p.amount && !(Number(p.amount) > 0))) return setError('Amounts must be more than zero');
    const ok = await run(() => api('/splits', { body: {
      transaction_id: tx.id, ways,
      shares: named.map((p) => ({ person: p.name.trim(), amount: p.amount ? Number(p.amount) : null })),
    } }), 'Split saved');
    if (ok) onClose();
  };
  const remove = async () => {
    if (!existing.data || !confirm('Stop splitting this? Linked paybacks are unlinked (the transactions stay).')) return;
    if (await run(() => api(`/splits/${existing.data!.id}`, { method: 'DELETE' }), 'Split removed')) onClose();
  };

  return (
    <Modal title={`Split ${tx.merchant ?? tx.description}`} open onClose={onClose}
      footer={<>
        {existing.data && <button className="btn btn-danger" style={{ marginRight: 'auto' }} onClick={remove}><Trash2 size={14} />Remove split</button>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save}>Save</button>
      </>}>
      <ErrorNotice error={error} />
      <p className="muted" style={{ fontSize: 13, margin: 0 }}>
        {money(total)} on {dateLabel(tx.date, true)}. Each person's share stays flagged until they pay you. A payment from them of about that amount, any time from this date on, shows up under Paybacks to check on the People page for you to confirm. Confirmed paybacks are filed under this purchase's category, so it nets down to your part.
      </p>
      <label className="field">
        <span>Split between (you included)</span>
        <input className="input num" type="number" min={2} max={50} value={ways} onChange={(e) => setWays(Math.max(2, Number(e.target.value) || 2))} style={{ width: 100 }} />
      </label>
      <div className="field">
        <span>Who owes you</span>
        <datalist id="people-names">{(payees.data?.payees ?? []).map((p) => <option key={p.id} value={p.name} />)}</datalist>
        {people.map((p, i) => (
          <div key={i} className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
            <input className="input grow" list="people-names" placeholder="Name" value={p.name} aria-label={`Person ${i + 1}`}
              onChange={(e) => setPeople(people.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
            <input className="input num" inputMode="decimal" placeholder={(even / 100).toFixed(2)} value={p.amount} style={{ width: 110 }} aria-label={`Amount for person ${i + 1}`}
              onChange={(e) => setPeople(people.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
            <button className="btn btn-ghost btn-icon btn-sm" aria-label="Remove person" onClick={() => setPeople(people.filter((_, j) => j !== i))}><X size={14} /></button>
          </div>
        ))}
        <button className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => { setPeople([...people, { name: '', amount: '' }]); if (named.length + 1 >= ways) setWays(named.length + 2); }}>
          <Plus size={13} />Add person
        </button>
        <span className="muted" style={{ fontSize: 12.5 }}>
          Leave an amount blank for an even share. {ways - 1 - named.length > 0 && `${ways - 1 - named.length} more ${ways - 1 - named.length === 1 ? 'share is' : 'shares are'} kept for whoever pays next. `}
          Your part: <b style={{ color: "var(--ink)" }}>{money(total - shareSum)}</b>
        </span>
      </div>
    </Modal>
  );
}

/** Small marker next to a transaction that's split or pays one back. */
export function SplitMark({ t }: { t: Transaction }) {
  if (t.split_id != null && t.split_owed_cents) {
    return <span className="split-mark warn" title={`Split ${t.split_ways} ways · waiting on ${money(t.split_owed_cents)}`}><Users size={11} />waiting on {money(t.split_owed_cents)}</span>;
  }
  if (t.split_id != null) return <span className="split-mark" title={`Split ${t.split_ways} ways`}><Users size={11} />{t.split_ways} ways</span>;
  if (t.payback_split_id != null) return <span className="split-mark" title={`Pays back their share of ${t.payback_for}`}><Users size={11} />for {t.payback_for}</span>;
  return null;
}
