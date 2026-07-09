# SOCN Sync — Runbook

This is for whoever operates this system day to day. It doesn't assume you can read code — if you can use Google Drive and n8n, that's enough.

## What this does, in one paragraph

Every day at 6am, a small automated service reads every worker attendance file across all 4 departments (SOCN, SOCE, SOCW, FSOCW), combines them, and updates one summary spreadsheet per year in the Central folder. You never have to run this by hand, and you never have to tell it about a new file — it finds them itself, as long as they're named correctly and shared with it (see below).

## What you never need to do manually

- **A new year starting (e.g. 2027 begins):** nothing. The first time the sync finds 2027 data, it automatically creates a brand-new "2027" spreadsheet in the Central folder with the right layout.
- **A new staffing vendor's file added for an existing department:** nothing, as long as it's named and shared correctly (see the one rule below). It just gets folded into that department's numbers on the next daily run.

## The one rule you do need to follow

When a new raw attendance file needs to be added (a new vendor, or a new year's file for an existing vendor), it must be:

1. **A real Google Sheet** (File → New → Google Sheets, or a copy of an existing one) — not a CSV file just sitting in Drive.
2. **Named exactly like this:** `[DEPARTMENT YEAR]_Daily name list_VENDOR`
   - Example: `[SOCE 2026]_Daily name list_BTS`
   - `DEPARTMENT` must be one of: `SOCN`, `SOCE`, `SOCW`, `FSOCW`
   - `YEAR` is a 4-digit year
   - `VENDOR` is the staffing vendor's short code (BTS, CYD, SPT, DSR, etc. — whatever it already is)
   - Get the brackets, spaces, and underscores exactly right — the system matches this pattern precisely and will refuse to run (rather than guess) if a file's name is close but not exact.
3. **Have one tab per month** inside it, named like `Jun 26` or `July 26`.
4. **Shared with the service account** as an **Editor**: `<ask the developer for the service-account email if you don't already have it>`.

If a file is missing any of these, the daily sync will fail loudly (not silently produce wrong numbers) — see "if the daily run fails" below.

## Where results live

Open the **Central** Drive folder. Inside it, one spreadsheet per year, named just the year (e.g. `2026`, `2027`). Each one has 7 tabs:

- **`SOCN`, `SOCE`, `SOCW`, `FSOCW`** — one tab per department, showing every worker's show-up day that year, combined across all that department's vendor files. Columns: *Date show up, Month show up, Sub-con name (the vendor), Name, Clock in, shift name, Shift_id, team*.
- **`Summary_1`, `Summary_Rotation`, `Summary_5`** — the three analysis views (show-up day buckets, station rotation, consecutive-day streaks), computed across all 4 departments combined.

**Important: all 7 tabs are wiped and rewritten every single day.** If you type anything directly into these tabs, it will be gone the next morning. If you need to correct something, fix it in the *source* file (the vendor's raw sheet), not here.

## If the daily run fails

1. In n8n, look at the workflow's execution history — a failed run shows up in red with an error message.
2. Common causes and what they mean:
   - *"no raw vendor spreadsheets found"* — the service account can't see any files at all. Check the sharing step above.
   - *"doesn't match the expected pattern"* — a file was found but its name doesn't exactly follow the `[DEPARTMENT YEAR]_Daily name list_VENDOR` format. Fix the name.
   - *"unrecognized department"* — a file's department code isn't one of SOCN/SOCE/SOCW/FSOCW. Check for a typo in the file name.
   - *"duplicate (name,date) rows"* — the same worker appears on the same date in two different vendor files for the same department. This needs a human to look at the source data and figure out which one is right.
3. You can also check `https://<the Render URL>/health` in a browser — if that doesn't load at all, the service itself is down (not a data problem), and that's a developer question.
4. When escalating to the developer, copy the exact error message from n8n's execution log — it's specific on purpose.

## Before the current developer's company account is deactivated

This system is designed to keep working even after the person who built it (and their company Google account) leaves — but only if these are done *before* that account is deactivated:

1. **GCP project**: the service account (the robot identity everything authenticates as) lives inside a Google Cloud project. Add a second Owner to that project — a generic company account, IT's account, or the next operator's own account — via Google Cloud Console → **IAM & Admin → IAM → Grant Access**. Once this is done, the project survives the original creator's account being gone; nothing about the service account, its key, or any Drive sharing needs to change.
2. **Render**: add a second team member/owner to the Render account or team, so the deployed service isn't locked to one person's login.
3. **GitHub**: add a second collaborator/owner to the repository, same reasoning.

None of this touches the service account's key, the `SYNC_TOKEN`, or any file sharing already set up — those keep working regardless of whose Gmail is active. This is purely about making sure a human can still *administer* things (redeploy, check logs, rotate the key someday) after the original operator is gone.

## Glossary

- **Department**: one of SOCN, SOCE, SOCW, FSOCW — the four groups this whole system tracks.
- **Vendor** (a.k.a. "Sub-con"): a staffing agency that supplies workers (BTS, CYD, SPT, DSR, etc.). Not a physical location — just which agency the worker's file came through. It's kept in the data for traceability only; nothing is calculated "per vendor."
- **Central folder**: the one Drive folder where every year's finished summary spreadsheet lives.
- **Sync**: the daily automated process that reads all vendor files and updates the Central folder.
