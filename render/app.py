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
import time
from collections import defaultdict
from datetime import datetime

import gspread
import pandas as pd
from flask import Flask, jsonify, request
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from gspread.exceptions import APIError

import test as engine

app = Flask(__name__)

_RETRYABLE_STATUS = {429, 500, 502, 503, 504}


def _retry(fn, *args, max_tries: int = 4, base_delay: float = 2.0, **kwargs):
    """Google's Sheets/Drive APIs occasionally return a transient 429/5xx
    under load -- confirmed live (503) once a sync started touching many
    vendor files/tabs in one run. Retries with exponential backoff instead
    of failing the whole /sync call outright; anything else (auth, 404,
    permission) is a real problem and re-raises immediately, not retried."""
    for attempt in range(max_tries):
        try:
            return fn(*args, **kwargs)
        except (APIError, HttpError) as e:
            status = e.code if isinstance(e, APIError) else e.status_code
            if status not in _RETRYABLE_STATUS or attempt == max_tries - 1:
                raise
            time.sleep(base_delay * (2 ** attempt))

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
        resp = _retry(drive.files().list(
            q=query, pageSize=1000, pageToken=page_token,
            fields="nextPageToken, files(id, name)",
        ).execute)
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
    matches = _retry(gc.list_spreadsheet_files, title=year, folder_id=folder_id)
    if len(matches) > 1:
        raise ValueError(f"{len(matches)} spreadsheets titled '{year}' in the central folder -- ambiguous")
    if not matches:
        raise ValueError(
            f"no spreadsheet titled '{year}' in the central folder -- a service account can't "
            f"create one there itself (Drive storage quota is tied to the service account, not "
            f"the folder). Create '{year}' there manually (e.g. duplicate last year's sheet) and "
            f"share it with the service account as Editor, then re-run"
        )
    return _retry(gc.open_by_key, matches[0]["id"])


def _to_raw_tab(df: pd.DataFrame) -> pd.DataFrame:
    return df.rename(columns=RAW_TAB_COLUMNS)[list(RAW_TAB_COLUMNS.values())]


def _batch_get_month_tabs(sh: gspread.Spreadsheet, titles: list) -> dict:
    """Read every matched month tab from one vendor spreadsheet in a single
    API call, instead of one get_all_values() call per tab -- confirmed
    live as the single biggest contributor to /sync exceeding even a 500s
    gunicorn timeout with enough real vendor files/tabs (every WORKER
    TIMEOUT crash was inside get_all_values()). Google's batchGet response
    returns valueRanges in the same order as the requested titles, so
    matching by position is safe and avoids re-parsing quoted range
    strings. Returns {title: values} for every input title (empty list for
    a tab with no data)."""
    if not titles:
        return {}
    resp = _retry(sh.values_batch_get, titles)
    value_ranges = resp.get("valueRanges", [])
    return {title: vr.get("values", []) for title, vr in zip(titles, value_ranges)}


def _quoted_range(title: str, cell: str = "") -> str:
    """A1-notation range for a whole tab (or a start cell in it), with the
    sheet title single-quoted per Sheets syntax ('' escapes a literal ')."""
    quoted = "'" + title.replace("'", "''") + "'"
    return f"{quoted}!{cell}" if cell else quoted


_SUMMARY_TABS = ["Summary_1", "Summary_Rotation", "Summary_5"]
_DEFAULT_GRID = {"rowCount": 1000, "columnCount": 26}


def _prepare_central(spreadsheet: gspread.Spreadsheet, dept_names: list) -> None:
    """Reset one year's central spreadsheet to a known-empty 7-tab shape and
    write the 4 department headers, in ~4 API calls -- done once per year,
    before any streamed department-row appends. The department tabs are then
    grown row-by-row via values.append (which auto-extends the grid), so we
    never have to hold a whole year's raw rows in memory to size or write
    them (the free-tier 512MB OOM this streaming design exists to avoid).
    Summary tabs are created here but written at the end from the slim
    {name,date,team} slice."""
    all_titles = list(dept_names) + _SUMMARY_TABS
    existing = {ws.title: ws.id for ws in _retry(spreadsheet.worksheets)}

    requests = []
    for title in all_titles:
        if title in existing:
            requests.append({"updateSheetProperties": {
                "properties": {"sheetId": existing[title], "gridProperties": _DEFAULT_GRID},
                "fields": "gridProperties.rowCount,gridProperties.columnCount",
            }})
        else:
            requests.append({"addSheet": {"properties": {"title": title, "gridProperties": _DEFAULT_GRID}}})
    _retry(spreadsheet.batch_update, {"requests": requests})

    _retry(spreadsheet.values_batch_clear, body={"ranges": [_quoted_range(t) for t in all_titles]})

    header = list(RAW_TAB_COLUMNS.values())
    _retry(spreadsheet.values_batch_update, body={
        "valueInputOption": "RAW",
        "data": [{"range": _quoted_range(d, "A1"), "values": [header]} for d in dept_names],
    })


def _append_dept_rows(spreadsheet: gspread.Spreadsheet, dept: str, df: pd.DataFrame) -> None:
    """Append one vendor file's rows to a department tab (RAW input option --
    IDs like Shift_id/team must not be reinterpreted as numbers). One call
    per vendor file; the caller releases the vendor frame right after, so raw
    rows never all coexist in memory. INSERT_ROWS grows the sheet grid as
    needed, so the modest _DEFAULT_GRID set in _prepare_central is fine."""
    if df.empty:
        return
    values = df.astype(str).values.tolist()
    _retry(spreadsheet.values_append,
           _quoted_range(dept, "A1"),
           {"valueInputOption": "RAW", "insertDataOption": "INSERT_ROWS"},
           {"values": values})


def _write_summary_tabs(spreadsheet: gspread.Spreadsheet, tabs: list) -> None:
    """Write the 3 summary tabs (title, df) in one USER_ENTERED batch, so
    counts/percentages land as real numbers rather than apostrophe-prefixed
    text. They're tiny (per-month / per-team rows) and comfortably fit the
    _DEFAULT_GRID from _prepare_central, so no resize is needed."""
    _retry(spreadsheet.values_batch_update, body={
        "valueInputOption": "USER_ENTERED",
        "data": [{
            "range": _quoted_range(title, "A1"),
            "values": [[str(c) for c in df.columns]] + df.astype(str).values.tolist(),
        } for title, df in tabs],
    })


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

    # Streamed to stay under Render free tier's 512MB: the heavy raw rows
    # (all columns) are appended to each department tab per vendor file and
    # released immediately, so they never all coexist in memory. Only the
    # slim {name,date,team} slice is accumulated for the whole year -- that's
    # all the 3 summary tabs' engine functions need, and it's small even for
    # hundreds of thousands of worker-days.
    dept_names = sorted(known_departments)
    central_by_year = {}                  # year -> prepared central spreadsheet
    slim_by_year = defaultdict(list)      # year -> list of slim {name,date,team} frames
    depts_by_year = defaultdict(set)      # year -> departments that had data
    file_report = []

    def _central_for(year):
        if year not in central_by_year:
            central = _find_central(gc, central_folder_id, year)
            _prepare_central(central, dept_names)
            central_by_year[year] = central
        return central_by_year[year]

    for dept, vendor, declared_year, file_id, title in parsed_files:
        sh = _retry(gc.open_by_key, file_id)
        month_titles = [ws.title for ws in _retry(sh.worksheets) if _is_month_tab(ws.title)]
        values_by_title = _batch_get_month_tabs(sh, month_titles)
        vendor_frames, matched_tabs = [], []
        for tab_title in month_titles:
            values = values_by_title.get(tab_title, [])
            if not values:
                continue
            try:
                clean = engine.load_raw_from_values(values)
            except Exception as e:
                raise ValueError(f"'{title}' tab '{tab_title}' (dept={dept}, vendor={vendor}): {e}") from e
            clean["department"], clean["vendor"] = dept, vendor
            vendor_frames.append(clean)
            matched_tabs.append(tab_title)
        del values_by_title
        if not matched_tabs:
            raise ValueError(
                f"'{title}' (dept={dept}, vendor={vendor}) matched raw discovery but has no "
                f"month tabs -- schema drift or an empty file"
            )
        file_report.append({"title": title, "department": dept, "vendor": vendor,
                             "declared_year": declared_year, "tabs": matched_tabs})

        vendor_df = pd.concat(vendor_frames, ignore_index=True)
        del vendor_frames
        vendor_df["_year"] = pd.to_datetime(vendor_df["date"]).dt.year.astype(str)
        for year, ydf in vendor_df.groupby("_year"):
            central = _central_for(year)
            _append_dept_rows(central, dept, _to_raw_tab(ydf))
            slim_by_year[year].append(ydf[["name", "date", "team"]].copy())
            depts_by_year[year].add(dept)
        del vendor_df

    year_results = {}
    for year in sorted(central_by_year):
        slim = pd.concat(slim_by_year[year], ignore_index=True)
        dup = slim.duplicated(subset=["name", "date"]).sum()
        if dup:
            raise ValueError(f"{year}: {dup} duplicate (name,date) rows across department/vendor files")

        counts, pct = engine.showup_block(slim)
        pct_renamed = pct.add_suffix(" %")
        showup = pd.concat([counts, pct_renamed], axis=1).reset_index(names="bucket")
        _write_summary_tabs(central_by_year[year], [
            ("Summary_1", showup),
            ("Summary_Rotation", engine.rotation_summary(slim)),
            ("Summary_5", engine.streak_month_crosstab(slim)),
        ])

        year_results[year] = {
            "spreadsheet_id": central_by_year[year].id,
            "departments": sorted(depts_by_year[year]),
            "months": sorted(pd.to_datetime(slim["date"]).dt.strftime("%Y-%m").unique().tolist()),
            "workers": int(slim["name"].nunique()),
            "rows": len(slim),
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
