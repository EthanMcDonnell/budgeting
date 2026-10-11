import { ChevronLeft, ChevronRight, Copy, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Category, CategoryKind } from '../api.ts';
import { addMonths, monthLabel, thisMonth } from '../format.ts';

// ---------- selected month, shared across pages ----------

const MonthContext = createContext<{ month: string; setMonth: (m: string) => void }>({ month: thisMonth(), setMonth: () => {} });

export function MonthProvider({ children }: { children: ReactNode }) {
  const initial = new URLSearchParams(location.search).get('m');
  const [month, setMonthState] = useState(initial && /^\d{4}-\d{2}$/.test(initial) ? initial : thisMonth());
  const setMonth = useCallback((m: string) => {
    setMonthState(m);
    const url = new URL(location.href);
    if (m === thisMonth()) url.searchParams.delete('m'); else url.searchParams.set('m', m);
    history.replaceState(history.state, '', url);
  }, []);
  return <MonthContext.Provider value={{ month, setMonth }}>{children}</MonthContext.Provider>;
}

export const useMonth = () => useContext(MonthContext);

export function MonthPicker() {
  const { month, setMonth } = useMonth();
  const current = thisMonth();
  return (
    <div className="month-picker" role="group" aria-label="Month">
      <button className="btn btn-ghost btn-icon" onClick={() => setMonth(addMonths(month, -1))} aria-label="Previous month">
        <ChevronLeft size={16} />
      </button>
      <span className="label" aria-live="polite">{monthLabel(month)}</span>
      <button className="btn btn-ghost btn-icon" onClick={() => setMonth(addMonths(month, 1))} aria-label="Next month">
        <ChevronRight size={16} />
      </button>
      {month !== current && (
        <button className="btn btn-ghost btn-sm" onClick={() => setMonth(current)} style={{ marginRight: 2 }}>
          This month
        </button>
      )}
    </div>
  );
}

// ---------- budget meter with a pace tick ----------

export function meterState(spent: number, budget: number, expected: number | null): 'ok' | 'warn' | 'bad' {
  if (budget <= 0) return spent > 0 ? 'bad' : 'ok';
  if (spent > budget) return 'bad';
  if (expected != null && spent > expected * 1.05 && spent > 0) return 'warn';
  return 'ok';
}

/**
 * Spending against a budget. `reserved` (money already spoken for, like recurring payments still due) shows as a
 * dashed stretch after the fill, red when it would take spending over.
 */
export function Meter({ spent, budget, pace, small, label, state: given, reserved = 0, reservedTitle }: {
  spent: number; budget: number; pace: number | null; small?: boolean; label: string; state?: 'ok' | 'warn' | 'bad';
  reserved?: number; reservedTitle?: string;
}) {
  const ratio = budget > 0 ? spent / budget : spent > 0 ? 1 : 0;
  const state = given ?? meterState(spent, budget, pace == null ? null : budget * pace);
  const from = Math.min(Math.max(ratio, 0), 1) * 100;
  const to = budget > 0 ? Math.min((Math.max(spent, 0) + reserved) / budget, 1) * 100 : from;
  return (
    <div
      className={`meter ${small ? 'meter-sm' : ''}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.max(budget, 1)}
      aria-valuenow={Math.min(spent, Math.max(budget, 1))}
    >
      <div className={`meter-fill ${state === 'ok' ? '' : state}`} style={{ width: `${Math.min(ratio, 1) * 100}%` }} />
      {reserved > 0 && to > from && (
        <div className={`meter-reserved ${Math.max(spent, 0) + reserved > budget ? 'over' : ''}`} style={{ left: `${from}%`, width: `${to - from}%` }} title={reservedTitle} />
      )}
      {pace != null && pace > 0 && pace < 1 && <div className="meter-tick" style={{ left: `${pace * 100}%` }} title="Where you'd be spending evenly" />}
    </div>
  );
}

// ---------- modal ----------

export function Modal({ title, open, onClose, children, footer }: {
  title: string; open: boolean; onClose: () => void; children: ReactNode; footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="modal" onClose={onClose} onCancel={onClose}>
      {open && (
        <>
          <div className="modal-head">
            <h2>{title}</h2>
            <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Close"><X size={16} /></button>
          </div>
          <div className="modal-body">{children}</div>
          {footer && <div className="modal-foot">{footer}</div>}
        </>
      )}
    </dialog>
  );
}

// ---------- category select, grouped by kind ----------

const KIND_LABEL: Record<CategoryKind, string> = { expense: 'Spending', income: 'Income', transfer: 'Transfers (not counted)' };

export function CategorySelect({ categories, value, onChange, allowNone = true, noneLabel = 'Uncategorised', className = '', ...rest }: {
  categories: Category[]; value: number | null; onChange: (id: number | null) => void;
  allowNone?: boolean; noneLabel?: string; className?: string; 'aria-label'?: string; id?: string;
}) {
  const groups = (['expense', 'income', 'transfer'] as const).map((k) => [k, categories.filter((c) => c.kind === k && (!c.archived || c.id === value))] as const);
  return (
    <select
      className={`select ${className}`}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      {...rest}
    >
      {allowNone && <option value="">{noneLabel}</option>}
      {groups.map(([kind, cats]) => cats.length > 0 && (
        <optgroup key={kind} label={KIND_LABEL[kind]}>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

// ---------- toast ----------

const ToastContext = createContext<(msg: string, kind?: 'info' | 'error') => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ msg: string; kind: 'info' | 'error'; id: number } | null>(null);
  const show = useCallback((msg: string, kind: 'info' | 'error' = 'info') => setToast({ msg, kind, id: Date.now() }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.kind === 'error' ? 6000 : 3200);
    return () => clearTimeout(t);
  }, [toast]);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div aria-live="polite">{toast && <div className={`toast ${toast.kind === 'error' ? 'error' : ''}`}>{toast.msg}</div>}</div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/** Runs an async action, toasting errors (and an optional success message). */
export function useAction() {
  const toast = useToast();
  return useCallback(async <T,>(fn: () => Promise<T>, success?: string | ((r: T) => string)) => {
    try {
      const r = await fn();
      if (success) toast(typeof success === 'function' ? success(r) : success);
      return r;
    } catch (e) {
      toast((e as Error).message, 'error');
      return undefined;
    }
  }, [toast]);
}

// ---------- misc ----------

export function CopyBlock({ text }: { text: string }) {
  const toast = useToast();
  return (
    <div className="code">
      {text}
      <button className="btn btn-sm btn-icon copy" aria-label="Copy" onClick={() => navigator.clipboard.writeText(text).then(() => toast('Copied'))}>
        <Copy size={14} />
      </button>
    </div>
  );
}

export function ErrorNotice({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="notice error" role="alert">{error}</div>;
}
