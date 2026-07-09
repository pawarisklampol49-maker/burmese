"""
SOCN sync service -- discovers raw vendor spreadsheets in Drive (one file per
department x staffing vendor, named "[<DEPT> <YEAR>]_Daily name list_<VENDOR>"),
runs test.py's engine, writes a 7-tab spreadsheet per year (4 raw-consolidated
department tabs + 3 summary tabs) into a fixed Central Drive folder, creating
that year's spreadsheet if it doesn't exist yet. Meant to be deployed on
Render and triggered daily by an n8n HTTP Request node (see
n8n/socn-daily-sync.json).

Config (env vars, set in Render's dashboard -- never commit these):
  GOOGLE_SERVICE_ACCOUNT_JSON  full service-account JSON, as one string
  CENTRAL_FOLDER_ID            Drive folder yearly central spreadsheets live in
  RAW_DEPARTMENTS              comma-separated known department codes,
                                e.g. "SOCN,SOCE,SOCW,FSOCW"
  SYNC_TOKEN                   shared secret; caller must send
                                Authorization: Bearer <SYNC_TOKEN>
"""
import json
import os
import re
from collections import defaultdict
from datetime import datetime

import gspread
import pandas as pd
from flask import Flask, jsonify, request
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

import test as engine

app = Flask(__name__)

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",   # not drive.readonly -- gc.create()
                                                 # for new central sheets is a
                                                 # Drive *write* operation.
]
MONTH_TAB_FORMATS = ["%b %y", "%B %y"]  # "Jun 26", "July 26"

RAW_TITLE_RE = re.compile(
    r"^\[(?P<dept>[A-Za-z]+)\s+(?P<year>\d{4})\]_Daily name list_(?P<vendor>.+)$"
)
RAW_TITLE_SEARCH_TERM = "_Daily name list_"

# sync-layer display header for the 4 raw-consolidated central tabs -- this
# wording is a display concern, not part of test.py's engine contract.
RAW_TAB_COLUMNS = {
    "date": "Date show up", "month": "Month show up", "vendor": "Sub-con name",
    "name": "Name", "clockin": "Clock in", "shift_name": "shift name",
    "shift_id": "Shift_id", "team": "team",
}


def _clients():
    info = json.loads(os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"])
    creds = Credentials.from_service_account_info(info, scopes=SCOPES)
    gc = gspread.authorize(creds)
    drive = build("drive", "v3", credentials=creds, cache_discovery=False)
    return gc, drive


def _is_month_tab(title: str) -> bool:
    title = title.strip()
    for fmt in MONTH_TAB_FORMATS:
        try:
            datetime.strptime(title, fmt)
            return True
        except ValueError:
            continue
    return False


def _parse_raw_title(title: str):
    m = RAW_TITLE_RE.match(title.strip())
    if not m:
        return None
    return m.group("dept").upper(), m.group("year"), m.group("vendor").strip()


def _list_raw_candidates(drive) -> list:
    query = (f'mimeType="application/vnd.google-apps.spreadsheet" '
             f'and name contains "{RAW_TITLE_SEARCH_TERM}" and trashed=false')
    files, page_token = [], None
    while True:
        resp = drive.files().list(
            q=query, pageSize=1000, pageToken=page_token,
            fields="nextPageToken, files(id, name)",
        ).execute()
        files.extend(resp["files"])
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    return files


def _find_central(gc: gspread.Client, folder_id: str, year: str) -> gspread.Spreadsheet:
    """Find that year's central spreadsheet -- does NOT create one. A bare
    service account has ~0 Drive storage quota of its own; a file it CREATES
    is owned by it and fails with "storage quota exceeded" regardless of how
    much space the folder itself has (confirmed live). Writing to an
    already-existing, human-created file doesn't touch that quota at all, so
    that's the one manual step per new year: duplicate last year's central
    sheet (or create a blank one), title it exactly the year, share it with
    the service account as Editor. See docs/RUNBOOK.md."""
    matches = gc.list_spreadsheet_files(title=year, folder_id=folder_id)
    if len(matches) > 1:
        raise ValueError(f"{len(matches)} spreadsheets titled '{year}' in the central folder -- ambiguous")
    if not matches:
        raise ValueError(
            f"no spreadsheet titled '{year}' in the central folder -- a service account can't "
            f"create one there itself (Drive storage quota is tied to the service account, not "
            f"the folder). Create '{year}' there manually (e.g. duplicate last year's sheet) and "
            f"share it with the service account as Editor, then re-run"
        )
    return gc.open_by_key(matches[0]["id"])


def _to_raw_tab(df: pd.DataFrame) -> pd.DataFrame:
    return df.rename(columns=RAW_TAB_COLUMNS)[list(RAW_TAB_COLUMNS.values())]


def _write_df(spreadsheet: gspread.Spreadsheet, tab: str, df: pd.DataFrame) -> None:
    ws = spreadsheet.worksheet(tab) if tab in [w.title for w in spreadsheet.worksheets()] \
        else spreadsheet.add_worksheet(tab, rows=max(len(df) + 10, 50), cols=max(len(df.columns) + 5, 20))
    ws.clear()
    values = [[str(c) for c in df.columns]] + df.astype(str).values.tolist()
    ws.update(values)


def run_sync() -> dict:
    gc, drive = _clients()
    central_folder_id = os.environ["CENTRAL_FOLDER_ID"]
    known_departments = {d.strip().upper() for d in os.environ["RAW_DEPARTMENTS"].split(",") if d.strip()}

    candidates = _list_raw_candidates(drive)

    parsed_files = []  # (dept, vendor, declared_year, file_id, title)
    for f in candidates:
        parsed = _parse_raw_title(f["name"])
        if parsed is None:
            raise ValueError(
                f"'{f['name']}' (id {f['id']}) matched raw discovery search but doesn't match "
                f"the expected '[DEPT YEAR]_Daily name list_VENDOR' pattern -- rename it or "
                f"narrow the discovery query"
            )
        dept, declared_year, vendor = parsed
        if dept not in known_departments:
            raise ValueError(
                f"unrecognized department '{dept}' parsed from '{f['name']}' -- "
                f"expected one of {sorted(known_departments)}"
            )
        parsed_files.append((dept, vendor, declared_year, f["id"], f["name"]))

    if not parsed_files:
        raise RuntimeError(
            "no raw vendor spreadsheets found via Drive search -- "
            "check that they're shared with the service account"
        )

    frames_by_year = defaultdict(list)
    file_report = []
    for dept, vendor, declared_year, file_id, title in parsed_files:
        sh = gc.open_by_key(file_id)
        matched_tabs = []
        for ws in sh.worksheets():
            if not _is_month_tab(ws.title):
                continue
            values = ws.get_all_values()
            if not values:
                continue
            try:
                clean = engine.load_raw_from_values(values)
            except Exception as e:
                raise ValueError(f"'{title}' tab '{ws.title}' (dept={dept}, vendor={vendor}): {e}") from e
            clean["department"], clean["vendor"] = dept, vendor
            years = pd.to_datetime(clean["date"]).dt.year.astype(str)
            for yr in years.unique():
                frames_by_year[yr].append(clean[years == yr])
            matched_tabs.append(ws.title)
        if not matched_tabs:
            raise ValueError(
                f"'{title}' (dept={dept}, vendor={vendor}) matched raw discovery but has no "
                f"month tabs -- schema drift or an empty file"
            )
        file_report.append({"title": title, "department": dept, "vendor": vendor,
                             "declared_year": declared_year, "tabs": matched_tabs})

    year_results = {}
    for year, frames in sorted(frames_by_year.items()):
        combined = pd.concat(frames, ignore_index=True)
        dup = combined.duplicated(subset=["name", "date"]).sum()
        if dup:
            raise ValueError(f"{year}: {dup} duplicate (name,date) rows across department/vendor files")

        central = _find_central(gc, central_folder_id, year)

        for dept in sorted(known_departments):
            dept_rows = combined[combined["department"] == dept]
            _write_df(central, dept, _to_raw_tab(dept_rows))

        counts, pct = engine.showup_block(combined)
        pct_renamed = pct.add_suffix(" %")
        showup = pd.concat([counts, pct_renamed], axis=1).reset_index(names="bucket")
        _write_df(central, "Summary_1", showup)
        _write_df(central, "Summary_Rotation", engine.rotation_summary(combined))
        _write_df(central, "Summary_5", engine.streak_month_crosstab(combined))

        year_results[year] = {
            "spreadsheet_id": central.id,
            "departments": sorted(combined["department"].unique().tolist()),
            "months": sorted(pd.to_datetime(combined["date"]).dt.strftime("%Y-%m").unique().tolist()),
            "workers": int(combined["name"].nunique()),
            "rows": len(combined),
        }

    return {"years": year_results, "files": file_report}


def _authorized(req) -> bool:
    token = req.headers.get("Authorization", "")
    return token.removeprefix("Bearer ").strip() == os.environ["SYNC_TOKEN"]


@app.route("/sync", methods=["POST"])
def sync():
    if not _authorized(request):
        return jsonify({"error": "unauthorized"}), 401
    try:
        result = run_sync()
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    return jsonify({"status": "ok", **result})


@app.route("/health")
def health():
    return jsonify({"status": "alive"})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
