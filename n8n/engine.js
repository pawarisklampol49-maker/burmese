/**
 * SOC worker-analysis engine -- dependency-free JavaScript port of
 * render/test.py's engine + report shaping, for running the whole pipeline
 * inside n8n (which can't run pandas). This file is the single source of the
 * metric/cleaning logic on the n8n side; keep it in lockstep with test.py's
 * LOCKED DEFINITIONS -- do not fork them.
 *
 * HOW TO VERIFY (do this before trusting it in a workflow):
 *   - In an n8n Code node ("Run Once for All Items", language JavaScript),
 *     paste this whole file, then add a final line:  return runSelfTests();
 *     Execute the node. It returns [{passed:true, log:[...]}] on success, or
 *     throws with the first failing assertion.
 *   - Or with Node.js locally:  node n8n/engine.js
 *
 * The self-tests mirror test.py's _run_tests exactly (same fixtures, same
 * expected numbers), so a pass here means the port matches the Python engine.
 */

// ------------------------------------------------------------------ constants
const OPERATIONAL_TEAMS = ["CBS", "IB", "mCBS", "MS", "OBI", "OBS", "OBC", "OBD"];
const BUCKETS = [[1, 5], [6, 10], [11, 15], [16, 20], [21, 30]];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// group-key separator: a control char that never appears in real data, so
// composite keys are unique even when a worker name contains spaces. Keys
// built with SEP are NEVER split back apart -- fields are read from the
// grouped rows instead (splitting on " " broke names like "CYD 11 A B").
const SEP = "\u0001";

const REQUIRED_RAW_COLUMNS = ["วันที่", "ค้นหา", "วันที่.1", "team", "เข้างาน", "shift name", "Shift_id"];
const SHEETS_ERROR_SENTINELS = new Set(["#REF!", "#N/A", "#VALUE!", "#DIV/0!", "#NAME?", "#NULL!", "#NUM!", "#ERROR!"]);
// confirmed business facts (see test.py _KNOWN_SHIFT_TEAM). Add a stripped
// shift-name -> team entry here only when the team name genuinely differs
// from the shift name; otherwise the shift-name-as-team fallback covers it.
const KNOWN_SHIFT_TEAM = { "FSOCE": "FSOCE" };

const MONTH_NUM = {};
["january", "february", "march", "april", "may", "june", "july",
 "august", "september", "october", "november", "december"].forEach((full, i) => {
  MONTH_NUM[full] = i + 1;
  MONTH_NUM[full.slice(0, 3)] = i + 1;
});

// ------------------------------------------------------------------ dates
function pad2(n) { return String(n).padStart(2, "0"); }

function makeDate(y, m, d) {
  // canonical calendar date + everything downstream needs derived once.
  const dayNum = Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  return {
    y: y, m: m, d: d,
    key: `${y}-${pad2(m)}-${pad2(d)}`,
    month: `${y}-${pad2(m)}`,          // YYYY-MM (engine grouping)
    dayNum: dayNum,                    // integer day, for consecutive-run math
    iso: isoWeekYear(y, m, d),
  };
}

function isoWeekYear(y, m, d) {
  // standard ISO-8601 week/year (matches pandas dt.isocalendar()).
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dayNum = (dt.getUTCDay() + 6) % 7;        // Mon=0..Sun=6
  dt.setUTCDate(dt.getUTCDate() - dayNum + 3);     // Thursday of this ISO week
  const isoYear = dt.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const ftDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ftDayNum + 3);
  const week = 1 + Math.round((dt - firstThursday) / (7 * 86400000));
  return { year: isoYear, week: week };
}

function validYMD(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  return true;
}

function normYear(y) { return y < 100 ? 2000 + y : y; }

function parseDayFirst(s) {
  // "9 Jul 26", "01 Jun 26", "1-Jan-26", "9/7/26", or ISO "2026-05-09".
  // Returns makeDate or null (null = unparseable, caller decides to throw).
  const t = String(s).trim().split(/[\s\-\/.]+/).filter(Boolean);
  if (t.length !== 3) return null;
  let y, m, d;
  if (/^\d{4}$/.test(t[0])) {                       // year-first (ISO-ish)
    y = parseInt(t[0], 10); m = monthToken(t[1]); d = parseInt(t[2], 10);
  } else {                                          // day-first
    d = parseInt(t[0], 10); m = monthToken(t[1]); y = normYear(parseInt(t[2], 10));
  }
  if (m == null || !validYMD(y, m, d)) return null;
  return makeDate(y, m, d);
}

function parseISO(s) {
  const mm = String(s).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!mm) return null;
  const y = parseInt(mm[1], 10), m = parseInt(mm[2], 10), d = parseInt(mm[3], 10);
  if (!validYMD(y, m, d)) return null;
  return makeDate(y, m, d);
}

function monthToken(tok) {
  if (/^\d{1,2}$/.test(tok)) { const n = parseInt(tok, 10); return (n >= 1 && n <= 12) ? n : null; }
  const n = MONTH_NUM[tok.toLowerCase()];
  return n == null ? null : n;
}

function monthLabel(monthISO) {           // "2026-06" -> "Jun"
  const m = parseInt(monthISO.slice(5, 7), 10);
  return MONTHS[m - 1];
}

// period grouping: a date -> a sortable key and a display label, for "month"
// (default), ISO "week", or "day". Lets one computation serve all three grains.
function periodKey(date, period) {
  if (period === "week") return date.iso.year + "-W" + pad2(date.iso.week);
  if (period === "day") return date.key;                 // YYYY-MM-DD
  return date.month;                                     // YYYY-MM
}
function periodLabel(key, period) {
  if (period === "week") return "W" + parseInt(key.slice(key.indexOf("W") + 1), 10);
  if (period === "day") return key;                      // already YYYY-MM-DD
  return monthLabel(key);
}

function parseClockMinutes(s) {            // "09:00" -> 540; garbled -> null (sorts last)
  const mm = String(s).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!mm) return null;
  return parseInt(mm[1], 10) * 60 + parseInt(mm[2], 10);
}

// ------------------------------------------------------------------ raw input
function mangleDupeCols(header) {
  const seen = {};
  return header.map((h) => {
    const n = seen[h] || 0;
    seen[h] = n + 1;
    return n === 0 ? h : `${h}.${n}`;
  });
}

// Recover a header whose fragile cells were overwritten by stray values or left
// blank (a date "49"/"4" in วันที่, a time "11:00:00 AM" in เข้างาน, a BLANK
// ค้นหา -- all confirmed live). The first columns are LOCKED in order
// (วันที่, ค้นหา, เข้างาน, shift name, วันที่, ...), so the block can be located
// by EITHER anchor that's still intact: ค้นหา, or 'shift name' (fixed 2 columns
// to its right). ค้นหา itself can be the corrupted cell -- DSR 'Jan 26' had a
// blank ค้นหา header with real names underneath while 'shift name' was fine --
// so it can't be the sole anchor. From the located name index the fragile cells
// are rewritten by their known offset: วันที่ = name-1, ค้นหา = name, เข้างาน =
// name+1, shift name = name+2, second วันที่ = name+3. Bails only if NEITHER
// anchor is present. Fallback only (see mangledHeaderCandidates) -- never
// touches an already-matching header, and a mis-repair still has to pass
// isSuperset AND real date parsing downstream, so "if the data matches, use it"
// stays structurally enforced.
function repairHeaderPositions(header) {
  let nameIdx = header.indexOf("ค้นหา");
  if (nameIdx < 0) {
    const shiftIdx = header.indexOf("shift name");
    if (shiftIdx >= 2) nameIdx = shiftIdx - 2;   // ค้นหา sits 2 left of shift name
  }
  if (nameIdx < 0) return header;                // no usable anchor
  const out = header.slice();
  if (nameIdx - 1 >= 0) out[nameIdx - 1] = "วันที่";
  out[nameIdx] = "ค้นหา";
  if (nameIdx + 1 < out.length) out[nameIdx + 1] = "เข้างาน";
  if (nameIdx + 2 < out.length) out[nameIdx + 2] = "shift name";
  if (nameIdx + 3 < out.length) out[nameIdx + 3] = "วันที่";
  return out;
}

function isSuperset(candidate) {
  const s = new Set(candidate);
  return REQUIRED_RAW_COLUMNS.every((c) => s.has(c));
}

function mangledHeaderCandidates(row) {
  return [mangleDupeCols(row), mangleDupeCols(repairHeaderPositions(row))];
}

function findHeaderRow(rows, maxScan) {
  maxScan = maxScan || 5;
  for (let i = 0; i < Math.min(maxScan, rows.length); i++) {
    for (const cand of mangledHeaderCandidates(rows[i])) {
      if (isSuperset(cand)) return i;
    }
  }
  throw new Error(
    `couldn't find a header row containing ${JSON.stringify(REQUIRED_RAW_COLUMNS.slice().sort())} ` +
    `in the first ${maxScan} rows -- schema drift, or a banner deeper than expected`
  );
}

function resolveHeader(row) {
  for (const cand of mangledHeaderCandidates(row)) {
    if (isSuperset(cand)) return cand;
  }
  throw new Error("header row no longer matches on rebuild -- internal inconsistency");
}

function rowsToRawObjects(grid) {
  // grid: array of string-arrays (ragged allowed). -> array of row objects
  // keyed by the mangled header; "" / missing cells become null.
  // We read ONLY the header's columns from each data row: a SHORTER row yields
  // nulls for its missing tail, a LONGER row has its extra (beyond-schema)
  // cells ignored. So we deliberately do NOT rectangular-pad the whole grid --
  // one broken, ultra-wide row (a spilled formula) would otherwise force every
  // row out to that width, allocating rows x width empty cells: enough to hang
  // the node for many minutes on a large sheet. Header detection runs on the
  // raw grid (the real header row is already full width).
  if (!grid || grid.length === 0) throw new Error("empty sheet -- no header row");
  const headerIdx = findHeaderRow(grid);
  const header = resolveHeader(grid[headerIdx]);
  const H = header.length;
  return grid.slice(headerIdx + 1).map((r) => {
    const obj = {};
    for (let c = 0; c < H; c++) {
      const v = r[c];
      obj[header[c]] = (v === "" || v == null) ? null : v;
    }
    return obj;
  });
}

function clearSentinel(v) {
  if (v == null) return null;
  return SHEETS_ERROR_SENTINELS.has(v) ? null : v;
}

// resolve one date cell after sentinel/blank normalization: blank, a known
// sentinel, OR a non-empty value that simply doesn't parse as a date -> null.
// Returning null (rather than throwing) lets the caller cross-fill from the
// sibling date column. Confirmed live in [SOCE 2026]_Daily name list_BTS
// 'Jul 26' row 2074: a broken formula spilled the shift name ("FSOCE ") across
// วันที่.1 and the rest of the row while วันที่ still held a clean "09 Jul 26".
// Same recovery the sentinel path already does for #REF!, just for garbage that
// isn't one of the known error strings. A row with NO valid date in EITHER
// column is still caught downstream (placeholder-drop or the "no usable date"
// throw); two columns holding DIFFERENT valid dates still trips the disagree throw.
function dateCell(rawVal, parser) {
  const v = clearSentinel(rawVal);
  if (v == null || v === "") return null;
  return parser(v);   // null if unparseable -> recoverable from the sibling column
}

// ------------------------------------------------------------------ cleaning
function cleanRaw(rawObjs) {
  const cols = rawObjs.length ? new Set(Object.keys(rawObjs[0])) : new Set();
  const missing = REQUIRED_RAW_COLUMNS.filter((c) => !cols.has(c));
  if (rawObjs.length && missing.length) {
    throw new Error(`missing required raw columns: ${JSON.stringify(missing.sort())}`);
  }

  // keep rows with a real name; drop an accidentally-duplicated header row
  let rows = rawObjs.filter((r) => r["ค้นหา"] != null && r["ค้นหา"] !== "ค้นหา");

  // per-row: normalize sentinels, parse both date columns, cross-fill
  rows = rows.map((r) => {
    const team0 = clearSentinel(r["team"]);
    const d1 = dateCell(r["วันที่"], parseDayFirst);
    const d2 = dateCell(r["วันที่.1"], parseISO);
    return { r: r, team: team0, d1: d1 || d2, d2: d2 || d1 };
  });

  // unrecoverable date (both null): DROP the row and count it. A show-up with
  // no date in EITHER column has no attributable calendar day, so it can't be
  // counted (streaks in Summary_5 need a real day) -- dropping beats throwing
  // and blocking the whole sync, and beats fabricating a day. Per user decision
  // (PNK 'Jul 26': 109 rows had a full work record -- name/clock/shift/team --
  // but both date cells simply blank). The count is surfaced on the returned
  // array (out.droppedNoDate) so the caller logs it and the drop is never silent.
  // This subsumes the old roster-placeholder case (all-fields-blank is just one
  // kind of no-date row).
  let noDateDropped = 0;
  rows = rows.filter((x) => {
    if (x.d1 || x.d2) return true;
    noDateDropped++;
    return false;
  });

  // both dates present but disagree -> genuine ambiguity, throw
  const mism = rows.filter((x) => x.d1.key !== x.d2.key);
  if (mism.length) {
    const ex = mism.slice(0, 5).map((x) =>
      `${x.r["ค้นหา"]}: วันที่=${JSON.stringify(x.r["วันที่"])} (${x.d1.key}) vs ` +
      `วันที่.1=${JSON.stringify(x.r["วันที่.1"])} (${x.d2.key})`).join("; ");
    throw new Error(
      `วันที่ and วันที่.1 disagree on date for ${mism.length} row(s) -- stop, ask ` +
      `which is the show-up date. First examples: ${ex}`
    );
  }

  // shift name (stripped) and team backfill
  rows.forEach((x) => { x.shift = x.r["shift name"] == null ? null : String(x.r["shift name"]).trim(); });

  const needsTeam = rows.filter((x) => x.team == null);
  if (needsTeam.length) {
    const needed = new Set(needsTeam.map((x) => x.shift));
    // learn shift -> team COUNTS from rows that already have both (limited to
    // needed shifts), then resolve each to its MAJORITY team. team is an
    // abbreviation of shift name, so the dominant pairing is the real mapping and
    // the minority are data-entry noise -- confirmed live (SPT 'Jul 26': "Outbound"
    // -> OB x195 with a scatter of stray teams, "Helper" -> Helper x9 with 3 stray).
    // (Was: threw on ANY shift mapping to >1 team, which stalled the whole sync on
    // one mislabeled row.) Only a genuine TIE for the top (no dominant team) is
    // real ambiguity and still throws.
    const counts = {};                  // shift -> { team: n }
    rows.filter((x) => x.team != null).forEach((x) => {
      if (!needed.has(x.shift)) return;
      const m = (counts[x.shift] = counts[x.shift] || {});
      m[x.team] = (m[x.team] || 0) + 1;
    });
    const tied = [];
    const shiftToTeam = {};
    Object.keys(counts).forEach((s) => {
      const m = counts[s], teams = Object.keys(m);
      let best = teams[0], bestN = m[teams[0]], tie = false;
      for (let i = 1; i < teams.length; i++) {
        if (m[teams[i]] > bestN) { best = teams[i]; bestN = m[teams[i]]; tie = false; }
        else if (m[teams[i]] === bestN) { tie = true; }
      }
      if (tie) tied.push(s); else shiftToTeam[s] = best;
    });
    if (tied.length) {
      throw new Error(`shift name(s) map to multiple teams with no majority (a tie), can't backfill safely: ${JSON.stringify(tied.sort())} -- stop, ask`);
    }

    needsTeam.forEach((x) => {
      if (x.shift != null && shiftToTeam[x.shift] != null) x.team = shiftToTeam[x.shift];   // data-driven
      if (x.team == null && x.shift != null && KNOWN_SHIFT_TEAM[x.shift] != null) x.team = KNOWN_SHIFT_TEAM[x.shift];  // confirmed facts
      if (x.team == null && x.shift != null && x.shift !== "") x.team = x.shift;             // shift name as team
    });

    // a row with NEITHER team nor shift name: nothing to attribute -> drop
    rows = rows.filter((x) => x.team != null);
  }

  // build clean rows; dedup (name,date) keeping earliest clock-in (garbled -> last)
  const built = rows.map((x, i) => ({
    name: x.r["ค้นหา"],
    date: x.d2,
    team: x.team,
    clockin: x.r["เข้างาน"] == null ? null : x.r["เข้างาน"],
    shift_name: x.shift,
    shift_id: x.r["Shift_id"] == null ? null : x.r["Shift_id"],
    _clock: parseClockMinutes(x.r["เข้างาน"] == null ? "" : x.r["เข้างาน"]),
    _i: i,
  }));
  // stable sort by clock (null last), then keep first per (name,date)
  built.sort((a, b) => {
    const ca = a._clock == null ? Infinity : a._clock;
    const cb = b._clock == null ? Infinity : b._clock;
    return ca !== cb ? ca - cb : a._i - b._i;
  });
  const seen = new Set();
  const out = [];
  for (const b of built) {
    const k = b.name + SEP + b.date.key;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      name: b.name, date: b.date, team: b.team, clockin: b.clockin,
      shift_name: b.shift_name, shift_id: b.shift_id, month: monthLabel(b.date.month),
    });
  }
  out.droppedNoDate = noDateDropped;   // surfaced for the caller to log (see cleanRaw's no-date drop)
  return out;
}

// public: raw grid (array of string-arrays) -> clean rows
function loadRawFromValues(grid) {
  return cleanRaw(rowsToRawObjects(grid));
}

// ------------------------------------------------------------------ core engine
function prepare(rows) {
  // rows: [{name, date:makeDate, team, ...}]. Validates uniqueness of (name,date).
  const seen = new Set();
  for (const r of rows) {
    if (r.name == null || r.date == null || r.team == null) {
      throw new Error("missing required columns: name/date/team");
    }
    const k = r.name + SEP + r.date.key;
    if (seen.has(k)) throw new Error("duplicate (name,date) rows -- clean set must be one row per worker per day");
    seen.add(k);
  }
  return rows;
}

function maxConsecutiveRun(dayNums) {
  const ds = Array.from(new Set(dayNums)).sort((a, b) => a - b);
  if (!ds.length) return 0;
  let best = 1, cur = 1;
  for (let i = 1; i < ds.length; i++) {
    cur = ds[i] - ds[i - 1] === 1 ? cur + 1 : 1;
    if (cur > best) best = cur;
  }
  return best;
}

function sortedUnique(arr) { return Array.from(new Set(arr)).sort(); }

// the distinct teams present in a clean set, sorted. Replaces the hardcoded
// OPERATIONAL_TEAMS -- teams are now data-driven per SOC (station lists differ
// by SOC, e.g. "OB" vs "OBD", and each SOC is reported separately).
function distinctTeams(rows) { return sortedUnique(rows.map((r) => r.team)); }

function round2(x) { return Math.round((x + Number.EPSILON) * 100) / 100; }

// group rows by keyFn; returns Map(key -> rows[]). Keys are never split back
// apart -- callers read fields from the grouped rows, so a name with spaces or
// any separator can't corrupt the grouping.
function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

// distinct show-up days per (month, worker)
function daysPerMonthWorker(d, team) {
  const x = team == null ? d : d.filter((r) => r.team === team);
  const g = groupBy(x, (r) => r.date.month + SEP + r.name);
  const out = [];
  for (const rs of g.values()) {
    out.push({
      month: rs[0].date.month,
      name: rs[0].name,
      days: new Set(rs.map((r) => r.date.key)).size,
    });
  }
  return out;
}

function showupBlock(rows, team) {
  const d = prepare(rows);
  const days = daysPerMonthWorker(d, team);
  const months = sortedUnique(d.map((r) => r.date.month));
  const bucketLabels = BUCKETS.map(([lo, hi]) => `${lo}-${hi}`);
  const counts = {};  // bucketLabel -> {monthISO -> n}
  bucketLabels.forEach((b) => { counts[b] = {}; });
  const summ = {};
  for (const m of months) {
    const g = days.filter((x) => x.month === m);
    BUCKETS.forEach(([lo, hi], bi) => {
      counts[bucketLabels[bi]][m] = g.filter((x) => x.days >= lo && x.days <= hi).length;
    });
    summ[m] = bucketLabels.reduce((s, b) => s + counts[b][m], 0);
  }
  // shape as {counts, pct} keyed by bucketLabel (+ "Sum Month") -> {monthLabel -> value}
  const relabel = (obj) => {
    const o = {};
    for (const b of Object.keys(obj)) {
      o[b] = {};
      for (const m of months) o[b][monthLabel(m)] = obj[b][m];
    }
    return o;
  };
  const countsOut = relabel(counts);
  const pct = {};
  bucketLabels.forEach((b) => {
    pct[b] = {};
    for (const m of months) pct[b][monthLabel(m)] = summ[m] ? round2(counts[b][m] / summ[m] * 100) : 0.0;
  });
  countsOut["Sum Month"] = {};
  pct["Sum Month"] = {};
  for (const m of months) {
    countsOut["Sum Month"][monthLabel(m)] = summ[m];
    pct["Sum Month"][monthLabel(m)] = 100.0;
  }
  return { counts: countsOut, pct: pct, monthLabels: months.map(monthLabel) };
}

// period defaults to "month" (unchanged behavior); "week" gives the same
// rotation logic recomputed per ISO week. teamCount[t] = distinct days at t
// (clean set is one row per name+date). rotationCount = # distinct teams touched.
function rotationWorkerTable(rows, period) {
  period = period || "month";
  const d = prepare(rows);
  const g = groupBy(d, (r) => periodKey(r.date, period) + SEP + r.name);
  const table = [];
  for (const rs of g.values()) {
    const teamCount = {};
    rs.forEach((r) => { teamCount[r.team] = (teamCount[r.team] || 0) + 1; });
    const rotationCount = Object.keys(teamCount).length;
    const analyze = {};
    Object.keys(teamCount).forEach((t) => {
      analyze[t] = (teamCount[t] > 1 && rotationCount > 1) ? "Rotated" : "";
    });
    const pk = periodKey(rs[0].date, period);
    table.push({ periodKey: pk, label: periodLabel(pk, period), name: rs[0].name, teamCount: teamCount, analyze: analyze });
  }
  return table;
}

function rotationSummary(rows, period) {
  period = period || "month";
  const wt = rotationWorkerTable(rows, period);
  const teams = distinctTeams(prepare(rows));
  const byPeriod = groupBy(wt, (r) => r.periodKey);
  const out = [];
  for (const pk of Array.from(byPeriod.keys()).sort()) {
    const g = byPeriod.get(pk);
    // monthly keeps the ISO month key ("2026-03", unchanged); weekly is "W7"
    const label = period === "month" ? pk : g[0].label;
    for (const t of teams) {
      const inTeam = g.filter((r) => (r.teamCount[t] || 0) >= 1);
      const pop = inTeam.length;
      if (pop === 0) continue;
      const rotated = inTeam.filter((r) => r.analyze[t] === "Rotated").length;
      const nonrot = pop - rotated;
      const oneday = inTeam.filter((r) => r.analyze[t] !== "Rotated" && (r.teamCount[t] || 0) === 1).length;
      out.push({
        month: label, team: t, population: pop, rotation: rotated, non_rotation: nonrot,
        oneday_nonrot: oneday,
        "rotation%": round2(rotated / pop * 100),
        "non_rotation%": round2(nonrot / pop * 100),
        "oneday%": nonrot ? round2(oneday / nonrot * 100) : null,
      });
    }
  }
  return out;
}

// New/Old face (slide p3): per (month, worker), the MAX distinct days at any
// single team. Old (experienced) if that max >= 10, else New. With a team arg,
// scope to that team (days at T), so Old = present at T with >=10 days at T.
// Returns a wide block {counts:{Old,New}, pct:{"Old %","New %"}, monthLabels}
// mirroring showupBlock's shape so one grid shaper renders both.
const NEWOLD_MIN_DAYS = 10;
function newOldMonthly(rows, team) {
  const d = prepare(rows);
  const x = team == null ? d : d.filter((r) => r.team === team);
  const months = sortedUnique(x.map((r) => r.date.month));
  const g = groupBy(x, (r) => r.date.month + SEP + r.name);
  const raw = { Old: {}, New: {} };
  months.forEach((m) => { raw.Old[m] = 0; raw.New[m] = 0; });
  for (const rs of g.values()) {
    const month = rs[0].date.month;
    const byTeam = groupBy(rs, (r) => r.team);
    let maxDays = 0;
    for (const trs of byTeam.values()) {
      const dd = new Set(trs.map((r) => r.date.key)).size;
      if (dd > maxDays) maxDays = dd;
    }
    if (maxDays >= NEWOLD_MIN_DAYS) raw.Old[month]++; else raw.New[month]++;
  }
  const counts = { Old: {}, New: {} };
  const pct = { "Old %": {}, "New %": {} };
  months.forEach((m) => {
    const ml = monthLabel(m);
    const tot = raw.Old[m] + raw.New[m];
    counts.Old[ml] = raw.Old[m];
    counts.New[ml] = raw.New[m];
    pct["Old %"][ml] = tot ? round2(raw.Old[m] / tot * 100) : 0.0;
    pct["New %"][ml] = tot ? round2(raw.New[m] / tot * 100) : 0.0;
  });
  return { counts: counts, pct: pct, monthLabels: months.map(monthLabel) };
}

// Attendance headcount: distinct workers present per period, per team, plus an
// "All" row across teams. Serves the daily ("day") and weekly ("week") grains
// (the bucket/rotation/consecutive metrics can't run on a single day, so this
// is the shared non-degenerate daily/weekly view). team rows x period cols.
function attendanceCrosstab(rows, period) {
  const d = prepare(rows);
  const teams = distinctTeams(d);
  const seenPeriods = {};
  const map = {};      // team -> periodKey -> Set(name)
  const allMap = {};   // periodKey -> Set(name)
  d.forEach((r) => {
    const pk = periodKey(r.date, period);
    seenPeriods[pk] = true;
    (map[r.team] = map[r.team] || {});
    (map[r.team][pk] = map[r.team][pk] || new Set()).add(r.name);
    (allMap[pk] = allMap[pk] || new Set()).add(r.name);
  });
  const periodKeys = Object.keys(seenPeriods).sort();
  const periodLabels = periodKeys.map((k) => periodLabel(k, period));
  const counts = {};
  teams.forEach((t) => {
    counts[t] = {};
    periodKeys.forEach((pk, i) => { counts[t][periodLabels[i]] = (map[t] && map[t][pk]) ? map[t][pk].size : 0; });
  });
  const allRow = {};
  periodKeys.forEach((pk, i) => { allRow[periodLabels[i]] = allMap[pk].size; });
  return { teams: teams, periodLabels: periodLabels, counts: counts, allRow: allRow };
}

function workerMonthStats(d, team) {
  const x = team == null ? d : d.filter((r) => r.team === team);
  const g = groupBy(x, (r) => r.date.month + SEP + r.name);
  const out = [];
  for (const rs of g.values()) {
    out.push({
      month: rs[0].date.month,
      name: rs[0].name,
      days: new Set(rs.map((r) => r.date.key)).size,
      run: maxConsecutiveRun(rs.map((r) => r.date.dayNum)),
    });
  }
  return out;
}

function streakMonthCrosstab(rows, team) {
  const d = prepare(rows);
  const st = workerMonthStats(d, team);
  const months = sortedUnique(d.map((r) => r.date.month));
  const out = [];
  for (const m of months) {
    const g = st.filter((x) => x.month === m);
    const lt = (x) => x.days < 10, gt = (x) => x.days > 10, used = (x) => x.run >= 3;
    out.push({
      month: monthLabel(m), active: g.length,
      "<10": g.filter(lt).length, ">10": g.filter(gt).length,
      "usedto_<10": g.filter((x) => used(x) && lt(x)).length,
      "usedto_>10": g.filter((x) => used(x) && gt(x)).length,
      "never_<10": g.filter((x) => !used(x) && lt(x)).length,
      "never_>10": g.filter((x) => !used(x) && gt(x)).length,
    });
  }
  return out;
}

function streakWeek(rows, team, minRun) {
  minRun = minRun || 3;
  const d = prepare(rows);
  const x = team == null ? d : d.filter((r) => r.team === team);
  const g = groupBy(x, (r) => r.date.iso.year + SEP + r.date.iso.week);
  const out = [];
  for (const rs of g.values()) {
    const week = rs[0].date.iso.week;
    const byWorker = groupBy(rs, (r) => r.name);
    const runs = Array.from(byWorker.values()).map((wr) => maxConsecutiveRun(wr.map((r) => r.date.dayNum)));
    const active = runs.length;
    const q = runs.filter((r) => r >= minRun).length;
    out.push({ week: `W${week}`, active: active, ">=3": q, "<3": active - q, ">=3%": active ? round2(q / active * 100) : 0.0 });
  }
  return out.sort((a, b) => parseInt(a.week.slice(1), 10) - parseInt(b.week.slice(1), 10));
}

// ------------------------------------------------------------------ self-tests
function assert(cond, msg) { if (!cond) throw new Error("ASSERT FAILED: " + msg); }

function makeCleanRows(triples) {
  // triples: [name, team, [y,m,d]] -> engine-ready rows
  return triples.map(([name, team, ymd]) => ({ name: name, team: team, date: makeDate(ymd[0], ymd[1], ymd[2]) }));
}

function synthetic() {
  const r = [];
  const add = (n, t, days) => days.forEach(([m, d]) => r.push([n, t, [2026, m, d]]));
  add("alice", "IB", [[3, 2], [3, 3], [3, 4], [3, 5], [3, 6]]);
  add("bob", "IB", [[3, 2]]); add("bob", "MS", [[3, 3]]);
  add("carol", "IB", [[3, 9], [3, 10], [3, 11], [3, 16]]);
  add("dave", "IB", [[3, 2], [3, 3]]); add("dave", "MS", [[3, 4], [3, 5], [3, 6]]);
  add("erin", "IB", [[3, 2]]);
  add("frank", "IB", [[3, 2], [3, 3], [3, 4], [3, 5], [3, 6], [3, 9], [3, 10]]);
  add("grace", "IB", [[3, 2], [3, 3], [3, 4], [3, 5], [3, 6], [3, 9], [3, 10], [3, 11], [3, 12], [3, 13], [3, 16], [3, 17]]);
  add("henry", "IB", [[3, 30], [3, 31], [4, 1]]);
  return makeCleanRows(r);
}

function expectThrow(fn, needle, label) {
  let threw = false;
  try { fn(); } catch (e) { threw = true; assert(String(e.message).includes(needle), `${label}: wrong error: ${e.message}`); }
  assert(threw, `${label}: expected a throw`);
}

const H = ["วันที่", "ค้นหา", "เข้างาน", "shift name", "วันที่", "BTS", "Shift_id", "team"];

function runSelfTests() {
  const log = [];
  const ok = (name) => log.push(name + " passed");

  // ref-date fallback: broken วันที่.1 recovered from วันที่
  let out = loadRawFromValues([H, ["9 Jul 26", "zoe", "09:00", "Inbound", "#REF!", "SITE", "SH-9", "IB"]]);
  assert(out.length === 1 && out[0].date.key === "2026-07-09", "ref-date fallback");
  ok("test_ref_date_fallback");

  // sentinel general: broken วันที่ recovered from วันที่.1; both broken -> dropped
  out = loadRawFromValues([H, ["#VALUE!", "amy", "09:00", "Inbound", "2026-07-10", "SITE", "SH-1", "IB"]]);
  assert(out[0].date.key === "2026-07-10", "sentinel symmetric");
  out = loadRawFromValues([H,
    ["#REF!", "ben", "09:00", "Inbound", "#N/A", "SITE", "SH-2", "IB"],
    ["10 Jul 26", "dave", "09:00", "Inbound", "2026-07-10", "SITE", "SH-4", "IB"]]);
  assert(out.length === 1 && out[0].name === "dave" && out.droppedNoDate === 1, "sentinel both-broken dropped");
  ok("test_sheets_error_sentinels_general");

  // blank placeholder AND date-only-missing are BOTH dropped now (no attributable day)
  out = loadRawFromValues([H,
    ["", "CYD 11502 THAE THAE", "", "", "", "SITE", "", ""],
    ["9 Jul 26", "zoe", "09:00", "Inbound", "2026-07-09", "SITE", "SH-9", "IB"]]);
  assert(out.length === 1 && out[0].name === "zoe" && out.droppedNoDate === 1, "placeholder dropped");
  out = loadRawFromValues([H, ["", "carol", "09:00", "Inbound", "", "SITE", "SH-3", "IB"]]);
  assert(out.length === 0 && out.droppedNoDate === 1, "date-only-missing dropped");
  ok("test_blank_placeholder_row_dropped");

  // garbled clock-in tolerated; loses same-day tie to a real time
  out = loadRawFromValues([H, ["9 Jul 26", "amy", "$0.88", "Inbound", "2026-07-09", "SITE", "SH-1", "IB"]]);
  assert(out.length === 1 && out[0].clockin === "$0.88", "garbled clockin preserved");
  out = loadRawFromValues([H,
    ["9 Jul 26", "ben", "$0.88", "Inbound", "2026-07-09", "SITE", "SH-2", "IB"],
    ["9 Jul 26", "ben", "08:00", "Outbound", "2026-07-09", "SITE", "SH-3", "OBD"]]);
  assert(out.length === 1 && out[0].team === "OBD", "real clock-in wins tie");
  ok("test_garbled_clockin_tolerated");

  // names with spaces must survive grouping (regression guard for the SEP fix)
  out = loadRawFromValues([H,
    ["9 Jul 26", "CYD 11 A B", "09:00", "Inbound", "2026-07-09", "SITE", "SH-1", "IB"],
    ["10 Jul 26", "CYD 11 A B", "09:00", "Inbound", "2026-07-10", "SITE", "SH-1", "IB"]]);
  const sb0 = showupBlock(out);
  assert(sb0.counts["1-5"]["Jul"] === 1, "name-with-spaces grouped as one worker");
  ok("test_name_with_spaces");

  // corrupted date header ("49") repaired by position; a single bad date column
  // is recovered from the valid sibling (was: threw on the unparseable cell)
  const Hbad = ["49", "ค้นหา", "เข้างาน", "shift name", "วันที่", "BTS", "Shift_id", "team", "กะ", "เวลาเข้า-ออกงาน"];
  out = loadRawFromValues([Hbad, ["9 May 26", "amy", "09:00", "Inbound", "2026-05-09", "SITE", "SH-1", "IB", "K1", "09:00-17:00"]]);
  assert(out.length === 1 && out[0].date.key === "2026-05-09", "corrupted header repaired");
  out = loadRawFromValues([Hbad, ["not a date", "ben", "09:00", "Inbound", "2026-05-10", "SITE", "SH-2", "IB", "K1", "09:00-17:00"]]);
  assert(out.length === 1 && out[0].date.key === "2026-05-10", "one bad date column recovered from sibling");
  ok("test_corrupted_date_header_repaired");

  // BTS 'Jul 26' row 2074: a broken formula spilled "FSOCE " across วันที่.1 and
  // the rest of the row; วันที่ still valid -> recover the show-up day, don't throw
  out = loadRawFromValues([H, ["09 Jul 26", "BTS 0122 x", "19:00", "FSOCE ", "FSOCE ", "FSOCE ", "FSOCE ", "FSOCE "]]);
  assert(out.length === 1 && out[0].date.key === "2026-07-09", "garbage วันที่.1 recovered from วันที่");
  // both date columns unparseable garbage, other fields populated -> the row is
  // DROPPED (no attributable day) and counted, not thrown (PNK 'Jul 26' decision)
  out = loadRawFromValues([H,
    ["junk", "cara", "09:00", "Inbound", "junk", "SITE", "SH-1", "IB"],
    ["10 Jul 26", "dave", "09:00", "Inbound", "2026-07-10", "SITE", "SH-2", "IB"]]);
  assert(out.length === 1 && out[0].name === "dave", "undated row dropped, dated row kept");
  assert(out.droppedNoDate === 1, "no-date drop counted");
  ok("test_garbage_date_col_recovered");

  // clock-in header cell overwritten by a stray time -> repaired by position
  const Htime = ["วันที่", "ค้นหา", "11:00:00 AM", "shift name", "วันที่", "PPO", "Shift_id", "team", "กะ", "เวลาเข้า-ออกงาน"];
  out = loadRawFromValues([Htime, ["9 Feb 26", "amy", "09:00", "Inbound", "2026-02-09", "SITE", "SH-1", "IB", "K1", "09:00-17:00"]]);
  assert(out.length === 1 && out[0].date.key === "2026-02-09" && out[0].clockin === "09:00", "clock-in header repaired");
  ok("test_corrupted_clockin_header_repaired");

  // DSR 'Jan 26': the ค้นหา (name) header cell is BLANK, names real underneath;
  // anchor on 'shift name' (2 cols right) to recover ค้นหา by position
  const Hname = ["วันที่", "", "เข้างาน", "shift name", "วันที่", "DSR", "Shift_id", "team", "กะ", "เวลาเข้า-ออกงาน"];
  out = loadRawFromValues([Hname, ["01 Jan 26", "DSRCW 0130 x", "23:00", "Small Sort", "2026-01-01", "DSR", "SS_N_23", "SS", "N", "23:00-08:00"]]);
  assert(out.length === 1 && out[0].name === "DSRCW 0130 x" && out[0].date.key === "2026-01-01", "blank name header repaired");
  ok("test_blank_name_header_repaired");

  // ragged rows normalized (wider + shorter than header)
  out = loadRawFromValues([H,
    ["9 Jul 26", "amy", "09:00", "Inbound", "2026-07-09", "SITE", "SH-1", "IB", "junk1", "junk2", "junk3"],
    ["10 Jul 26", "ben", "09:00", "Inbound", "2026-07-10", "SITE", "SH-2"]]);
  const teamsByName = Object.fromEntries(out.map((r) => [r.name, r.team]));
  assert(teamsByName["amy"] === "IB" && teamsByName["ben"] === "IB", "ragged rows normalized");
  ok("test_ragged_rows_normalized");

  // duplicate header row dropped
  out = loadRawFromValues([H, H.slice(), ["9 Mar 26", "amy", "09:00", "Inbound", "2026-03-09", "SITE", "SH-1", "IB"]]);
  assert(out.length === 1 && out[0].name === "amy", "duplicate header dropped");
  ok("test_duplicate_header_row_dropped");

  // team learned from shift name; majority wins over noise; a TIE throws;
  // unlearnable -> shift name; both-missing dropped
  out = loadRawFromValues([H,
    ["9 Jul 26", "amy", "09:00", "Outbound", "2026-07-09", "SITE", "SH-1", "OBD"],
    ["9 Jul 26", "ben", "09:00", "Outbound", "2026-07-09", "SITE", "SH-2", ""],
    ["9 Jul 26", "cara", "09:00", "FSOCE ", "2026-07-09", "SITE", "SH-3", "FSOCE"],
    ["9 Jul 26", "dan", "09:00", "FSOCE", "2026-07-09", "SITE", "SH-4", ""]]);
  const t2 = Object.fromEntries(out.map((r) => [r.name, r.team]));
  assert(t2["ben"] === "OBD" && t2["dan"] === "FSOCE", "team learned");
  // majority vote: dominant team + noise -> the blank-team row gets the dominant team
  out = loadRawFromValues([H,
    ["9 Jul 26", "amy", "09:00", "Outbound", "2026-07-09", "SITE", "SH-1", "OB"],
    ["9 Jul 26", "ben", "09:00", "Outbound", "2026-07-09", "SITE", "SH-2", "OB"],
    ["9 Jul 26", "cara", "09:00", "Outbound", "2026-07-09", "SITE", "SH-3", "AdminA"],
    ["9 Jul 26", "dan", "09:00", "Outbound", "2026-07-09", "SITE", "SH-4", ""]]);
  assert(Object.fromEntries(out.map((r) => [r.name, r.team]))["dan"] === "OB", "majority team backfill");
  // genuine tie (OBD x1 vs IB x1) has no dominant team -> still throws
  expectThrow(() => loadRawFromValues([H,
    ["9 Jul 26", "amy", "09:00", "Mixed", "2026-07-09", "SITE", "SH-1", "OBD"],
    ["9 Jul 26", "ben", "09:00", "Mixed", "2026-07-09", "SITE", "SH-2", "IB"],
    ["9 Jul 26", "cara", "09:00", "Mixed", "2026-07-09", "SITE", "SH-3", ""]]),
    "no majority", "tied team");
  out = loadRawFromValues([H, ["9 Jul 26", "erin", "09:00", "Ghost Shift", "2026-07-09", "SITE", "SH-9", ""]]);
  assert(out[0].team === "Ghost Shift", "unlearnable -> shift name as team");
  out = loadRawFromValues([H,
    ["9 Jul 26", "fay", "09:00", "", "2026-07-09", "SITE", "SH-8", ""],
    ["9 Jul 26", "gus", "09:00", "Inbound", "2026-07-09", "SITE", "SH-7", "IB"]]);
  assert(out.length === 1 && out[0].name === "gus", "both-missing dropped");
  ok("test_team_learned_from_shift_name");

  // FSOCE hardcoded fallback when unlearnable (no valid example in tab)
  out = loadRawFromValues([H,
    ["9 Mar 26", "amy", "09:00", "FSOCE", "2026-03-09", "SITE", "SH-1", ""],
    ["9 Mar 26", "ben", "09:00", "FSOCE ", "2026-03-09", "SITE", "SH-2", ""]]);
  assert(out.every((r) => r.team === "FSOCE"), "FSOCE hardcoded fallback");
  ok("test_fsoce_hardcoded_fallback_when_unlearnable");

  // ---- engine numbers against the synthetic fixture (same as test.py) ----
  const df = synthetic();
  const sb = showupBlock(df);
  assert(sb.counts["1-5"]["Mar"] === 6 && sb.counts["6-10"]["Mar"] === 1 && sb.counts["11-15"]["Mar"] === 1, "showup buckets");
  const rs = rotationSummary(df);
  const ib = rs.find((r) => r.month === "2026-03" && r.team === "IB");
  assert(ib.population === 8 && ib.rotation === 1 && ib.non_rotation === 7, "rotation IB pop/rot");
  assert(ib.oneday_nonrot === 2, "rotation IB oneday (Reading B)");
  const ms = rs.find((r) => r.month === "2026-03" && r.team === "MS");
  assert(ms.population === 2 && ms.rotation === 1 && ms.oneday_nonrot === 1, "rotation MS");
  const x = streakMonthCrosstab(df);
  const mar = x.find((r) => r.month === "Mar");
  assert(mar["usedto_<10"] + mar["usedto_>10"] === 5, "streak usedto total");
  const w = Object.fromEntries(streakWeek(df).map((r) => [r.week, r]));
  assert(w["W10"][">=3"] === 4 && w["W11"][">=3"] === 2 && w["W14"][">=3"] === 1, "streak week");
  ok("engine_synthetic_numbers");

  // data-driven teams: exactly the teams present in the clean set
  assert(JSON.stringify(distinctTeams(df)) === JSON.stringify(["IB", "MS"]), "distinctTeams");
  ok("test_distinct_teams");

  // New/Old face: only grace (12 days at IB in Mar) clears the 10-day bar -> Old
  const nof = newOldMonthly(df);
  assert(nof.counts.Old["Mar"] === 1 && nof.counts.New["Mar"] === 7, "newold all Mar");
  const nofIB = newOldMonthly(df, "IB");
  assert(nofIB.counts.Old["Mar"] === 1 && nofIB.counts.New["Mar"] === 7, "newold IB Mar");
  // a worker split 5+6 across two teams (max 6 < 10) stays New despite 11 total days
  const split = makeCleanRows([
    ["zed", "IB", [2026, 6, 1]], ["zed", "IB", [2026, 6, 2]], ["zed", "IB", [2026, 6, 3]],
    ["zed", "IB", [2026, 6, 4]], ["zed", "IB", [2026, 6, 5]],
    ["zed", "MS", [2026, 6, 8]], ["zed", "MS", [2026, 6, 9]], ["zed", "MS", [2026, 6, 10]],
    ["zed", "MS", [2026, 6, 11]], ["zed", "MS", [2026, 6, 12]], ["zed", "MS", [2026, 6, 15]],
  ]);
  assert(newOldMonthly(split).counts.New["Jun"] === 1 && newOldMonthly(split).counts.Old["Jun"] === 0, "newold split-max<10 is New");
  ok("test_newold_face");

  // attendance headcount: 6 distinct workers present on Mar-02, all in IB
  const ad = attendanceCrosstab(df, "day");
  assert(ad.counts["IB"]["2026-03-02"] === 6 && ad.allRow["2026-03-02"] === 6, "attendance daily");
  const aw = attendanceCrosstab(df, "week");
  assert(aw.allRow["W10"] === 6, "attendance weekly W10");
  ok("test_attendance_crosstab");

  // weekly rotation reuses the monthly logic per ISO week (smoke: shape + fields)
  const rw = rotationSummary(df, "week");
  assert(rw.length > 0 && rw[0].month[0] === "W" && "population" in rw[0], "weekly rotation shape");
  ok("test_rotation_weekly");

  log.push("ALL SELF-TESTS PASSED");
  return [{ json: { passed: true, log: log } }];
}

// n8n Code node: `return runSelfTests();`  |  Node.js: prints below.
if (typeof module !== "undefined" && require.main === module) {
  const res = runSelfTests();
  console.log(res[0].json.log.join("\n"));
}
if (typeof module !== "undefined") {
  module.exports = {
    loadRawFromValues: loadRawFromValues, cleanRaw: cleanRaw, rowsToRawObjects: rowsToRawObjects,
    showupBlock: showupBlock, rotationSummary: rotationSummary, streakMonthCrosstab: streakMonthCrosstab,
    streakWeek: streakWeek, makeDate: makeDate, monthLabel: monthLabel, runSelfTests: runSelfTests,
    distinctTeams: distinctTeams, newOldMonthly: newOldMonthly, attendanceCrosstab: attendanceCrosstab,
    OPERATIONAL_TEAMS: OPERATIONAL_TEAMS, BUCKETS: BUCKETS,
  };
}
