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
      appscript/              <- CURRENT deployable: standalone Google Apps Script
        engine.gs              <- verbatim copy of n8n/engine.js (JS runs as-is in GAS)
        Code.gs                <- discovery + read/clean + per-SOC summaries + write
        appsscript.json         <- manifest (enables Advanced Sheets Service, V8, scopes)
      n8n/                    <- SUPERSEDED by appscript/ (kept for reference)
        engine.js              <- canonical engine; source that engine.gs is copied from
        soc-daily-sync.json    <- old Schedule Trigger workflow (retired)
      render/                 <- SUPERSEDED by appscript/ (kept for reference)
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

## Automation — CURRENT: standalone Apps Script (supersedes Render + n8n)

Everything runs inside one **standalone Google Apps Script** (`appscript/`),
triggered daily by its own time-based trigger. This replaced the Render + n8n
stack after the n8n rewrite hit an unavoidable worker OOM: pulling every
vendor sheet's raw rows into an n8n worker (plus 3-4 duplicate copies across
the compute/write nodes) blew the 512MB worker — the same all-in-memory wall
that OOM-killed Render. Apps Script reads/computes/writes **in place on
Google's servers**, so the data never travels and there is no memory ceiling.

Why standalone (not a sheet-bound script): it's pasted once, ever, and runs
as the owning Google account (real Drive quota, unlike the ~0-quota service
account), so it **creates each new year's central sheet itself** — no manual
setup and nothing to re-paste when 2027 rolls over.

- `appscript/engine.gs` — **verbatim copy** of `n8n/engine.js`. That file is
  plain JS and its Node footer is guarded by `typeof module !== "undefined"`,
  so it runs unchanged under GAS V8. In practice edits now land in `engine.gs`
  first (it's the deployed one) and are copied back — the direction doesn't
  matter, **keeping the two byte-identical does** (`diff` must be empty; one
  source of the cleaning + metric logic, no fork). 2026-07-15: found they had
  silently drifted (the rep-row `*Members` + `newOldFace_` changes existed only
  in `engine.gs`); refreshed `n8n/engine.js` from `engine.gs`. NOTE:
  `render/test.py`'s Python engine mirror is STALE from that same point (it
  still returns bare names from `*Members` and predates `newOldFace_`) and is
  no longer a parity check for the engine — the checks are `engine.gs`'s own
  `runSelfTests()` (run it in GAS after every paste) plus targeted local
  transcriptions of new logic; test.py's docstring remains the spec for the
  locked metric definitions.
- **Write path is Advanced Sheets Service ONLY, never SpreadsheetApp.** Mixing
  the two on one spreadsheet silently corrupts output: `SpreadsheetApp` buffers
  writes and flushes them lazily (often at script end), so a `SpreadsheetApp`
  `clear()`/`insertSheet()` can land *after* the Advanced Service value writes
  and wipe them. First live `sync` hit exactly this — all 7 tabs present but
  empty, `lastRow=0`, no error, while the result JSON still reported 141k rows.
  `prepareCentral_` now does tab add/delete via `Sheets.Spreadsheets.batchUpdate`,
  clears via `values.batchClear`, and writes via `values.batchUpdate`/`append` —
  no `SpreadsheetApp` mutation on the write path (only `.create()` in
  `findOrCreateYearSheet_`, committed with `SpreadsheetApp.flush()` before the
  Advanced Service takes over).
- `appscript/Code.gs` — the orchestration (ported from `render/app.py`
  `run_sync` + the five retired `n8n/*.js` Code-node scripts): `discoverFiles_`
  (Drive search + strict title parse, throws on a loose match / unknown dept),
  `readMonthTabs_` (Advanced Sheets Service `batchGet`, capped to `A:J`),
  streams each file's raw rows into its dept tab via `appendDeptRows_` and
  keeps only the slim `{name,date,team,dept}` slice, `findOrCreateYearSheet_`
  (the create-if-missing that the service account couldn't do), `sync()` the
  daily entry point, plus `initProperties`/`dryRun`/`createYearSheet`/
  `installTrigger` ops helpers.
- Config is **Script Properties** (successor-editable, no code change):
  `CENTRAL_FOLDER_ID`, `RAW_DEPARTMENTS`. Run `initProperties()` once to seed.

**Departments are SOCN / SOCE / SOCW (FSOCW dropped).** `RAW_DEPARTMENTS` =
`SOCN,SOCE,SOCW`. (`FSOCN` is a *station* inside SOCN, not the dropped `FSOCW`
department.)

**Vendor nationality (Thai vs Burmese).** No vendors are skipped anymore (the old
`SKIP_VENDORS` is retired — run `migrateSkipVendors()` once to delete the
property). Instead, every vendor is classified: the `THAI_VENDORS` Script Property
(`PPO,WAS,RG,YSL,BigBoom`) lists Thai vendors; **anything not in it is Burmese**
(`nationalityOf_`, the user's chosen default — NOT fail-fast: a new unlisted vendor
just counts as Burmese until added). Each cleaned row carries `nationality`
(threaded onto the slim slice from its vendor). Every summary scope is then split
by nationality — see the nationality note below.

**Per SOC per year**, created in the Central folder by the script itself:
- `<YEAR>_<DEPT>` (e.g. `2026_SOCN`) — the main results file, **5 tabs**
  (`SOC_TABS`): one `raw` tab + **one tab per aspect** (`New-Old Face`, `Show Up`,
  `Consecutive`, `Rotation` — `ASPECT_TABS`).
- `<YEAR>_<DEPT>_<ASPECT>_Names` (e.g. `2026_SOCN_ShowUp_Names`) — **one drill-down
  file PER ASPECT** (4 of them; suffix via `ASPECT_NAME_SUFFIX`), each a single
  `Names` tab.

The drill-down detail is in **separate spreadsheet files** because Google's
10,000,000-cell cap is **per workbook** (shared across all tabs, NOT per tab). The
detail is large — each counted person is a full 8-column raw row and every number
is drillable at both the `All` scope and each team — so first a single combined
file, then even a single dedicated `Names` file, overflowed the cap live
(`batchUpdate ... above the limit of 10000000 cells`). Splitting `Names` into
per-aspect *tabs* in one file would NOT help (same shared budget); only separate
*files* add capacity, so each aspect gets its **own** file (its own 10M).
`findOrCreateSheet_(folderId, title)` + `prepareSocSheet_` build the main 5-tab
shape; `findOrCreateSheet_` + `prepareNamesSheet_` build each aspect's Names file;
`sync` keys its streaming context by `(year, dept)` and holds `ss` + `namesFiles`
(aspect → `{ss, gid}`).

**Names auto-split (2026-07-21, user request: "if it's almost the limit, split
the sheet").** Before this, a Names file crossing the real 10M-cell cap was a
hard, deterministic `batchUpdate` throw with no proactive handling — and since
it's deterministic (not transient), the department-level auto-retry would just
fail identically both times rather than recovering. `namesCollector_` (was
`(namesFileId, namesGid)`) is now `(firstSeg, nextSegmentFactory)` and owns a
`segments` array instead of one flat `rows` array: `link()` computes each new
group's cell cost (`(4 + members.length) * RAW_TAB_HEADER.length`) and, only if
adding it would push the CURRENT segment over `NAMES_SEGMENT_CELL_CAP` (9M — a
10% safety margin under the real 10M cap) AND the segment already has content,
lazily opens the next one via `nextSegmentFactory(index)` — found/created as
`<...>_Names_2`, `_Names_3`, … through the same `findOrCreateSheet_` +
`prepareNamesSheet_` pair used for segment 1. A group is **never split
mid-block** (a clicked count must resolve to one contiguous range) — a single
group that alone exceeds the cap still lands whole in the segment it started
(effectively impossible: that's a ~280,000-member group). Each `link()` call's
`=HYPERLINK` targets whichever segment the group actually landed in, so a
mixed-segment aspect still resolves every count correctly. `runSync_`'s write
loop now writes **every** populated segment (`nc.segments.forEach`, was a
single `writeSummaryTab_` call) and logs a `[names split]` line the moment a
new segment opens. The common case (current usage: ~2–6% of the cap per
department/aspect after 5 months) is untouched — one segment, one file,
identical to before; the extra file-creation path only executes once actually
needed, so this doesn't add risk or overhead to today's normal runs.

**Summaries follow the slide deck**, **grouped by team**. **Every aspect now
carries day + week + month grains except Consecutive** (month + week — the user's
explicit "keep it as it is"; added 2026-07-15 per user request). A metric that
can't literally run on one day (buckets need a span; nothing rotates WITHIN a day
since a worker has ONE team per day) gets a **presence projection** instead: the
daily view counts workers PRESENT that day by their MONTHLY verdict — the user's
rule, "shows up that day and he is old face → count him as old face". **All daily
blocks are PLAIN NUMBERS** (a per-person daily drill-down copies ~2× the raw log
and overflowed a Names file live — the daily roster is the `raw` tab filtered by
date); monthly and weekly counts are clickable. Percentages render with a `%`
sign (`pctCell_`, written USER_ENTERED so `"45.11%"` is a real percent number,
not stuck text):
  - **New / Old face** — the user's **operational experience rule** (`newOldFace_`
    in engine.gs), per (month, worker). Only classifies workers **fixed to one
    station** that month: **Old (experienced)** = one station AND **≥10 days**;
    **New (inexperienced)** = one station AND **<10 days**. **Rotated** workers
    (>1 station) are **EXCLUDED** (`newOldFace_` returns `null`) — they belong to
    the Rotation tab. (Evolution: first "max days at any single team ≥ 10" (wrong);
    then "rotated = New"; the user's final word was "both old and new are
    fixed-station-only," so rotated is now dropped, not folded into New.)
    Classification uses the worker's WHOLE month (all teams), so team-scoping only
    changes WHO is counted (present at T) + the rep row shown, never the verdict.
    **Monthly + weekly + daily.** Monthly = the same two-table + trend + `All
    <DEPT>` + `visibleTeams_` treatment as Show Up. Weekly and daily are
    **presence projections of the monthly verdict** (`newOldPresence` in
    engine.gs): who was present that ISO week / that day, counted Old/New by
    their month's verdict — rotated workers stay excluded, so Old + New per day ≤
    that day's head count. A week can straddle two months (the only cross-month
    grain); the verdict of the month of the worker's EARLIEST show-up in that
    week decides. Weekly reuses `renderNewOld_` verbatim (mem keyed by `W<n>`),
    clickable; daily is two plain tables (`renderFaceDaily_`, scopes as rows,
    days as columns). (NOT tenure/range — that was a mid-conversation detour
    the user corrected.)
  - **Show up** — day-count buckets 1-5/6-10/11-15/16-20/21-30, **monthly** (with
    drill-down), PLUS a **weekly bucket table** and a **daily head-count** block.
    Weekly (`renderShowupWeek_`/`showupWeekMembers`, user-confirmed buckets
    `WEEK_BUCKETS` = **1-2 / 3-4 / 5-7** days — the monthly buckets can't apply
    to a ≤7-day week): same per-scope blocks as monthly, ISO weeks as columns,
    counts clickable, plain `Sum Week` row; every 1..7-day count lands in a
    bucket, so a week's bucket sum == its distinct head count (self-tested).
    Daily head count (`renderHeadcount_` — distinct workers present per day, one
    row per nationality scope) is **PLAIN NUMBERS, not clickable**: a per-person
    daily drill-down copies ~2× the entire raw log and overflowed even a
    dedicated Names file; the daily roster is already the `raw` tab filtered by
    date. `renderHeadcount_` computes distinct names/day straight from the slice
    (no `attendanceCrosstab`); the engine's `attendanceCrosstab`/
    `attendanceMembers` remain, self-tested, but are unused by `Code.gs`.

    **The combined row is `All <DEPT>`, department-dynamic** (`allLabel_(dept)` →
    `All SOCN`/`All SOCE`/`All SOCW`), NOT a hardcoded `"All SOCN"` — the same code
    writes all three SOCs, so the label must follow the SOC being written (was a
    real bug: literal `"All SOCN"` showed on SOCE/SOCW too). `dept` is threaded from
    `sync()`'s ctx into each `*TabGrid_(slim, nc, dept)`. The combined row is the
    all-teams aggregate (no team filter); team rows use the bare team name (`IB`,
    not `team IB`). `isAllScope_(scope)` (`/^All /`) distinguishes the combined row
    from a team for header coloring — safe because no `VIS_TEAMS` name starts with
    `"All "`. Rotation has no `All <DEPT>` row at all (an aggregate double-counts a
    worker who rotated across teams), so it ignores `dept`.

    **Team scope: all four aspects** are now restricted to the fixed 8-team
    allowlist `VIS_TEAMS = [IB, CBS, mCBS, MS, OBI, OBC, OBS, OBD]` (`visibleTeams_`),
    NOT `distinctTeams` — per the user's request, to keep the visualization free of
    noise teams (a stray `Helper`, or a shift-name-as-team fallback). This is a
    display-layer filter only; `raw`/drill-down data is untouched.

    **Nationality split (Thai / Burmese), all four aspects.** Every scope is split
    by worker nationality and interleaved per base scope: `All <DEPT> Burmese`,
    `All <DEPT> Thai`, `IB Burmese`, `IB Thai`, … (`natScopes_` for the three
    All-plus-team aspects; `natTeams_` for Rotation, which has no All row). A
    base/nationality pair with no rows is skipped, so a Burmese-only SOC shows no
    empty Thai blocks. There is **no combined (both-nationalities) row** — the point
    is to separate the two populations (flagged for the user to confirm they don't
    also want a combined total). Each scope filters the slim slice to its
    nationality (`filterNat_`) then calls the same `*Members` functions. Rotation
    computes `rotationMembers` per nationality (`monthByNat`/`weekByNat`) and reads
    each `<team> <nat>` row from its own nationality's map. `isAllScope_` still works
    with the suffix (`"All SOCN Burmese"` starts `"All "`), so both nationality
    All-rows get the header/highlight color.

    **Shift_id breakdown (all four aspects, 2026-07-16, user request).** Within
    each team group, that team's numbers are further split by `Shift_id` (e.g.
    `CBS` → `CBS_N_00`, `CBS_N_01`; format confirmed against the local June BTS
    CSV — a shift id belongs to exactly one team, 2–10+ ids per team per vendor).
    Shift scoping is **team scoping one level finer, same semantics**: a worker
    counts under every shift they actually worked in the period, days/streak-runs
    are counted AT that shift, and the monthly verdicts (Old/New; Rotated +
    Reading-B oneday) NEVER change — the shift only filters who is counted and
    which rows the rep is picked from. Engine: `normShift`, optional `shiftId`
    param on `newOldMembers`/`newOldPresence`, per-team `cell.shifts` on
    `rotationMembers` (self-tested: `test_shift_scoping`). Code.gs: `shiftKey_`
    (same normalization as `normShift`), `shiftIdsOf_` (data-driven per
    nationality slice + team), `shiftSlice_`; a blank shift id groups under `''`
    and displays `(no Shift_id)`; row labels are indented with `SHIFT_INDENT`
    (NBSPs, written as `\u00A0` escapes — a plain leading space would be trimmed
    by USER_ENTERED). Layout, user-chosen ("extra rows under the team"):
    **indented rows under each team row in every teams-as-rows table** — Show Up
    by-bucket + daily head count; New/Old by-category + daily face tables;
    Rotation detail + trend + daily (detail-row counts ARE linked; link keys and
    Names titles use the parent `<team> <nat>` label + sid — the bare indented
    display label repeats across nationalities and would collide). **Consecutive
    is the exception**: its rows are streak categories, not teams, so each team
    block is followed by per-shift SUB-BLOCKS (same renderers on a
    shift-filtered slice, label `<sid> <nat>` indented) — flagged to the user as
    the necessary deviation from the rows layout. Deliberately NOT shift-split
    (block-style tables, per the rows-not-blocks choice): Show Up table A and
    weekly buckets, New/Old monthly/weekly count blocks. Names-file growth comes
    only from Rotation detail shift rows (~2× Rotation Names) and Consecutive
    shift sub-blocks (~one extra scope per worker) — the streak Names file stays
    the first 10M watch-item.

    **Show Up now has TWO tables** (per the user's reference screenshots): the
    original **by-team** table (`renderShowup_`, unchanged shape) and a new
    **by-bucket** table (`renderShowupByBucket_`) — one block per bucket, rows =
    `All <DEPT>` + each visible team, columns = months (% only). The by-bucket table
    flags a row when its LAST-TWO-MONTHS % move is ≥ `TREND_THRESHOLD_PTS` (5
    points): colors those two cells (green/`FMT.increaseBg`+`increaseFg` for a
    rise, red/`decreaseBg`+`decreaseFg` for a drop), boxes them
    (`fmtRange_(...,{border:true})`), and writes an `increases`/`decreases` label
    in the column after the last month. This is a **generic threshold rule
    applied to every row**, not a hardcoded "always highlight team X" — the user's
    reference screenshot happened to flag one particular team in both examples
    shown, which may have been a manual/one-off highlight rather than a rule;
    flagged for the user to confirm against the live threshold-based result.

    **Cell coloring is real Sheets formatting, not just values.** `fmtCell_`/
    `fmtRange_` collect abstract `{row, col, [rowEnd/colEnd], bg, fg, bold, size,
    border, borderTop, borderBottom}` instructions (grid-relative, 0-based) into a
    `formats` array returned alongside the grid; `writeSummaryTab_` converts them
    to real `repeatCell`/`updateBorders` requests (`formatRequests_`, `hexColor_`
    — precise per-property `fields` masks so instructions on the same cell
    COMPOSE) against the tab's `sheetId` and applies them in one `batchUpdate`
    AFTER the values are written (still Advanced-Sheets-Service only — no
    `SpreadsheetApp` formatting calls). **All four `*TabGrid_` functions return
    `{grid, formats}`** so `sync()`'s write loop can treat every aspect uniformly.

    **Full visual theme (2026-07-16, "decorate the 4 summaries").** Each aspect
    tab has a color identity (`ASPECT_STYLE`: New-Old deep blue, Show Up deep
    green, Consecutive plum, Rotation brown-orange): the **tab strip** is colored
    (`tabColor`), the top row is a full-width accent **banner** (white bold, size
    12; `banner_`) and each sub-section title a pale-tint **section bar**
    (`section_`) — both use `colEnd: -1`, a sentinel `writeSummaryTab_` resolves
    to the final grid width. On top of that, `decorateFormats_(grid)` is a
    generic structural pass hooked in the write loop (PREPENDED so renderer
    colors like trend flags win): table header rows (first cell
    `bucket`/`face`/`team`, or `''` followed only by plain non-`%` strings — the
    rule that also catches Rotation's period/column rows while skipping the
    streak validation `%` row) get gray-bold + a thin bottom rule; rows of
    `team`-headed tables get **zebra striping**; indented `Shift_id` labels are
    muted gray; `Sum Month`/`Sum Week`/`Total` rows get bold + a thin top rule.
    `writeSummaryTab_` also (aspect tabs only): **resets ALL formatting** on the
    grid first (`repeatCell` fields `userEnteredFormat` — values.batchClear only
    clears VALUES, so stale colors from a previous differently-shaped run would
    linger), **freezes row 1 + column 1** (labels stay visible against the wide
    month/week/day columns), and applies the scope-header colors across the
    block's real width (was col A only). Detection rules verified by a local
    Python transcription (all row shapes classify correctly).

    **Columns: A is fixed, the rest auto-fit.** `writeSummaryTab_` sizes col A to
    a fixed 230px (auto-fitting it to the long banner sentences made it absurdly
    wide; banner text overflows across the blank cells to its right) and
    `autoResizeDimensions` the remaining columns (skipped entirely for the Names
    files — cosmetic only there, not worth the extra call on an already-heavy
    write) — long headers like "Non Rotation and show up 1 day in month" were
    getting clipped at the default column width.

    **`Sum Month` is a PLAIN NUMBER, not a link.** It used to be `nc.link`'d to the
    concatenation of every bucket's members — i.e. a second copy of names already
    linked individually per bucket, duplicated into the Names file for nothing.
    Fixed after the user flagged it live ("same data, waste of memory"); the same
    rule now applies to every derived/recombined total across the whole file (see
    Consecutive, below) — link the real distinct groups, never their sum.
  - **3-day consecutive** — redesigned to match the user's reference sheet
    (`renderStreakMonth_`/`renderStreakWeek_`, `visibleTeams_`-scoped like Show Up),
    replacing the old flat 7-column `STREAK_CATS` table:
    - **Monthly**, per scope (`All SOCN` + each visible team): a **COUNTS**
      section — block 1 (`<10`/`>10`, no title), block 2 ("Used to work for at
      least 3 consecutive days (at least one period)", green title), block 3
      ("Never work for at least 3 consecutive days (at least one period)", red
      title) — each 2 rows (`Show up < 10 days` / `Show up > 10 days`) + a plain
      `Total` row; then a **PERCENTAGES** section mirroring all 3 blocks, where
      blocks 2 and 3 use block 1's denominator (`streakActive_` — that month's
      total active headcount), not their own subtotal — confirmed against the
      user's reference numbers, since all three blocks partition the identical
      population, just by a different question (raw day-count vs streak
      history). Ends with a validation row: block 2 + block 3 percentages should
      sum to ~100%.
    - **Weekly**, same scoping: TRANSPOSED from the old layout — categories as
      ROWS (`>=3 days consecutive` / `< 3 days and non-consecutive`), weeks as
      COLUMNS, counts then percentages, plain `Total` row.
    - **Deferred, NOT built:** the reference sheet's third weekly mini-table
      (columns numbered 1–17, matching the exact week count of the Mar–Jun
      period) — the user's clarification didn't resolve what column *N* counts
      (a longest-streak-length histogram vs a qualifying-week-count histogram
      are both consistent with the 17-column coincidence). Confirm a concrete
      example before building; a wrong guess here is expensive (large sync).
  - **Rotation** — redesigned to match the user's reference sheet
    (`visibleTeams_`-scoped, no `All SOCN` row — an aggregate would double-count a
    worker who rotated across several teams, and the reference sheet doesn't show
    one either), replacing the old flat `period, team` table:
    - **Per-period DETAIL blocks** (`renderRotationDetail_`, one block per
      month/week, teams as rows), 7 columns matching the reference order: `Non
      Rotation` (count, linked), `Rotation` (count, linked), "Non Rotation and
      show up 1 day in month" (count, linked, then its own % of `Non Rotation` —
      confirmed against the reference, e.g. 310/334=92.81%), `Total` (**plain**,
      = `Non Rotation` + `Rotation` recombined — same anti-duplication rule), then
      `Non Rotation %` / `Rotation %` of `Total`.
    - **Trend-summary section** (`renderRotationTrend_`, 3 stacked blocks —
      `Rotation` plain title, `Non Rotation` green title, "Non rotation worker
      who come to work only 1 day in a month" orange title (`FMT.oneDayFg`) —
      teams as rows, periods as columns, % only, not linked (derived from the
      detail blocks above)) via the **same shared trend helper as Show Up's
      by-bucket table** — `renderTrendPctBlock_`, extracted this round so the
      last-two-periods/`TREND_THRESHOLD_PTS`/box/label logic lives in exactly one
      place. Same caveat as Show Up: this is a generic per-row threshold rule, not
      a hand-picked "always flag team X" — the reference screenshot's boxed cell
      may reflect a different comparison (e.g. Apr→May, not the generic last-two-
      periods rule here); flagged for the user to confirm against the live result.
    - **Weekly** gets the same two-part treatment (per-week detail blocks +
      trend summary) by extension/consistency with monthly — the reference
      screenshots only showed monthly, so this is inferred, not confirmed.
    - **Daily** (`renderRotationDaily_`/`rotationPresenceDay`, plain numbers):
      a worker has exactly ONE team per day (the dedup keeps the earliest
      clock-in), so nothing can rotate WITHIN a day — the user confirmed the
      daily block should count **workers present at team T that day by their
      MONTH's Reading-B status at T** ("month rotators present that day",
      chosen over week-status and over an "away from home team today" metric).
      Two tables (DAILY ROTATION / DAILY NON ROTATION), (team × nationality) as
      rows, days as columns; the two counts partition that day's head count at
      the team (self-tested). Plain, not clickable — same 10M rationale as the
      head count.

**Drill-down (BUILT).** Every monthly/weekly count in an aspect tab (every DAILY
block — head count, daily New/Old, daily Rotation — is plain, see above)
is written as a **cross-file**
`=HYPERLINK("https://docs.google.com/spreadsheets/d/<AspectNamesFileId>/edit#gid=<gid>&range=A<row>", count)`;
clicking it opens **that aspect's** `<YEAR>_<DEPT>_<ASPECT>_Names` file at the
number's block. Each aspect uses its OWN `namesCollector_(fileId, gid)` so its
links target its own file. Each group is rendered as the **full 8 raw columns**
(the `raw` header), **one row per counted person** (representative row = earliest
`(date, clock-in)`, via `pickRep`), so the row count always equals the clicked
number — a worker with 20 days is **one** row, not 20. Groups are separated by
**two blank rows**. Rows come from the engine's **`*Members`** functions
(`showupMembers`/`showupWeekMembers`/`newOldMembers`/`newOldPresence`/
`streakMonthMembers`/`streakWeekMembers`/`rotationMembers`), which return
**representative row objects** (not bare names)
using the same grouping as the count functions and are **self-tested to satisfy
`members.length === count`**. The `slim` slice carries the full raw-column set
(`name/date/team/clockin/vendor/shift_name/shift_id/month`) so each member row can
render every raw column. (Watch-item: if one aspect's detail ever exceeds its
file's 10M — the weekly grains are the largest: streak-weekly, and now showup-
weekly + newold-weekly, each ≈ workers × ISO weeks × All+team in its own file —
the next fallback is to reduce that aspect's drill-down scope; the per-aspect
split already removes the cross-aspect stacking that broke the single-file
design.)

Teams are **data-driven per SOC** (`distinctTeams` — the distinct `team` values
in that SOC's own slice), not a fixed station list; abbreviations differ across
SOCs (e.g. `OB` vs `OBD`) and each SOC is a separate file. The hardcoded
`OPERATIONAL_TEAMS`/`STATIONS_*` remain only for the local `render/test.py` mock.
Assembly: one `*TabGrid_(slim, nc)` builder per aspect
(`newOldTabGrid_`/`showUpTabGrid_`/`consecutiveTabGrid_`/`rotationTabGrid_`) whose
count cells go through the shared `namesCollector_` (`nc`), then `writeSummaryTab_`
(resizes each tab to its actual grid; aspect tabs USER_ENTERED for live
`=HYPERLINK`, the `Names` tab RAW so a name starting with `=`/`-` stays literal).

**Excluded:** slide p2 "% Burmese" and Cap.-per-station need total (non-Burmese)
headcount we don't have (Burmese-only name lists) — out of scope.

`Code.gs` dedups one row per `(name,date)` (keeping the earliest clock-in, the
same rule `cleanRaw` uses within a tab) both **per vendor file** before writing
its rows to that SOC's `raw` tab and **per (year, dept)** before the summaries —
`dedupByNameDate_`. This is needed because month tabs overlap at boundaries: a
`Mar 26` tab and an `Apr 26` tab both carry the same Apr-1 show-up (confirmed
live for SPT — identical team and clock-in in both). Worker names are
vendor-prefixed (`SPT 543…`, `BTS 0015…`), so a `(name,date)` collision only
ever happens within one vendor across adjacent tabs, never across vendors.
Where app.py's `run_sync` *threw* on a duplicate `(name,date)`, the Apps Script
collapses it — a show-up recorded in two tabs is one show-up, not an error.

Still true from the old design (the raw side is mostly unchanged): each SOC
file's `raw` tab has the verbatim 8-col header `Date show up | Month show up |
Sub-con name | Name | Clock in | shift name | Shift_id | team` (RAW), always
written even if header-only; recompute-from-scratch every run (`prepareSocSheet_`
clears all tabs first and deletes strays); year derived from each row's actual
date. 2026-07-16 (user request "filter from the header of the table"): the raw
tab's header row now carries a **basic filter** (`setBasicFilter`, all 8 columns,
unbounded rows) plus `frozenRowCount: 1`, set at the END of each run after all
appends; `prepareSocSheet_` issues `clearBasicFilter` FIRST each run — the old
filter's range would block the shrink-to-1-row grid reset, and leftover user
criteria must not be active during the append phase. Sheets allows ONE basic
filter per tab, so the aspect tabs (stacks of many small tables) deliberately
get none — filtering lives on `raw`; per-table filter VIEWS were considered and
skipped (clunky for the audience, and they accumulate across runs).
`prepareSocSheet_` MUST unfreeze every existing tab BEFORE shrinking it to the
1-row baseline: run N freezes row 1 (raw tab filter) and row 1 + col 1 (aspect
tabs, `writeSummaryTab_`), and run N+1's shrink to 1 row under a frozen row leaves
ZERO non-frozen rows — Sheets throws "not possible to delete all non-frozen rows"
(hit live on the 2nd sync after the freeze/filter feature landed). CRUCIAL detail
learned the hard way: putting `frozenRowCount:0` in the SAME `updateSheetProperties`
as `rowCount:1` does NOT work — the shrink is validated against the tab's EXISTING
frozen count (still 1), not the merged result (this failed live twice). The
unfreeze must be its OWN request, ordered BEFORE the resize, in the batchUpdate
(requests apply + validate sequentially, so the standalone unfreeze runs while the
grid is still full-size = always valid, then the shrink sees 0 frozen). So the
request order is: clearBasicFilter → unfreeze-all-existing → resize/add → delete
strays. Freezes are re-applied later the same run.

**Durable-account requirement (handoff-critical):** the script and its daily
trigger run as whichever Google account owns the project. That account must
NOT be the company Gmail being deactivated after handoff, and the raw vendor
sheets + central folder must be accessible to it. This replaces the old
service-account/n8n-OAuth ownership risks with a single one — see
docs/RUNBOOK.md.

Scaling ceiling is **execution time** (the Apps Script per-run limit — typically
6 min, or 30 min for some Workspace accounts), not memory. **One department per
execution** remains mandatory; `sync()` is only a small-data smoke entry. After the
2026-07-16 live failures, two measured bottlenecks were fixed: New/Old had repeatedly
regrouped the entire SOC for every team/Shift_id/grain (755.9s for SOCN), so engine
validation, nationality/team/shift slices, and monthly New/Old verdicts are now
per-execution cached/indexed; and 12-tab `batchGet` calls could occupy the Sheets
backend for minutes before a 503, so reads now use four-tab chunks and retry only
the failed subset. Existing engine self-tests cover the cached month/week/day and
Shift_id paths.

**2026-07-20 SOCW live failures — per-minute quota + heavy-file 503, fixed:** two
distinct crimes. (1) `Quota exceeded ... 'Read requests per minute per user'` thrown
from `prepareNamesSheet_`'s `Sheets.Spreadsheets.get` — root cause: all three depts
run as the SAME account and share ONE 60-reads/min/user quota, and the `socCtx_`
burst (`prepareSocSheet_` + 4× `prepareNamesSheet_`, each 2 `spreadsheets.get`) was
BOTH unwrapped by any retry AND, where wrapped, used a 1–2s backoff useless against a
per-minute window. Fixes: `retryRead_`/`retryWrite_` are now **quota-aware**
(`isRateLimitError_` → sleep a full `QUOTA_WAIT_MS`=60s window, not 1–2s), and every
`prepare*` `get`/`batchUpdate`/`batchClear` is wrapped in the retry helpers.
`appendRawRows_` is deliberately LEFT unwrapped — `values.append` is non-idempotent,
so a retry after a partial success would DUPLICATE raw rows; a crashed append is
instead recovered cleanly by the department-level retry (which re-clears + re-appends
from scratch). (2) **SOCW/PPO is formula-heavy and can't be read whole.** Evidence
across runs: PPO's tabs have the SAME ~16k-row grid as its sibling vendors (CYD/RG/
WAS), which read a 10k-row page in ~1s — but PPO's read HANGS ~3 min then 503s. The
difference is that PPO's "empty" rows are **dragged-down lookup formulas** (e.g. the
team column) that evaluate on read and are NOT trimmed like true blanks, so a whole
`A:J` (or even 10k-row) read evaluates thousands of filler cells and times out. The
user confirmed PPO has only ~4k real rows padded out with empties. Fix in
`readMonthTabs_`: keep the fast **four-tab `batchGet` chunk** path for every file
(Google trims a normal vendor's empty tail for free); the moment a chunk fails,
switch that WHOLE file to `readTabByRowPages_` — **small `ROW_PAGE`=500 pages that
STOP once a page's tail is filler** (`rowHasData_` = ≥2 filled cells), so a formula-padded
16k-row grid is read only through its ~4k real rows, not the filler. A first, larger
`HEAVY_TAB_ROWS`-based routing attempt was REVERTED: the padding inflates EVERY tab's
grid to ~16k, so grid size can't tell PPO from RG and it mis-paged the healthy
vendors (RG 18.8s → 80.2s). Two more turns of the same fix: (a) the chunk read
(`readChunk_`) is a **single attempt, NO retry** — a chunk that fails is a formula-
heavy hang, and `retryRead_`'s 3 attempts just burned 3×3min=9min of hangs before
failing over to paging (the visible "still retrying" symptom); per-PAGE retries in
the paged path cover genuine blips. (b) a **`PAGED_VENDORS` Script Property** (seeded
`PPO`) makes a known formula-heavy vendor skip the batch attempt ENTIRELY
(`forcePaged` → `readMonthTabs_` starts in paged mode), so PPO never eats even the one
exploratory 3-min hang. **Final diagnosis (don't keep tuning the reader): the PPO
FILE is unservable by Google's Sheets API in its current state.** Even small paged
reads return an ERRATIC mix — instant 503, 500 "Internal error," 404 "Requested
entity was not found," some hanging 3 min, some instant — on PPO ONLY, while sibling
vendors with the identical ~16k grid read fine. That is a backend/file problem, not a
read-strategy problem; no chunking/paging/retry setting fixes a file the API itself
errors on. So the pipeline is made RESILIENT instead: `runSync_` collects
`failedFiles` and, when a vendor's read throws after its own retries, LOGS
`[SKIPPED VENDOR]` and CONTINUES — the department's summaries are built from the
vendors that read, rather than one bad file sinking all of SOCW. It throws only if
EVERY file fails (systemic outage), so nothing is silently empty, and a skipped file
does NOT schedule a department retry (retrying an unservable file is pointless). This
is a deliberate exception to "fail fast": it tolerates an EXTERNAL infra read failure,
never a data/schema/parse error (those still throw). The real cure remains data-side
— **rebuild the PPO sheet** (its ~4k real rows into a fresh sheet, or delete the
dragged-down empty formula rows) — after which it reads on the fast path like RG and
can drop out of `PAGED_VENDORS`.

**Confirmed from the actual PPO CSV (2026-07-20):** PPO's Jul tab = **1,346 real rows
then 14,517 filler rows whose ONLY content is a literal `FALSE` in the last column J**
(`เวลาเข้า-ออกงาน`, a formula dragged to the bottom of the grid). It is NOT a row
limit — sibling SOCW vendors read fine at far higher REAL counts (SPT 36,498 rows in
15s, DSR 15,991, RG 14,206, CYD 12,751). Two consequent fixes: (a) `rowHasData_` now
requires **≥2 non-blank cells** so that lone `FALSE` doesn't read as data; (b)
`readTabByRowPages_` stops as soon as a page's **TAIL** (last few rows) is filler —
real rows are a contiguous top block — so PPO reads ONLY page 1 (its 1,346 rows) and
never REQUESTS the all-filler pages below, which are the ones that 503/hang (PPO's
page 2 = pure filler was what sank the read). Net: a live run now COMPLETES — PPO's
data is included if page 1 reads (slow, ~5–8 min, because the 654 filler rows in page
1 still evaluate), or it's cleanly SKIPPED (resilience) if even page 1 fails, without
sinking SOCW. Cleaning the sheet makes it instant either way.

**SpreadsheetApp read path (2026-07-20, the automatic no-manual fix that finally
worked — LIVE-CONFIRMED).** The read METHOD is dispatched in `readVendorTabs_(f, conf)`:
a vendor in `PAGED_VENDORS` ("known-problem file") is read via
`readMonthTabsViaSpreadsheetApp_`; every OTHER file uses the fast values API and
**auto-falls-back to SpreadsheetApp if it throws** (a newly-broken file self-heals, no
config). Two backends were tried and REJECTED for PPO before this, both proven dead:
(1) the values API (`spreadsheets.values.get`/`batchGet`) fails ERRATICALLY (500/503/
404) on PPO regardless of page size — even a 500-row page over PPO's REAL top data
(rows 1–500, well above the filler that starts ~row 1,347) 500s, so it is not the
filler being evaluated, the whole FILE is unservable by that backend. (2) The CSV
export endpoint (`docs.google.com/.../export?format=csv&gid=`, via `UrlFetchApp` +
`ScriptApp.getOAuthToken()`) returns **HTTP 400 with Google's HTML error page** —
root cause: the export 302-redirects to a `googleusercontent.com` download URL and
`UrlFetchApp` DROPS the `Authorization: Bearer` header on the cross-domain hop, so the
second request is unauthenticated (a browser export works only because its session
COOKIES survive the redirect; a Bearer token does not). The winning path,
`readMonthTabsViaSpreadsheetApp_`, uses `SpreadsheetApp.openById()` — the SAME backend
the browser uses — which serves PPO where both APIs refuse, for two reasons:
`getDisplayValues()` returns each cell's STORED computed value from the spreadsheet
model (no whole-grid re-evaluation like values.get, the thing that times out), and
there is no export redirect to strip auth. It reads in bounded `ROW_PAGE` pages with
the SAME tail-filler stop as `readTabByRowPages_` (`rowHasData_` ≥2 cells), range A:J
(10 cols, national-ID never read), `getDisplayValues` (NOT `getValues`) so the shape
is formatted STRINGS matching the values-API `FORMATTED_VALUE` the cleaner expects
(dates as `"09 Jul 26"`, not `Date` objects). loadRawFromValues then drops PPO's
no-name filler rows as usual. **Live result 2026-07-20:** SOCW ran to completion with
all 7 vendors — PPO read via SpreadsheetApp in 35.7s (12 tabs, 12,127 real rows),
department total 5,953 workers / 97,989 rows (was 4,596 / 85,771 with PPO skipped).
No new OAuth scope needed (SpreadsheetApp uses the existing `spreadsheets` scope), so
NO re-authorization — the `script.external_request` scope added for the abandoned CSV
attempt is now unused but left in `appsscript.json` (removing it would force a
needless re-consent). This lets PPO read WITHOUT touching the sheet; cleaning it
(delete the dragged-down formula filler rows) is still nice-to-have (faster, and lets
PPO drop out of `PAGED_VENDORS` onto the fast values path) but no longer required.

The daily schedule uses shared `SYNC_HOURS` **11:00 / 13:00 / 15:00 / 17:00**
(project time zone). Department wrappers are **staggered within each window** by
`SYNC_DEPT_STAGGER_MINUTES` (5) — SOCN :00, SOCE :05, SOCW :10 — so their read
bursts don't collide in the same per-minute quota window (the root cause of the
2026-07-20 quota crash); the quota-aware backoff above is the safety net for the
residual overlap Apps Script's ~15-min jitter can still cause. All three wrappers run
in every configured hour, producing 12 recurring triggers. **Changing the stagger (or
any trigger constant) requires re-running `installTrigger()`.** Apps Script timing
remains approximate (about +/-15 minutes). Transient 429/5xx/timeout failures schedule up
to two automatic department retries, 20 minutes apart; retry state expires after
90 minutes so the next regular two-hour window receives a fresh allowance.
Triggers cannot pass arguments, so wrappers `syncSOCN`/`syncSOCE`/`syncSOCW` call
`runDepartmentSync_(dept)`, which calls `runSync_(dept)`. A department in
`RAW_DEPARTMENTS` without a wrapper is a hard install error. The installer keeps
the 12 recurring triggers plus a six-trigger retry reserve within Apps Script's
20-trigger per-user/per-script limit.

`writeSummaryTab_` writes **50k-row chunks** to stay below the per-request payload
limit, and fixed-range writes use `retryWrite_`. Discovery stays global (cheap and
keeps strict title validation); only processing is department-filtered.

### Superseded: Render + n8n (kept for reference, retired)

The section below documents the previous Render Flask service + n8n workflow.
It is no longer the deployed path — `appscript/` is. Left intact because the
real-bug catalog (data-quality edge cases the engine handles) and the design
rationale still apply to `engine.gs`, which is the same logic.

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
  - `[SOCE 2026]_Daily name list_BTS`, tab `Jul 26`, row 2074 (found live on
    the first Apps Script `dryRun`): a broken formula spilled the shift name
    `"FSOCE "` (trailing space, not a known error sentinel) across `วันที่.1`
    AND every column after it, while `วันที่` still held a clean `"09 Jul 26"`.
    The old rule from the `"49"` entry above -- "a date column that doesn't
    parse throws" -- was too strict: it killed a real worker's show-up day
    even though the sibling column had a perfectly good date. Relaxed the date
    resolution from `errors="raise"` to `errors="coerce"` (JS: `dateCell`
    returns `null` instead of throwing on an unparseable value): a non-empty
    value that simply doesn't parse becomes NA and is cross-filled from the
    other date column, exactly like a `#REF!` sentinel already was. The
    safety guards are unchanged and still do the real work -- a row with NO
    valid date in EITHER column is caught (placeholder-drop, or the "no usable
    date" throw when other fields are populated), and two columns holding
    DIFFERENT valid dates still trips the disagree throw. This also softens
    the `"49"` entry's claim that a mis-repaired position column throws: it
    only throws now if BOTH date columns end up unusable, which a genuinely
    wrong repair (two non-date columns) still produces. Covered by
    `_test_garbage_date_col_recovered` (and the `_test_corrupted_date_header_repaired`
    bad-row case now asserts recovery from the sibling instead of a throw).
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
