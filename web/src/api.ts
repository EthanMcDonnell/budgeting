import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

export type CategoryKind = 'expense' | 'income' | 'transfer';
export interface Category { id: number; name: string; kind: CategoryKind; sort: number; archived: number; bucket_id: number | null }
export type BucketKind = 'spend' | 'save';
export interface Bucket {
  id: number; name: string; kind: BucketKind; percent: number | null; amount_cents: number | null; sort: number;
  /** 1 = the target is what its recurring payments come to each month. */
  follows_recurring: number;
  /** 1 = gives or takes the month-to-month difference in buckets that follow recurring payments. */
  balances: number;
}
export interface Account { id: number; name: string; institution: string; type: string; number: string | null; tx_count: number }
export interface Meta {
  accounts: Account[];
  categories: Category[];
  buckets: Bucket[];
  overview: { transaction_count: number; first_date: string | null; last_date: string | null; uncategorized: number; months: string[] };
  db_path: string;
}
export type PayeeKind = 'merchant' | 'person';
/** `merchant` is the linked payee's friendly name (a shop or a person); `description` is the bank's text. */
export interface Transaction {
  id: number; account_id: number; account: string; date: string; description: string;
  merchant: string | null; payee_id: number | null; payee_kind: PayeeKind | null;
  amount_cents: number; balance_cents: number | null; category_id: number | null; category: string | null;
  category_kind: CategoryKind | null; categorized_by: 'rule' | 'ai' | 'user' | null; notes: string | null;
  /** What the other person wrote on it, word for word. */
  memo: string | null;
  source: string; import_id: number | null; recurring_id: number | null; recurring: string | null;
  /** 1 while the bank still shows it as a pending authorisation. */
  pending: number;
  contributor_id: number | null; contributor: string | null;
  split_id: number | null; split_ways: number | null; split_owed_cents: number | null; payback_split_id: number | null; payback_for: string | null;
}
export interface Rule {
  id: number; pattern: string; match_type: 'contains' | 'regex'; category_id: number | null; category: string | null;
  payee_id: number | null; merchant: string | null; payee_kind: PayeeKind | null;
}

export class ApiError extends Error {}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? (init?.body ? 'POST' : 'GET'),
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`);
  if ((init?.method ?? (init?.body ? 'POST' : 'GET')) !== 'GET') bumpVersion();
  return data as T;
}

// Any write bumps a global version so every mounted view refetches.
let version = 0;
const listeners = new Set<() => void>();
export function bumpVersion() {
  version++;
  listeners.forEach((l) => l());
}
function useVersion() {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => version);
}

/** Fetches `path` (null to skip), refetching after writes and when the window regains focus (e.g. after a Claude import). */
export function useApi<T>(path: string | null) {
  const v = useVersion();
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [focusTick, setFocusTick] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    const onFocus = () => setFocusTick((t) => t + 1);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const load = useCallback(() => {
    if (!path) return;
    const req = ++latest.current;
    setState((s) => ({ ...s, loading: true }));
    api<T>(path)
      .then((data) => { if (req === latest.current) setState({ data, error: null, loading: false }); })
      .catch((e: Error) => { if (req === latest.current) setState((s) => ({ ...s, error: e.message, loading: false })); });
  }, [path]);

  useEffect(load, [load, v, focusTick]);
  return { ...state, reload: load };
}
