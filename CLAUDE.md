# CLAUDE.md — SOCN Worker Analysis

## How to work (method — applies to everything)

You are a **detective**, not a mechanic with a hammer. For any bug or surprising
result: (1) state the crime, (2) form a specific, falsifiable theory of the cause,
(3) collect targeted evidence (print/inspect real values, shapes, intermediate
outputs) to confirm or kill it, (4) only then fix — surgically. A beautiful theory
with no evidence is a guess, not a fix.

Design principles:
- Don't overengineer — simple beats complex.
- No fallbacks — one correct path, no silent alternates.
- One way — one way to do a thing, not many.
- Clarity over compatibility.
- Throw errors — fail fast when a precondition isn't met (missing column, wrong
  dtype, schema drift, non-unique keys). Never coerce silently.
- No backups — trust the primary mechanism.
- Separation of concerns — one function, one responsibility.
- Surgical changes only; minimal targeted logging; fix root causes, not symptoms.

If anything is unclear, **ask — do not assume.** Follow steps in order.

## Working mode

Local folder + CSVs. No Google Drive or GitHub connector — work from files in
this workspace; deliver files here. Do not try to "connect to drive." Nothing is
pushed to Git without explicit review. Never commit .env*; if in doubt, stop and ask.

## Layout

    root/
      CLAUDE.md              <- this file (must be here, capital name)
      source/                <- local raw month CSV(s), for offline dev/validation
      docs/
        RUNBOOK.md            <- plain-language ops guide for the non-technical successor
      n8n/
        socn-daily-sync.json  <- Schedule Trigger -> HTTP Request workflow (see Automation)
      render/                 <- the deployable unit (Render deploys THIS folder)
        app.py                 <- Flask sync service (Drive discovery + writes)
        test.py                 <- metric engine + report shaping (the "socn mvp")
        test_sync.py            <- app.py tests, mocked Google APIs
        requirements.txt

`test.py` lives inside `render/`, not at repo root — `render/app.py` does
`import test as engine`, and Render deploys `render/` as an isolated subtree,
so the engine has to travel with it. Local dev commands are `python
render/test.py`, run from repo root (relative `source/*.csv` paths still
resolve via CWD, not the script's location).

## Metric spec lives in the code

render/test.py's **module docstring is the single source of truth** for every
locked definition (buckets, rotation rule + Reading B, consecutive-day
week/month semantics, ISO weeks). Do not restate or fork those here — read
them there. The engine's actual input requirement is just `{name, date,
team}` (see the INPUT CONTRACT note in that docstring) — `_clean_raw()`'s
real output is richer (adds month/clockin/shift_name/shift_id) because the
sync layer's raw-tab writes need those fields, not because the engine does.

## Current state

- render/test.py = engine + report shaping. Self-tests pass (`python render/test.py`).
- Mock output already matches the layout of all three Summary CSVs.
- Reading B locked: "1 day" = count[team] == 1, non-rotated.
- load_raw(path) is built and evidence-checked against the real June BTS CSV:
  - วันที่ (`%d %b %y`) and วันที่.1 (ISO) encode the SAME date, just different
    formats -- not raw-string-identical. วันที่.1 is used as `date`.
  - Export pads with fully-blank trailer rows (4,499 of 10,912 for Jun) --
    dropped via ค้นหา.notna().
  - "FSOCE " (trailing space) vs "FSOCE" (no space) is a data-entry split of
    one shift name; for the latter, `team` is a literal `"#N/A"` string (a
    broken spreadsheet lookup formula baked into the export), not an empty
    cell -- confirmed via raw `csv` module read, bypassing pandas' NA
    inference. This only looked like a blank cell because `pd.read_csv`
    silently treats `"#N/A"` as NaN by default; that trick doesn't apply once
    input comes from the Sheets API instead of a CSV, so `_clean_raw` now
    normalizes `"#N/A"` -> NA explicitly before the FSOCE backfill.
    Discovered by round-tripping the same CSV through both `load_raw()` and
    `load_raw_from_values()` and diffing the output -- they silently
    disagreed until this was fixed.
  - 150 worker-days had two different teams same-day (double shift / OT past
    midnight). Resolved: keep the row with the EARLIEST เข้างาน (min
    time-of-day) as that date's team of record.
- **Resolved (was "known blocker" as of 2026-07-07):** `source/` only ever had
  one raw file ("...BTS - Jun 26.csv"), whose June load_raw() output (378
  workers) undershot Summary_1's June "All SOCN" total (2,757, ~7.3x) with 3
  whole teams entirely absent. Root cause, confirmed with the user: "BTS" is
  a staffing **vendor**, not the whole department -- each department has an
  open-ended number of vendor files (`[<DEPT> <YEAR>]_Daily name list_
  <VENDOR>`), and the local `source/` CSV was only ever one vendor's slice.
  Fixed by the dynamic multi-vendor discovery in `render/app.py` (see
  Automation below) -- not a logic bug, just an incomplete local sample.
- Summary CSVs themselves live in `~/Downloads/SOCN Burmese Worker Analysis
  Mar 26 - Jun 26 - Summary {1,5,Rotation}.csv`, not in this repo's `source/`
  or `docs/` -- ask the user before copying them in.

## Input — one raw CSV drives all three views

All three views are aggregations of the SAME monthly raw attendance log.
Only the first 10 columns are used:
`วันที่ · ค้นหา · เข้างาน · shift name · วันที่ · BTS · Shift_id · team · กะ · เวลาเข้า-ออกงาน`

RESOLVED mapping to the engine's clean contract (name, date, team):
- name  = ค้นหา  (the "search" column IS the worker key)
- date  = วันที่
- team  = team
- A show-up = a (ค้นหา, วันที่) row EXISTS -> that worker showed up that date.
  No clock-in filter; half-day irrelevant; every used row = one show-up day.
- Dedup to one row per (ค้นหา, วันที่).

Evidence checks load_raw() MUST do (fail fast, don't assume):
- There are TWO วันที่ columns (pandas will suffix the 2nd as `วันที่.1`).
  Verify they are identical; if they differ, STOP and ask which is the show-up date.
- After dedup, (name, date) must be unique — throw if not.
- Do not surface รหัส 13 หลัก (national ID) anywhere.

## Next task (in order)

Steps 1-4 (load_raw, three-view validation, gspread write, auto new-tab
pickup) are done -- see Automation below. Remaining, in order:

1. User completes the pre-deployment/rollout checklist in the plan this was
   built from (Google/Drive sharing, git push, Render env vars, manual
   `/sync` smoke test, n8n wiring) -- see "Your step-by-step" in that plan.
2. First live `/sync` run against real credentials -- NOT yet done, since
   this was all built and tested against mocked Google APIs. Cross-check the
   response against what's actually in Drive before trusting the daily
   schedule.
3. Confirm exact department spelling (`SOCN`/`SOCE`/`SOCW`/`FSOCW`) against
   the real raw file titles once visible -- this session took the user's word
   for "FSOCW", flagged as unconfirmed against live data.

## Automation (Render + n8n)

Architecture: a small Flask service (`render/app.py`) deployed on Render,
triggered daily by n8n (company-hosted, no local/Docker access -- HTTP
Request node is the only viable trigger path). n8n owns
scheduling/retries/alerting only; all business logic stays in
`render/test.py` (one way, no duplicate logic in n8n JS nodes).

Raw side -- **dynamic discovery, no static IDs.** Raw data is one Google
Sheet per (department, staffing vendor), titled `[<DEPT> <YEAR>]_Daily name
list_<VENDOR>` (e.g. `[SOCE 2026]_Daily name list_BTS`; BTS/CYD/SPT/DSR/etc
are staffing vendors, NOT physical sites -- see the resolved blocker above).
The vendor list is open-ended and not enumerated in code. `app.py` searches
Drive for any spreadsheet whose name contains `_Daily name list_`
(`_list_raw_candidates`), parses `[DEPT YEAR]_..._VENDOR` out of the title
via `RAW_TITLE_RE`, and throws if a match fails that strict pattern or has an
unrecognized department -- silently skipping a malformed match is exactly
the failure mode that produced the original 7.3x-undershoot bug, so it's a
hard error, not a skip. No folder ID scopes this search (asked the user 3
times for one; the answer was consistently "use my root directory," which
isn't an addressable Drive object for a service account) -- visibility is
entirely governed by what's shared with the service account. Each matched
file still uses the original per-tab-is-a-month convention (`_is_month_tab`,
tries `%b %y` then `%B %y`, e.g. "Jun 26" / "July 26"). Year is derived from
each row's actual date, not trusted from the title.

Central side -- **one spreadsheet per year, human-created, service account
only writes to it.** Lives inside a fixed Central Drive folder
(`1oDCnJmwIjedcHNtSyd_Hr-B5HDhZIN4K`), titled exactly the year (e.g.
`"2027"`). `_find_central` searches that folder for an exact-title match and
throws a clear, actionable error if it's missing -- it does NOT call
`gc.create()`. **Reversed from the original design (auto-create) after live
testing:** a bare service account has ~0 Drive storage quota of its own; a
file it creates is owned by it and fails with "storage quota exceeded"
regardless of how much space the folder itself has -- confirmed live via a
real 403. Writing to an already-existing, human-owned file doesn't touch
that quota at all, so the one remaining manual step per new year is: a human
duplicates last year's central sheet (or makes a blank one), titles it
exactly the year, shares it with the service account as Editor -- documented
in docs/RUNBOOK.md. (If the company's Workspace plan includes Shared
Drives, auto-create could be restored by putting the Central folder on one --
Shared Drive files are owned by the Shared Drive itself, not any individual
account -- untested, not pursued since it's a paid Workspace tier and the
project's constraint is to stay free.) `drive` scope (not `drive.readonly`)
is still needed for the write operations `_write_df`/`_find_central` do (and
originally for `create`, no longer called, but the write scope stays
required regardless). Each central spreadsheet holds exactly 7 tabs:
  - 4 raw-consolidated department tabs, named exactly `SOCN`/`SOCE`/`SOCW`/
    `FSOCW`, aggregating every vendor file for that department/year. Header
    (user-specified, verbatim): `Date show up | Month show up | Sub-con name
    | Name | Clock in | shift name | Shift_id | team` (built by
    `_to_raw_tab` from `RAW_TAB_COLUMNS`). Always written, even empty
    (header-only), so the 7-tab shape never silently varies run to run.
  - 3 summary tabs (`Summary_1`, `Summary_Rotation`, `Summary_5`), same
    `showup_block`/`rotation_summary`/`streak_month_crosstab` computation as
    before, scoped to that year's combined data across all 4 departments.

Every `/sync` call recomputes every discovered year from scratch (no
incremental state -- `ws.clear()` before every write, matches the project's
"no fallbacks" stance). Config is env vars, not code constants, so a
non-technical successor can change them from Render's dashboard without a
redeploy: `GOOGLE_SERVICE_ACCOUNT_JSON`, `CENTRAL_FOLDER_ID`,
`RAW_DEPARTMENTS` (comma-separated, e.g. `SOCN,SOCE,SOCW,FSOCW`),
`SYNC_TOKEN` (Bearer auth on `/sync`).

Dry-run tested end-to-end with Google APIs mocked (`render/test_sync.py`),
including against the real June BTS CSV content routed through the new
multi-vendor flow as a single-vendor case -- output matches the
manually-verified numbers from the earlier diff (378 workers, same buckets).
The multi-vendor/multi-year grouping is still only exercised against
synthetic fixtures locally (only one real raw file exists in `source/`) --
confirmed instead against real data live in production, per real bugs below.

`n8n/socn-daily-sync.json`: Schedule Trigger (daily 06:00) -> HTTP Request
(POST to the Render URL, httpHeaderAuth credential named "SOCN Sync Token"
holding `Authorization: Bearer <SYNC_TOKEN>`). Fire-and-forget -- no
downstream node parses the response body, so it needed no changes across the
dynamic-discovery redesign. URL is a placeholder until the Render service is
deployed.

User is handling: GCP service account creation/sharing (Editor on the
Central folder and every raw vendor file), moving the existing 2026 central
sheet into the Central folder, Render deployment, git repo/push, n8n
credential setup -- all deliberately left to them (external/credentialed
actions). Full step-by-step in the plan this redesign was built from.

Real bugs found and fixed while building this:
  - 170 "FSOCE" rows have team = literal `"#N/A"` (broken spreadsheet lookup
    formula), not an empty cell -- see the load_raw section above.
  - `_MONTH_NAME` was a hardcoded dict covering only 2026-03..06; replaced
    with `_month_label()` derived from the month string itself, since this
    automation exists specifically to handle months/years beyond that range.
  - Found live against real vendor data, in order: (1) วันที่'s display
    format isn't fixed -- local CSV sample was "01 Jun 26", a live vendor
    sheet (DSR) actually uses "1-Jan-26" (hyphens, no leading zero); switched
    to per-element format inference (`format="mixed", dayfirst=True`) instead
    of a hardcoded strptime pattern. (2) Some vendor exports have a title/
    banner row above the real header (also DSR) -- `_find_header_row` now
    scans the first few rows for the one whose columns match the required
    set, instead of assuming row 0 is always the header; unified `load_raw`
    and `load_raw_from_values` around this shared detection. (3) Central
    spreadsheet auto-create hit a real Drive storage-quota wall -- see the
    Central-side paragraph above; reverted to human-creates/service-account-
    only-writes.
  - Raw-load errors originally had no file/tab context, making live failures
    hard to diagnose without direct Sheets access -- `load_raw_from_values`
    calls in `run_sync` are now wrapped to prefix errors with the
    spreadsheet title, tab, department, and vendor.

Deployed 2026-07-08 to Render (`https://burmese-8ere.onrender.com`), pushed
to `github.com/pawarisklampol49-maker/burmese` (main branch; `render/` as
Render's configured Root Directory; `source/` gitignored -- real worker
names, never pushed). First live `/sync` call correctly threw "no raw vendor
spreadsheets found" -- confirms auth/env vars are fine, the gap was raw files
not yet shared with the service account (a one-time per-file action, tracked
in the runbook).

Considered and rejected: moving Drive discovery into n8n (OAuth-based, like
the user's separate unrelated "Resolve Monthly File IDs" workflow) to avoid
the service-account sharing step. Rejected because it would still need some
authorized identity to actually read file contents via gspread (sharing
doesn't disappear, only discovery would move), and trades a simple
per-file-share action for JS Code-node logic a non-technical successor can't
maintain. Real constraint behind the ask: the user's company Gmail will be
deactivated after handoff. Resolved without an architecture change -- the
service account's identity/key and all Drive sharing are already independent
of any human Google login; the only actual risk is GCP *project* ownership,
covered in docs/RUNBOOK.md's pre-handoff checklist (add a second Owner on
the GCP project, Render, and GitHub before the account is deactivated).

## Testing & secrets

- Everything locally runnable. Flag any env change; the user tests locally.
- No secrets yet. gspread service-account JSON appears at the Sheets-write step —
  guide creating it as a local file / GH secret, never committed.