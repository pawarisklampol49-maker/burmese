/**
 * n8n Code node "Compute Tabs".
 * Mode: "Run Once for All Items". Language: JavaScript.
 *
 * HOW TO BUILD THIS NODE:
 *   Paste the FULL contents of engine.js first, then paste THIS footer at the
 *   very bottom. engine.js provides showupBlock/rotationSummary/
 *   streakMonthCrosstab + BUCKETS and all the helpers.
 *
 * Sits after the read/clean chain:
 *   ... -> [Clean Rows] (one item per vendor file) -> THIS
 * It gathers every cleaned row across all files, groups by the data-derived
 * year, and for each year builds the 7 central-sheet tabs as ready-to-write
 * 2D grids (header row + data rows), matching render/app.py exactly:
 *   - 4 department tabs (RAW input option): SOCN/SOCE/SOCW/FSOCW, with the
 *     verbatim 8-column header. Always emitted, header-only if a dept has no
 *     rows that year, so the 7-tab shape never varies.
 *   - 3 summary tabs (USER_ENTERED input option): Summary_1 / Summary_Rotation
 *     / Summary_5, same computation as the Python engine (already verified by
 *     runSelfTests()).
 *
 * Output: ONE item per data-year, { year, departments, summaryTabs, tabs },
 * where tabs is { tabName -> grid }. The Write stage consumes this.
 *
 * The engine's prepare() (called inside each summary function) throws on a
 * duplicate (name,date) across the year's combined dept/vendor rows -- that's
 * the same cross-vendor collision guard app.py runs before writing summaries.
 */

// ======================= paste engine.js ABOVE this line =======================

// verbatim, user-specified raw-tab header (app.py RAW_TAB_COLUMNS order)
const RAW_TAB_HEADER = ["Date show up", "Month show up", "Sub-con name", "Name",
                        "Clock in", "shift name", "Shift_id", "team"];
const DEPARTMENTS = ["SOCN", "SOCE", "SOCW", "FSOCW"];
const SUMMARY_TABS = ["Summary_1", "Summary_Rotation", "Summary_5"];

const BUCKET_ORDER = BUCKETS.map(([lo, hi]) => `${lo}-${hi}`).concat(["Sum Month"]);
// column order = engine dict-key order (matches test.py / app.py DataFrame cols)
const ROTATION_COLS = ["month", "team", "population", "rotation", "non_rotation",
                       "oneday_nonrot", "rotation%", "non_rotation%", "oneday%"];
const STREAK_COLS = ["month", "active", "<10", ">10",
                     "usedto_<10", "usedto_>10", "never_<10", "never_>10"];

const cell = (v) => (v == null ? "" : String(v));

// gather every cleaned row across all files
const all = [];
for (const it of items) {
  for (const r of (it.json.rows || [])) all.push(r);
}
if (!all.length) throw new Error("no cleaned rows from any file -- nothing to compute");

// group by data-derived year (date.y), like app.py pd.to_datetime(date).dt.year
const byYear = new Map();
for (const r of all) {
  const y = String(r.date.y);
  if (!byYear.has(y)) byYear.set(y, []);
  byYear.get(y).push(r);
}

function deptGrid(rows) {
  const grid = [RAW_TAB_HEADER.slice()];
  for (const r of rows) {
    grid.push([
      cell(r.date.key), cell(r.month), cell(r.vendor), cell(r.name),
      cell(r.clockin), cell(r.shift_name), cell(r.shift_id), cell(r.team),
    ]);
  }
  return grid;
}

function summary1Grid(slim) {
  const { counts, pct, monthLabels } = showupBlock(slim);
  const header = ["bucket"].concat(monthLabels, monthLabels.map((m) => m + " %"));
  const grid = [header];
  for (const b of BUCKET_ORDER) {
    const row = [b];
    for (const m of monthLabels) row.push(cell(counts[b][m]));
    for (const m of monthLabels) row.push(cell(pct[b][m]));
    grid.push(row);
  }
  return grid;
}

function objRowsGrid(objs, cols) {
  const grid = [cols.slice()];
  for (const o of objs) grid.push(cols.map((c) => cell(o[c])));
  return grid;
}

const out = [];
for (const year of Array.from(byYear.keys()).sort()) {
  const yrows = byYear.get(year);
  // slim {name,date,team} slice drives the 3 summaries (all the engine needs)
  const slim = yrows.map((r) => ({ name: r.name, date: r.date, team: r.team }));

  const tabs = {};
  for (const dept of DEPARTMENTS) {
    tabs[dept] = deptGrid(yrows.filter((r) => r.dept === dept));
  }
  tabs["Summary_1"] = summary1Grid(slim);
  tabs["Summary_Rotation"] = objRowsGrid(rotationSummary(slim), ROTATION_COLS);
  tabs["Summary_5"] = objRowsGrid(streakMonthCrosstab(slim), STREAK_COLS);

  out.push({
    json: {
      year: year,
      departments: DEPARTMENTS,     // written RAW
      summaryTabs: SUMMARY_TABS,    // written USER_ENTERED
      workers: new Set(slim.map((r) => r.name)).size,
      rows: slim.length,
      tabs: tabs,
    },
  });
}
return out;
