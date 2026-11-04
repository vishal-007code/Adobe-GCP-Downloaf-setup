#!/usr/bin/env python3
"""Weekly result report (.xlsx) in the layout of Result_Report_District_17-23_Oct_26.xlsx.

Two sheets, as in that reference:
  District-wise Report  per KV RO and per Bihar district: No. of IDs | Passed | Failed | Downloads,
                        all COUNTIFS formulas over All Accounts, with Total KV / Total Bihar / GRAND TOTAL
  All Accounts          S# | Email | Sheet (KV/Bihar) | Region/Dist | Test Status, plus a Download
                        column (Yes/No) so Downloads can differ from Passed: laptop runs are login only

Test Status comes from each run's report (scripts/build-run-report.mjs output):
  Login + Download, Login only -> Passed    Login failed -> Failed    Not run -> Not Attempted
An account in several runs keeps its best result.

Each run is one --run "ACCOUNTS CSV|RUN REPORT CSV". Re-run the script with every run of the
week to rebuild the workbook; laptop runs are added the same way once their run report is built.

Example:
  python scripts/build-weekly-report.py --week "31st Oct–6th Nov 2026" \
    --client "per-week-data/Activatio data Bihar ICT-31st Oct to 6th Nov 26.xlsx" \
    --out "per-week-data/Result_Report_District_31_Oct-6_Nov_26.xlsx" \
    --run "tmp/india-2region-20261031120722/accounts-master.csv|reports/run-report-gcp-20261031.csv" \
    --run "accounts2nov.csv|reports/run-report-gcp-20261102.csv" \
    --run "accounts3nov.csv|reports/run-report-gcp-20261103.csv"
"""
import argparse
import csv
import re
import sys

import openpyxl
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

# KV RO per email domain. The first group is how the 17-23 Oct reference named them; the
# second is read off the domain name (kvsro<city>, <city code>.kvs.ac.in) for domains the
# reference didn't have.
KV_RO = {
    'rokvsagra.in': 'Agra', 'bho.kvs.ac.in': 'Bhopal', 'cha.kvs.ac.in': 'Chandigarh',
    'kvsrochd.in': 'Chandigarh', 'deh.kvs.ac.in': 'Dehradun', 'hyd.kvs.ac.in': 'Hyderabad',
    'jam.kvs.ac.in': 'Jammu', 'luc.kvs.ac.in': 'Lucknow', 'mum.kvs.ac.in': 'Mumbai',
    # read off the domain
    'ahm.kvs.ac.in': 'Ahmedabad', 'che.kvs.ac.in': 'Chennai', 'gur.kvs.ac.in': 'Gurugram',
    'kol.kvs.ac.in': 'Kolkata', 'var.kvs.ac.in': 'Varanasi', 'kvsrobhubaneswar.in': 'Bhubaneswar',
    'kvsrodehradun.co.in': 'Dehradun', 'kvsrogurugram.in': 'Gurugram', 'kvsroguwahati.in': 'Guwahati',
    'kvsrohyd.in': 'Hyderabad', 'kvsrojaipuronline.in': 'Jaipur', 'kvsrokolkata.in': 'Kolkata',
    'kvsromumbai.in': 'Mumbai', 'kvsroranchi.in': 'Ranchi', 'kvsrosilchar.in': 'Silchar',
    'kvsrotinsukia.in': 'Tinsukia', 'kvsrovaranasi.in': 'Varanasi', 'elearnkvsroblr.in': 'Bengaluru',
}

# The 37 Bihar districts, as the reference lists them.
BIHAR_DISTRICTS = [
    'Araria', 'Arwal', 'Aurangabad', 'Banka', 'Begusarai', 'Bhagalpur', 'Bhojpur', 'Buxar', 'Darbhanga',
    'Gaya', 'Gopalganj', 'Jehanabad', 'Kaimur', 'Katihar', 'Khagaria', 'Kishanganj', 'Lakhisarai',
    'Madhepura', 'Madhubani', 'Munger', 'Muzaffarpur', 'Nalanda', 'Nawada', 'Paschim Champaran', 'Patna',
    'Purbi Champaran', 'Purnia', 'Rohtas', 'Saharsa', 'Samastipur', 'Saran', 'Sheikhpura', 'Sheohar',
    'Sitamarhi', 'Siwan', 'Supaul', 'Vaishali',
]
# Bihar district per email domain, from the reference; used when the client workbook lacks the account.
BIHAR_BY_DOMAIN = {
    'ar.patnaedu.in': 'Arwal', 'ar.purniaedu.in': 'Araria', 'au.magadhedu.in': 'Aurangabad',
    'ba.bhagalpuredu.in': 'Banka', 'be.mungeredu.in': 'Begusarai', 'bh.bhagalpuredu.in': 'Bhagalpur',
    'bh.patnaedu.in': 'Bhojpur', 'bu.patnaedu.in': 'Buxar', 'da.darbhangaedu.in': 'Darbhanga',
    'ga.magadhedu.in': 'Gaya', 'go.saranedu.in': 'Gopalganj', 'je.patnaedu.in': 'Jehanabad',
    'ka.patnaedu.in': 'Kaimur', 'ka.purniaedu.in': 'Katihar', 'kh.mungeredu.in': 'Khagaria',
    'ki.purniaedu.in': 'Kishanganj', 'la.mungeredu.in': 'Lakhisarai', 'ma.darbhangaedu.in': 'Madhubani',
    'ma.kosiedu.in': 'Madhepura', 'mu.mungeredu.in': 'Munger', 'mu.tirhutedu.in': 'Muzaffarpur',
    'na.magadhedu.in': 'Nawada', 'na.patnaedu.in': 'Nalanda', 'pa.patnaedu.in': 'Patna',
    'pa.tirhutedu.in': 'Paschim Champaran', 'pu.purniaedu.in': 'Purnia', 'pu.tirhutedu.in': 'Purbi Champaran',
    'ro.patnaedu.in': 'Rohtas', 'sa.darbhangaedu.in': 'Samastipur', 'sa.kosiedu.in': 'Saharsa',
    'sa.saranedu.in': 'Saran', 'sh.mungeredu.in': 'Sheikhpura', 'sh.tirhutedu.in': 'Sheohar',
    'si.saranedu.in': 'Siwan', 'si.tirhutedu.in': 'Sitamarhi', 'su.kosiedu.in': 'Supaul',
    'va.tirhutedu.in': 'Vaishali',
}

STATUS = {'Login + Download': 'Passed', 'Login only': 'Passed', 'Login failed': 'Failed', 'Not run': 'Not Attempted'}
RANK = {'Login + Download': 3, 'Login only': 2, 'Login failed': 1, 'Not run': 0}

ARIAL = Font(name='Arial', size=10)
ARIAL_BOLD = Font(name='Arial', size=10, bold=True)
THIN = Side(style='thin')
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
GREY = PatternFill('solid', fgColor='D9D9D9')
PEACH = PatternFill('solid', fgColor='F8CBAD')


def read_csv(path):
    with open(path, encoding='utf-8-sig', newline='') as handle:
        return list(csv.DictReader(handle))


def load_client_districts(path):
    canonical = {name.lower(): name for name in BIHAR_DISTRICTS}
    lookup = {}
    wb = openpyxl.load_workbook(path, read_only=True)
    for ws in wb.worksheets:
        for row in ws.iter_rows(min_row=2, values_only=True):
            if row and row[1] and row[3]:
                lookup.setdefault(str(row[1]).strip().lower(), canonical.get(str(row[3]).strip().lower()))
    return lookup


def classify(email, client):
    domain = email.split('@')[-1]
    if 'kvs' in domain:
        name = KV_RO.get(domain)
        if not name and (m := re.fullmatch(r'kvsro([a-z]+)\.(?:in|co\.in)', domain)):
            name = m.group(1).capitalize()
        return 'KV', name
    if domain.endswith('edu.in'):
        return 'Bihar', client.get(email) or BIHAR_BY_DOMAIN.get(domain)
    return None, None


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--week', required=True, help='for the title, e.g. "31st Oct–6th Nov 2026"')
    parser.add_argument('--client', required=True, help="the client's Bihar activation data workbook (districts)")
    parser.add_argument('--out', required=True)
    parser.add_argument('--run', action='append', required=True, help='ACCOUNTS CSV|RUN REPORT CSV')
    args = parser.parse_args()

    client = load_client_districts(args.client)
    accounts, unknown = {}, set()
    for spec in args.run:
        parts = spec.split('|')
        if len(parts) != 2:
            sys.exit(f'--run needs "ACCOUNTS CSV|RUN REPORT CSV", got: {spec}')
        emails = [r['Email'].strip().lower() for r in read_csv(parts[0]) if r.get('Email', '').strip()]
        report = {r['email'].strip().lower(): r for r in read_csv(parts[1])}
        missing = [e for e in emails if e not in report]
        if missing:
            sys.exit(f'{parts[1]} has no row for {len(missing)} account(s) of {parts[0]}, e.g. {missing[0]}')
        for email in emails:
            r = report[email]
            sheet, region = classify(email, client)
            if not region:
                unknown.add(email.split('@')[-1])
                continue
            previous = accounts.get(email)
            if previous is None or RANK[r['result']] > RANK[previous['result']]:
                accounts[email] = {'sheet': sheet, 'region': region, 'result': r['result'],
                                   'download': 'Yes' if r['downloaded'] == 'yes' else 'No'}
    if unknown:
        sys.exit('No KV RO / Bihar district known for these domains; add them to KV_RO or BIHAR_BY_DOMAIN: '
                 + ', '.join(sorted(unknown)))

    rows = sorted(accounts.items(), key=lambda item: (item[1]['sheet'] != 'KV', item[1]['region'], item[0]))
    last = len(rows) + 1
    wb = openpyxl.Workbook()
    report_ws = wb.active
    report_ws.title = 'District-wise Report'

    # ── All Accounts ──
    acc = wb.create_sheet('All Accounts')
    acc.append(['S#', 'Email', 'Sheet', 'Region/Dist', 'Test Status', 'Download'])
    for number, (email, a) in enumerate(rows, start=1):
        acc.append([number, email, a['sheet'], a['region'], STATUS[a['result']], a['download']])
    for col, width in zip('ABCDEF', [7, 38, 9, 22, 14, 11]):
        acc.column_dimensions[col].width = width
    for cells in acc.iter_rows(min_row=1, max_row=last):
        for cell in cells:
            cell.font, cell.border = (ARIAL_BOLD if cell.row == 1 else ARIAL), BORDER
            if cell.row == 1:
                cell.fill = GREY
        cells[0].alignment = Alignment(horizontal='right') if cells[0].row > 1 else Alignment()
    acc.freeze_panes = 'A2'
    acc.auto_filter.ref = f'A1:F{last}'

    # ── District-wise Report ──
    ws = report_ws
    ws.merge_cells('A1:F1')
    ws['A1'] = f'Adobe Activation Result Report – {args.week} (Region/District-wise)'
    ws['A1'].font = Font(name='Arial', size=12, bold=True)
    ws['A1'].fill = GREY
    ws['A1'].alignment = Alignment(horizontal='center')
    for col, width in zip('ABCDEF', [6, 30, 13, 12, 12, 12]):
        ws.column_dimensions[col].width = width

    rng = lambda col: f"'All Accounts'!${col}$2:${col}${last}"

    def counts(row, sheet):
        base = f'{rng("C")},"{sheet}",{rng("D")},$B{row}'
        return [f'=COUNTIFS({base})',
                f'=COUNTIFS({base},{rng("E")},"Passed")',
                f'=COUNTIFS({base},{rng("E")},"Failed")',
                f'=COUNTIFS({base},{rng("F")},"Yes")']

    def header(row, name_label):
        for col, text in enumerate(['S#', name_label, 'No. of IDs', 'Passed', 'Failed', 'Downloads'], start=1):
            cell = ws.cell(row=row, column=col, value=text)
            cell.font, cell.fill, cell.border = ARIAL_BOLD, PEACH, BORDER
            cell.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
        ws.row_dimensions[row].height = 30

    def section(start, sheet, names, total_label):
        for index, name in enumerate(names):
            row = start + index
            values = [index + 1, name] + counts(row, sheet)
            for col, value in enumerate(values, start=1):
                cell = ws.cell(row=row, column=col, value=value)
                cell.font, cell.border = ARIAL, BORDER
                if col >= 3:
                    cell.alignment = Alignment(horizontal='right')
        total = start + len(names)
        ws.cell(row=total, column=1).border = BORDER
        ws.cell(row=total, column=1).fill = GREY
        ws.cell(row=total, column=2, value=total_label)
        for col in range(3, 7):
            letter = 'CDEF'[col - 3]
            ws.cell(row=total, column=col, value=f'=SUM({letter}{start}:{letter}{total - 1})')
        for col in range(2, 7):
            cell = ws.cell(row=total, column=col)
            cell.font, cell.fill, cell.border = ARIAL_BOLD, GREY, BORDER
            if col >= 3:
                cell.alignment = Alignment(horizontal='right')
        return total

    kv_names = sorted({a['region'] for a in accounts.values() if a['sheet'] == 'KV'})
    header(3, 'KV RO Name')
    kv_total = section(4, 'KV', kv_names, 'Total KV')
    bihar_head = kv_total + 3
    header(bihar_head, 'Dist')
    bihar_total = section(bihar_head + 1, 'Bihar', BIHAR_DISTRICTS, 'Total Bihar')
    grand = bihar_total + 2
    ws.cell(row=grand, column=2, value='GRAND TOTAL')
    for col in range(3, 7):
        letter = 'CDEF'[col - 3]
        ws.cell(row=grand, column=col, value=f'={letter}{kv_total}+{letter}{bihar_total}')
    for col in range(2, 7):
        cell = ws.cell(row=grand, column=col)
        cell.font, cell.fill, cell.border = ARIAL_BOLD, GREY, BORDER
        if col >= 3:
            cell.alignment = Alignment(horizontal='right')

    wb.calculation.fullCalcOnLoad = True
    wb.save(args.out)

    # The same numbers computed here, to check the formulas against.
    def tally(sheet, region=None):
        sel = [a for a in accounts.values() if a['sheet'] == sheet and (region is None or a['region'] == region)]
        return (len(sel), sum(STATUS[a['result']] == 'Passed' for a in sel),
                sum(STATUS[a['result']] == 'Failed' for a in sel), sum(a['download'] == 'Yes' for a in sel))
    for name in kv_names:
        print(f'KV    {name:<18} IDs/Passed/Failed/Downloads = {tally("KV", name)}')
    print(f'Total KV                 {tally("KV")}')
    print(f'Total Bihar              {tally("Bihar")}')
    print(f'Not Attempted            {sum(STATUS[a["result"]] == "Not Attempted" for a in accounts.values())}')
    print(f'Wrote {args.out} ({len(rows)} accounts)')


if __name__ == '__main__':
    main()
