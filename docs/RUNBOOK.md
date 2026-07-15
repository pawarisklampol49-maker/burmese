# SOC Sync — Runbook

This is for whoever operates this system day to day. It doesn't assume you can read code — if you can use Google Drive and open the Apps Script editor, that's enough.

## What this does, in one paragraph

Every day, a small Google Apps Script reads every worker attendance file across the 3 departments (SOCN, SOCE, SOCW) and updates one summary spreadsheet per year in the Central folder. It runs entirely inside Google — there's no separate server. It runs **three times a day, one department per run** (around 11:00 SOCN, 12:00 SOCE, 13:00 SOCW) — one department's data is all one run can finish inside Google's per-run time limit. You never run it by hand, you never tell it about a new file (it finds them itself), and you never create the yearly spreadsheet by hand (it makes that itself too). The only rule is that the raw files are named correctly and shared with the account that owns the script.

## Where the script lives

It's a **standalone Apps Script project** (not attached to any spreadsheet), owned by one Google account. To open it: that account → <https://script.google.com> → the SOC sync project. Everything — the schedule, the code, the run history — is in there.

## What you never need to do manually

- **A new staffing vendor's file for an existing department:** nothing beyond the one rule below (naming + sharing). It gets folded into that department's numbers on the next daily run.
- **Each new year's central spreadsheet:** the script creates it automatically. When January 2027 arrives and the first 2027 data appears, it makes a spreadsheet titled `2027` in the Central folder itself. This used to be a manual once-a-year task; it no longer is.

## The one thing you DO need to do by hand

**Every new raw attendance file** (a new vendor, or a new year's file for an existing vendor) must be:

1. **A real Google Sheet** (File → New → Google Sheets, or a copy of an existing one) — not a CSV file just sitting in Drive.
2. **Named exactly like this:** `[DEPARTMENT YEAR]_Daily name list_VENDOR`
   - Example: `[SOCE 2026]_Daily name list_BTS`
   - `DEPARTMENT` must be one of: `SOCN`, `SOCE`, `SOCW`
   - `YEAR` is a 4-digit year
   - `VENDOR` is the staffing vendor's short code (BTS, CYD, SPT, DSR, WAS, etc. — whatever it already is)
   - Get the brackets, spaces, and underscores exactly right — the system matches this pattern precisely and will refuse to run (rather than guess) if a file's name is close but not exact.
3. **Have one tab per month** inside it, named like `Jun 26` or `July 26`.
4. **Shared with the account that owns the script** as an **Editor** (the Google account named under "Where the script lives"). There is no separate "service account" anymore — it's just that one human account.

If a file is missing any of this, the daily sync fails loudly (rather than silently producing wrong numbers) — see "if the daily run fails" below.

## Where results live

Open the **Central** Drive folder. Inside it, for each SOC each year there are several spreadsheets, all created by the script itself:

- `<YEAR>_<DEPT>` — e.g. `2026_SOCN`, `2026_SOCE`, `2026_SOCW` — the **main results** file, with **5 tabs**: one `raw` tab + one tab per analysis aspect. This is the one you actually read.
- `<YEAR>_<DEPT>_<ASPECT>_Names` — e.g. `2026_SOCN_ShowUp_Names`, `2026_SOCN_Rotation_Names` — a **drill-down** file for each aspect. You never open these directly; you reach them by clicking a number.

There are separate drill-down files because a single Google spreadsheet can hold at most 10 million cells *across all its tabs*, and the "who's behind each number" detail is large enough to blow that limit if kept in one file. Giving each aspect its own **file** (not just another tab — tabs share one budget) is what keeps it under the limit.

- **`raw`** — every worker's show-up day that year for this SOC, combined across all its vendor files. Columns: *Date show up, Month show up, Sub-con name (the vendor), Name, Clock in, shift name, Shift_id, team*.
- **`New-Old Face`** — experienced vs inexperienced, for `All <DEPT>` + the 8 stations. Only counts workers who **stayed at one station** that month: **Old (experienced)** = one station AND worked **≥10 days**; **New (inexperienced)** = one station AND fewer than 10 days. Workers who **rotated** between stations are **not shown here at all** — they're in the Rotation tab. Shown at **three time scales**: monthly (two ways like Show Up: by station, then one block per category with trend coloring), **weekly** (who was present that week, counted by their month's Old/New verdict — clickable), and **daily** (same idea per day — plain numbers, not clickable). A worker's verdict always comes from their whole month; the week and day views only change *who was present*.
- **`Show Up`** — day-count buckets (1-5 / 6-10 / 11-15 / 16-20 / 21-30 days in a month), monthly, shown TWO ways: grouped **by team** (each team's own block), then the same numbers grouped **by bucket** (each bucket's own block, teams as rows) with color — a month that moved 5+ percentage points from the prior month is highlighted green (up) or red (down), boxed, and labeled. Only these 8 stations are shown: IB, CBS, mCBS, MS, OBI, OBC, OBS, OBD (other station labels found in the raw data are left out of this view on purpose). Then a **weekly bucket table** — the same idea per ISO week, with week-sized buckets (**1-2 / 3-4 / 5-7 days** in a week), weeks as columns, clickable. Plus a **daily head-count block** (how many distinct workers were present each day, per team and overall — plain numbers, not clickable).
- **`Consecutive`** — worked ≥3 days in a row: monthly and weekly, for `All SOCN` and each of the same 8 stations as Show Up. Each period shows worker counts split "Show up < 10 days" vs "Show up > 10 days", first as the plain split, then narrowed to "used to work 3+ days in a row at least once" (green) vs "never did" (red), as both counts and percentages. A `Total` row is included for reference but isn't clickable (it's just the two rows above it added together).
- **`Rotation`** — worked at a station more than once and whether they were rotated to others: monthly and weekly, one block per period, for each of the 8 stations (no overall total row — a worker who rotated across several stations would get counted more than once in a total, so there isn't one). Below the period-by-period detail, a second section shows the same three percentages (Rotation %, Non Rotation %, and "worked only 1 day") side by side across all months, with the same trend coloring described under Show Up. At the bottom, a **daily block** (plain numbers, not clickable): for each day, who was present at each station, split by whether they were a rotator **that month** — a worker only ever has one station per day, so "rotated today" by itself can't exist; the day view shows *where this month's rotators and non-rotators were, day by day*.

"By team" means each of the 8 stations gets its own rows. Every scope is also split by nationality — you'll see `All SOCN Burmese` / `All SOCN Thai`, `IB Burmese` / `IB Thai`, and so on. Only the nationalities actually present in that SOC appear. Percentages are shown with a `%` sign (e.g. `45.11%`).

**Click a number to see who's behind it.** Every monthly and weekly count in the four analysis tabs is a **clickable link**. The exception is anything **daily** (the head-count block, the daily New/Old tables, the daily Rotation tables): those are plain numbers — for the roster of a single day, just filter the `raw` tab by that date. Click a count and that aspect's `_Names` file opens at a block listing exactly those people, shown with the **same columns as the raw tab** (Date show up, Month, Sub-con, Name, Clock in, shift name, Shift_id, team). The number of rows always equals the number you clicked — click a count of 3 and you get exactly 3 rows, one per person (their first show-up in that group). Groups are separated by two blank rows.

The slide's **"% Burmese"** figure and **capacity-per-station** targets are **not** produced — both need the total (non-Burmese) headcount, which these Burmese-only name lists don't contain.

**Important: all of these files (every tab) are wiped and rewritten every single day.** If you type anything directly into these tabs, it's gone the next morning. To correct something, fix it in the *source* file (the vendor's raw sheet), not here.

## How the data is cleaned

The raw vendor sheets are messy (broken formulas, blank cells, duplicate rows, tabs that overlap at month boundaries). Before any number is counted, each month tab is cleaned by these rules. Every rule either fixes the row or drops it loudly — nothing wrong is silently counted.

- **One show-up per person per day.** A worker is counted as present on a date if any row exists for them that date. If the same person appears twice on the same date (e.g. a double shift, or the same day showing up in two overlapping month tabs like `Mar 26` and `Apr 26`), those are collapsed to **one** show-up, keeping the earliest clock-in.
- **Missing team is filled in from the shift name.** The `team` column is an abbreviation of the shift. When it's blank, the system fills it by learning the shift→team pairing from the other rows in the same tab that *do* have a team, using the most common pairing. If it still can't tell (a genuine tie), it stops and asks rather than guessing. As a last resort it uses a short list of known facts (e.g. shift `FSOCE` → team `FSOCE`), and failing that, the shift name itself as the team.
- **Undated rows are dropped and counted.** Some rows have a full work record (name, clock-in, shift, team) but no date in either date column — there's no day to attribute the show-up to, so the row is dropped. The count of dropped rows is written to the run log, never hidden.
- **Broken formula cells are recovered where possible.** Cells showing spreadsheet errors (`#REF!`, `#N/A`, `#VALUE!`, etc.) or a corrupted header cell are repaired from the other, intact copy of the same information (each row has the date in two columns; the header block has a fixed layout). If a date genuinely can't be recovered from either column, the row is dropped (see above). If the two date columns hold two *different* valid dates, it stops and asks.
- **Thai vs Burmese vendors.** No vendors are skipped. Each vendor is either Thai or Burmese: the `THAI_VENDORS` script property lists the Thai ones (currently `PPO, WAS, RG, YSL, BigBoom`), and **anything not on that list is treated as Burmese**. The summaries show Burmese and Thai as separate rows in every table. To classify a **new** vendor as Thai, add it to `THAI_VENDORS` in Script Properties (no code change); if you forget, it simply counts as Burmese until you do.
- **Only the file's own year is read.** A `[SOCN 2026]…` file is read only for its `… 26` month tabs; a leftover off-year tab (e.g. a stray `Dec 25`) is ignored.

## If the daily run fails

1. Open the Apps Script project → **Executions** (the left sidebar, the "clock/list" icon). A failed run shows up with a red "Failed" status and an error message — the function name tells you which department it was (`syncSOCN`, `syncSOCE`, or `syncSOCW`; each department has its own daily run). Click it to read the full message. The other two departments' runs are independent — one failing doesn't stop the others.
2. Common causes and what they mean:
   - *"no raw vendor spreadsheets found"* — the owning account can't see any files. Check the sharing step above.
   - *"doesn't match … pattern"* — a file was found but its name doesn't exactly follow `[DEPARTMENT YEAR]_Daily name list_VENDOR`. Fix the name.
   - *"unrecognized department"* — a file's department code isn't one of SOCN/SOCE/SOCW. Check for a typo in the file name.
   - *"duplicate (name,date)"* — the same worker appears on the same date in two vendor files **for the same department**. A human needs to look at the source data and decide which is right.
   - a message ending in *"…: <something about a date / team / column>"* prefixed with a file name and tab — a specific bad row in that vendor sheet; the message names the file and tab.
3. To test without waiting for the schedule: in the editor, pick the **`dryRun`** function and Run it, then open **Executions** to read its log — it reports what it found (files, row counts) and writes nothing. To do a real run on demand, Run the failed department's function (**`syncSOCN`** / **`syncSOCE`** / **`syncSOCW`**) — one department at a time; running all three at once (`sync`) takes longer than Google's per-run time limit allows on a full year's data.
4. When escalating to the developer, copy the exact error message from the Executions log — it's specific on purpose.

## Before the current owner's company account is deactivated

This system keeps working after the person who built it leaves — **but only if the Apps Script project is not owned by a Google account that gets deactivated.** The script, its daily trigger, and its access to the sheets all run as whoever owns the project.

Do this *before* the original account goes away:

1. **Move ownership of the Apps Script project** to a durable account — a generic company account, IT's account, or the next operator's personal account. (In Apps Script / Google Drive, transfer ownership of the project, or re-create it under the durable account by copying `engine.gs` + `Code.gs` + the manifest.)
2. **Re-run `installTrigger`** under that durable account so the daily schedule belongs to it, and **re-run `initProperties`** (or confirm the Script Properties `CENTRAL_FOLDER_ID` and `RAW_DEPARTMENTS` are set).
3. **Make sure the durable account has Editor access** to the Central folder and every raw vendor sheet (or that those are owned by it).
4. **GitHub** (where the code is version-controlled): add a second collaborator/owner to the repository.

Once the project is owned by a durable account, nothing about the daily run depends on the departed person's Gmail.

## Glossary

- **Department (SOC)**: one of SOCN, SOCE, SOCW — the three groups this system tracks. Each gets its own results file (`<YEAR>_<DEPT>`) plus one drill-down file per aspect (`<YEAR>_<DEPT>_<ASPECT>_Names`).
- **Vendor** (a.k.a. "Sub-con"): a staffing agency that supplies workers (BTS, CYD, SPT, DSR, WAS, etc.). Not a physical location — just which agency the worker's file came through. Kept for traceability only; nothing is calculated "per vendor."
- **Central folder**: the one Drive folder where every year's finished summary spreadsheet lives, and where the script auto-creates each new year's sheet.
- **Apps Script**: Google's built-in automation tool. Our script is "standalone" (its own project, not attached to a sheet) and runs on a daily timer.
- **Sync**: the daily process that reads a department's vendor files and rewrites its files in the Central folder. Runs as three scheduled functions, one per department (`syncSOCN`, `syncSOCE`, `syncSOCW`); `sync` (no suffix) does all three in one go and is only for small-data tests.
