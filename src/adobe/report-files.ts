import fs from 'node:fs';
import path from 'node:path';
import { appendCsvRow, writeCsvFile } from './csv';
import { loadConsumedLedgerRows, normalizeAdobeEmail } from './accounts';
import {
  ADOBE_CONSUMED_HEADERS,
  ADOBE_RESULTS_HEADERS,
  getAdobeConsumedLedgerPath,
  getAdobeResultsPath,
  getAdobeTmpDir,
} from './runtime';
import type { AdobeConsumedRow, AdobeResultRow } from './types';

type FragmentLocation = {
  cwd?: string;
  runId: string;
  workerIndex: number;
};

export function appendConsumedFragment(row: AdobeConsumedRow, location: FragmentLocation): void {
  const filePath = path.join(getAdobeTmpDir(location.runId, location.cwd), `consumed-worker-${location.workerIndex}.csv`);
  appendCsvRow(filePath, ADOBE_CONSUMED_HEADERS, [row.email, row.consumed_at]);
}

export function appendResultFragment(row: AdobeResultRow, location: FragmentLocation): void {
  const filePath = path.join(getAdobeTmpDir(location.runId, location.cwd), `results-worker-${location.workerIndex}.csv`);
  appendCsvRow(filePath, ADOBE_RESULTS_HEADERS, toResultValues(row));
}

function toResultValues(row: AdobeResultRow): string[] {
  return [
    row.timestamp,
    row.email,
    row.test_status,
    row.logged_in ?? '',
    row.dashboard_url ?? '',
    row.owner_entity ?? '',
    row.failed_at_step,
    row.failure_reason,
    row.duration_ms,
    row.published_link ?? '',
  ];
}

export function mergeAdobeRunArtifacts(options: {
  cwd?: string;
  finishedAt?: Date;
  runId: string;
}): { consumedLedgerPath: string; resultsPath: string; consumedCount: number; resultCount: number } {
  const cwd = options.cwd ?? process.cwd();
  const tmpDir = getAdobeTmpDir(options.runId, cwd);
  const resultsRows = loadRowsFromFragments<AdobeResultRow>(tmpDir, /^results-worker-\d+\.csv$/, ADOBE_RESULTS_HEADERS);
  const consumedRows = loadRowsFromFragments<AdobeConsumedRow>(
    tmpDir,
    /^consumed-worker-\d+\.csv$/,
    ADOBE_CONSUMED_HEADERS,
  );

  const resultsPath = getAdobeResultsPath(options.finishedAt, cwd);
  writeCsvFile(
    resultsPath,
    ADOBE_RESULTS_HEADERS,
    resultsRows.map(toResultValues),
  );

  const consumedLedgerPath = getAdobeConsumedLedgerPath(cwd);
  const existingLedgerRows = loadConsumedLedgerRows(consumedLedgerPath);
  const mergedConsumedRows = dedupeConsumedRows([...existingLedgerRows, ...consumedRows]);
  writeCsvFile(
    consumedLedgerPath,
    ADOBE_CONSUMED_HEADERS,
    mergedConsumedRows.map((row) => [row.email, row.consumed_at]),
  );

  fs.rmSync(tmpDir, { force: true, recursive: true });
  return {
    consumedLedgerPath,
    resultsPath,
    consumedCount: mergedConsumedRows.length,
    resultCount: resultsRows.length,
  };
}

function loadRowsFromFragments<T extends Record<string, string>>(
  tmpDir: string,
  pattern: RegExp,
  headers: readonly string[],
): T[] {
  if (!fs.existsSync(tmpDir)) {
    return [];
  }

  const rows: T[] = [];
  const files = fs.readdirSync(tmpDir).filter((fileName) => pattern.test(fileName)).sort();
  for (const fileName of files) {
    const filePath = path.join(tmpDir, fileName);
    const content = fs.readFileSync(filePath, 'utf8').trim();
    if (!content) {
      continue;
    }

    const [headerLine, ...dataLines] = content.split(/\r?\n/);
    const actualHeaders = headerLine.split(',');
    if (actualHeaders.join(',') !== headers.join(',')) {
      throw new Error(`Unexpected fragment header in "${filePath}". Expected ${headers.join(',')}.`);
    }

    for (const line of dataLines) {
      if (!line.trim()) {
        continue;
      }

      const parsedLine = parseFragmentLine(line);
      const row: Record<string, string> = {};
      headers.forEach((header, index) => {
        row[header] = parsedLine[index] ?? '';
      });
      rows.push(row as T);
    }
  }
  return rows;
}

function parseFragmentLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (inQuotes) {
      if (char === '"') {
        const next = line[index + 1];
        if (next === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ',') {
      values.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

function dedupeConsumedRows(rows: AdobeConsumedRow[]): AdobeConsumedRow[] {
  const deduped = new Map<string, AdobeConsumedRow>();
  for (const row of rows) {
    const normalizedEmail = normalizeAdobeEmail(row.email);
    if (!normalizedEmail || deduped.has(normalizedEmail)) {
      continue;
    }
    deduped.set(normalizedEmail, {
      email: normalizedEmail,
      consumed_at: row.consumed_at,
    });
  }
  return [...deduped.values()];
}
