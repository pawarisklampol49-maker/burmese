"""
SOCN worker-analysis — MVP engine + report shaping.

Reproduces the three manual Google Sheets views, oriented to match the
Summary CSVs (months/weeks as columns) so the output can later be written
straight into the central Google Sheet.

  View 1  Show-up buckets   (Summary_1)      — All SOCN + per station
  View 2  Station rotation  (Summary_Rotation)
  View 3  Consecutive-day   (Summary_5)      — <10/>10, used-to/never, weekly, depth

INPUT CONTRACT (clean set, one row per worker per show-up day; clock-ins only):
    name : worker   ("Name")      date : show-up date ("Date show up")   team ("team")
    This is all the engine below (_prepare and everything downstream) reads --
    extra columns are ignored. _clean_raw()'s actual output is richer (month,
    clockin, shift_name, shift_id) because the sync layer's raw-tab writes
    need them; that richness is not part of this contract.

LOCKED DEFINITIONS
  - Teams/stations are DATA-DRIVEN (distinct_teams): the distinct `team` values
    present in each SOC's own clean set, not a fixed list. (The old hardcoded
    OPERATIONAL_TEAMS/STATIONS_* remain only for the local mock render.)
  - New/Old face (slide p3): per (month, worker), the MAX distinct days at any
    single team. Old (experienced) if that max >= 10, else New. Scoped to a team
    T, Old = present at T with >= 10 days at T. (NEWOLD_MIN_DAYS = 10.)
  - Granularity: month (default), ISO week, or day, via a shared period key.
    Bucket/rotation/consecutive logic is inherently multi-day; the day/week grain
    for those is attendance_crosstab (distinct workers present per period, per
    team) -- the shared non-degenerate daily/weekly view.
  - Show-up day = one clock-in on one date = 1. Days/worker/month = distinct dates.
  - Buckets 1-5,6-10,11-15,16-20,21-30. % over that scope's bucketed workers.
    ALL scope: days = total across teams. STATION scope: days = days in that station.
  - Rotation pivot (worker x team = day counts):
        Grand Total    = total days that month
        Rotation count = # team cols with count > 0  (ALL teams — "follow the sheet")
        Analyze <T>    = "Rotated" iff count[T] > 1 AND Rotation count > 1
    Per team: population = count[T] >= 1; Rotation = Analyze=="Rotated"; NonRot = rest.
  - "1 day" subgroup = READING B: count[T] == 1 (one day IN THAT team), non-rotated.
  - Consecutive = calendar-adjacent dates. WEEK run bounded to one ISO week;
    MONTH run bounded to the month (Mar30-31+Apr1 -> week 14, but neither month).
  - Week numbering = ISO week.
"""
import calendar
import datetime as dt
import random
import pandas as pd

OPERATIONAL_TEAMS = ["CBS", "IB", "mCBS", "MS", "OBI", "OBS", "OBC", "OBD"]
STATIONS_SHOWUP = ["IB", "Helper", "CBS", "mCBS", "MS", "OBI", "OBS", "OBC", "OBD"]
STATIONS_ROT = ["IB", "CBS", "mCBS", "MS", "OBI", "OBC", "OBS", "OBD"]
BUCKETS = [(1, 5), (6, 10), (11, 15), (16, 20), (21, 30)]


def _month_label(m: str) -> str:
    """'2026-06' -> 'Jun'. Derived from the month string itself so it isn't
    pinned to a hardcoded year range (was a fixed dict, broke silently past
    2026-06)."""
    return dt.datetime.strptime(m, "%Y-%m").strftime("%b")


# ---------------------------------------------------------------- raw input
def _mangle_dupe_cols(header: list) -> list:
    """Reproduce pandas' read_csv dupe-column suffixing (วันที่, วันที่ -> วันที่, วันที่.1)
    for header rows pulled from a Google Sheet, which don't get that for free."""
    seen = {}
    out = []
    for h in header:
        n = seen.get(h, 0)
        out.append(h if n == 0 else f"{h}.{n}")
        seen[h] = n + 1
    return out


_REQUIRED_RAW_COLUMNS = {"วันที่", "ค้นหา", "วันที่.1", "team", "เข้างาน", "shift name", "Shift_id"}

# Broken spreadsheet formulas surface as literal Excel/Sheets error strings,
# not blank cells -- confirmed live twice now (team="#N/A" in one vendor
# file, วันที่.1="#REF!" in another). pandas' default NA-string inference
# can't be relied on once input comes from the Sheets API instead of
# read_csv, so these are normalized explicitly, everywhere they might show
# up, rather than one column/sentinel at a time as each is discovered live.
_SHEETS_ERROR_SENTINELS = {"#REF!", "#N/A", "#VALUE!", "#DIV/0!", "#NAME?", "#NULL!", "#NUM!", "#ERROR!"}


def _clear_sheets_errors(s: pd.Series) -> pd.Series:
    return s.where(~s.isin(_SHEETS_ERROR_SENTINELS), pd.NA)


# team is a spreadsheet lookup from shift name (stripped) that can break
# with no learnable example left in a given tab (confirmed live: FSOCE,
# HIGHVALUE). These are confirmed business facts from the user, not
# guesses -- add a new stripped-shift-name -> team entry here whenever
# _clean_raw's "no learnable shift-name -> team mapping" error names one,
# rather than special-casing each in code. Applied only as a last resort,
# after the data-driven learning in _clean_raw already had its chance.
_KNOWN_SHIFT_TEAM = {
    "FSOCE": "FSOCE",
}


def _repair_date_header_positions(header: list) -> list:
    """A fragile header cell can itself be overwritten by a stray value or left
    blank -- not one of _SHEETS_ERROR_SENTINELS, just a bare number, a time, or
    an empty string. Confirmed live: BTS 'May 26' had "49" where the first
    วันที่ should be; PPO 'Feb 26' had "11:00:00 AM" where เข้างาน (clock-in)
    should be; DSR 'Jan 26' had a BLANK ค้นหา (name) cell with real names
    underneath. The column ORDER is unaffected, only that one cell's text -- the
    locked schema (CLAUDE.md's Input section) fixes the fragile columns by
    position. The block is located by EITHER anchor still intact: ค้นหา, or
    'shift name' (fixed 2 columns to its right). ค้นหา itself can be the
    corrupted cell, so it can't be the sole anchor. From the located name index:
    วันที่ = name-1, ค้นหา = name, เข้างาน = name+1, shift name = name+2, second
    วันที่ = name+3. Only ever consulted as a fallback (see _find_header_row/
    _resolve_header) when strict name-matching has already failed -- never
    touches an already-working header, and a mis-repair still has to pass the
    superset check AND real date parsing downstream."""
    if "ค้นหา" in header:
        name_idx = header.index("ค้นหา")
    elif "shift name" in header and header.index("shift name") >= 2:
        name_idx = header.index("shift name") - 2   # ค้นหา sits 2 left of shift name
    else:
        return header
    header = list(header)
    if name_idx - 1 >= 0:
        header[name_idx - 1] = "วันที่"
    header[name_idx] = "ค้นหา"
    if name_idx + 1 < len(header):
        header[name_idx + 1] = "เข้างาน"
    if name_idx + 2 < len(header):
        header[name_idx + 2] = "shift name"
    if name_idx + 3 < len(header):
        header[name_idx + 3] = "วันที่"
    return header


def _mangled_header_candidates(row: list):
    """Header candidates for one row, in order of trust: the literal
    (dupe-mangled) header first, then a position-repaired version as a
    fallback. Shared by _find_header_row and _resolve_header so row
    detection and header construction can never disagree about which
    candidate matched."""
    yield _mangle_dupe_cols(row)
    yield _mangle_dupe_cols(_repair_date_header_positions(row))


def _find_header_row(rows: list, max_scan: int = 5) -> int:
    """Some vendor exports have a title/banner row above the real header
    (seen live: a merged note + 'OPS ID' + a wall of blank cells) -- others
    (the originally-validated BTS file) don't. Scan for the row whose
    (dupe-mangled) columns are a superset of what _clean_raw needs, rather
    than assuming row 0 is always the header."""
    for i, row in enumerate(rows[:max_scan]):
        for mangled in _mangled_header_candidates(row):
            if _REQUIRED_RAW_COLUMNS <= set(mangled):
                return i
    raise ValueError(
        f"couldn't find a header row containing {sorted(_REQUIRED_RAW_COLUMNS)} "
        f"in the first {max_scan} rows -- schema drift, or a banner deeper than expected"
    )


def _resolve_header(row: list) -> list:
    """The actual mangled header for a row already confirmed by
    _find_header_row -- same strict-then-position-repaired precedence, kept
    as one shared function so it can't disagree with how the row was found."""
    for mangled in _mangled_header_candidates(row):
        if _REQUIRED_RAW_COLUMNS <= set(mangled):
            return mangled
    raise ValueError("header row no longer matches on rebuild -- internal inconsistency")


def _rows_to_raw_df(rows: list) -> pd.DataFrame:
    """rows: list of row-lists (all strings, header position not yet known).
    Locates the real header row, builds the raw (uncleaned) frame for _clean_raw.

    Normalizes every row to one common width first. The Sheets API batchGet
    endpoint (used by the batched read in app.py) returns RAGGED rows --
    trailing empty cells trimmed per row, and a data row can even run WIDER
    than the header when there's stray data past the schema -- unlike
    gspread's get_all_values, which rectangularizes. A row wider than the
    header would otherwise crash DataFrame construction ("N columns passed,
    passed data had M columns"); a row narrower would misalign. Padding
    header and data alike to the max width reproduces exactly what
    get_all_values used to hand us: extra beyond-schema columns become
    unused, nameless columns, and the required columns still line up."""
    if not rows:
        raise ValueError("empty sheet -- no header row")
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    header_idx = _find_header_row(rows)
    header = _resolve_header(rows[header_idx])
    return pd.DataFrame(rows[header_idx + 1:], columns=header).replace("", pd.NA)


def _clean_raw(raw: pd.DataFrame) -> pd.DataFrame:
    """Clean one raw monthly attendance export -> (name, date, month, team,
    clockin, shift_name, shift_id) frame. The engine (_prepare) only ever
    requires {name, date, team} and ignores the rest -- the extra columns
    exist for the sync layer's raw-tab writes, not for any metric computed
    in this module.

    Resolved mapping (see CLAUDE.md): name=ค้นหา, date=วันที่.1, team=team.
    วันที่ and วันที่.1 encode the same date in different formats (DD Mon YY vs
    ISO) -- verified equal after parsing, not as raw strings. Export pads the
    file with fully-blank trailer rows, dropped via ค้นหา.notna(). Broken
    vendor-file spreadsheet formulas surface as literal Excel/Sheets error
    strings (e.g. "#N/A", "#REF!"), not blank cells -- confirmed live in team
    and in either date column, across different vendor files; see
    _SHEETS_ERROR_SENTINELS. team is itself a spreadsheet lookup from shift
    name and can break the same way; when missing, it's first backfilled by
    learning shift name -> team from whichever OTHER rows in the same tab
    already have both populated (a shift name mapping to more than one
    distinct team, among rows that actually need it, isn't guessed -- still
    throws). "FSOCE " with a trailing space vs "FSOCE" without is a
    data-entry split of one shift name (stripped before learning, so one
    variant's valid rows can recover the other's broken ones) -- and
    _KNOWN_SHIFT_TEAM (confirmed business facts, e.g. shift "FSOCE" -> team
    "FSOCE") is applied as a last resort when even that learning can't
    resolve a row (e.g. an entire tab where every row for that shift name
    has a broken lookup, with no valid example left to learn from); after
    that, the shift name itself is used as team. A row with NEITHER team
    nor shift name has nothing to attribute a station to at all -- dropped,
    not thrown on. If either date column is a sentinel, it's recovered from
    the other; if both are, or if they parse to genuinely different dates,
    _clean_raw throws rather than guessing. Same-day rows with two different
    teams (double shift / OT past
    midnight) are collapsed by keeping the earliest เข้างาน (min clock-in
    time-of-day) -- the original เข้างาน string (not the parsed time used
    only for that tie-break) is kept in the output as `clockin`.
    """
    missing = _REQUIRED_RAW_COLUMNS - set(raw.columns)
    if missing:
        raise ValueError(f"missing required raw columns: {sorted(missing)}")

    df = raw[raw["ค้นหา"].notna()].copy()
    # Confirmed live: [SOCE 2026]_Daily name list_SPT, tab 'Mar 26' had the
    # header row accidentally pasted twice (rows 1 and 2), so after the real
    # header is correctly identified, the SECOND header copy shows up as a
    # data row -- ค้นหา literally == "ค้นหา", วันที่ literally == "วันที่", etc.
    # No real worker is named "ค้นหา", so this one check safely drops the
    # duplicate without adopting a general "drop anything unparseable" rule,
    # which would also hide a genuine data-entry typo that deserves a human.
    df = df[df["ค้นหา"] != "ค้นหา"]
    df["team"] = _clear_sheets_errors(df["team"])

    # วันที่'s display format varies by source (local CSV export: "01 Jun 26";
    # live Sheets data seen in production: "1-Jan-26", no leading zero, hyphens)
    # -- infer per-element rather than pin to one sample's format. Either
    # column can independently be a broken formula (see _SHEETS_ERROR_SENTINELS);
    # each is cross-filled from the other when one is unrecoverable, so a
    # single broken cell doesn't lose a real worker's show-up day.
    # errors="coerce" (not "raise"): a non-empty value that just doesn't parse as
    # a date becomes NaT and is cross-filled from the sibling column, same as a
    # known sentinel. Confirmed live in [SOCE 2026]_Daily name list_BTS 'Jul 26'
    # row 2074, where a broken formula spilled the shift name ("FSOCE ") across
    # วันที่.1 and the rest of the row while วันที่ still held "09 Jul 26". A row
    # with no valid date in EITHER column is dropped-and-counted below; two
    # DIFFERENT valid dates still trips the disagree throw.
    d1 = pd.to_datetime(_clear_sheets_errors(df["วันที่"]), format="mixed", dayfirst=True, errors="coerce")
    d2 = pd.to_datetime(_clear_sheets_errors(df["วันที่.1"]), format="%Y-%m-%d", errors="coerce")
    d1, d2 = d1.fillna(d2), d2.fillna(d1)

    # A row with no usable date in EITHER column has no attributable calendar
    # day (streaks in Summary_5 need a real day), so it can't be counted as a
    # show-up -- DROP it and count it, rather than throwing and blocking the
    # whole sync or fabricating a day. Per user decision (confirmed live: PNK
    # 'Jul 26' had 109 rows with a full work record -- name/clock/shift/team --
    # but both date cells simply blank; earlier CYD 'Feb 26' had 2 all-blank
    # roster placeholders). The count is surfaced on df.attrs['dropped_no_date']
    # so the caller logs it and the drop is never silent.
    unrecoverable = d1.isna() & d2.isna()
    dropped_no_date = int(unrecoverable.sum())
    if unrecoverable.any():
        keep = ~unrecoverable
        df, d1, d2 = df[keep], d1[keep], d2[keep]

    mismatch = d1 != d2
    if mismatch.any():
        sample = df.loc[mismatch, ["ค้นหา", "วันที่", "วันที่.1"]].head(5)
        examples = "; ".join(
            f"{row['ค้นหา']}: วันที่={row['วันที่']!r} (parsed {d1[i].date()}) vs "
            f"วันที่.1={row['วันที่.1']!r} (parsed {d2[i].date()})"
            for i, row in sample.iterrows()
        )
        raise ValueError(
            f"วันที่ and วันที่.1 disagree on date for {int(mismatch.sum())} row(s) -- stop, ask "
            f"which is the show-up date. First examples: {examples}"
        )

    shift = df["shift name"].str.strip()
    # team is itself a spreadsheet lookup from shift name, and can break the
    # same way as everything else (#N/A, blank). Learn shift name -> team
    # from whichever OTHER rows in THIS tab already have both, but only for
    # shift names that actually have a row needing backfill -- a shift name
    # is free to appear with more than one team elsewhere in real data as
    # long as nothing missing depends on it. When a NEEDED shift name maps to
    # multiple teams, resolve to its MAJORITY team: team is an abbreviation of
    # shift name, so the dominant pairing is the real mapping and the minority
    # are data-entry noise (confirmed live: SPT 'Jul 26' "Outbound" -> OB x195
    # with a scatter of stray teams, "Helper" -> Helper x9 with 3 stray). Only
    # a genuine TIE for the top (no dominant team) is real ambiguity and throws.
    missing_team = df["team"].isna()
    if missing_team.any():
        needed = set(shift[missing_team])
        has_team = df["team"].notna()
        pairs = pd.DataFrame({"shift": shift[has_team], "team": df.loc[has_team, "team"]})
        pairs = pairs[pairs["shift"].isin(needed)]
        resolved, tied = {}, []
        for s, grp in pairs.groupby("shift"):
            vc = grp["team"].value_counts()
            if len(vc) > 1 and vc.iloc[0] == vc.iloc[1]:
                tied.append(s)                 # no dominant team -> ambiguous
            else:
                resolved[s] = vc.index[0]      # majority team wins
        if tied:
            raise ValueError(f"shift name(s) map to multiple teams with no majority (a tie), can't backfill safely: {sorted(tied)} -- stop, ask")
        shift_to_team = pd.Series(resolved, dtype=object)

        backfilled = shift[missing_team].map(shift_to_team).astype(df["team"].dtype)
        df.loc[missing_team, "team"] = backfilled

        # Confirmed business facts (_KNOWN_SHIFT_TEAM), applied only as a
        # last resort to rows the data-driven learning above still couldn't
        # resolve (e.g. an entire tab where every row for that shift name
        # has a broken team lookup, leaving no valid example anywhere to
        # learn from) -- never overrides a value the general learning
        # already filled in.
        still_missing = df["team"].isna()
        known_fallback = shift[still_missing].map(_KNOWN_SHIFT_TEAM).astype(df["team"].dtype)
        df.loc[still_missing, "team"] = known_fallback

        # Final fallback: the shift name itself, as a last resort. Some
        # teams are genuinely named after their shift, and requiring a
        # human answer for every never-before-seen shift name doesn't scale
        # (confirmed live: FSOCE, then HIGHVALUE, in quick succession across
        # different vendor files). Only a row with NO shift name either
        # (nothing left to fall back to) still throws.
        still_missing = df["team"].isna()
        df.loc[still_missing, "team"] = shift[still_missing]

        # A row with NEITHER team nor shift name has nothing to attribute a
        # station to at all -- same shape as the CYD placeholder rows
        # (confirmed live: BTS 'Jul 26' had 3 such rows), so it's dropped
        # rather than blocking the whole tab.
        keep = df["team"].notna()
        if not keep.all():
            df, d1, d2, shift = df[keep], d1[keep], d2[keep], shift[keep]

    out = pd.DataFrame({
        "name": df["ค้นหา"],
        "date": d2,
        "team": df["team"],
        "clockin": df["เข้างาน"],
        "shift_name": shift,
        "shift_id": df["Shift_id"],
        # เข้างาน isn't load-bearing for a show-up day at all (no clock-in
        # filter on the core metric) -- it's only read here to break ties
        # when the SAME worker has two different teams on the SAME date.
        # Confirmed live: [SOCE 2026]_Daily name list_CYD, tab 'Mar 26' had
        # a garbled value ("$0.88" -- looks like a different column's data
        # leaked in via a broken formula) that isn't a time at all. coerce
        # instead of raise: an unparseable clock-in sorts last (pandas'
        # default NaT ordering), so it naturally loses a tie to a row with a
        # real time, and only matters at all for the rare collision case --
        # the raw string is preserved as-is in `clockin` regardless.
        "_clocksort": pd.to_datetime(df["เข้างาน"], format="%H:%M", errors="coerce"),
    })
    out = out.sort_values("_clocksort").drop_duplicates(subset=["name", "date"], keep="first")
    out = out.drop(columns="_clocksort").reset_index(drop=True)
    out["month"] = pd.to_datetime(out["date"]).dt.strftime("%Y-%m").map(_month_label)

    dup = out.duplicated(subset=["name", "date"]).sum()
    if dup:
        raise ValueError(f"{dup} duplicate (name,date) rows survived dedup -- clean set must be one row per worker per day")
    out.attrs["dropped_no_date"] = dropped_no_date   # surfaced for the caller to log
    return out


def load_raw(path: str) -> pd.DataFrame:
    """Load one raw monthly attendance CSV -> clean (name, date, team) frame. See _clean_raw
    and _rows_to_raw_df (header row isn't always row 0 -- some vendor exports have a title
    banner above it). keep_default_na=False so a CSV and a live Sheet behave identically
    going into _clean_raw (which does its own explicit NA/#N/A normalization)."""
    rows = pd.read_csv(path, dtype=str, header=None, keep_default_na=False).values.tolist()
    return _clean_raw(_rows_to_raw_df(rows))


def load_raw_from_values(values: list) -> pd.DataFrame:
    """Load one raw monthly attendance worksheet tab (gspread worksheet.get_all_values()
    output: rows of strings, header row not yet known) -> clean (name, date, team) frame.
    See _clean_raw and _rows_to_raw_df."""
    return _clean_raw(_rows_to_raw_df(values))


# ---------------------------------------------------------------- core engine
def _prepare(df: pd.DataFrame) -> pd.DataFrame:
    required = {"name", "date", "team"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"missing required columns: {sorted(missing)}")
    out = df[["name", "date", "team"]].copy()
    ts = pd.to_datetime(out["date"], errors="raise").dt.normalize()
    out["date"] = ts.dt.date
    dup = out.duplicated(subset=["name", "date"]).sum()
    if dup:
        raise ValueError(f"{dup} duplicate (name,date) rows — clean set must be one row per worker per day")
    iso = ts.dt.isocalendar()
    out["iso_year"] = iso["year"].to_numpy()
    out["iso_week"] = iso["week"].to_numpy()
    out["month"] = ts.dt.strftime("%Y-%m")
    return out


def _max_consecutive_run(dates) -> int:
    ds = sorted(set(dates))
    if not ds:
        return 0
    best = cur = 1
    for a, b in zip(ds, ds[1:]):
        cur = cur + 1 if (b - a).days == 1 else 1
        best = max(best, cur)
    return best


def _days_pwm(d, team=None):
    """distinct show-up days per (month, worker), optionally within one team."""
    x = d if team is None else d[d["team"] == team]
    return x.groupby(["month", "name"]).size().rename("days").reset_index()


def distinct_teams(df):
    """The distinct teams present, sorted -- data-driven (replaces the hardcoded
    OPERATIONAL_TEAMS; station lists differ per SOC)."""
    return sorted(_prepare(df)["team"].unique())


def _period_series(d, period):
    """(sort_key, display_label) Series for 'month' (default), ISO 'week', or 'day'."""
    if period == "week":
        wk = d["iso_week"].astype(int)
        key = d["iso_year"].astype(str) + "-W" + wk.map(lambda w: f"{w:02d}")
        return key, "W" + wk.astype(str)
    if period == "day":
        key = d["date"].astype(str)
        return key, key
    return d["month"], d["month"].map(_month_label)


def rotation_worker_table(df, period="month"):
    d = _prepare(df)
    key, label = _period_series(d, period)
    d = d.assign(_pk=key, _plabel=label)
    piv = d.pivot_table(index=["_pk", "_plabel", "name"], columns="team",
                        values="date", aggfunc="count", fill_value=0)
    team_cols = list(piv.columns)
    piv["Rotation count"] = (piv[team_cols] > 0).sum(axis=1)
    for t in team_cols:                        # data-driven: only teams present
        piv[f"Analyze {t}"] = ((piv[t] > 1) & (piv["Rotation count"] > 1)).map({True: "Rotated", False: ""})
    return piv.reset_index()


def rotation_summary(df, period="month"):
    wt = rotation_worker_table(df, period)
    teams = distinct_teams(df)
    rows = []
    for pk, g in wt.groupby("_pk"):
        # monthly keeps the ISO month key ("2026-03", unchanged); weekly is "W7"
        label = pk if period == "month" else g["_plabel"].iloc[0]
        for t in teams:
            if t not in g.columns:
                continue
            in_team = g[g[t] >= 1]
            pop = len(in_team)
            if pop == 0:
                continue
            rotated = int((in_team[f"Analyze {t}"] == "Rotated").sum())
            nonrot = pop - rotated
            oneday = int(((in_team[f"Analyze {t}"] != "Rotated") & (in_team[t] == 1)).sum())  # READING B
            rows.append({"month": label, "team": t, "population": pop, "rotation": rotated,
                         "non_rotation": nonrot, "oneday_nonrot": oneday,
                         "rotation%": round(rotated / pop * 100, 2),
                         "non_rotation%": round(nonrot / pop * 100, 2),
                         "oneday%": round(oneday / nonrot * 100, 2) if nonrot else float("nan")})
    return pd.DataFrame(rows)


NEWOLD_MIN_DAYS = 10


def new_old_monthly(df, team=None):
    """New/Old face (slide p3): per (month, worker), the MAX distinct days at any
    single team; Old (experienced) if that max >= 10, else New. With a team arg,
    scope to that team. Returns (counts, pct) DataFrames shaped like showup_block
    (rows Old/New, cols=month labels)."""
    d = _prepare(df)
    x = d if team is None else d[d["team"] == team]
    months = _mcols(d)
    labels = [_month_label(m) for m in months]
    counts = pd.DataFrame(0, index=["Old", "New"], columns=labels)
    if len(x):
        per_team = x.groupby(["month", "name", "team"]).size().rename("days").reset_index()
        max_days = per_team.groupby(["month", "name"])["days"].max().reset_index()
        max_days["face"] = max_days["days"].map(lambda v: "Old" if v >= NEWOLD_MIN_DAYS else "New")
        for m, ml in zip(months, labels):
            g = max_days[max_days["month"] == m]
            counts.loc["Old", ml] = int((g["face"] == "Old").sum())
            counts.loc["New", ml] = int((g["face"] == "New").sum())
    pct = pd.DataFrame(0.0, index=["Old %", "New %"], columns=labels)
    for ml in labels:
        tot = counts.loc["Old", ml] + counts.loc["New", ml]
        pct.loc["Old %", ml] = round(counts.loc["Old", ml] / tot * 100, 2) if tot else 0.0
        pct.loc["New %", ml] = round(counts.loc["New", ml] / tot * 100, 2) if tot else 0.0
    return counts, pct


def attendance_crosstab(df, period):
    """Distinct workers present per period, per team, + an 'All' row across teams.
    Serves the daily ('day') and weekly ('week') grains. team rows x period cols."""
    d = _prepare(df)
    teams = distinct_teams(df)
    key, label = _period_series(d, period)
    d = d.assign(_pk=key, _plabel=label)
    period_keys = sorted(d["_pk"].unique())
    labels = [d[d["_pk"] == k]["_plabel"].iloc[0] for k in period_keys]
    counts = pd.DataFrame(0, index=teams, columns=labels)
    for t in teams:
        xt = d[d["team"] == t]
        n = xt.groupby("_pk")["name"].nunique()
        for k, lab in zip(period_keys, labels):
            counts.loc[t, lab] = int(n.get(k, 0))
    all_row = d.groupby("_pk")["name"].nunique()
    all_series = pd.Series({lab: int(all_row.get(k, 0)) for k, lab in zip(period_keys, labels)})
    return counts, all_series


# ---------------------------------------------------------------- membership (drill-down)
# The NAMES behind each summary count. Each *_members reuses the SAME grouping
# as its count function, so names.length == count (asserted in _run_tests).
def showup_members(df, team=None):
    d = _prepare(df)
    days = _days_pwm(d, team)
    out = {}
    for _, x in days.iterrows():
        bucket = None
        for lo, hi in BUCKETS:
            if lo <= x["days"] <= hi:
                bucket = f"{lo}-{hi}"
        if bucket is None:
            continue
        out.setdefault(_month_label(x["month"]), {}).setdefault(bucket, []).append(x["name"])
    return out


def new_old_members(df, team=None):
    d = _prepare(df)
    x = d if team is None else d[d["team"] == team]
    out = {}
    if len(x):
        per_team = x.groupby(["month", "name", "team"]).size().rename("days").reset_index()
        maxd = per_team.groupby(["month", "name"])["days"].max().reset_index()
        for _, row in maxd.iterrows():
            ml = _month_label(row["month"])
            face = "Old" if row["days"] >= NEWOLD_MIN_DAYS else "New"
            out.setdefault(ml, {"Old": [], "New": []})[face].append(row["name"])
    return out


def streak_month_members(df, team=None):
    d = _prepare(df)
    st = _worker_month_stats(d, team)
    out = {}
    for _, x in st.iterrows():
        o = out.setdefault(_month_label(x["month"]), {
            "active": [], "<10": [], ">10": [], "usedto_<10": [], "usedto_>10": [],
            "never_<10": [], "never_>10": []})
        lt, gt, used = x["days"] < 10, x["days"] > 10, x["run"] >= 3
        o["active"].append(x["name"])
        if lt: o["<10"].append(x["name"])
        if gt: o[">10"].append(x["name"])
        if used and lt: o["usedto_<10"].append(x["name"])
        if used and gt: o["usedto_>10"].append(x["name"])
        if not used and lt: o["never_<10"].append(x["name"])
        if not used and gt: o["never_>10"].append(x["name"])
    return out


def streak_week_members(df, team=None, min_run=3):
    d = _prepare(df)
    x = d if team is None else d[d["team"] == team]
    out = {}
    for (yr, wk), g in x.groupby(["iso_year", "iso_week"]):
        o = out.setdefault(f"W{int(wk)}", {"active": [], ">=3": [], "<3": []})
        for name, wr in g.groupby("name"):
            o["active"].append(name)
            run = _max_consecutive_run(list(wr["date"]))
            (o[">=3"] if run >= min_run else o["<3"]).append(name)
    return out


def rotation_members(df, period="month"):
    wt = rotation_worker_table(df, period)
    teams = distinct_teams(df)
    out = {}
    for pk, g in wt.groupby("_pk"):
        label = pk if period == "month" else g["_plabel"].iloc[0]
        team_obj = {}
        for t in teams:
            if t not in g.columns:
                continue
            in_team = g[g[t] >= 1]
            if not len(in_team):
                continue
            cell = {"population": [], "rotation": [], "non_rotation": [], "oneday_nonrot": []}
            for _, r in in_team.iterrows():
                cell["population"].append(r["name"])
                if r[f"Analyze {t}"] == "Rotated":
                    cell["rotation"].append(r["name"])
                else:
                    cell["non_rotation"].append(r["name"])
                    if r[t] == 1:
                        cell["oneday_nonrot"].append(r["name"])
            team_obj[t] = cell
        out[label] = team_obj
    return out


def _worker_month_stats(d, team=None):
    x = d if team is None else d[d["team"] == team]
    g = x.groupby(["month", "name"])
    days = g.size().rename("days")
    run = g["date"].apply(lambda s: _max_consecutive_run(list(s))).rename("run")
    return pd.concat([days, run], axis=1).reset_index()


# ---------------------------------------------------------------- report shaping
def _mcols(d):
    return sorted(d["month"].unique())


def showup_block(df, team=None):
    """counts + % table shaped like a Summary_1 block: rows=buckets+Sum, cols=months."""
    d = _prepare(df)
    days = _days_pwm(d, team)
    months = _mcols(d)
    idx = [f"{lo}-{hi}" for lo, hi in BUCKETS]
    counts = pd.DataFrame(0, index=idx, columns=months)
    summ = {}
    for m in months:
        g = days[days["month"] == m]
        for lo, hi in BUCKETS:
            counts.loc[f"{lo}-{hi}", m] = int(((g["days"] >= lo) & (g["days"] <= hi)).sum())
        summ[m] = int(counts[m].sum())
    counts.loc["Sum Month"] = [summ[m] for m in months]
    pct = counts.astype(float).copy()
    for m in months:
        pct[m] = (counts[m] / summ[m] * 100).round(2) if summ[m] else 0.0
    pct.loc["Sum Month"] = 100.0
    counts.columns = pct.columns = [_month_label(m) for m in months]
    return counts, pct


def rotation_month_table(df, month_iso):
    rs = rotation_summary(df)
    g = rs[rs["month"] == month_iso].set_index("team").reindex(STATIONS_ROT)
    return g[["non_rotation", "rotation", "oneday_nonrot", "oneday%", "population", "non_rotation%", "rotation%"]]


def rotation_pct_block(df, col):
    rs = rotation_summary(df)
    months = _mcols(rs.rename(columns={"month": "month"}))
    p = rs.pivot(index="team", columns="month", values=col).reindex(STATIONS_ROT)[months]
    p.columns = [_month_label(m) for m in months]
    return p


def streak_month_crosstab(df, team=None):
    """used-to/never x <10/>10 counts per month, shaped like Summary_5 left."""
    d = _prepare(df)
    st = _worker_month_stats(d, team)
    rows = []
    for m in _mcols(d):
        g = st[st["month"] == m]
        lt, gt, used = g["days"] < 10, g["days"] > 10, g["run"] >= 3
        s = lambda c: int(c.sum())
        rows.append({"month": _month_label(m), "active": len(g),
                     "<10": s(lt), ">10": s(gt),
                     "usedto_<10": s(used & lt), "usedto_>10": s(used & gt),
                     "never_<10": s(~used & lt), "never_>10": s(~used & gt)})
    return pd.DataFrame(rows)


def streak_week(df, team=None, min_run=3):
    """>=min_run within ISO week: counts + % per week, shaped like Summary_5 weekly."""
    d = _prepare(df)
    x = d if team is None else d[d["team"] == team]
    rows = []
    for (yr, wk), g in x.groupby(["iso_year", "iso_week"]):
        runs = g.groupby("name")["date"].apply(lambda s: _max_consecutive_run(list(s)))
        active = len(runs)
        q = int((runs >= min_run).sum())
        rows.append({"week": f"W{int(wk)}", "active": active, ">=3": q, "<3": active - q,
                     ">=3%": round(q / active * 100, 2) if active else 0.0})
    return pd.DataFrame(rows).sort_values("week", key=lambda s: s.str[1:].astype(int)).reset_index(drop=True)


def weeks_depth(df, team=None, min_run=3):
    """Summary_5 depth: of workers who EVER hit >=min_run, distribution by #weeks."""
    d = _prepare(df)
    x = d if team is None else d[d["team"] == team]
    wk = x.groupby(["name", "iso_year", "iso_week"])["date"].apply(lambda s: _max_consecutive_run(list(s)))
    per_worker_weeks = (wk >= min_run).groupby(level="name").sum()
    total_workers = x["name"].nunique()
    ever = int((per_worker_weeks >= 1).sum())
    dist = per_worker_weeks[per_worker_weeks >= 1].value_counts().sort_index()
    return total_workers, ever, dist


# ---------------------------------------------------------------- tests (correctness)
def _synthetic():
    def d(day, month=3):
        return dt.date(2026, month, day)
    r = []
    def add(n, t, ds):
        r.extend({"name": n, "team": t, "date": x} for x in ds)
    add("alice", "IB", [d(2), d(3), d(4), d(5), d(6)])
    add("bob", "IB", [d(2)]); add("bob", "MS", [d(3)])
    add("carol", "IB", [d(9), d(10), d(11), d(16)])
    add("dave", "IB", [d(2), d(3)]); add("dave", "MS", [d(4), d(5), d(6)])
    add("erin", "IB", [d(2)])
    add("frank", "IB", [d(2), d(3), d(4), d(5), d(6), d(9), d(10)])
    add("grace", "IB", [d(2), d(3), d(4), d(5), d(6), d(9), d(10), d(11), d(12), d(13), d(16), d(17)])
    add("henry", "IB", [d(30), d(31), d(1, 4)])
    return pd.DataFrame(r)


def _test_ref_date_fallback():
    """วันที่.1 (ISO date) can be a broken-formula '#REF!' in live vendor data
    (confirmed: '[SOCE 2026]_Daily name list_BTS', tab 'Jul 26') -- _clean_raw
    must recover the date from the sibling วันที่ column instead of throwing
    or dropping a real worker's show-up day."""
    header = ["วันที่", "ค้นหา", "เข้างาน", "shift name", "วันที่", "BTS", "Shift_id", "team"]
    row = ["9 Jul 26", "zoe", "09:00", "Inbound", "#REF!", "SITE", "SH-9", "IB"]
    out = _clean_raw(_rows_to_raw_df([header, row]))
    assert len(out) == 1
    assert out.iloc[0]["date"] == pd.Timestamp(2026, 7, 9)
    print("_test_ref_date_fallback passed")


def _test_corrupted_date_header_repaired():
    """Confirmed live: [SOCE 2026]_Daily name list_BTS, tab 'May 26' -- the
    header's first วันที่ cell had a stray value ("49") instead of the
    column name, while the data underneath was still real dates. Name-match
    alone can't find a header row (only one literal 'วันที่' survives), so
    it must recover via position relative to ค้นหา/'shift name', then still
    require the recovered column's data to actually parse as dates."""
    header = ["49", "ค้นหา", "เข้างาน", "shift name", "วันที่", "BTS", "Shift_id", "team",
              "กะ", "เวลาเข้า-ออกงาน"]
    row = ["9 May 26", "amy", "09:00", "Inbound", "2026-05-09", "SITE", "SH-1", "IB", "K1", "09:00-17:00"]
    out = _clean_raw(_rows_to_raw_df([header, row]))
    assert len(out) == 1 and out.iloc[0]["date"] == pd.Timestamp(2026, 5, 9)

    # one date column unparseable but the sibling valid -> recover from the
    # sibling (was: threw). วันที่ here is "not a date", วันที่.1 is a real date.
    bad_row = ["not a date", "ben", "09:00", "Inbound", "2026-05-10", "SITE", "SH-2", "IB",
               "K1", "09:00-17:00"]
    out = _clean_raw(_rows_to_raw_df([header, bad_row]))
    assert len(out) == 1 and out.iloc[0]["date"] == pd.Timestamp(2026, 5, 10)
    print("_test_corrupted_date_header_repaired passed")


def _test_garbage_date_col_recovered():
    """Confirmed live: [SOCE 2026]_Daily name list_BTS, tab 'Jul 26' row 2074 --
    a broken formula spilled the shift name ("FSOCE ") across วันที่.1 and the
    rest of the row while วันที่ still held a clean "09 Jul 26". The valid
    sibling recovers the show-up day; when BOTH date columns are unrecoverable
    the row is DROPPED (no attributable day) and counted, not thrown."""
    header = ["วันที่", "ค้นหา", "เข้างาน", "shift name", "วันที่", "BTS", "Shift_id", "team"]
    row = ["09 Jul 26", "BTS 0122 x", "19:00", "FSOCE ", "FSOCE ", "FSOCE ", "FSOCE ", "FSOCE "]
    out = _clean_raw(_rows_to_raw_df([header, row]))
    assert len(out) == 1 and out.iloc[0]["date"] == pd.Timestamp(2026, 7, 9)

    both_bad = ["junk", "cara", "09:00", "Inbound", "junk", "SITE", "SH-1", "IB"]
    good = ["10 Jul 26", "dave", "09:00", "Inbound", "2026-07-10", "SITE", "SH-2", "IB"]
    out = _clean_raw(_rows_to_raw_df([header, both_bad, good]))
    assert list(out["name"]) == ["dave"] and out.attrs["dropped_no_date"] == 1
    print("_test_garbage_date_col_recovered passed")


def _test_corrupted_clockin_header_repaired():
    """Confirmed live: [SOCW 2026]_Daily name list_PPO, tab 'Feb 26' -- the
    เข้างาน (clock-in) header cell held a stray time "11:00:00 AM" instead of
    the column name, so name-matching couldn't find a header. Position-repair
    recovers เข้างาน as ค้นหา+1 (locked schema); the actual clock-in data
    underneath is read normally."""
    header = ["วันที่", "ค้นหา", "11:00:00 AM", "shift name", "วันที่", "PPO",
              "Shift_id", "team", "กะ", "เวลาเข้า-ออกงาน"]
    row = ["9 Feb 26", "amy", "09:00", "Inbound", "2026-02-09", "SITE", "SH-1", "IB",
           "K1", "09:00-17:00"]
    out = _clean_raw(_rows_to_raw_df([header, row]))
    assert len(out) == 1 and out.iloc[0]["date"] == pd.Timestamp(2026, 2, 9)
    assert out.iloc[0]["clockin"] == "09:00"
    print("_test_corrupted_clockin_header_repaired passed")


def _test_blank_name_header_repaired():
    """Confirmed live: [SOCW 2026]_Daily name list_DSR, tab 'Jan 26' -- the
    ค้นหา (name) header cell was BLANK with real names underneath, while every
    other column (incl. 'shift name') was intact. ค้นหา can't be the sole
    anchor when it's the corrupted cell, so the repair anchors on 'shift name'
    (2 cols right) and recovers ค้นหา by position."""
    header = ["วันที่", "", "เข้างาน", "shift name", "วันที่", "DSR",
              "Shift_id", "team", "กะ", "เวลาเข้า-ออกงาน"]
    row = ["01 Jan 26", "DSRCW 0130 x", "23:00", "Small Sort", "2026-01-01", "DSR",
           "SS_N_23", "SS", "N", "23:00-08:00"]
    out = _clean_raw(_rows_to_raw_df([header, row]))
    assert len(out) == 1 and out.iloc[0]["name"] == "DSRCW 0130 x"
    assert out.iloc[0]["date"] == pd.Timestamp(2026, 1, 1)
    print("_test_blank_name_header_repaired passed")


def _test_ragged_rows_normalized():
    """Confirmed live: [SOCE 2026]_Daily name list_PPO, tab 'Jul 26' -- the
    Sheets API batchGet endpoint returns ragged rows (unlike get_all_values),
    and one data row ran WIDER than the header (29 vs 22 cols) from stray
    data past the schema, crashing DataFrame construction. _rows_to_raw_df
    must rectangularize -- pad short rows AND widen the header for over-long
    ones (extra columns are outside the schema and unused)."""
    header = ["วันที่", "ค้นหา", "เข้างาน", "shift name", "วันที่", "BTS", "Shift_id", "team"]
    wider = ["9 Jul 26", "amy", "09:00", "Inbound", "2026-07-09", "SITE", "SH-1", "IB",
             "junk1", "junk2", "junk3"]   # 3 cols past the 8-col header
    shorter = ["10 Jul 26", "ben", "09:00", "Inbound", "2026-07-10", "SITE", "SH-2"]  # missing team
    out = _clean_raw(_rows_to_raw_df([header, wider, shorter]))
    teams = out.set_index("name")["team"]
    assert teams["amy"] == "IB"
    # ben's team cell was trimmed off entirely -> NA -> learned from amy's
    # Inbound row (same shift name), proving alignment held after widening
    assert teams["ben"] == "IB"
    print("_test_ragged_rows_normalized passed")


def _test_duplicate_header_row_dropped():
    """Confirmed live: [SOCE 2026]_Daily name list_SPT, tab 'Mar 26' -- the
    header was accidentally pasted twice, so the second copy shows up as a
    data row (ค้นหา literally == 'ค้นหา'). Must be dropped, not thrown on --
    but only via this exact signal, not a general 'drop anything
    unparseable' rule."""
    header = ["วันที่", "ค้นหา", "เข้างาน", "shift name", "วันที่", "BTS", "Shift_id", "team"]
    dup_header_row = ["วันที่", "ค้นหา", "เข้างาน", "shift name", "วันที่", "BTS", "Shift_id", "team"]
    real_row = ["9 Mar 26", "amy", "09:00", "Inbound", "2026-03-09", "SITE", "SH-1", "IB"]
    out = _clean_raw(_rows_to_raw_df([header, dup_header_row, real_row]))
    assert len(out) == 1 and out.iloc[0]["name"] == "amy"
    print("_test_duplicate_header_row_dropped passed")


def _test_team_learned_from_shift_name():
    """Confirmed live: [SOCE 2026]_Daily name list_PPO, tab 'Jul 26' -- 10
    rows had no team and weren't the FSOCE special case. team is itself a
    lookup from shift name, so it's learned from whichever OTHER rows in
    the tab already have both, generalizing the old FSOCE-only rule."""
    header = ["วันที่", "ค้นหา", "เข้างาน", "shift name", "วันที่", "BTS", "Shift_id", "team"]
    rows = [
        ["9 Jul 26", "amy", "09:00", "Outbound", "2026-07-09", "SITE", "SH-1", "OBD"],
        ["9 Jul 26", "ben", "09:00", "Outbound", "2026-07-09", "SITE", "SH-2", ""],   # learn from amy
        ["9 Jul 26", "cara", "09:00", "FSOCE ", "2026-07-09", "SITE", "SH-3", "FSOCE"],
        ["9 Jul 26", "dan", "09:00", "FSOCE", "2026-07-09", "SITE", "SH-4", ""],      # stripped match
    ]
    out = _clean_raw(_rows_to_raw_df([header] + rows))
    teams = out.set_index("name")["team"]
    assert teams["ben"] == "OBD" and teams["dan"] == "FSOCE"

    # majority vote: a needed shift with a dominant team + noise resolves to the
    # dominant one (confirmed live: SPT 'Jul 26' "Outbound" -> OB x195 + strays)
    majority_rows = [
        ["9 Jul 26", "amy", "09:00", "Outbound", "2026-07-09", "SITE", "SH-1", "OB"],
        ["9 Jul 26", "ben", "09:00", "Outbound", "2026-07-09", "SITE", "SH-2", "OB"],
        ["9 Jul 26", "cara", "09:00", "Outbound", "2026-07-09", "SITE", "SH-3", "AdminA"],
        ["9 Jul 26", "dan", "09:00", "Outbound", "2026-07-09", "SITE", "SH-4", ""],   # -> OB
    ]
    outm = _clean_raw(_rows_to_raw_df([header] + majority_rows))
    assert outm.set_index("name")["team"]["dan"] == "OB"

    # genuine tie (OBD x1 vs IB x1) has no dominant team -- must throw
    tied_rows = [
        ["9 Jul 26", "amy", "09:00", "Mixed", "2026-07-09", "SITE", "SH-1", "OBD"],
        ["9 Jul 26", "ben", "09:00", "Mixed", "2026-07-09", "SITE", "SH-2", "IB"],
        ["9 Jul 26", "cara", "09:00", "Mixed", "2026-07-09", "SITE", "SH-3", ""],
    ]
    try:
        _clean_raw(_rows_to_raw_df([header] + tied_rows))
    except ValueError as e:
        assert "no majority" in str(e)
    else:
        raise AssertionError("expected ValueError for a tied shift name -> team mapping")

    # no valid example anywhere and no _KNOWN_SHIFT_TEAM entry -- falls back
    # to the shift name itself as team, rather than throwing
    unlearnable_row = ["9 Jul 26", "erin", "09:00", "Ghost Shift", "2026-07-09", "SITE", "SH-9", ""]
    out2 = _clean_raw(_rows_to_raw_df([header, unlearnable_row]))
    assert out2.iloc[0]["team"] == "Ghost Shift"

    # a row missing BOTH team and shift name has nothing to attribute a
    # station to at all -- dropped, not thrown on (confirmed live: BTS
    # 'Jul 26' had 3 such rows)
    no_shift_row = ["9 Jul 26", "fay", "09:00", "", "2026-07-09", "SITE", "SH-8", ""]
    real_row = ["9 Jul 26", "gus", "09:00", "Inbound", "2026-07-09", "SITE", "SH-7", "IB"]
    out3 = _clean_raw(_rows_to_raw_df([header, no_shift_row, real_row]))
    assert list(out3["name"]) == ["gus"]
    print("_test_team_learned_from_shift_name passed")


def _test_fsoce_hardcoded_fallback_when_unlearnable():
    """Confirmed live: [SOCE 2026]_Daily name list_BTS, tab 'Mar 26' -- every
    single FSOCE row in the tab had a broken team lookup, so there was no
    valid example anywhere to learn from and the general mechanism alone
    threw. team="FSOCE" for shift name "FSOCE" is a confirmed, locked
    business fact (not a guess), so it must still resolve here as a last
    resort -- without this, the earlier generalization actually regressed
    the original, narrower FSOCE fix."""
    header = ["วันที่", "ค้นหา", "เข้างาน", "shift name", "วันที่", "BTS", "Shift_id", "team"]
    rows = [
        ["9 Mar 26", "amy", "09:00", "FSOCE", "2026-03-09", "SITE", "SH-1", ""],
        ["9 Mar 26", "ben", "09:00", "FSOCE ", "2026-03-09", "SITE", "SH-2", ""],
    ]
    out = _clean_raw(_rows_to_raw_df([header] + rows))
    assert (out.set_index("name")["team"] == "FSOCE").all()
    print("_test_fsoce_hardcoded_fallback_when_unlearnable passed")


def _test_sheets_error_sentinels_general():
    """The sentinel normalization isn't specific to one column/value -- any
    known Excel/Sheets error string, in either date column or in team,
    should be recovered the same way."""
    header = ["วันที่", "ค้นหา", "เข้างาน", "shift name", "วันที่", "BTS", "Shift_id", "team"]
    # วันที่ (not วันที่.1) broken this time -- symmetric recovery
    row_a = ["#VALUE!", "amy", "09:00", "Inbound", "2026-07-10", "SITE", "SH-1", "IB"]
    out_a = _clean_raw(_rows_to_raw_df([header, row_a]))
    assert out_a.iloc[0]["date"] == pd.Timestamp(2026, 7, 10)
    # both date columns broken -- genuinely unrecoverable, DROPPED and counted
    row_b = ["#REF!", "ben", "09:00", "Inbound", "#N/A", "SITE", "SH-2", "IB"]
    row_c = ["10 Jul 26", "dave", "09:00", "Inbound", "2026-07-10", "SITE", "SH-4", "IB"]
    out_b = _clean_raw(_rows_to_raw_df([header, row_b, row_c]))
    assert list(out_b["name"]) == ["dave"] and out_b.attrs["dropped_no_date"] == 1
    print("_test_sheets_error_sentinels_general passed")


def _test_blank_placeholder_row_dropped():
    """Confirmed live: [SOCE 2026]_Daily name list_CYD, tab 'Feb 26' -- 2
    rows have a name but every other field genuinely blank (no date, no
    team, no shift, no clock-in, no Shift_id). Not a real show-up (no date
    to attribute one to) -- dropped. A row missing ONLY the date, with other
    fields populated (PNK 'Jul 26'), is also dropped now (no attributable
    day) and counted, not thrown."""
    header = ["วันที่", "ค้นหา", "เข้างาน", "shift name", "วันที่", "BTS", "Shift_id", "team"]
    placeholder_row = ["", "CYD 11502 THAE THAE", "", "", "", "SITE", "", ""]
    real_row = ["9 Jul 26", "zoe", "09:00", "Inbound", "2026-07-09", "SITE", "SH-9", "IB"]
    out = _clean_raw(_rows_to_raw_df([header, placeholder_row, real_row]))
    assert len(out) == 1 and out.iloc[0]["name"] == "zoe" and out.attrs["dropped_no_date"] == 1

    partial_row = ["", "carol", "09:00", "Inbound", "", "SITE", "SH-3", "IB"]
    out2 = _clean_raw(_rows_to_raw_df([header, partial_row]))
    assert len(out2) == 0 and out2.attrs["dropped_no_date"] == 1
    print("_test_blank_placeholder_row_dropped passed")


def _test_garbled_clockin_tolerated():
    """เข้างาน isn't load-bearing for a show-up day -- a garbled value like
    '$0.88' (confirmed live, CYD 'Mar 26') must not crash the whole sync,
    and must still lose a same-day dedup tie-break to a row with a real
    clock-in time."""
    header = ["วันที่", "ค้นหา", "เข้างาน", "shift name", "วันที่", "BTS", "Shift_id", "team"]
    solo = ["9 Jul 26", "amy", "$0.88", "Inbound", "2026-07-09", "SITE", "SH-1", "IB"]
    out = _clean_raw(_rows_to_raw_df([header, solo]))
    assert len(out) == 1 and out.iloc[0]["clockin"] == "$0.88"

    garbled = ["9 Jul 26", "ben", "$0.88", "Inbound", "2026-07-09", "SITE", "SH-2", "IB"]
    real = ["9 Jul 26", "ben", "08:00", "Outbound", "2026-07-09", "SITE", "SH-3", "OBD"]
    out2 = _clean_raw(_rows_to_raw_df([header, garbled, real]))
    assert len(out2) == 1 and out2.iloc[0]["team"] == "OBD"   # real clock-in wins the tie
    print("_test_garbled_clockin_tolerated passed")


def _run_tests():
    _test_ref_date_fallback()
    _test_sheets_error_sentinels_general()
    _test_blank_placeholder_row_dropped()
    _test_garbled_clockin_tolerated()
    _test_corrupted_date_header_repaired()
    _test_garbage_date_col_recovered()
    _test_corrupted_clockin_header_repaired()
    _test_blank_name_header_repaired()
    _test_ragged_rows_normalized()
    _test_duplicate_header_row_dropped()
    _test_team_learned_from_shift_name()
    _test_fsoce_hardcoded_fallback_when_unlearnable()
    df = _synthetic()
    c, _ = showup_block(df)
    assert c.loc["1-5", "Mar"] == 6 and c.loc["6-10", "Mar"] == 1 and c.loc["11-15", "Mar"] == 1
    rs = rotation_summary(df)
    ib = rs[(rs.month == "2026-03") & (rs.team == "IB")].iloc[0]
    assert ib.population == 8 and ib.rotation == 1 and ib.non_rotation == 7
    assert ib.oneday_nonrot == 2                       # READING B: bob(IB1)+erin(IB1)
    ms = rs[(rs.month == "2026-03") & (rs.team == "MS")].iloc[0]
    assert ms.population == 2 and ms.rotation == 1 and ms.oneday_nonrot == 1   # bob MS1
    x = streak_month_crosstab(df)
    mar = x[x.month == "Mar"].iloc[0]
    assert mar["usedto_<10"] + mar["usedto_>10"] == 5        # alice,carol,dave,frank,grace
    w = streak_week(df).set_index("week")
    assert w.loc["W10", ">=3"] == 4 and w.loc["W11", ">=3"] == 2 and w.loc["W14", ">=3"] == 1

    # data-driven teams
    assert distinct_teams(df) == ["IB", "MS"]
    # New/Old face: only grace (12 days at IB in Mar) clears the 10-day bar
    nc, _ = new_old_monthly(df)
    assert nc.loc["Old", "Mar"] == 1 and nc.loc["New", "Mar"] == 7
    ncIB, _ = new_old_monthly(df, "IB")
    assert ncIB.loc["Old", "Mar"] == 1 and ncIB.loc["New", "Mar"] == 7
    # split 5+6 across two teams (max 6 < 10) stays New despite 11 total days
    split = pd.DataFrame(
        [{"name": "zed", "team": "IB", "date": dt.date(2026, 6, d)} for d in (1, 2, 3, 4, 5)] +
        [{"name": "zed", "team": "MS", "date": dt.date(2026, 6, d)} for d in (8, 9, 10, 11, 12, 15)])
    sc, _ = new_old_monthly(split)
    assert sc.loc["New", "Jun"] == 1 and sc.loc["Old", "Jun"] == 0
    # attendance headcount: 6 distinct workers present on Mar-02, all IB
    ad, ad_all = attendance_crosstab(df, "day")
    assert ad.loc["IB", "2026-03-02"] == 6 and ad_all["2026-03-02"] == 6
    _, aw_all = attendance_crosstab(df, "week")
    assert aw_all["W10"] == 6
    # weekly rotation reuses the monthly logic per ISO week (shape + fields)
    rw = rotation_summary(df, "week")
    assert len(rw) > 0 and str(rw.iloc[0]["month"]).startswith("W") and "population" in rw.columns

    # drill-down membership: names.length must equal the summary count everywhere
    shm = showup_members(df)
    assert len(shm["Mar"]["1-5"]) == c.loc["1-5", "Mar"]
    nom = new_old_members(df)
    assert len(nom["Mar"]["Old"]) == nc.loc["Old", "Mar"] and len(nom["Mar"]["New"]) == nc.loc["New", "Mar"]
    smm = streak_month_members(df)
    assert len(smm["Mar"]["usedto_<10"]) + len(smm["Mar"]["usedto_>10"]) == 5
    swm = streak_week_members(df)
    assert len(swm["W10"][">=3"]) == 4 and len(swm["W11"][">=3"]) == 2
    rom = rotation_members(df)
    ib = rom["2026-03"]["IB"]
    assert len(ib["population"]) == 8 and len(ib["rotation"]) == 1 and len(ib["oneday_nonrot"]) == 2
    assert "grace" in ib["population"]
    print("All correctness self-tests passed.\n")


# ---------------------------------------------------------------- mock (shape demo)
def _mock(seed=7, n=300):
    rng = random.Random(seed)
    teams = STATIONS_ROT + ["Helper", "4PL", "Translator"]
    rows = []
    for w in range(n):
        name = f"w{w:04d}"
        primary = rng.choice(teams)
        for mth in (3, 4, 5, 6):
            if rng.random() < 0.35:
                continue
            last = calendar.monthrange(2026, mth)[1]
            ndays = min(rng.choice([1, 1, 2, 3, 5, 8, 12, 18, 25, last]), last)
            start = rng.randint(1, max(1, last - ndays))
            days = sorted(set(rng.choice([start + i for i in range(ndays)],)  # bias toward runs
                              if False else rng.sample(range(1, last + 1), ndays)))
            for day in days:
                team = primary if rng.random() < 0.85 else rng.choice(teams)
                rows.append({"name": name, "team": team, "date": dt.date(2026, mth, day)})
    return pd.DataFrame(rows).drop_duplicates(subset=["name", "date"])


def _demo():
    df = _mock()
    p = lambda t: print(t.to_string())
    print("========== VIEW 1  SHOW-UP BUCKETS — All SOCN (counts | %) ==========")
    c, q = showup_block(df); p(c); print(); p(q)
    print("\n========== VIEW 1  SHOW-UP BUCKETS — CBS (%) ==========")
    _, q = showup_block(df, "CBS"); p(q)
    print("\n========== VIEW 2  ROTATION — Mar per-team table ==========")
    p(rotation_month_table(df, "2026-03"))
    print("\n--- Rotation% (team x month) ---"); p(rotation_pct_block(df, "rotation%"))
    print("--- Non-rotation% ---"); p(rotation_pct_block(df, "non_rotation%"))
    print("--- 1-day% of non-rotation ---"); p(rotation_pct_block(df, "oneday%"))
    print("\n========== VIEW 3  CONSISTENCY — monthly cross-tab (All SOCN) ==========")
    p(streak_month_crosstab(df))
    print("\n--- Weekly >=3 consecutive (All SOCN) ---"); p(streak_week(df))
    tot, ever, dist = weeks_depth(df, "CBS")
    print(f"\n--- Depth (CBS): {ever}/{tot} workers ever hit >=3 consec ({ever/tot*100:.2f}%) ---")
    print("weeks_hit -> #workers"); p(dist.rename("workers").to_frame())


if __name__ == "__main__":
    _run_tests()
    _demo()