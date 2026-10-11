import { useState } from 'react';
import {
  Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { money, moneyCompact, moneyWhole, monthLabel, monthShort } from '../format.ts';
import type { PayeeDetail, Summary, Trends } from '../types.ts';

const axis = { stroke: 'var(--chart-axis)', fontSize: 12, tickLine: false, axisLine: false } as const;

function Tip({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div className="chart-tip">
      <div className="t">{title}</div>
      {rows.map(([k, v]) => <div className="r" key={k}><span>{k}</span><b>{v}</b></div>)}
    </div>
  );
}

/** Running spend through the month against an even-spending line to the total budget. */
export function PaceChart({ s }: { s: Summary }) {
  const hasBudget = s.totals.budget_cents > 0;
  const [y, m] = s.month.split('-').map(Number);
  const dayLabel = (d: number) => new Date(y, m - 1, d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  return (
    <div>
      <div className="chart-legend" style={{ marginBottom: 8 }}>
        <span><i className="swatch line" style={{ background: 'var(--series-1)' }} />Spent so far</span>
        {hasBudget && <span><i className="swatch line" style={{ background: 'var(--chart-axis)' }} />Even pace to budget</span>}
      </div>
      <div style={{ height: 220 }} role="img" aria-label={`Cumulative spending for ${monthLabel(s.month)}`}>
        <ResponsiveContainer>
          <ComposedChart data={s.daily} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
            <XAxis dataKey="day" {...axis} interval="preserveStartEnd" minTickGap={24} tickFormatter={(d) => dayLabel(d)} />
            <YAxis {...axis} width={56} tickFormatter={moneyCompact} />
            <Tooltip
              cursor={{ stroke: 'var(--line-strong)' }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as Summary['daily'][number];
                const rows: [string, string][] = [['Spent that day', money(p.spent_cents)]];
                if (p.cumulative_cents != null) rows.push(['Spent so far', money(p.cumulative_cents)]);
                if (hasBudget) rows.push(['Even pace', money(p.pace_cents)]);
                return <Tip title={dayLabel(p.day)} rows={rows} />;
              }}
            />
            {s.is_current && s.elapsed_days > 0 && <ReferenceLine x={s.elapsed_days} stroke="var(--line-strong)" />}
            {hasBudget && <Line dataKey="pace_cents" stroke="var(--chart-axis)" strokeWidth={2} dot={false} activeDot={false} isAnimationActive={false} />}
            <Area
              dataKey="cumulative_cents" type="monotone" stroke="var(--series-1)" strokeWidth={2} fill="var(--series-1)" fillOpacity={0.1}
              connectNulls={false} dot={false} activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }} isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** Spending per month; the selected month is highlighted and clicking a bar selects it. */
export function MonthBars({ t, selected, onSelect }: { t: Trends; selected: string; onSelect: (m: string) => void }) {
  return (
    <div style={{ height: 220 }} role="img" aria-label="Spending by month">
      <ResponsiveContainer>
        <BarChart data={t.months} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="month" {...axis} tickFormatter={monthShort} />
          <YAxis {...axis} width={56} tickFormatter={moneyCompact} />
          <Tooltip
            cursor={{ fill: 'var(--surface-2)' }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as Trends['months'][number];
              const rows: [string, string][] = [['Spent', money(p.spent_cents)]];
              if (p.budget_cents) rows.push(['Budget', money(p.budget_cents)]);
              if (p.income_cents) rows.push(['Income', money(p.income_cents)]);
              return <Tip title={monthLabel(p.month)} rows={rows} />;
            }}
          />
          <Bar dataKey="spent_cents" maxBarSize={24} radius={[4, 4, 0, 0]} onClick={(d) => onSelect((d as unknown as { month: string }).month)} style={{ cursor: 'pointer' }} isAnimationActive={false}>
            {t.months.map((m) => <Cell key={m.month} fill={m.month === selected ? 'var(--series-1)' : 'var(--series-muted)'} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Income and spending side by side per month. */
export function IncomeSpendChart({ t }: { t: Trends }) {
  return (
    <div>
      <div className="chart-legend" style={{ marginBottom: 8 }}>
        <span><i className="swatch" style={{ background: 'var(--series-1)' }} />Spending</span>
        <span><i className="swatch" style={{ background: 'var(--series-2)' }} />Income</span>
        <span><i className="swatch line" style={{ background: 'var(--chart-axis)' }} />Budget</span>
      </div>
      <div style={{ height: 260 }} role="img" aria-label="Income and spending by month">
        <ResponsiveContainer>
          <ComposedChart data={t.months} margin={{ top: 6, right: 8, left: 0, bottom: 0 }} barGap={2}>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
            <XAxis dataKey="month" {...axis} tickFormatter={monthShort} />
            <YAxis {...axis} width={56} tickFormatter={moneyCompact} />
            <Tooltip
              cursor={{ fill: 'var(--surface-2)' }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as Trends['months'][number];
                return <Tip title={monthLabel(p.month)} rows={[
                  ['Spending', money(p.spent_cents)], ['Income', money(p.income_cents)],
                  ['Budget', p.budget_cents ? money(p.budget_cents) : '—'], ['Net', money(p.income_cents - p.spent_cents)],
                ]} />;
              }}
            />
            <Bar dataKey="spent_cents" fill="var(--series-1)" maxBarSize={20} radius={[4, 4, 0, 0]} isAnimationActive={false} />
            <Bar dataKey="income_cents" fill="var(--series-2)" maxBarSize={20} radius={[4, 4, 0, 0]} isAnimationActive={false} />
            <Line dataKey={(d: Trends['months'][number]) => d.budget_cents || null} type="stepAfter" stroke="var(--chart-axis)" strokeWidth={2} dot={false} activeDot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** Money to and from one merchant or person per month. */
export function PayeeMonthsChart({ months, outLabel, inLabel }: {
  months: PayeeDetail['months']; outLabel: string; inLabel: string;
}) {
  const hasIn = months.some((m) => m.in_cents > 0);
  return (
    <div>
      <div className="chart-legend" style={{ marginBottom: 8 }}>
        <span><i className="swatch" style={{ background: 'var(--series-1)' }} />{outLabel}</span>
        {hasIn && <span><i className="swatch" style={{ background: 'var(--series-2)' }} />{inLabel}</span>}
      </div>
      <div style={{ height: 220 }} role="img" aria-label={`${outLabel} by month`}>
        <ResponsiveContainer>
          <BarChart data={months} margin={{ top: 6, right: 8, left: 0, bottom: 0 }} barGap={2}>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
            <XAxis dataKey="month" {...axis} tickFormatter={monthShort} interval="preserveStartEnd" minTickGap={16} />
            <YAxis {...axis} width={56} tickFormatter={moneyCompact} />
            <Tooltip
              cursor={{ fill: 'var(--surface-2)' }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as PayeeDetail['months'][number];
                const rows: [string, string][] = [[outLabel, money(p.out_cents)]];
                if (hasIn) rows.push([inLabel, money(p.in_cents)]);
                rows.push(['Transactions', String(p.count)]);
                return <Tip title={monthLabel(p.month)} rows={rows} />;
              }}
            />
            <Bar dataKey="out_cents" fill="var(--series-1)" maxBarSize={20} radius={[4, 4, 0, 0]} isAnimationActive={false} />
            {hasIn && <Bar dataKey="in_cents" fill="var(--series-2)" maxBarSize={20} radius={[4, 4, 0, 0]} isAnimationActive={false} />}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** Colours for the seven biggest categories (fixed by category order, so a colour stays with its category); the rest share grey. */
export function categoryColors(categories: { id: number | null; sort: number; name: string; total_cents: number }[], slots = 7) {
  const top = categories.filter((c) => c.id != null && c.total_cents > 0)
    .sort((a, b) => b.total_cents - a.total_cents).slice(0, slots)
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  return new Map(top.map((c, i) => [c.id as number, `var(--cat-${i + 1})`]));
}

// Buckets take colours in bucket order: blue, green, orange, amber, then the rest of the categorical set.
const BUCKET_SLOTS = [1, 3, 2, 4, 5, 7, 6];
export const bucketColor = (index: number) => (index < BUCKET_SLOTS.length ? `var(--cat-${BUCKET_SLOTS[index]})` : 'var(--series-muted)');

type TrendCategory = Trends['categories'][number];

/**
 * Spending per month stacked by category: the coloured categories in their own segments, the rest as one grey
 * "Everything else". With `selected`, just that category, against its monthly average.
 */
export function CategoryTrendChart({ t, colors, selected }: { t: Trends; colors: Map<number, string>; selected: TrendCategory | null }) {
  const colored = t.categories.filter((c) => c.id != null && colors.has(c.id)).sort((a, b) => a.sort - b.sort);
  const rest = t.categories.filter((c) => c.id == null || !colors.has(c.id));
  const data = t.months.map((m) => {
    const row: Record<string, number | string> = { month: m.month };
    for (const c of colored) row[`c${c.id}`] = Math.max(c.values[m.month] ?? 0, 0);
    row.rest = rest.reduce((s, c) => s + Math.max(c.values[m.month] ?? 0, 0), 0);
    if (selected) row.sel = selected.values[m.month] ?? 0;
    return row;
  });
  const color = selected ? (selected.id != null && colors.get(selected.id)) || 'var(--series-1)' : '';
  const series = [...colored.map((c) => ({ key: `c${c.id}`, name: c.name, color: colors.get(c.id!)! })),
    ...(rest.length ? [{ key: 'rest', name: 'Everything else', color: 'var(--series-muted)' }] : [])];

  return (
    <div style={{ height: 280 }} role="img" aria-label={selected ? `${selected.name} spending by month` : 'Spending by month, by category'}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="month" {...axis} tickFormatter={monthShort} interval="preserveStartEnd" minTickGap={12} />
          <YAxis {...axis} width={56} tickFormatter={moneyCompact} />
          <Tooltip
            cursor={{ fill: 'var(--surface-2)' }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const row = payload[0].payload as Record<string, number> & { month: string };
              if (selected) return <Tip title={`${selected.name}, ${monthLabel(row.month)}`} rows={[['Spent', money(row.sel)], ['Monthly average', money(selected.average_cents)]]} />;
              const rows = series.filter((x) => row[x.key]).sort((a, b) => row[b.key] - row[a.key]).map((x) => [x.name, money(row[x.key])] as [string, string]);
              return <Tip title={monthLabel(row.month)} rows={[...rows, ['Total', money(series.reduce((s, x) => s + row[x.key], 0))]]} />;
            }}
          />
          {selected ? (
            <>
              <Bar dataKey="sel" fill={color} maxBarSize={28} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              <ReferenceLine y={selected.average_cents} stroke="var(--chart-axis)" strokeDasharray="4 4" strokeWidth={2} />
            </>
          ) : series.map((x, i) => (
            <Bar key={x.key} dataKey={x.key} stackId="s" fill={x.color} stroke="var(--surface)" strokeWidth={2} maxBarSize={28}
              radius={i === series.length - 1 ? [4, 4, 0, 0] : undefined} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface Slice { key: string; name: string; cents: number; color: string; members?: string[] }

/** Share of a total by category. Slices keep a 2px surface gap; the legend carries names and values. */
export function CategoryDonut({ slices, centerLabel }: { slices: Slice[]; centerLabel: string }) {
  const [active, setActive] = useState<string | null>(null);
  const total = slices.reduce((s, x) => s + x.cents, 0);
  const pctOf = (c: number) => (total ? Math.round((c / total) * 100) : 0);
  const pctLabel = (c: number) => (c > 0 && pctOf(c) === 0 ? '<1%' : `${pctOf(c)}%`);
  return (
    <div className="donut">
      <div className="donut-chart" role="img" aria-label={`${centerLabel}: ${slices.map((s) => `${s.name} ${pctLabel(s.cents)}`).join(', ')}`}>
        <ResponsiveContainer>
          <PieChart>
            <Pie
              data={slices} dataKey="cents" nameKey="name" innerRadius="62%" outerRadius="100%" startAngle={90} endAngle={-270}
              stroke="var(--surface)" strokeWidth={2} isAnimationActive={false}
              onMouseEnter={(_, i) => setActive(slices[i]?.key ?? null)} onMouseLeave={() => setActive(null)}
            >
              {slices.map((s) => <Cell key={s.key} fill={s.color} opacity={active && active !== s.key ? 0.45 : 1} />)}
            </Pie>
            <Tooltip content={({ active: on, payload }) => {
              if (!on || !payload?.length) return null;
              const s = payload[0].payload as Slice;
              return <Tip title={s.name} rows={[['Amount', money(s.cents)], ['Share', pctLabel(s.cents)], ...(s.members?.length ? [['Includes', s.members.join(', ')] as [string, string]] : [])]} />;
            }} />
          </PieChart>
        </ResponsiveContainer>
        <div className="donut-center"><b>{moneyWhole(total)}</b><span>{centerLabel}</span></div>
      </div>
      <div className="donut-legend">
        {slices.map((s) => (
          <div key={s.key} className={`item ${active === s.key ? 'hover' : ''}`} onMouseEnter={() => setActive(s.key)} onMouseLeave={() => setActive(null)}
            title={s.members?.length ? `Includes ${s.members.join(', ')}` : undefined}>
            <i className="swatch" style={{ background: s.color }} />
            <span className="nm">{s.name}{s.members?.length ? <span className="muted"> ({s.members.length})</span> : null}</span>
            <span className="num">{money(s.cents)}</span>
            <span className="pc num">{pctLabel(s.cents)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
