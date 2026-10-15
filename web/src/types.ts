import type { Bucket, BucketKind, PayeeKind, Rule, Transaction } from './api.ts';

export interface Summary {
  month: string;
  days_in_month: number;
  elapsed_days: number;
  is_current: boolean;
  data_through: string | null;
  latest_transaction: string | null;
  totals: {
    spent_cents: number; income_cents: number; net_cents: number;
    /** What the spending buckets add up to; savings buckets are left out. */
    budget_cents: number; save_target_cents: number; planned_income_cents: number; reserved_cents: number;
    budgeted_spent_cents: number; unbudgeted_spent_cents: number; expected_to_date_cents: number;
    projected_cents: number | null; prev_spent_cents: number; prev_income_cents: number;
  };
  uncategorized: { count: number; out_cents: number; in_cents: number };
  buckets: { id: number; name: string; kind: BucketKind; target_cents: number | null; target_percent: number | null; actual_cents: number; reserved: Reserved; schedule: Schedule | null; balance_cents: number }[];
  /** bucket_id is null when the category isn't in a spending bucket. */
  categories: { id: number; name: string; spent_cents: number; count: number; bucket_id: number | null }[];
  income: { id: number; name: string; amount_cents: number; count: number }[];
  daily: { day: number; spent_cents: number; cumulative_cents: number | null; pace_cents: number }[];
  top_merchants: { name: string; payee_id: number | null; payee_kind: PayeeKind | null; spent_cents: number; count: number }[];
}

export interface Trends {
  months: { month: string; spent_cents: number; income_cents: number; budget_cents: number }[];
  categories: { id: number | null; name: string; sort: number; values: Record<string, number>; total_cents: number; average_cents: number }[];
  averaged_months: string[];
  average_spent_cents: number;
  average_income_cents: number;
}

/** Recurring payments still due in the month. */
export interface Reserved { cents: number; items: { name: string; each_cents: number; dates: string[]; cents: number }[] }

/** The recurring payments behind a bucket that follows them: this month (4 or 5 rent Thursdays) and a usual month. */
export interface Schedule {
  cents: number; average_cents: number;
  items: { name: string; each_cents: number; count: number | null; cents: number; average_cents: number }[];
}

export interface BudgetCategory { category_id: number; name: string; spent_cents: number; last_month_cents: number; avg3_cents: number }

export interface BudgetBucket extends Bucket {
  /** Which number was set: a percentage (follows income) or an amount (fixed). */
  mode: 'percent' | 'amount' | 'recurring' | null;
  target_cents: number | null; target_percent: number | null;
  /** Spent, or for a savings bucket, saved. */
  actual_cents: number; last_month_cents: number; avg3_cents: number; actual_percent: number | null;
  reserved: Reserved;
  schedule: Schedule | null;
  /** For the balancing bucket: what it gives up (negative) or gets back this month, already in target_cents. */
  balance_cents: number;
  categories: BudgetCategory[];
}

export interface BudgetPlan {
  month: string;
  income: {
    planned_cents: number; source: 'fixed' | 'average' | 'this_month' | 'none'; months: string[];
    actual_cents: number; usual_cents: number;
    categories: { category_id: number; name: string; amount_cents: number }[];
  };
  buckets: BudgetBucket[];
  unassigned: BudgetCategory[];
  uncategorized_cents: number;
  totals: {
    allocated_cents: number; allocated_percent: number | null; spend_target_cents: number; save_target_cents: number;
    spent_cents: number; saved_cents: number; reserved_cents: number;
  };
}

export type Frequency = 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'yearly';
export type RecurringStatus = 'overdue' | 'due_soon' | 'upcoming' | 'awaiting_data' | 'no_payments' | 'inactive';

export type ShareStatus = 'paid' | 'partial' | 'owing' | 'waiting';
export interface Contributor { id: number; name: string; pattern: string; match_type: 'contains' | 'regex'; share_cents: number | null; custom_share: boolean }
export interface BillCycle {
  date: string; bill_paid: boolean; bill_cents: number | null;
  shares: { contributor_id: number; name: string; expected_cents: number; paid_cents: number; paid_date: string | null; status: ShareStatus }[];
}

export interface RecurringItem {
  id: number; name: string; pattern: string; match_type: 'contains' | 'regex'; frequency: Frequency;
  expected_cents: number | null; active: number; category: string | null;
  typical_cents: number | null; monthly_cents: number | null;
  last_paid: { date: string; amount_cents: number } | null; change_cents: number | null;
  next_due: string | null; days_until_due: number | null; days_overdue: number; status: RecurringStatus;
  paid_recently: boolean; payment_count: number; credits_90d_cents: number; contributors_90d_cents: number;
  contributors: Contributor[]; your_share_cents: number | null; your_monthly_cents: number | null;
  owed_to_you_cents: number; cycles: BillCycle[]; current_cycle: BillCycle | null;
  history: { id: number; date: string; description: string; merchant: string | null; amount_cents: number; account: string; category: string | null }[];
  history_count: number;
}

export interface RecurringSuggestion {
  name: string; pattern: string; frequency: Frequency; typical_cents: number; count: number; last_date: string; category: string | null;
}

export interface RecurringList {
  data_through: string | null; monthly_total_cents: number; your_monthly_total_cents: number; owed_to_you_cents: number;
  items: RecurringItem[]; suggestions: RecurringSuggestion[];
}

export interface PayeeRow {
  id: number; name: string; kind: PayeeKind; notes: string | null;
  tx_count: number; first_date: string | null; last_date: string | null;
  out_cents: number; in_cents: number;
  month_out_cents: number; month_in_cents: number;
  year_out_cents: number; year_in_cents: number;
  category: string | null; bank_names: string[]; patterns: string[];
  bills_owed_cents: number;
  split_owed_cents: number;
}

export interface PayeeList { month: string; payees: PayeeRow[] }

export interface PayeeDetail {
  id: number; name: string; kind: PayeeKind; notes: string | null;
  totals: { tx_count: number; first_date: string | null; last_date: string | null; out_cents: number; in_cents: number; bills_owed_cents: number; split_owed_cents: number };
  splits: Split[];
  payback_suggestions: PaybackSuggestion[];
  months: { month: string; out_cents: number; in_cents: number; count: number }[];
  categories: { category: string | null; kind: string | null; out_cents: number; in_cents: number; count: number }[];
  bank_names: { name: string; count: number; last_date: string }[];
  rules: Rule[];
  transactions: Transaction[];
  transaction_count: number;
}

export type SplitShareStatus = 'owing' | 'partial' | 'paid' | 'settled';
export interface SplitShare {
  id: number; split_id: number; payee_id: number | null; person: string | null;
  amount_cents: number; paid_cents: number; outstanding_cents: number; settled: boolean; status: SplitShareStatus;
  payments: { transaction_id: number; date: string; amount_cents: number; description: string }[];
}
export interface Split {
  id: number; transaction_id: number; date: string; merchant: string | null; description: string;
  amount_cents: number; category: string | null; notes: string | null;
  ways: number; your_share_cents: number; owed_cents: number; shares: SplitShare[];
}
export interface PaybackSuggestion {
  purchase: { id: number; date: string; merchant: string | null; description: string; amount_cents: number; category: string | null; split_id: number | null; notes: string | null };
  ways: number; share_cents: number;
  payments: { id: number; date: string; person: string; payee_id: number; amount_cents: number; description: string; memo: string | null; notes: string | null; unlinked?: boolean }[];
  confidence: 'high' | 'medium'; reasons: string[];
  /** People sent different amounts (each paid for what they had). */
  uneven: boolean;
  /** Claude's notes on these payments. */
  reviews: { payment_id: number; person: string; verdict: 'likely' | 'unsure'; note: string }[];
}
export interface SplitsOverview { owed_cents: number; unclaimed_cents: number; open: Split[]; suggestions: PaybackSuggestion[] }
