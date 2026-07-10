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
        RUNBOOK.md              <- plain-language ops guide for the non-technical successor
        visualizations.html    <- worked examples of the 3 Summary tabs, real numbers from
                                   `python render/test.py`'s mock run -- illustrates the locked
                                   definitions in test.py's docstring, never forks them. Add a
                                   new tab here per the "Adding a fourth aspect" footer whenever
                                   a new metric gets wired into a Summary tab in run_sync().
      n8n/
        soc-daily-sync.json   <- Schedule Trigger -> HTTP Request workflow (see Automation)
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

Central side -- **one spreadsheet per year, auto-created by n8n, service
account only writes to it.** Lives inside a fixed Central Drive folder
(`1oDCnJmwIjedcHNtSyd_Hr-B5HDhZIN4K`), titled exactly the year (e.g.
`"2027"`). `_find_central` (render/app.py) searches that folder for an
exact-title match and throws a clear, actionable error if it's missing -- it
does NOT call `gc.create()`. Root cause, confirmed live via a real 403: a
bare service account has ~0 Drive storage quota of its own; a file it
creates is owned by it and fails with "storage quota exceeded" regardless of
how much space the folder itself has. Writing to an already-existing file
doesn't touch that quota at all, so `render/app.py` can never be the thing
that creates the yearly sheet.

**Auto-create is restored, but at the n8n layer, not the service account.**
`n8n/soc-daily-sync.json` now does the create-if-missing check itself using
n8n's own Google Sheets/Drive OAuth credentials (a human-authorized identity
with real Drive quota, unlike the service account): `Set Year` -> `Search
Sheet In Folder` (Drive query for a spreadsheet named exactly the year in
the Central folder, `alwaysOutputData: true` so a zero-match search still
produces an item with no `id` instead of stalling the workflow) -> `Exists?`
(IF node on `$json.id` empty) -> if missing: `Create Sheet` (Google Sheets
node, creates a blank spreadsheet titled the year) -> `Move Into Folder`
(Google Drive node, moves it into the Central folder) -> either branch
converges on calling `/sync`. This works because Drive folder-level sharing
is inherited by whatever's inside the folder, present or future -- since the
Central folder is already shared with the service account as Editor, a
sheet created elsewhere and moved in should become writable by the service
account without any separate per-file share. **Not yet confirmed live** --
the next real daily run (or a manual trigger) is the actual test; if
`_find_central` still throws "no spreadsheet titled" right after a fresh
`Create Sheet` + `Move Into Folder`, that theory is wrong and the moved file
needs an explicit share step added to the n8n workflow.

Open question, unresolved: `n8n/soc-daily-sync.json`'s `Create Sheet` /
`Move Into Folder` nodes use n8n-stored Google OAuth credentials
("Google Sheets account 215" / "Google Drive account 104") tied to whichever
human Google account authorized them in n8n. If that's the user's *company*
Gmail (the one scheduled for deactivation post-handoff -- see the
Gmail-shutdown paragraph below), auto-create breaks once that account is
gone, even though the service account's daily write to existing sheets keeps
working -- silently reintroducing the exact risk the original
service-account-only design was meant to avoid. Needs to be confirmed with
the user and, if so, added to docs/RUNBOOK.md's pre-handoff checklist
(reconnect those two n8n credentials to a durable account before the company
Gmail is deactivated).

(If the company's Workspace plan includes Shared Drives, the *service
account* could instead own auto-create by putting the Central folder on
one -- Shared Drive files are owned by the Shared Drive itself, not any
individual account -- untested, not pursued since it's a paid Workspace tier
and the project's constraint is to stay free; n8n's own OAuth nodes turned
out to be the free path to the same result.) `drive` scope (not
`drive.readonly`) is still needed on the service account for the write
operations `_prepare_central`/`_append_dept_rows`/`_write_summary_tabs`/
`_find_central` do. Each central spreadsheet holds exactly 7 tabs:
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
incremental state -- `_prepare_central` clears all 7 tabs before any write,
matches the project's "no fallbacks" stance). Writes are streamed, not
accumulated, to stay under Render free tier's 512MB (see the OOM entry in
"Real bugs" below): heavy raw rows are appended per vendor file and
released; only the slim `{name,date,team}` slice is held for the summaries. Config is env vars, not code constants, so a
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

`n8n/soc-daily-sync.json` (renamed "SOC Daily Sync" by the user; single
merged "Call SOC Sync" node reached from both the Exists?-true and
Exists?-false branches): Schedule Trigger (daily 11:00, moved from the
original 06:00) -> `Set Year` -> the create-if-missing central-sheet check
described above -> HTTP Request POST to `/sync` (httpHeaderAuth credential
"Header Auth account 17"
holding `Authorization: Bearer <SYNC_TOKEN>`; `retryOnFail: true, maxTries:
3, waitBetweenTries: 5000`, `timeout: 340000` -- raised from an original
180000/30000 pairing after a live 500 turned out to be gunicorn's default
30s worker timeout killing the request mid-sync, not an app error; Render's
Start Command must carry a matching `--timeout 300` flag, e.g. `gunicorn
--bind 0.0.0.0:$PORT --timeout 300 app:app`). Fire-and-forget -- no
downstream node parses the response body.

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
  - วันที่.1 (the ISO date column, used as `date`) can itself be a broken
    spreadsheet formula evaluating to `"#REF!"` -- confirmed live in
    `[SOCE 2026]_Daily name list_BTS`, tab `Jul 26`. Same failure class as
    team's `"#N/A"`. The affected row still had a real name (survived the
    `ค้นหา.notna()` filter) and วันที่ (the sibling display-format date column)
    parsed fine for every row -- so `_clean_raw` recovers from the sibling
    column for just those rows instead of throwing or silently dropping a
    real worker's show-up day. Covered by `_test_ref_date_fallback`.
  - Generalized after a second, different vendor file (`[SOCE
    2026]_Daily name list_CYD`, tab `Feb 26`) hit a live case the narrow
    `"#REF!"`-in-one-column fix didn't cover: both วันที่ and วันที่.1 parsed
    to genuinely *different* valid dates (not a broken-formula sentinel at
    all). `_clean_raw` now recognizes any of a small set of known
    Excel/Sheets error strings (`_SHEETS_ERROR_SENTINELS`:
    `#REF!/#N/A/#VALUE!/#DIV/0!/#NAME?/#NULL!/#NUM!/#ERROR!`) in **either**
    date column or in team, cross-fills each date column from the other when
    one is a sentinel, and throws a clear error (naming the affected
    workers/rows, not just "some rows") if both are unrecoverable or if they
    disagree without either being a known sentinel -- that last case is a
    genuine data ambiguity, not something to silently resolve, so it still
    stops and asks. Covered by `_test_sheets_error_sentinels_general`.
  - The same CYD/Feb 26 tab also had 2 rows where **every** field was blank
    except ค้นหา (name) -- confirmed live by the user checking the actual
    sheet. Not a broken formula, and not a real show-up (no date to
    attribute one to) -- a roster placeholder that only survived the
    `ค้นหา.notna()` filter because it has a name. `_clean_raw` now drops a
    row with an unrecoverable date ONLY when every other field (team, shift
    name, clock-in, Shift_id) is also blank; a row missing just the date
    while other fields are populated still throws (a real worked shift with
    an unknown date is a genuine gap, not a placeholder to silently
    discard). Covered by `_test_blank_placeholder_row_dropped`.
  - Same vendor, tab `Mar 26`: เข้างาน (clock-in) had a garbled value
    (`"$0.88"` -- looks like a different column's data leaked in via a
    broken formula, not a broken-formula sentinel like `#REF!`/`#N/A`).
    Unlike team/date, clock-in genuinely isn't load-bearing for the core
    show-up-day metric (see "Input" section above: "No clock-in filter" --
    it's only read here to break ties when one worker has two different
    teams on the same date). Changed `_clocksort`'s `pd.to_datetime(...,
    errors="raise")` to `errors="coerce")` -- an unparseable clock-in
    becomes NaT, sorts last, and so naturally loses a same-day tie-break to
    a row with a real time; the raw string is still preserved as-is in the
    `clockin` output column regardless. Covered by
    `_test_garbled_clockin_tolerated`.
  - `[SOCE 2026]_Daily name list_BTS`, tab `May 26`: the header's first
    วันที่ cell had a stray value (`"49"`) instead of the column name, while
    the actual data underneath was still real dates -- confirmed by the
    user reading the live sheet. Pure name-matching couldn't find a header
    row at all (only one literal `วันที่` survives, so mangling never
    produces the expected `วันที่`/`วันที่.1` pair). User proposed
    column-position matching as a first-class strategy; scoped it narrower
    than "position first everywhere" -- `_find_header_row`/`_resolve_header`
    now try strict name-matching first (unchanged, zero risk to any
    already-working file) and only fall back to `_repair_date_header_positions`
    when that fails, which recovers the two วันที่ columns by their locked
    position relative to `ค้นหา`/`shift name` (columns that have never shown
    corruption). Not a blind position override: the recovered columns still
    have to actually parse as dates downstream, or it throws -- "if the data
    still matches, use it" is enforced structurally by the existing strict
    date parsing, not a separate check. Covered by
    `_test_corrupted_date_header_repaired`.
  - `[SOCE 2026]_Daily name list_SPT`, tab `Mar 26`: the header row was
    accidentally pasted twice (rows 1 and 2), so once the real header is
    identified, the second copy shows up as a plain data row and blows up
    date parsing ("Unknown datetime string format, unable to parse: วันที่").
    User asked for a general "drop any row that doesn't match the format"
    rule; deliberately scoped narrower than that -- a blanket
    drop-on-parse-failure would also hide a genuine data-entry typo that
    deserves a human's attention. Instead, `_clean_raw` drops a row only
    when ค้นหา literally equals `"ค้นหา"` (the header's own label -- no real
    worker is named that), which is exactly the duplicate-header signature
    and nothing else. Covered by `_test_duplicate_header_row_dropped`.
  - `[SOCE 2026]_Daily name list_PPO`, tab `Jul 26`: 10 rows had no team and
    weren't the FSOCE special case -- user pointed out team is itself an
    abbreviation of shift name, so it should be learnable the same general
    way. Replaced the hardcoded FSOCE-only backfill with one that learns
    shift name -> team from whichever OTHER rows in the same tab already
    have both (subsumes FSOCE for free once shift names are stripped, since
    "FSOCE " and "FSOCE" both normalize to the same key). Scoped to only
    the shift names that actually have a row needing backfill -- checking
    ambiguity tab-wide was too eager and broke the existing multi-vendor
    test fixture (one shift name legitimately paired with several different
    teams across unrelated, already-complete rows). Still throws if a
    *needed* shift name maps to more than one team, or has no valid example
    anywhere in the tab. Covered by `_test_team_learned_from_shift_name`.
  - Regression from the above, found immediately on the next live run:
    `[SOCE 2026]_Daily name list_BTS`, tab `Mar 26` had 275 rows with shift
    name "FSOCE" and no team, and *zero* valid FSOCE examples anywhere in
    that tab to learn from -- the general mechanism alone threw, when the
    original narrower fix (team="FSOCE" for shift name "FSOCE", a confirmed
    business fact, not a guess) would have resolved it instantly. Restored
    that hardcoded rule as an explicit last-resort fallback, applied only to
    rows the data-driven learning still couldn't resolve -- it never
    overrides a value the general learning already filled in ("map only if
    it doesn't exist yet"). Covered by
    `_test_fsoce_hardcoded_fallback_when_unlearnable`.
  - Generalized the hardcode into `_KNOWN_SHIFT_TEAM` (a plain dict, e.g.
    `{"FSOCE": "FSOCE"}`) so a new confirmed shift-name -> team fact from
    the user is a dict entry, not a code change -- prompted by
    `[SOCE 2026]_Daily name list_PPO`, tab `Jul 26` hitting a second
    unlearnable shift name (`HIGHVALUE`) right after FSOCE.
  - Then generalized once more per the user's explicit instruction: if a
    team is still unresolved after data-driven learning AND
    `_KNOWN_SHIFT_TEAM` both miss, fall back to using the shift name itself
    as team, rather than throwing to ask every single time -- some teams
    are genuinely named after their shift. Only a row missing BOTH team and
    shift name (nothing left to fall back to at all) still throws. This
    means `_KNOWN_SHIFT_TEAM` is now only needed for cases where the team
    name *differs* from the shift name (like FSOCE was originally assumed
    to, though it turned out identical) -- still covered by
    `_test_team_learned_from_shift_name`.
  - `[SOCE 2026]_Daily name list_BTS`, tab `Jul 26`: 3 rows had neither team
    nor shift name -- nothing left to attribute a station to at all, same
    shape as the CYD placeholder rows. Per explicit user instruction,
    changed the final "nothing to fall back to" case from throwing to
    dropping the row, consistent with how the CYD case is already handled.
    Covered by the "no shift name either" case in
    `_test_team_learned_from_shift_name`.
  - `APIError: [503]: The service is currently unavailable.` -- Google's
    Sheets/Drive APIs themselves, not our code, and increasingly likely to
    surface as real vendor files/tabs grow (many more read/write calls per
    `/sync` than the mocked tests ever exercised). Added `app._retry()`, a
    small exponential-backoff wrapper (`max_tries=4, base_delay=2.0` ->
    delays of 2/4/8s), applied at every actual Google API call site
    (`drive.files().list().execute`, `gc.list_spreadsheet_files`,
    `gc.open_by_key`, `sh.worksheets`, `ws.get_all_values`,
    `spreadsheet.worksheets`/`worksheet`/`add_worksheet`, `ws.clear`,
    `ws.update`) -- retries only on `429/500/502/503/504`; anything else
    (auth, 404, permission) re-raises immediately, not retried. Covered by
    `test_retry_succeeds_after_transient_error`,
    `test_retry_reraises_non_retryable_immediately`,
    `test_retry_gives_up_after_max_tries` in `render/test_sync.py`.
  - Retries alone weren't enough: 43 minutes of Render logs showed every
    single attempt (across multiple n8n retries) dying with the same
    `WORKER TIMEOUT`, every time inside `ws.get_all_values()` -- confirming
    this isn't transient throttling but that a full sync now genuinely
    takes longer than even a 500s timeout with this much real vendor data.
    Bumping the timeout further is a dead end (treadmill against
    ever-growing data, and a 10+ minute daily sync is fragile regardless).
    Root-caused to call *count*, not slowness per call: reading was making
    1 `get_all_values()` call per month tab per vendor file (a full year of
    one vendor = ~13 calls just to read). Added `app._batch_get_month_tabs`
    using gspread's `values_batch_get` (Google's Sheets API batchGet
    endpoint) to fetch every matched month tab from one vendor spreadsheet
    in a single API call instead of one call per tab -- cuts the read side
    from `1 + N` calls per vendor file down to `2`, regardless of how many
    months it has. `valueRanges` in the batchGet response come back in the
    same order as the requested titles (matched by position, not by
    re-parsing quoted range strings, which vary by sheet-name escaping).
    Covered by `test_batch_get_month_tabs`. The write side (7 tabs x ~4
    calls each = up to 28 calls per year) has the same batching option
    available (`values_batch_update`/`values_batch_clear`/`batch_update`
    for new-sheet creation) but wasn't needed yet -- reads were the
    confirmed bottleneck (the actual crash was always inside
    `get_all_values()`), so this was scoped to the fix with evidence behind
    it rather than batching everything preemptively.
  - Write-side batching followed one run later: even with batched reads, a
    live run took ~19 minutes across n8n retries and still timed out. The
    write side was making ~4 sequential calls per tab (exists-check /
    open-or-create / clear / update = ~28 per year). Replaced `_write_df`
    (per-tab) with `_write_tabs` (all 7 tabs of one central spreadsheet in
    4-5 calls total): one `worksheets()` listing, one `batch_update` that
    both adds missing tabs and RESIZES existing ones (values:batchUpdate
    does not grow a sheet's grid -- writing more rows than the tab has
    would fail with "exceeds grid limits"; the old per-tab path sized tabs
    only at creation, a latent bug once data outgrew day one), one
    `values_batch_clear`, then two `values_batch_update` calls -- two, not
    one, because a values:batchUpdate carries a single valueInputOption and
    the dept tabs need RAW while summary tabs need USER_ENTERED (see the
    apostrophe bug above). Sheet titles in A1 ranges are single-quoted with
    '' escaping via `_quoted_range`. `FakeCentralSpreadsheet` in
    test_sync.py now speaks this batched API and records written values per
    tab, so all existing assertions still hold.
  - Regression from the batched read (found next live run): the Sheets API
    batchGet endpoint returns RAGGED rows -- trailing empty cells trimmed
    per row, and a data row can even run WIDER than the header when there's
    stray data past the schema -- unlike `get_all_values`, which
    rectangularizes. `[SOCE 2026]_Daily name list_PPO`, tab `Jul 26` had a
    29-column data row against a 22-column header, crashing DataFrame
    construction ("22 columns passed, passed data had 29 columns"). The
    batch optimization was meant to be purely a perf change, so
    `_rows_to_raw_df` now normalizes every row to a common max width first
    (pad short rows, widen the header for over-long ones -- extra
    beyond-schema columns become unused, nameless columns), reproducing
    exactly the rectangular grid `get_all_values` used to hand it. Covered
    by `_test_ragged_rows_normalized`.
  - Ran out of memory (>512MB, Render free tier's cap) -- the OOM killer,
    not a timeout. `run_sync` accumulated every vendor file's cleaned rows
    (all ~9 columns) for the whole year in memory, then `pd.concat`'d them
    (temporary doubling) before writing -- and the batched read made it
    worse by holding a whole vendor-year of raw values at once. **Redesigned
    to stream, not accumulate:** the heavy raw rows are now appended to each
    department tab per vendor file (`_append_dept_rows` via
    `values.append`/INSERT_ROWS, which auto-grows the grid) and released
    immediately, so a whole year's raw rows never coexist in memory. Only
    the slim `{name,date,team}` slice is accumulated for the year -- that's
    all the 3 summary tabs' engine functions need, and it's small even for
    hundreds of thousands of worker-days. `_write_tabs` (the single-shot
    all-7-tabs writer) was replaced by three phase helpers: `_prepare_central`
    (once per year: add/resize the 7 tabs to a modest default grid, clear
    all, write the 4 dept headers), `_append_dept_rows` (per vendor file,
    RAW), and `_write_summary_tabs` (once per year, USER_ENTERED, from the
    slim slice -- summaries are tiny so they fit the default grid, no resize
    needed). Peak memory is now ~one vendor file + the slim year slice,
    instead of every vendor's full data at once. Tradeoff, accepted under
    the free-tier constraint: the cross-vendor duplicate-(name,date) check
    now runs at the end (on the slim slice) *after* dept rows are already
    appended, so a dup error leaves that year's dept tabs written but
    summaries blank until the next run re-clears everything -- consistent
    with the project's recompute-from-scratch stance, and dup errors are
    rare and loud. `FakeCentralSpreadsheet` in test_sync.py now models each
    tab's full content across prepare/append/summary phases.
  - Summary tab numbers showed up in Sheets with a leading apostrophe (e.g.
    `'8`) -- `_write_df` cast every value to a Python string
    (`df.astype(str)`) then called `ws.update(values)` with no
    `value_input_option`, and gspread 6.2.1 defaults to `raw=True` (Sheets'
    RAW input mode), which stores numeric-looking text as literal text;
    Sheets flags that with the apostrophe since it won't sum/sort/chart as a
    number. Fixed by adding a `raw` param to `_write_df`: the 4
    raw-consolidated tabs stay `raw=True` (IDs like `Shift_id`/`team` must
    not be silently reinterpreted as numbers -- e.g. a leading zero would
    get dropped), the 3 summary tabs now pass `raw=False` (USER_ENTERED) so
    counts/percentages land as real numbers.

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