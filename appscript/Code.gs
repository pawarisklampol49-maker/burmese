/**
 * SOC worker-analysis sync -- standalone Google Apps Script.
 *
 * This is the whole automation: it discovers the vendor spreadsheets, cleans
 * every month tab with the shared engine (engine.gs -- a verbatim copy of
 * n8n/engine.js), and writes one central spreadsheet per year with 7 tabs
 * (4 raw department tabs + 3 summary tabs). It replaces the Render service and
 * the n8n workflow: everything runs inside Google, so the vendor data never
 * leaves Google's servers and there is no memory limit to hit.
 *
 * It is a STANDALONE script (not bound to any sheet), so:
 *   - it is pasted/deployed exactly once, ever;
 *   - it runs as the owning Google account (real Drive quota), so it can
 *     CREATE each new year's central sheet itself -- no manual sheet setup.
 *
 * SETUP (once):
 *   1. Enable the Advanced Sheets Service (Services + -> Google Sheets API),
 *      or trust appsscript.json which already declares it.
 *   2. Run initProperties() once to set CENTRAL_FOLDER_ID and RAW_DEPARTMENTS
 *      (or set them under Project Settings -> Script Properties).
 *   3. Run runSelfTests() (from engine.gs) -> expect ALL SELF-TESTS PASSED.
 *   4. Run dryRun() -> logs the discovered files + row counts, writes nothing.
 *   5. Run sync() once by hand and check the year's sheet.
 *   6. Run installTrigger() to schedule the daily run.
 *
 * The engine's helpers (loadRawFromValues, showupBlock, rotationSummary,
 * streakMonthCrosstab, BUCKETS, SEP, ...) are global -- Apps Script shares one
 * scope across all .gs files, so engine.gs's definitions are visible here.
 */

// ------------------------------------------------------------------ config
function initProperties() {
  PropertiesService.getScriptProperties().setProperties({
    CENTRAL_FOLDER_ID: '1oDCnJmwIjedcHNtSyd_Hr-B5HDhZIN4K',
    RAW_DEPARTMENTS: 'SOCN,SOCE,SOCW,FSOCW',
  });
  Logger.log('Script properties set.');
}

function cfg_() {
  const props = PropertiesService.getScriptProperties();
  const folderId = props.getProperty('CENTRAL_FOLDER_ID');
  const deptsRaw = props.getProperty('RAW_DEPARTMENTS');
  if (!folderId) throw new Error('Script Property CENTRAL_FOLDER_ID is not set -- run initProperties()');
  if (!deptsRaw) throw new Error('Script Property RAW_DEPARTMENTS is not set -- run initProperties()');
  const departments = deptsRaw.split(',').map(function (s) { return s.trim().toUpperCase(); }).filter(Boolean);
  return { folderId: folderId, departments: departments };
}

// ------------------------------------------------------------------ discovery
const RAW_TITLE_RE = /^\[([A-Za-z]+)\s+(\d{4})\]_Daily name list_(.+)$/;

// mirrors render/app.py _list_raw_candidates + _parse_raw_title / n8n Parse Titles:
// a loose match that fails the strict pattern or has an unknown department is a
// HARD ERROR (silent-skip is what caused the original 7.3x undercount).
function discoverFiles_(knownDepts) {
  const known = {};
  knownDepts.forEach(function (d) { known[d] = true; });
  const q = 'title contains "_Daily name list_" and ' +
            'mimeType = "application/vnd.google-apps.spreadsheet" and trashed = false';
  const it = DriveApp.searchFiles(q);
  const out = [];
  while (it.hasNext()) {
    const f = it.next();
    const name = f.getName();
    const m = String(name).trim().match(RAW_TITLE_RE);
    if (!m) {
      throw new Error("'" + name + "' matched raw discovery but doesn't match " +
        "'[DEPT YEAR]_Daily name list_VENDOR' -- rename it or narrow the search");
    }
    const dept = m[1].toUpperCase();
    if (!known[dept]) {
      throw new Error("unrecognized department '" + dept + "' parsed from '" + name +
        "' -- expected one of " + JSON.stringify(Object.keys(known).sort()));
    }
    out.push({ id: f.getId(), name: name, dept: dept, year: m[2], vendor: m[3].trim() });
  }
  if (!out.length) {
    throw new Error('no raw vendor spreadsheets found -- check they are shared with ' +
      'this account and named "[DEPT YEAR]_Daily name list_VENDOR"');
  }
  return out;
}

// ------------------------------------------------------------------ month tabs
const MONTH_TAB_NAMES = {};
['january', 'february', 'march', 'april', 'may', 'june', 'july',
 'august', 'september', 'october', 'november', 'december'].forEach(function (full) {
  MONTH_TAB_NAMES[full] = true;
  MONTH_TAB_NAMES[full.slice(0, 3)] = true;
});

// "Jun 26" / "July 26" -> true (matches app.py _is_month_tab)
function isMonthTab_(title) {
  const t = String(title).trim().split(/\s+/);
  return t.length === 2 && MONTH_TAB_NAMES[t[0].toLowerCase()] === true && /^\d{2}$/.test(t[1]);
}

function quoted_(t) { return "'" + String(t).replace(/'/g, "''") + "'"; }

// read every month tab of one vendor file in a single batchGet, capped to A:J
// (only the first ~8 columns are used -- avoids junk/wide columns). Mirrors
// n8n Build Ranges + Batch Read and app.py _batch_get_month_tabs.
function readMonthTabs_(fileId) {
  const meta = Sheets.Spreadsheets.get(fileId, { fields: 'sheets.properties.title' });
  const titles = (meta.sheets || [])
    .map(function (s) { return s.properties.title; })
    .filter(isMonthTab_);
  if (!titles.length) return { titles: [], valuesByTitle: {} };
  const ranges = titles.map(function (t) { return quoted_(t) + '!A:J'; });
  const resp = Sheets.Spreadsheets.Values.batchGet(fileId, { ranges: ranges, majorDimension: 'ROWS' });
  const vr = resp.valueRanges || [];
  const valuesByTitle = {};
  titles.forEach(function (t, i) { valuesByTitle[t] = (vr[i] && vr[i].values) || []; });
  return { titles: titles, valuesByTitle: valuesByTitle };
}

// ------------------------------------------------------------------ central sheet
const SUMMARY_TABS = ['Summary_1', 'Summary_Rotation', 'Summary_5'];
const RAW_TAB_HEADER = ['Date show up', 'Month show up', 'Sub-con name', 'Name',
                        'Clock in', 'shift name', 'Shift_id', 'team'];

// find the spreadsheet titled exactly <year> in the central folder, or CREATE it
// (the standalone-script payoff: runs as the user, so create/move works where
// the service account's ~0-quota gc.create() failed).
function findOrCreateYearSheet_(folderId, year) {
  const folder = DriveApp.getFolderById(folderId);
  const it = folder.getFilesByName(String(year));
  const matches = [];
  while (it.hasNext()) matches.push(it.next());
  if (matches.length > 1) {
    throw new Error(matches.length + " files titled '" + year + "' in the central folder -- ambiguous");
  }
  if (matches.length === 1) return SpreadsheetApp.openById(matches[0].getId());
  const ss = SpreadsheetApp.create(String(year));
  const file = DriveApp.getFileById(ss.getId());
  folder.addFile(file);
  DriveApp.getRootFolder().removeFile(file);
  return ss;
}

// reset one year's central sheet to the 7-tab shape, clear all, write dept
// headers. Done once per year before any raw-row appends. Mirrors app.py
// _prepare_central.
function prepareCentral_(ss, departments) {
  const allTitles = departments.concat(SUMMARY_TABS);
  const keep = {};
  allTitles.forEach(function (t) { keep[t] = true; });

  const existing = {};
  ss.getSheets().forEach(function (sh) { existing[sh.getName()] = sh; });

  // ensure every target tab exists
  allTitles.forEach(function (t) {
    if (!existing[t]) existing[t] = ss.insertSheet(t);
  });
  // drop any stray tab (e.g. the default "Sheet1" on a freshly created sheet)
  // so the 7-tab shape never varies. Safe: the 7 keepers already exist.
  ss.getSheets().forEach(function (sh) {
    if (!keep[sh.getName()]) ss.deleteSheet(sh);
  });
  // clear all 7
  allTitles.forEach(function (t) { existing[t].clear(); });
  // dept headers (RAW so IDs are never reinterpreted)
  departments.forEach(function (d) {
    Sheets.Spreadsheets.Values.update(
      { values: [RAW_TAB_HEADER] }, ss.getId(), quoted_(d) + '!A1',
      { valueInputOption: 'RAW' });
  });
}

// append one vendor file's rows to a department tab (RAW, INSERT_ROWS auto-grows
// the grid). Mirrors app.py _append_dept_rows.
function appendDeptRows_(ss, dept, rows) {
  if (!rows.length) return;
  const values = rows.map(function (r) {
    return [
      r.date.key, blank_(r.month), blank_(r.vendor), blank_(r.name),
      blank_(r.clockin), blank_(r.shift_name), blank_(r.shift_id), blank_(r.team),
    ];
  });
  Sheets.Spreadsheets.Values.append(
    { values: values }, ss.getId(), quoted_(dept) + '!A1',
    { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' });
}

function blank_(v) { return v == null ? '' : v; }

// ------------------------------------------------------------------ summaries
// grid shapers (ported from n8n compute-tabs.js). numbers stay numbers so the
// summary tabs hold real numbers (USER_ENTERED), not apostrophe-prefixed text.
// NOTE: BUCKET_ORDER is derived from BUCKETS (defined in engine.gs) INSIDE the
// function, not at top level -- Apps Script shares one scope across .gs files
// but their top-level load order isn't guaranteed, so a cross-file const read
// at load time can hit BUCKETS in its temporal dead zone. Function bodies run
// at call time, after every file is loaded, so this is safe.
const ROTATION_COLS = ['month', 'team', 'population', 'rotation', 'non_rotation',
                       'oneday_nonrot', 'rotation%', 'non_rotation%', 'oneday%'];
const STREAK_COLS = ['month', 'active', '<10', '>10',
                     'usedto_<10', 'usedto_>10', 'never_<10', 'never_>10'];

function numCell_(v) { return v == null ? '' : v; }

function summary1Grid_(slim) {
  const bucketOrder = BUCKETS.map(function (b) { return b[0] + '-' + b[1]; }).concat(['Sum Month']);
  const res = showupBlock(slim);
  const counts = res.counts, pct = res.pct, monthLabels = res.monthLabels;
  const header = ['bucket'].concat(monthLabels, monthLabels.map(function (m) { return m + ' %'; }));
  const grid = [header];
  bucketOrder.forEach(function (b) {
    const row = [b];
    monthLabels.forEach(function (m) { row.push(numCell_(counts[b][m])); });
    monthLabels.forEach(function (m) { row.push(numCell_(pct[b][m])); });
    grid.push(row);
  });
  return grid;
}

function objRowsGrid_(objs, cols) {
  const grid = [cols.slice()];
  objs.forEach(function (o) { grid.push(cols.map(function (c) { return numCell_(o[c]); })); });
  return grid;
}

// write one summary tab as 4 stacked, labeled SOC sections. Each section is the
// SAME computation as before, scoped to that one department's slim slice. A
// department with no rows still emits its label + header (predictable shape).
function writeStacked_(ss, tabName, slim, departments, blockFn) {
  const grid = [];
  departments.forEach(function (dept) {
    const deptSlim = slim.filter(function (r) { return r.dept === dept; });
    grid.push([dept]);                          // section label
    blockFn(deptSlim).forEach(function (row) { grid.push(row); });
    grid.push([]);                              // spacer
  });
  writeGrid_(ss, tabName, grid);
}

function writeGrid_(ss, tabName, grid) {
  let width = 1;
  grid.forEach(function (r) { if (r.length > width) width = r.length; });
  const rect = grid.map(function (r) {
    const c = r.slice();
    while (c.length < width) c.push('');
    return c;
  });
  Sheets.Spreadsheets.Values.update(
    { values: rect }, ss.getId(), quoted_(tabName) + '!A1',
    { valueInputOption: 'USER_ENTERED' });
}

// ------------------------------------------------------------------ main sync
function sync() {
  const conf = cfg_();
  const files = discoverFiles_(conf.departments);

  // stream: per file, append its raw rows to the dept tab per year and release;
  // keep only the slim {name,date,team,dept} slice for the summaries.
  const yearData = {};   // year -> { ss, slim: [] }

  function yearCtx_(year) {
    if (!yearData[year]) {
      const ss = findOrCreateYearSheet_(conf.folderId, year);
      prepareCentral_(ss, conf.departments);
      yearData[year] = { ss: ss, slim: [] };
    }
    return yearData[year];
  }

  files.forEach(function (f) {
    const read = readMonthTabs_(f.id);
    if (!read.titles.length) {
      throw new Error("'" + f.name + "' (dept=" + f.dept + ", vendor=" + f.vendor +
        ") has no month tabs -- schema drift or an empty file");
    }
    const rowsByYear = {};
    read.titles.forEach(function (t) {
      const values = read.valuesByTitle[t];
      if (!values || !values.length) return;
      let cleaned;
      try {
        cleaned = loadRawFromValues(values);
      } catch (e) {
        throw new Error("'" + f.name + "' tab '" + t + "' (dept=" + f.dept +
          ", vendor=" + f.vendor + "): " + e.message);
      }
      cleaned.forEach(function (r) {
        r.dept = f.dept;
        r.vendor = f.vendor;
        const y = String(r.date.y);
        (rowsByYear[y] = rowsByYear[y] || []).push(r);
      });
    });
    Object.keys(rowsByYear).forEach(function (y) {
      const ctx = yearCtx_(y);
      const rows = rowsByYear[y];
      appendDeptRows_(ctx.ss, f.dept, rows);
      rows.forEach(function (r) {
        ctx.slim.push({ name: r.name, date: r.date, team: r.team, dept: r.dept });
      });
    });
  });

  // per year: write the 3 per-SOC summary tabs. The engine's prepare() (inside
  // each summary fn) throws on a duplicate (name,date) WITHIN a department --
  // the meaningful cross-vendor collision guard; the same name+date in two
  // different SOCs is fine, they're separate sections.
  const result = {};
  Object.keys(yearData).forEach(function (y) {
    const ctx = yearData[y];
    writeStacked_(ctx.ss, 'Summary_1', ctx.slim, conf.departments,
      function (s) { return summary1Grid_(s); });
    writeStacked_(ctx.ss, 'Summary_Rotation', ctx.slim, conf.departments,
      function (s) { return objRowsGrid_(rotationSummary(s), ROTATION_COLS); });
    writeStacked_(ctx.ss, 'Summary_5', ctx.slim, conf.departments,
      function (s) { return objRowsGrid_(streakMonthCrosstab(s), STREAK_COLS); });

    const names = {};
    ctx.slim.forEach(function (r) { names[r.name] = true; });
    result[y] = { spreadsheetId: ctx.ss.getId(), rows: ctx.slim.length,
                  workers: Object.keys(names).length };
  });

  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

// ------------------------------------------------------------------ ops helpers
// discover + clean, log counts, write NOTHING. Safe to run any time.
function dryRun() {
  const conf = cfg_();
  const files = discoverFiles_(conf.departments);
  const report = [];
  files.forEach(function (f) {
    const read = readMonthTabs_(f.id);
    let rows = 0;
    read.titles.forEach(function (t) {
      const v = read.valuesByTitle[t];
      if (v && v.length) {
        try { rows += loadRawFromValues(v).length; }
        catch (e) { throw new Error("'" + f.name + "' tab '" + t + "': " + e.message); }
      }
    });
    report.push({ name: f.name, dept: f.dept, vendor: f.vendor, tabs: read.titles.length, rows: rows });
  });
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

// test the yearly auto-create in isolation (make one, then delete it by hand).
function createYearSheet(year) {
  const conf = cfg_();
  const ss = findOrCreateYearSheet_(conf.folderId, String(year));
  Logger.log('Sheet id for ' + year + ': ' + ss.getId());
  return ss.getId();
}

// install (idempotently) the daily time-based trigger on sync().
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sync') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sync').timeBased().everyDays(1).atHour(11).create();
  Logger.log('Daily trigger installed (runs sync() ~11:00 in the project time zone).');
}
