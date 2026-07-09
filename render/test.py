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


def _find_header_row(rows: list, max_scan: int = 5) -> int:
    """Some vendor exports have a title/banner row above the real header
    (seen live: a merged note + 'OPS ID' + a wall of blank cells) -- others
    (the originally-validated BTS file) don't. Scan for the row whose
    (dupe-mangled) columns are a superset of what _clean_raw needs, rather
    than assuming row 0 is always the header."""
    for i, row in enumerate(rows[:max_scan]):
        if _REQUIRED_RAW_COLUMNS <= set(_mangle_dupe_cols(row)):
            return i
    raise ValueError(
        f"couldn't find a header row containing {sorted(_REQUIRED_RAW_COLUMNS)} "
        f"in the first {max_scan} rows -- schema drift, or a banner deeper than expected"
    )


def _rows_to_raw_df(rows: list) -> pd.DataFrame:
    """rows: list of row-lists (all strings, header position not yet known).
    Locates the real header row, builds the raw (uncleaned) frame for _clean_raw."""
    if not rows:
        raise ValueError("empty sheet -- no header row")
    header_idx = _find_header_row(rows)
    header = _mangle_dupe_cols(rows[header_idx])
    data = [r + [""] * (len(header) - len(r)) for r in rows[header_idx + 1:]]
    return pd.DataFrame(data, columns=header).replace("", pd.NA)


def _clean_raw(raw: pd.DataFrame) -> pd.DataFrame:
    """Clean one raw monthly attendance export -> (name, date, month, team,
    clockin, shift_name, shift_id) frame. The engine (_prepare) only ever
    requires {name, date, team} and ignores the rest -- the extra columns
    exist for the sync layer's raw-tab writes, not for any metric computed
    in this module.

    Resolved mapping (see CLAUDE.md): name=ค้นหา, date=วันที่.1, team=team.
    วันที่ and วันที่.1 encode the same date in different formats (DD Mon YY vs
    ISO) -- verified equal after parsing, not as raw strings. Export pads the
    file with fully-blank trailer rows, dropped via ค้นหา.notna(). "FSOCE "
    (trailing space) vs "FSOCE" (no space) is a data-entry split of one shift
    name; for the latter, team is a literal "#N/A" (a broken spreadsheet
    lookup formula baked into the export, confirmed via raw csv module read
    -- not an empty cell, and not something pandas' default NA-string
    recognition can be relied on once input comes from Sheets API values
    instead of read_csv). Normalized to NA here, then backfilled to
    team="FSOCE" so it isn't silently dropped by pivot_table on a NaN team
    key. Same-day rows with two different teams (double shift / OT past
    midnight) are collapsed by keeping the earliest เข้างาน (min clock-in
    time-of-day) -- the original เข้างาน string (not the parsed time used
    only for that tie-break) is kept in the output as `clockin`.
    """
    missing = _REQUIRED_RAW_COLUMNS - set(raw.columns)
    if missing:
        raise ValueError(f"missing required raw columns: {sorted(missing)}")

    df = raw[raw["ค้นหา"].notna()].copy()
    df["team"] = df["team"].replace("#N/A", pd.NA)

    # วันที่'s display format varies by source (local CSV export: "01 Jun 26";
    # live Sheets data seen in production: "1-Jan-26", no leading zero, hyphens)
    # -- infer per-element rather than pin to one sample's format.
    d1 = pd.to_datetime(df["วันที่"], format="mixed", dayfirst=True, errors="raise")
    # วันที่.1 (ISO) is itself a formula in some vendor files (confirmed live:
    # "[SOCE 2026]_Daily name list_BTS", tab "Jul 26") and can evaluate to the
    # broken-reference sentinel "#REF!" -- same failure class as team's
    # "#N/A". วันที่ parses fine for every one of those rows (checked above,
    # errors="raise" didn't fire), so recover via the sibling column instead
    # of losing a real worker's show-up day.
    d2 = pd.to_datetime(df["วันที่.1"].replace("#REF!", pd.NA), format="%Y-%m-%d", errors="raise")
    d2 = d2.fillna(d1)
    if not (d1 == d2).all():
        raise ValueError("วันที่ and วันที่.1 disagree on date for some rows -- stop, ask which is the show-up date")

    shift = df["shift name"].str.strip()
    fsoce_blank_team = (shift == "FSOCE") & df["team"].isna()
    df.loc[fsoce_blank_team, "team"] = "FSOCE"
    if df["team"].isna().any():
        raise ValueError(f"{df['team'].isna().sum()} rows have no team after FSOCE backfill -- stop, ask")

    out = pd.DataFrame({
        "name": df["ค้นหา"],
        "date": d2,
        "team": df["team"],
        "clockin": df["เข้างาน"],
        "shift_name": shift,
        "shift_id": df["Shift_id"],
        "_clocksort": pd.to_datetime(df["เข้างาน"], format="%H:%M", errors="raise"),
    })
    out = out.sort_values("_clocksort").drop_duplicates(subset=["name", "date"], keep="first")
    out = out.drop(columns="_clocksort").reset_index(drop=True)
    out["month"] = pd.to_datetime(out["date"]).dt.strftime("%Y-%m").map(_month_label)

    dup = out.duplicated(subset=["name", "date"]).sum()
    if dup:
        raise ValueError(f"{dup} duplicate (name,date) rows survived dedup -- clean set must be one row per worker per day")
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


def rotation_worker_table(df):
    d = _prepare(df)
    piv = d.pivot_table(index=["month", "name"], columns="team",
                        values="date", aggfunc="count", fill_value=0)
    team_cols = list(piv.columns)
    piv["Grand Total"] = piv[team_cols].sum(axis=1)
    piv["Rotation count"] = (piv[team_cols] > 0).sum(axis=1)
    for t in OPERATIONAL_TEAMS:
        if t in team_cols:
            piv[f"Analyze {t}"] = ((piv[t] > 1) & (piv["Rotation count"] > 1)).map({True: "Rotated", False: ""})
        else:
            piv[f"Analyze {t}"] = ""
    return piv.reset_index()


def rotation_summary(df):
    wt = rotation_worker_table(df)
    rows = []
    for month, g in wt.groupby("month"):
        for t in OPERATIONAL_TEAMS:
            if t not in g.columns:
                continue
            in_team = g[g[t] >= 1]
            pop = len(in_team)
            if pop == 0:
                continue
            rotated = int((in_team[f"Analyze {t}"] == "Rotated").sum())
            nonrot = pop - rotated
            oneday = int(((in_team[f"Analyze {t}"] != "Rotated") & (in_team[t] == 1)).sum())  # READING B
            rows.append({"month": month, "team": t, "population": pop, "rotation": rotated,
                         "non_rotation": nonrot, "oneday_nonrot": oneday,
                         "rotation%": round(rotated / pop * 100, 2),
                         "non_rotation%": round(nonrot / pop * 100, 2),
                         "oneday%": round(oneday / nonrot * 100, 2) if nonrot else float("nan")})
    return pd.DataFrame(rows)


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


def _run_tests():
    _test_ref_date_fallback()
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