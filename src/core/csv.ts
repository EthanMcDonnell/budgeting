import type { IncomingTransaction } from './importer.ts';
import { normalizeDate, parseMoney } from './util.ts';

/** RFC 4180-ish CSV parser: quoted fields, escaped quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

const ALIASES = {
  date: ['transaction date', 'date', 'posted date', 'posting date', 'effective date', 'value date', 'time'],
  description: ['narration', 'description', 'transaction details', 'details', 'memo', 'narrative', 'particulars'],
  debit: ['debit', 'debits', 'debit amount', 'withdrawal', 'withdrawals', 'money out', 'paid out'],
  credit: ['credit', 'credits', 'credit amount', 'deposit', 'deposits', 'money in', 'paid in'],
  amount: ['amount', 'value', 'transaction amount', 'amount aud', 'total aud'],
  merchant: ['payee', 'merchant'],
  balance: ['balance', 'running balance'],
  accountNumber: ['account number', 'account no', 'account'],
  type: ['transaction type', 'type'],
} as const;

type Field = keyof typeof ALIASES;

export interface ParsedCsv {
  format: 'bankwest' | 'headed' | 'headerless';
  columns: Partial<Record<Field, number>>;
  accountNumbers: string[];
  /** accountNumber is set when the file has an account number column (Bankwest's export can cover several accounts). */
  transactions: (IncomingTransaction & { accountNumber?: string })[];
  skippedRows: { line: number; reason: string }[];
}

function norm(h: string) {
  return h.trim().toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function mapHeader(header: string[]): Partial<Record<Field, number>> {
  const cols: Partial<Record<Field, number>> = {};
  const names = header.map(norm);
  for (const field of Object.keys(ALIASES) as Field[]) {
    for (const alias of ALIASES[field]) {
      const i = names.indexOf(alias);
      if (i >= 0 && !Object.values(cols).includes(i)) { cols[field] = i; break; }
    }
  }
  return cols;
}

/**
 * Parses a bank CSV export. Understands Bankwest's export (BSB Number, Account Number,
 * Transaction Date, Narration, Cheque Number, Debit, Credit, Balance, Transaction Type),
 * Up Bank's export (Time, Payee, Description, Total (AUD)), other headed exports with
 * Date/Description/Amount or Debit/Credit columns, and
 * CommBank-style headerless files (date, amount, description, balance).
 */
export function parseBankCsv(text: string): ParsedCsv {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error('The file is empty');

  const headerIndex = rows.slice(0, 10).findIndex((r) => {
    const c = mapHeader(r);
    return c.date != null && (c.amount != null || c.debit != null || c.credit != null);
  });

  let columns: Partial<Record<Field, number>>;
  let dataRows: string[][];
  let format: ParsedCsv['format'];
  let firstLine: number;

  if (headerIndex >= 0) {
    columns = mapHeader(rows[headerIndex]);
    dataRows = rows.slice(headerIndex + 1);
    firstLine = headerIndex + 2;
    const names = rows[headerIndex].map(norm);
    format = names.includes('narration') && names.includes('bsb number') ? 'bankwest' : 'headed';
  } else {
    columns = guessHeaderless(rows);
    dataRows = rows;
    firstLine = 1;
    format = 'headerless';
  }

  if (columns.date == null) throw new Error('Could not find a date column');
  if (columns.amount == null && columns.debit == null && columns.credit == null) {
    throw new Error('Could not find an amount, debit or credit column');
  }

  const transactions: ParsedCsv['transactions'] = [];
  const skippedRows: ParsedCsv['skippedRows'] = [];
  const accountNumbers = new Set<string>();

  dataRows.forEach((r, i) => {
    const line = firstLine + i;
    const get = (f: Field) => (columns[f] != null ? (r[columns[f]!] ?? '').trim() : '');
    const date = normalizeDate(get('date'));
    if (!date) { skippedRows.push({ line, reason: `Unreadable date "${get('date')}"` }); return; }

    let amount: number | null = null;
    if (columns.amount != null) amount = parseMoney(get('amount'));
    else {
      const debit = parseMoney(get('debit'));
      const credit = parseMoney(get('credit'));
      if (debit) amount = -Math.abs(debit);
      else if (credit) amount = Math.abs(credit);
      else if (debit === 0 || credit === 0) amount = 0;
    }
    if (amount == null) { skippedRows.push({ line, reason: 'No amount' }); return; }
    // Bankwest adds $0 notes such as "FEES INCLUDED IN TRAN ... IS WAIVED".
    if (amount === 0) { skippedRows.push({ line, reason: 'Zero amount' }); return; }

    let description = get('description');
    const type = get('type');
    // Pending card authorisations reappear as normal transactions once they settle.
    if (type.toUpperCase() === 'DAU' || /^AUTHORISATION ONLY\b/i.test(description)) {
      skippedRows.push({ line, reason: 'Pending authorisation; imported once it settles' });
      return;
    }
    if (!description) description = type || 'Unknown';
    const acct = get('accountNumber');
    if (acct) accountNumbers.add(acct);

    const balance = parseMoney(get('balance'));
    transactions.push({ date, description, amount, balance, merchant: get('merchant') || null, ...(acct && { accountNumber: acct }) });
  });

  return { format, columns, accountNumbers: [...accountNumbers], transactions, skippedRows };
}

function guessHeaderless(rows: string[][]): Partial<Record<Field, number>> {
  const sample = rows.slice(0, 20);
  const width = Math.max(...sample.map((r) => r.length));
  const cols: Partial<Record<Field, number>> = {};
  const share = (pred: (v: string) => boolean, c: number) =>
    sample.filter((r) => pred((r[c] ?? '').trim())).length / sample.length;

  for (let c = 0; c < width; c++) if (cols.date == null && share((v) => !!normalizeDate(v), c) > 0.8) cols.date = c;
  const money = [...Array(width).keys()].filter((c) => c !== cols.date && share((v) => parseMoney(v) != null, c) > 0.8);
  // The first money column is the amount; a second is usually the running balance.
  if (money[0] != null) cols.amount = money[0];
  if (money[1] != null) cols.balance = money[1];
  let best = -1;
  for (let c = 0; c < width; c++) {
    if (c === cols.date || money.includes(c)) continue;
    const len = sample.reduce((s, r) => s + (r[c]?.length ?? 0), 0);
    if (len > best) { best = len; cols.description = c; }
  }
  return cols;
}
