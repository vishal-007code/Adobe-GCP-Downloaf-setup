#!/usr/bin/env node
// Build the weekly "Mix_District_Links_Login" workbook from the source account
// sheets plus whatever login evidence we have.
//
// Mirrors the layout of Mix_District_Links_Login_1-7_Aug_26.xlsx:
//   Sheet "District-wise Report" — KV block, Bihar block, and totals, with
//                                  columns: S# | Name | No. of IDs | Adobe Links | Logged In
//   Sheet "All Adobe Links"      — one row per account: S# | Email | Sheet |
//                                  Region/Dist | Adobe Link | Logged In
//
// The Adobe Link column is left blank — those come off the laptops later and get
// merged in by re-running this with --links=<csv of email,link>.
//
// Usage:
//   node scripts/build-activation-report.mjs \
//     --passed=<file>            one email per line; repeatable
//     --links=<csv>              optional email,link pairs
//     --out=<xlsx>               output path
//
// "Logged in" = the account is NOT in any resume CSV (i.e. it passed in the
// original run), OR it appears in one of the --passed files (recovered in a retry).

import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.join('=')];
  }),
);
const passedFiles = process.argv.slice(2).filter((a) => a.startsWith('--passed=')).map((a) => a.slice(9));
const OUT = args.out || 'Mix_District_Links_Login_8-14_Aug_26.xlsx';

const norm = (e) => String(e || '').replace(/\s+/g, '').toLowerCase();

// ── Accounts that had NOT passed as of the original runs ─────────────────────
const pending = new Set();
for (const f of ['resume-bihar.csv', 'resume-0814-kva1.csv', 'resume-0814-kva2.csv', 'resume-kvb.csv']) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, 'utf8').split('\n').slice(1)) {
    const e = norm(line.split(',')[0]);
    if (e) pending.add(e);
  }
}

// ── Accounts recovered since (retry runs) ────────────────────────────────────
const recovered = new Set();
for (const f of passedFiles) {
  if (!fs.existsSync(f)) {
    console.error(`WARN: --passed file not found, skipping: ${f}`);
    continue;
  }
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const e = norm(line.split(',')[0]);
    if (e && e.includes('@')) recovered.add(e);
  }
}

// ── Accounts to drop entirely (bad source data, not a run failure) ───────────
// These are counted nowhere: not in "No. of IDs", not in "Logged In". Keeping
// them would permanently depress every total with accounts that CANNOT succeed.
const excludeFiles = process.argv.slice(2).filter((a) => a.startsWith('--exclude=')).map((a) => a.slice(10));
const excluded = new Set();
for (const f of excludeFiles) {
  if (!fs.existsSync(f)) {
    console.error(`WARN: --exclude file not found, skipping: ${f}`);
    continue;
  }
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const e = norm(line.split(',')[0]);
    if (e && e.includes('@')) excluded.add(e);
  }
}

// ── Adobe links, if supplied ─────────────────────────────────────────────────
const links = new Map();
if (args.links && fs.existsSync(args.links)) {
  for (const line of fs.readFileSync(args.links, 'utf8').split('\n').slice(1)) {
    const [e, ...rest] = line.split(',');
    const email = norm(e);
    const link = rest.join(',').trim();
    if (email && link) links.set(email, link);
  }
}

// Accounts that have actually been through a run. The resume CSVs only tell us
// who FAILED, so "not in a resume CSV" means "passed" ONLY for accounts that were
// dispatched. A newly-added account is in neither set — without this guard it
// would be silently counted as logged in and inflate every total.
const dispatched = new Set();
for (const [file, sheet] of [
  ['Server_Bihar_ICT_Activation_8-14_Aug_26.xlsx', 0],
  ['Server_KV_Activation_8-14_Aug_26.xlsx', 0],
]) {
  if (!fs.existsSync(file)) continue;
  const wb = XLSX.readFile(file);
  for (const r of XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[sheet]], { defval: '' })) {
    const e = norm(r['Email Address']);
    if (e) dispatched.add(e);
  }
}

const loggedIn = (email) =>
  recovered.has(email) || (dispatched.has(email) && !pending.has(email));

// ── Read the two source workbooks ────────────────────────────────────────────
// Each block merges one or more workbooks — the weekly file plus any "Extra"
// top-ups — into a single set of per-region rows, so a region that appears in
// both is one row, not two.
const BLOCKS = [
  {
    sheet: 'KV',
    label: 'KV RO Name',
    col: 'Region',
    files: ['Server_KV_Activation_8-14_Aug_26.xlsx', 'Extra_Server_KV_12-14_Aug_26.xlsx'],
  },
  {
    sheet: 'Bihar',
    label: 'Dist',
    col: 'Dist',
    files: ['Server_Bihar_ICT_Activation_8-14_Aug_26.xlsx', 'Extra_Server_Bihar_ICT_12-14_Aug_26.xlsx'],
  },
];

const perAccount = [];
const blocks = [];
let skippedExcluded = 0;
let skippedDupe = 0;

for (const block of BLOCKS) {
  const agg = new Map();
  const seen = new Set();

  for (const file of block.files) {
    if (!fs.existsSync(file)) {
      console.error(`WARN: source not found, skipping: ${file}`);
      continue;
    }
    const wb = XLSX.readFile(file);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });

    for (const r of rows) {
      const email = norm(r['Email Address']);
      if (!email) continue;
      if (excluded.has(email)) { skippedExcluded += 1; continue; }
      if (seen.has(email)) { skippedDupe += 1; continue; }
      seen.add(email);

      const group = String(r[block.col] || '(blank)').trim() || '(blank)';
      const isIn = loggedIn(email);
      const link = links.get(email) || '';

      if (!agg.has(group)) agg.set(group, { ids: 0, links: 0, in: 0 });
      const a = agg.get(group);
      a.ids += 1;
      if (link) a.links += 1;
      if (isIn) a.in += 1;

      perAccount.push([0, String(r['Email Address']).trim(), block.sheet, group, link, isIn ? 'Yes' : 'No']);
    }
  }

  blocks.push({ ...block, agg });
}

// ── Laptop batches: accounts + results that are NOT in the source workbooks ───
// These come off the laptops as a pair of files (an accounts CSV and a Playwright
// results CSV carrying published_link). They are placed by looking the account up
// in the source workbooks first, and falling back to its email DOMAIN — every
// domain in this programme maps to exactly one region, so the fallback is safe.
const batchAccountFiles = process.argv.slice(2).filter((a) => a.startsWith('--batch-accounts=')).map((a) => a.slice(17));
const batchResultFiles = process.argv.slice(2).filter((a) => a.startsWith('--batch-results=')).map((a) => a.slice(16));

if (batchAccountFiles.length) {
  // email -> {sheet, group} for everything already placed, plus domain -> best region
  const placed = new Map();
  const domainVotes = new Map();
  for (const b of blocks) {
    for (const [group, _] of b.agg) void group;
  }
  perAccount.forEach((row, idx) => {
    const e = norm(row[1]);
    placed.set(e, { sheet: row[2], group: row[3], idx });
    const d = e.split('@')[1] || '';
    if (!domainVotes.has(d)) domainVotes.set(d, new Map());
    const m = domainVotes.get(d);
    const k = row[2] + '|' + row[3];
    m.set(k, (m.get(k) || 0) + 1);
  });
  const byDomain = (email) => {
    const m = domainVotes.get(email.split('@')[1] || '');
    if (!m) return null;
    const [k] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    const [sheet, group] = k.split('|');
    return { sheet, group };
  };

  let added = 0, addedLinks = 0, addedIn = 0, unplaceable = 0, enrichedLinks = 0, enrichedLogins = 0;

  // Results files do NOT pair 1:1 with accounts files — one laptop run can emit
  // several result CSVs, and a later run can supersede an earlier failure. Pool
  // them all into one lookup, letting a row WITH a link win over one without.
  // A laptop run only reports status=passed when it published a link. But an
  // account that reached the Adobe dashboard and then tripped on a LATER step
  // (Share, Create Link, ...) has still logged in — scoring it "not logged in"
  // because it produced no link conflates two different things. These steps all
  // happen AFTER the dashboard, so reaching them is proof of login.
  const POST_LOGIN_STEPS = new Set([
    'Click Share button',
    'Click Create Link button',
    'Click Copy Link button',
    'Open View Only Link',
    'Navigate to Fixed Postcard',
  ]);

  const res = new Map();
  for (const resFile of batchResultFiles) {
    if (!fs.existsSync(resFile)) { console.error(`WARN: batch results not found: ${resFile}`); continue; }
    for (const line of fs.readFileSync(resFile, 'utf8').split('\n').slice(1)) {
      const m = line.match(/^[^,]*,([^,]+@[^,]+),(\w+),([^,"]*)/);
      if (!m) continue;
      const email = norm(m[1]);
      const link = (line.match(/(https:\/\/new\.express\.adobe\.com\/publishedV2\/[^,\s"]+)/) || [])[1] || '';
      const passed = m[2] === 'passed';
      const didLogin = passed || POST_LOGIN_STEPS.has((m[3] || '').trim());
      const prev = res.get(email);
      if (!prev || (!prev.link && link) || (!prev.passed && passed) || (!prev.didLogin && didLogin)) {
        res.set(email, {
          link: link || prev?.link || '',
          passed: passed || prev?.passed || false,
          didLogin: didLogin || prev?.didLogin || false,
        });
      }
    }
  }

  for (const acctFile of batchAccountFiles) {
    if (!fs.existsSync(acctFile)) { console.error(`WARN: batch accounts not found: ${acctFile}`); continue; }

    for (const line of fs.readFileSync(acctFile, 'utf8').split('\n').slice(1)) {
      const email = norm(line.split(',')[0]);
      if (!email || !email.includes('@')) continue;
      if (excluded.has(email)) { skippedExcluded += 1; continue; }

      // Already placed — from a source workbook or an earlier batch. Do NOT skip
      // it outright: the laptop run may have produced a link (or a login) that the
      // existing row lacks. Enrich in place instead, so nothing is lost to dedupe.
      const prior = placed.get(email);
      if (prior) {
        skippedDupe += 1;
        const r0 = res.get(email);
        if (!r0) continue;
        const row = perAccount[prior.idx];
        const block0 = blocks.find((b) => b.sheet === prior.sheet);
        const a0 = block0?.agg.get(prior.group);
        if (r0.link && !row[4]) { row[4] = r0.link; if (a0) a0.links += 1; enrichedLinks += 1; }
        if (r0.didLogin && row[5] !== "Yes") { row[5] = 'Yes'; if (a0) a0.in += 1; enrichedLogins += 1; }
        continue;
      }

      const where = byDomain(email);
      if (!where) { unplaceable += 1; continue; }

      const r = res.get(email) || {};
      const link = r.link || links.get(email) || '';
      const isIn = Boolean(r.didLogin) || recovered.has(email);

      const block = blocks.find((b) => b.sheet === where.sheet);
      if (!block.agg.has(where.group)) block.agg.set(where.group, { ids: 0, links: 0, in: 0 });
      const a = block.agg.get(where.group);
      a.ids += 1;
      if (link) { a.links += 1; addedLinks += 1; }
      if (isIn) { a.in += 1; addedIn += 1; }

      placed.set(email, { ...where, idx: perAccount.length });
      perAccount.push([0, line.split(',')[0].trim(), where.sheet, where.group, link, isIn ? 'Yes' : 'No']);
      added += 1;
    }
  }
  console.error(`Batch merge: added=${added} links=${addedLinks} loggedIn=${addedIn} unplaceable=${unplaceable}`);
  console.error(`Enriched existing rows: links=${enrichedLinks} logins=${enrichedLogins}`);
}

// ── Sheet 1: District-wise Report ────────────────────────────────────────────
const summary = [['Adobe Activation Report | 8th-14th Aug 26 (All Sources Combined)', '', '', '', '']];
let gIds = 0, gLinks = 0, gIn = 0;

for (const b of blocks) {
  summary.push([b.sheet, '', '', '', '']);
  summary.push(['S#', b.label, 'No. of IDs', 'Adobe Links', 'Logged In']);

  let n = 0, tIds = 0, tLinks = 0, tIn = 0;
  for (const name of [...b.agg.keys()].sort()) {
    const a = b.agg.get(name);
    summary.push([++n, name, a.ids, a.links || '', a.in]);
    tIds += a.ids; tLinks += a.links; tIn += a.in;
  }
  summary.push(['', `${b.sheet} Total`, tIds, tLinks || '', tIn]);
  summary.push(['', '', '', '', '']);
  gIds += tIds; gLinks += tLinks; gIn += tIn;
}
summary.push(['', 'Grand Total', gIds, gLinks || '', gIn]);

// ── Sheet 2: All Adobe Links ─────────────────────────────────────────────────
perAccount.forEach((r, i) => { r[0] = i + 1; });
const detail = [['S#', 'Email', 'Sheet', 'Region/Dist', 'Adobe Link', 'Logged In'], ...perAccount];

const wb = XLSX.utils.book_new();
const ws1 = XLSX.utils.aoa_to_sheet(summary);
ws1['!cols'] = [{ wch: 6 }, { wch: 20 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
XLSX.utils.book_append_sheet(wb, ws1, 'District-wise Report');

const ws2 = XLSX.utils.aoa_to_sheet(detail);
ws2['!cols'] = [{ wch: 7 }, { wch: 38 }, { wch: 8 }, { wch: 16 }, { wch: 60 }, { wch: 10 }];
XLSX.utils.book_append_sheet(wb, ws2, 'All Adobe Links');

fs.mkdirSync(path.dirname(OUT) || '.', { recursive: true });
XLSX.writeFile(wb, OUT);

console.log('──────────────────────────────────────────────');
console.log(`Accounts:      ${perAccount.length}`);
console.log(`Excluded (bad source data): ${skippedExcluded}`);
console.log(`Duplicate rows dropped:     ${skippedDupe}`);
console.log(`Pending (pre-retry): ${pending.size}`);
console.log(`Recovered in retries: ${recovered.size}`);
console.log(`LOGGED IN:     ${gIn}  (${((gIn * 100) / gIds).toFixed(2)}%)`);
console.log(`Adobe links:   ${gLinks}`);
console.log(`Wrote:         ${OUT}`);
console.log('──────────────────────────────────────────────');
