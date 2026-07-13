# SOC Sync — Runbook

This is for whoever operates this system day to day. It doesn't assume you can read code — if you can use Google Drive and open the Apps Script editor, that's enough.

## What this does, in one paragraph

Every day, a small Google Apps Script reads every worker attendance file across all 4 departments (SOCN, SOCE, SOCW, FSOCW) and updates one summary spreadsheet per year in the Central folder. It runs entirely inside Google — there's no separate server. You never run it by hand, you never tell it about a new file (it finds them itself), and you never create the yearly spreadsheet by hand (it makes that itself too). The only rule is that the raw files are named correctly and shared with the account that owns the script.

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
   - `DEPARTMENT` must be one of: `SOCN`, `SOCE`, `SOCW`, `FSOCW`
   - `YEAR` is a 4-digit year
   - `VENDOR` is the staffing vendor's short code (BTS, CYD, SPT, DSR, WAS, etc. — whatever it already is)
   - Get the brackets, spaces, and underscores exactly right — the system matches this pattern precisely and will refuse to run (rather than guess) if a file's name is close but not exact.
3. **Have one tab per month** inside it, named like `Jun 26` or `July 26`.
4. **Shared with the account that owns the script** as an **Editor** (the Google account named under "Where the script lives"). There is no separate "service account" anymore — it's just that one human account.

If a file is missing any of this, the daily sync fails loudly (rather than silently producing wrong numbers) — see "if the daily run fails" below.

## Where results live

Open the **Central** Drive folder. Inside it, one spreadsheet per year, named just the year (e.g. `2026`, `2027`). Each one has 7 tabs:

- **`SOCN`, `SOCE`, `SOCW`, `FSOCW`** — one tab per department, showing every worker's show-up day that year, combined across all that department's vendor files. Columns: *Date show up, Month show up, Sub-con name (the vendor), Name, Clock in, shift name, Shift_id, team*.
- **`Summary_1`, `Summary_Rotation`, `Summary_5`** — the three analysis views (show-up day buckets, station rotation, consecutive-day streaks). Each of these tabs is split into **4 stacked sections, one per department** (SOCN, then SOCE, then SOCW, then FSOCW), each labeled — so you read each SOC's numbers separately, not blended together.

**Important: all 7 tabs are wiped and rewritten every single day.** If you type anything directly into these tabs, it's gone the next morning. To correct something, fix it in the *source* file (the vendor's raw sheet), not here.

## If the daily run fails

1. Open the Apps Script project → **Executions** (the left sidebar, the "clock/list" icon). A failed run of `sync` shows up with a red "Failed" status and an error message. Click it to read the full message.
2. Common causes and what they mean:
   - *"no raw vendor spreadsheets found"* — the owning account can't see any files. Check the sharing step above.
   - *"doesn't match … pattern"* — a file was found but its name doesn't exactly follow `[DEPARTMENT YEAR]_Daily name list_VENDOR`. Fix the name.
   - *"unrecognized department"* — a file's department code isn't one of SOCN/SOCE/SOCW/FSOCW. Check for a typo in the file name.
   - *"duplicate (name,date)"* — the same worker appears on the same date in two vendor files **for the same department**. A human needs to look at the source data and decide which is right.
   - a message ending in *"…: <something about a date / team / column>"* prefixed with a file name and tab — a specific bad row in that vendor sheet; the message names the file and tab.
3. To test without waiting for the schedule: in the editor, pick the **`dryRun`** function and Run it, then open **Executions** to read its log — it reports what it found (files, row counts) and writes nothing. To do a real run on demand, Run **`sync`**.
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

- **Department (SOC)**: one of SOCN, SOCE, SOCW, FSOCW — the four groups this system tracks. Each now gets its own section in every summary tab.
- **Vendor** (a.k.a. "Sub-con"): a staffing agency that supplies workers (BTS, CYD, SPT, DSR, WAS, etc.). Not a physical location — just which agency the worker's file came through. Kept for traceability only; nothing is calculated "per vendor."
- **Central folder**: the one Drive folder where every year's finished summary spreadsheet lives, and where the script auto-creates each new year's sheet.
- **Apps Script**: Google's built-in automation tool. Our script is "standalone" (its own project, not attached to a sheet) and runs on a daily timer.
- **Sync**: the daily process (`sync` function) that reads all vendor files and rewrites the Central folder's year spreadsheet.
