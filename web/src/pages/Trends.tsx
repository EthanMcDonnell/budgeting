import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../api.ts';
import { CategoryTrendChart, IncomeSpendChart, categoryColors } from '../components/charts.tsx';
import { ErrorNotice, useMonth } from '../components/ui.tsx';
import { money, moneyWhole, monthLabel, monthShort, pct, thisMonth } from '../format.ts';
import type { Trends as TrendsData } from '../types.ts';

export default function Trends() {
  const [months, setMonths] = useState(12);
  const { setMonth } = useMonth();
  const data = useApi<TrendsData>(`/trends?months=${months}&end=${thisMonth()}`);
  const t = data.data;

  const n = t?.averaged_months.length ?? 0;
  const avgSpent = t?.average_spent_cents ?? 0;
  const avgIncome = t?.average_income_cents ?? 0;
  const [selected, setSelected] = useState<string | null>(null);
  const sel = t?.categories.find((c) => c.name === selected) ?? null;
  const colors = useMemo(() => (t ? categoryColors(t.categories) : new Map<number, string>()), [t]);
  // Legend in stack order: coloured categories, then the grey rest.
  const legend = useMemo(() => {
    if (!t) return [];
    const colored = t.categories.filter((c) => c.id != null && colors.has(c.id)).sort((a, b) => a.sort - b.sort);
    const items: { key: string; name: string; color: string; cat: typeof colored[number] | null }[] =
      colored.map((c) => ({ key: String(c.id), name: c.name, color: colors.get(c.id!)!, cat: c }));
    if (t.categories.length > colored.length) items.push({ key: 'rest', name: 'Everything else', color: 'var(--series-muted)', cat: null });
    return items;
  }, [t, colors]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Trends</h1>
          {t && n > 0 && (
            <p className="sub">
              Averaging {moneyWhole(avgSpent)} spent and {moneyWhole(avgIncome)} earned a month
              {avgIncome > 0 ? ` — about ${pct(Math.max(avgIncome - avgSpent, 0), avgIncome)}% saved` : ''}, over {n} {t.averaged_months.at(-1)! < thisMonth() ? 'complete ' : ''}month{n === 1 ? '' : 's'}.
            </p>
          )}
        </div>
        <div className="segmented" role="group" aria-label="Range">
          {[6, 12, 24].map((n) => <button key={n} aria-pressed={months === n} onClick={() => setMonths(n)}>{n} months</button>)}
        </div>
      </div>
      <ErrorNotice error={data.error} />

      {t && (
        <>
          <section className="panel">
            <div className="panel-head"><h2>Income and spending</h2></div>
            <div className="panel-body"><IncomeSpendChart t={t} /></div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>By category</h2>
              <span className="hint">{sel ? <>Just {sel.name}, against its {moneyWhole(sel.average_cents)} monthly average. <button className="link-btn" onClick={() => setSelected(null)}>Show all</button></> : 'Pick a category to see it on its own.'}</span>
            </div>
            <div className="panel-body stack">
              {t.categories.length === 0 ? (
                <div className="empty"><strong>No spending yet</strong></div>
              ) : (
                <>
                  <div className="chart-legend" role="group" aria-label="Categories">
                    {legend.map((c) => (
                      <button key={c.key} className={`legend-btn ${sel && sel.name === c.name ? 'active' : ''} ${sel && sel.name !== c.name ? 'dim' : ''}`}
                        aria-pressed={sel?.name === c.name} disabled={!c.cat}
                        onClick={() => c.cat && setSelected(sel?.name === c.name ? null : c.cat.name)}>
                        <i className="swatch" style={{ background: c.color }} />{c.name}
                      </button>
                    ))}
                  </div>
                  <CategoryTrendChart t={t} colors={colors} selected={sel} />
                </>
              )}
            </div>
            {t.categories.length > 0 && (
              <div className="table-wrap">
                <table className="table cat-trend">
                  <thead>
                    <tr>
                      <th style={{ position: 'sticky', left: 0, zIndex: 1 }}>Category</th>
                      {t.months.map((m) => (
                        <th key={m.month} className="month">
                          <Link to="/" onClick={() => setMonth(m.month)} title={`Open ${monthLabel(m.month)}`} style={{ color: 'inherit' }}>
                            {monthShort(m.month)}{m.month.endsWith('-01') ? ` ’${m.month.slice(2, 4)}` : ''}
                          </Link>
                        </th>
                      ))}
                      <th className="num">Avg</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.categories.map((c) => {
                      const color = c.id != null ? colors.get(c.id) : undefined;
                      return (
                        <tr key={c.name} className={`clickable ${sel?.name === c.name ? 'selected' : ''}`} onClick={() => setSelected(sel?.name === c.name ? null : c.name)}
                          aria-selected={sel?.name === c.name}>
                          <td className="cat"><i className="swatch" style={{ background: color ?? 'var(--series-muted)', marginRight: 8 }} />{c.name}</td>
                          {t.months.map((m) => {
                            const v = c.values[m.month] ?? 0;
                            return <td key={m.month} className={`cell ${v ? '' : 'zero'}`} title={`${c.name}, ${monthLabel(m.month)}: ${money(v)}`}>{v ? moneyWhole(v) : '–'}</td>;
                          })}
                          <td className="num" style={{ fontWeight: 600 }}>{moneyWhole(c.average_cents)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td className="cat">Total spending</td>
                      {t.months.map((m) => <td key={m.month} className="num">{m.spent_cents ? moneyWhole(m.spent_cents) : '–'}</td>)}
                      <td className="num">{moneyWhole(avgSpent)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
