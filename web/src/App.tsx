import { ArrowDownToLine, LayoutDashboard, LineChart, ListOrdered, Monitor, Moon, PiggyBank, Repeat, Settings as SettingsIcon, Store, Sun, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { useApi, type Meta } from './api.ts';
import { MonthProvider, ToastProvider } from './components/ui.tsx';
import Budgets from './pages/Budgets.tsx';
import Dashboard from './pages/Dashboard.tsx';
import Import from './pages/Import.tsx';
import { PayeeDetailPage, PayeeListPage } from './pages/Payees.tsx';
import Recurring from './pages/Recurring.tsx';
import Settings from './pages/Settings.tsx';
import Transactions from './pages/Transactions.tsx';
import Trends from './pages/Trends.tsx';

type Theme = 'system' | 'light' | 'dark';

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try { return (localStorage.getItem('theme') as Theme) || 'system'; } catch { return 'system'; }
  });
  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('theme', theme); } catch { /* storage unavailable */ }
  }, [theme]);
  return [theme, setTheme];
}

export default function App() {
  const [theme, setTheme] = useTheme();
  const meta = useApi<Meta>('/meta');
  const uncategorized = meta.data?.overview.uncategorized ?? 0;

  const nav = [
    { to: '/', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/transactions', label: 'Transactions', icon: ListOrdered, count: uncategorized },
    { to: '/budgets', label: 'Budgets', icon: PiggyBank },
    { to: '/recurring', label: 'Recurring', icon: Repeat },
    { to: '/merchants', label: 'Merchants', icon: Store },
    { to: '/people', label: 'People', icon: Users },
    { to: '/trends', label: 'Trends', icon: LineChart },
    { to: '/import', label: 'Import', icon: ArrowDownToLine },
    { to: '/settings', label: 'Settings', icon: SettingsIcon },
  ];

  return (
    <ToastProvider>
      <MonthProvider>
        <div className="shell">
          <nav className="sidebar" aria-label="Main">
            <div className="brand">
              <div className="brand-mark" aria-hidden><PiggyBank size={16} /></div>
              <span>Budget</span>
            </div>
            {nav.map(({ to, label, icon: Icon, count }) => (
              <NavLink key={to} to={to} end={to === '/'} className="nav-link">
                <Icon size={17} aria-hidden />
                <span className="label">{label}</span>
                {count ? <span className="nav-count" title={`${count} uncategorised`}>{count}</span> : null}
              </NavLink>
            ))}
            <div className="sidebar-foot">
              <div className="theme-toggle" role="group" aria-label="Theme">
                {([['system', Monitor], ['light', Sun], ['dark', Moon]] as const).map(([t, Icon]) => (
                  <button key={t} aria-pressed={theme === t} onClick={() => setTheme(t)} aria-label={`${t} theme`} title={`${t[0].toUpperCase()}${t.slice(1)} theme`}>
                    <Icon size={14} />
                  </button>
                ))}
              </div>
              <span className="muted" style={{ fontSize: 12 }}>Stored locally on this Mac</span>
            </div>
          </nav>
          <main className="main">
            <Routes>
              <Route path="/" element={<Dashboard meta={meta.data} />} />
              <Route path="/transactions" element={<Transactions meta={meta.data} />} />
              <Route path="/budgets" element={<Budgets />} />
              <Route path="/recurring" element={<Recurring />} />
              <Route path="/merchants" element={<PayeeListPage key="merchant" kind="merchant" />} />
              <Route path="/merchants/:id" element={<PayeeDetailPage meta={meta.data} />} />
              <Route path="/people" element={<PayeeListPage key="person" kind="person" />} />
              <Route path="/people/:id" element={<PayeeDetailPage meta={meta.data} />} />
              <Route path="/trends" element={<Trends />} />
              <Route path="/import" element={<Import meta={meta.data} />} />
              <Route path="/settings" element={<Settings meta={meta.data} />} />
              <Route path="*" element={<Dashboard meta={meta.data} />} />
            </Routes>
          </main>
        </div>
      </MonthProvider>
    </ToastProvider>
  );
}
