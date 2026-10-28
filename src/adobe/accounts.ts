import fs from 'node:fs';
import path from 'node:path';
import { parseCsv } from './csv';
import {
  ADOBE_CONSUMED_HEADERS,
  ADOBE_NO_FRESH_ACCOUNTS_REASON,
  getAdobeConsumedLedgerPath,
} from './runtime';
import type { AdobeAccount, AdobeAccountSource, AdobeConsumedRow, FreshAdobeAccountsResult } from './types';

export class AdobeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdobeConfigurationError';
  }
}

type LoadFreshAdobeAccountsOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  consumedLedgerPath?: string;
};

const SOURCE_HEADERS = ['email', 'password'] as const;

export function normalizeAdobeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function loadFreshAdobeAccounts(
  options: LoadFreshAdobeAccountsOptions = {},
): FreshAdobeAccountsResult {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const source = resolveAdobeAccountSource({ cwd, env });
  const sourceAccounts = source.kind === 'csv'
    ? loadAccountsFromCsv(source.path)
    : [loadAccountFromEnv(env)];
  const accounts = dedupeAccounts(sourceAccounts, source.description);
  // ADOBE_IGNORE_CONSUMED=1 runs every account in the CSV, ledger or not — e.g. to
  // re-run accounts an older run marked consumed without ever producing a download.
  const consumedEmails = env.ADOBE_IGNORE_CONSUMED?.trim() === '1'
    ? new Set<string>()
    : loadConsumedEmailSet(options.consumedLedgerPath ?? getAdobeConsumedLedgerPath(cwd));
  const freshAccounts = accounts.filter((account) => !consumedEmails.has(account.email));

  return {
    accounts: freshAccounts,
    source,
    skipReason: freshAccounts.length === 0 ? ADOBE_NO_FRESH_ACCOUNTS_REASON : undefined,
  };
}

export function resolveAdobeAccountSource(options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
} = {}): AdobeAccountSource {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const explicitCsv = env.ADOBE_ACCOUNTS_CSV?.trim();

  if (explicitCsv) {
    const resolvedPath = path.resolve(cwd, explicitCsv);
    if (!fs.existsSync(resolvedPath)) {
      throw new AdobeConfigurationError(
        `ADOBE_ACCOUNTS_CSV points to "${resolvedPath}", but that file does not exist.`,
      );
    }
    return {
      kind: 'csv',
      description: `ADOBE_ACCOUNTS_CSV (${resolvedPath})`,
      path: resolvedPath,
    };
  }

  const repoLocalCsv = path.join(cwd, 'accounts.csv');
  if (fs.existsSync(repoLocalCsv)) {
    return {
      kind: 'csv',
      description: `repo-local accounts.csv (${repoLocalCsv})`,
      path: repoLocalCsv,
    };
  }

  if (env.ADOBE_EMAIL?.trim() || env.ADOBE_PASSWORD?.trim()) {
    return {
      kind: 'env',
      description: 'ADOBE_EMAIL + ADOBE_PASSWORD',
    };
  }

  throw new AdobeConfigurationError(
    'Adobe accounts are not configured. Set ADOBE_ACCOUNTS_CSV, add accounts.csv, or set ADOBE_EMAIL and ADOBE_PASSWORD.',
  );
}

export function loadConsumedLedgerRows(filePath: string): AdobeConsumedRow[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const rows = parseCsv(content);
  if (rows.length === 0) {
    return [];
  }

  const headerMap = buildHeaderMap(rows[0]);
  validateRequiredHeaders(headerMap, ADOBE_CONSUMED_HEADERS, filePath);

  const parsedRows: AdobeConsumedRow[] = [];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const email = normalizeAdobeEmail(readField(row, headerMap, 'email'));
    const consumedAt = readField(row, headerMap, 'consumed_at').trim();

    if (!email && !consumedAt) {
      continue;
    }
    if (!email) {
      throw new AdobeConfigurationError(`Consumed ledger "${filePath}" has a blank email on row ${rowIndex + 1}.`);
    }
    if (!consumedAt) {
      throw new AdobeConfigurationError(
        `Consumed ledger "${filePath}" has a blank consumed_at value on row ${rowIndex + 1}.`,
      );
    }

    parsedRows.push({ email, consumed_at: consumedAt });
  }

  return parsedRows;
}

function loadAccountsFromCsv(filePath: string): AdobeAccount[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const rows = parseCsv(content);
  if (rows.length === 0) {
    throw new AdobeConfigurationError(`Account CSV "${filePath}" is empty.`);
  }

  const headerMap = buildHeaderMap(rows[0]);
  validateRequiredHeaders(headerMap, SOURCE_HEADERS, filePath);

  const accounts: AdobeAccount[] = [];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const rawEmail = readField(row, headerMap, 'email');
    const rawPassword = readField(row, headerMap, 'password');

    if (!rawEmail.trim() && !rawPassword.trim()) {
      continue;
    }

    const email = normalizeAdobeEmail(rawEmail);
    const password = rawPassword.trim();

    if (!email) {
      throw new AdobeConfigurationError(`Account CSV "${filePath}" has a blank email on row ${rowIndex + 1}.`);
    }
    if (!password) {
      throw new AdobeConfigurationError(`Account CSV "${filePath}" has a blank password on row ${rowIndex + 1}.`);
    }

    accounts.push({ email, password });
  }

  if (accounts.length === 0) {
    throw new AdobeConfigurationError(`Account CSV "${filePath}" did not contain any account rows.`);
  }

  return accounts;
}

function loadAccountFromEnv(env: NodeJS.ProcessEnv): AdobeAccount {
  const email = normalizeAdobeEmail(env.ADOBE_EMAIL ?? '');
  const password = (env.ADOBE_PASSWORD ?? '').trim();

  if (!email || !password) {
    throw new AdobeConfigurationError(
      'ADOBE_EMAIL and ADOBE_PASSWORD must both be set when using the single-account environment fallback.',
    );
  }

  return { email, password };
}

function dedupeAccounts(accounts: AdobeAccount[], sourceDescription: string): AdobeAccount[] {
  const seen = new Map<string, AdobeAccount>();
  const deduped: AdobeAccount[] = [];
  let duplicateCount = 0;
  let conflictingPasswordCount = 0;

  for (const account of accounts) {
    const existing = seen.get(account.email);
    if (existing) {
      duplicateCount += 1;
      if (existing.password !== account.password) {
        conflictingPasswordCount += 1;
      }
      continue;
    }
    seen.set(account.email, account);
    deduped.push(account);
  }

  if (duplicateCount > 0) {
    const passwordNote = conflictingPasswordCount > 0
      ? ` ${conflictingPasswordCount} duplicate row(s) had a different password; keeping the first value for each email.`
      : '';
    console.warn(
      `Collapsed ${duplicateCount} duplicate Adobe account row(s) from ${sourceDescription}.${passwordNote}`,
    );
  }

  return deduped;
}

function loadConsumedEmailSet(filePath: string): Set<string> {
  return new Set(loadConsumedLedgerRows(filePath).map((row) => row.email));
}

function buildHeaderMap(headers: string[]): Map<string, number> {
  const headerMap = new Map<string, number>();
  headers.forEach((header, index) => {
    headerMap.set(header.trim().toLowerCase(), index);
  });
  return headerMap;
}

function validateRequiredHeaders(
  headerMap: Map<string, number>,
  headers: readonly string[],
  filePath: string,
): void {
  const missing = headers.filter((header) => !headerMap.has(header));
  if (missing.length > 0) {
    throw new AdobeConfigurationError(
      `CSV "${filePath}" is missing required column(s): ${missing.join(', ')}.`,
    );
  }
}

function readField(row: string[], headerMap: Map<string, number>, header: string): string {
  const index = headerMap.get(header);
  return index === undefined ? '' : row[index] ?? '';
}
