#!/usr/bin/env node
// Slices accounts.csv for a specific Cloud Run task.
// Usage: node scripts/slice-accounts.mjs <input-csv> <task-index> <task-count> <output-csv>

import fs from 'node:fs';

const [,, inputPath, taskIndex, taskCount, outputPath] = process.argv;

if (!inputPath || taskIndex === undefined || !taskCount || !outputPath) {
  console.error('Usage: node scripts/slice-accounts.mjs <input-csv> <task-index> <task-count> <output-csv>');
  process.exit(1);
}

const idx = parseInt(taskIndex, 10);
const count = parseInt(taskCount, 10);

const lines = fs.readFileSync(inputPath, 'utf8')
  .split('\n')
  .filter(l => l.trim());

const header = lines[0];
const dataLines = lines.slice(1);
const total = dataLines.length;

const batchSize = Math.ceil(total / count);
const start = idx * batchSize;
const end = Math.min(start + batchSize, total);
const slice = dataLines.slice(start, end);

if (slice.length === 0) {
  console.warn(`Task ${idx}: no accounts in slice (start=${start}, total=${total}) — writing empty file`);
  fs.writeFileSync(outputPath, header + '\n', 'utf8');
} else {
  fs.writeFileSync(outputPath, [header, ...slice].join('\n') + '\n', 'utf8');
  console.log(`Task ${idx}/${count}: wrote ${slice.length} accounts (rows ${start + 1}–${end}) → ${outputPath}`);
}
