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
    RAW_DEPARTMENTS: 'SOCN,SOCE,SOCW',
    SKIP_VENDORS: 'PPO,WAS,RG,YSL,BigBoom',
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
  // Vendors to skip entirely (an intentional, config-driven exclusion -- NOT the
  // silent auto-skip that caused the 7.3x undercount; a matched-but-skipped file
  // is logged, not dropped quietly). Compared case-insensitively on the vendor
  // token parsed from the title. Empty/unset = skip nothing.
  const skipRaw = props.getProperty('SKIP_VENDORS') || '';
  const skipVendors = {};
  skipRaw.split(',').map(function (s) { return s.trim().toUpperCase(); }).filter(Boolean)
    .forEach(function (v) { skipVendors[v] = true; });
  return { folderId: folderId, departments: departments, skipVendors: skipVendors };
}

// ------------------------------------------------------------------ discovery
const RAW_TITLE_RE = /^\[([A-Za-z]+)\s+(\d{4})\]_Daily name list_(.+)$/;

// mirrors render/app.py _list_raw_candidates + _parse_raw_title / n8n Parse Titles:
// a loose match that fails the strict pattern or has an unknown department is a
// HARD ERROR (silent-skip is what caused the original 7.3x undercount).
function discoverFiles_(knownDepts, skipVendors) {
  const known = {};
  knownDepts.forEach(function (d) { known[d] = true; });
  const skip = skipVendors || {};
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
    const vendor = m[3].trim();
    // config-driven skip (loud): drop excluded vendors before the dept check, so
    // a skipped vendor never has to have a recognized department. Logged, not silent.
    if (skip[vendor.toUpperCase()]) {
      Logger.log("SKIP vendor '" + vendor + "' -- '" + name + "' (in SKIP_VENDORS)");
      continue;
    }
    if (!known[dept]) {
      throw new Error("unrecognized department '" + dept + "' parsed from '" + name +
        "' -- expected one of " + JSON.stringify(Object.keys(known).sort()));
    }
    out.push({ id: f.getId(), name: name, dept: dept, year: m[2], vendor: vendor });
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

// the 2-digit year suffix of a month tab ("Dec 25" -> "25")
function monthTabYear_(title) { return String(title).trim().split(/\s+/)[1]; }

function quoted_(t) { return "'" + String(t).replace(/'/g, "''") + "'"; }

// retry an idempotent read through transient Google API errors (a live 404
// "Requested entity was not found" cleared on its own the next second -- Drive/
// Sheets eventual consistency). Reads only: safe to repeat. Backoff 1s/2s/4s.
function retryRead_(fn) {
  var lastErr;
  for (var attempt = 1; attempt <= 4; attempt++) {
    try { return fn(); }
    catch (e) {
      lastErr = e;
      if (attempt < 4) Utilities.sleep(1000 * Math.pow(2, attempt - 1));
    }
  }
  throw lastErr;
}

// read every month tab of one vendor file in a single batchGet, capped to A:J
// (only the first ~8 columns are used -- avoids junk/wide columns). Mirrors
// n8n Build Ranges + Batch Read and app.py _batch_get_month_tabs.
function readMonthTabs_(fileId, yearSuffix) {
  const meta = retryRead_(function () {
    return Sheets.Spreadsheets.get(fileId, { fields: 'sheets.properties.title' });
  });
  // Only this file's own year: a '[<DEPT> 2026]' file is scoped to 2026 by its
  // title, so read only its '... 26' tabs. An off-year tab (e.g. a leftover
  // 'Dec 25') belongs to a different year's file and can have stale/broken
  // structure -- confirmed live, PPO SOCW had a 'Dec 25' tab that broke header
  // detection. yearSuffix is the title's last two digits ('2026' -> '26').
  const titles = (meta.sheets || [])
    .map(function (s) { return s.properties.title; })
    .filter(function (t) { return isMonthTab_(t) && monthTabYear_(t) === yearSuffix; });
  if (!titles.length) return { titles: [], valuesByTitle: {} };
  const ranges = titles.map(function (t) { return quoted_(t) + '!A:J'; });
  const resp = retryRead_(function () {
    return Sheets.Spreadsheets.Values.batchGet(fileId, { ranges: ranges, majorDimension: 'ROWS' });
  });
  const vr = resp.valueRanges || [];
  const valuesByTitle = {};
  titles.forEach(function (t, i) { valuesByTitle[t] = (vr[i] && vr[i].values) || []; });
  return { titles: titles, valuesByTitle: valuesByTitle };
}

// ------------------------------------------------------------------ central sheets
// One spreadsheet PER SOC PER YEAR, titled "<YEAR>_<DEPT>" (e.g. "2026_SOCN"),
// each holding exactly 5 tabs: one "raw" tab + one tab per summary aspect. Each
// aspect gets its own tab (not stacked). ASPECT_TABS order = display order.
const RAW_TAB = 'raw';
const ASPECT_TABS = ['New-Old Face', 'Show Up', 'Consecutive', 'Rotation'];
const RAW_TAB_HEADER = ['Date show up', 'Month show up', 'Sub-con name', 'Name',
                        'Clock in', 'shift name', 'Shift_id', 'team'];

function socSheetTitle_(year, dept) { return String(year) + '_' + dept; }

// find the spreadsheet titled "<year>_<dept>" in the central folder, or CREATE it
// (the standalone-script payoff: runs as the user, so create/move works where
// the service account's ~0-quota gc.create() failed).
function findOrCreateSocSheet_(folderId, year, dept) {
  const folder = DriveApp.getFolderById(folderId);
  const title = socSheetTitle_(year, dept);
  const it = folder.getFilesByName(title);
  const matches = [];
  while (it.hasNext()) matches.push(it.next());
  if (matches.length > 1) {
    throw new Error(matches.length + " files titled '" + title + "' in the central folder -- ambiguous");
  }
  if (matches.length === 1) return SpreadsheetApp.openById(matches[0].getId());
  const ss = SpreadsheetApp.create(title);
  const file = DriveApp.getFileById(ss.getId());
  folder.addFile(file);
  DriveApp.getRootFolder().removeFile(file);
  return ss;
}

// reset one SOC sheet to the 5-tab shape (raw + 4 aspects), clear all, write the
// raw header. Done once per (year, dept) before any raw-row appends. IMPORTANT:
// uses ONLY the Advanced Sheets Service -- NOT SpreadsheetApp. Mixing the two on
// one spreadsheet corrupts the result: SpreadsheetApp buffers its writes and
// flushes them lazily (often at script end), so a SpreadsheetApp clear()/
// insertSheet can land AFTER the Advanced Service value writes and silently wipe
// them -- the "tabs present, all empty, no error" failure seen live. Everything
// on the write path is Advanced Service so ordering is deterministic.
function prepareSocSheet_(ss) {
  const id = ss.getId();
  SpreadsheetApp.flush();   // commit the create/move from findOrCreateSocSheet_ first
  const allTitles = [RAW_TAB].concat(ASPECT_TABS);
  const keep = {};
  allTitles.forEach(function (t) { keep[t] = true; });

  const meta = Sheets.Spreadsheets.get(id, { fields: 'sheets.properties(sheetId,title)' });
  const existing = {};   // title -> sheetId
  (meta.sheets || []).forEach(function (s) { existing[s.properties.title] = s.properties.sheetId; });

  // RESET every target tab to a small baseline grid. Clearing values does NOT
  // shrink a sheet's grid, so without this a tab grows every run and the workbook
  // eventually blows past the hard 10,000,000-cell limit (hit live). The raw tab
  // gets exactly the 8 header columns (values.append re-grows rows each run);
  // aspect tabs get a 1x1 baseline and writeSummaryTab_ resizes them to their
  // actual grid at write time (values.update does NOT auto-grow). Also self-heals
  // an already-bloated grid, since shrinking cells is always allowed.
  function gridFor_(t) {
    return t === RAW_TAB
      ? { rowCount: 1, columnCount: RAW_TAB_HEADER.length }
      : { rowCount: 1, columnCount: 1 };
  }
  // one batchUpdate: add missing tabs (sized), resize existing tabs, then delete
  // strays (default "Sheet1", any old layout). Adds/updates precede deletes so we
  // never delete the last remaining sheet.
  const requests = [];
  allTitles.forEach(function (t) {
    if (t in existing) {
      requests.push({ updateSheetProperties: {
        properties: { sheetId: existing[t], gridProperties: gridFor_(t) },
        fields: 'gridProperties.rowCount,gridProperties.columnCount',
      } });
    } else {
      requests.push({ addSheet: { properties: { title: t, gridProperties: gridFor_(t) } } });
    }
  });
  Object.keys(existing).forEach(function (t) {
    if (!keep[t]) requests.push({ deleteSheet: { sheetId: existing[t] } });
  });
  if (requests.length) Sheets.Spreadsheets.batchUpdate({ requests: requests }, id);

  // clear all tabs, then write the raw header (RAW so IDs aren't reinterpreted)
  Sheets.Spreadsheets.Values.batchClear({ ranges: allTitles.map(quoted_) }, id);
  Sheets.Spreadsheets.Values.batchUpdate({
    valueInputOption: 'RAW',
    data: [{ range: quoted_(RAW_TAB) + '!A1', values: [RAW_TAB_HEADER] }],
  }, id);

  // re-fetch to capture sheetIds of any just-added tabs (needed to resize the
  // aspect tabs at write time).
  const meta2 = Sheets.Spreadsheets.get(id, { fields: 'sheets.properties(sheetId,title)' });
  const sheetIds = {};
  (meta2.sheets || []).forEach(function (s) { sheetIds[s.properties.title] = s.properties.sheetId; });
  return sheetIds;
}

// append cleaned rows to this SOC sheet's single "raw" tab (RAW, INSERT_ROWS
// auto-grows the grid). Called once per vendor file feeding this SOC.
function appendRawRows_(ss, rows) {
  if (!rows.length) return;
  const values = rows.map(function (r) {
    return [
      r.date.key, blank_(r.month), blank_(r.vendor), blank_(r.name),
      blank_(r.clockin), blank_(r.shift_name), blank_(r.shift_id), blank_(r.team),
    ];
  });
  Sheets.Spreadsheets.Values.append(
    { values: values }, ss.getId(), quoted_(RAW_TAB) + '!A1',
    { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' });
}

function blank_(v) { return v == null ? '' : v; }

// ------------------------------------------------------------------ summaries
// One tab PER SOC ("<DEPT> Summary"), stacking the 4 aspects (New/Old face, Show
// up, 3-day consecutive, Rotation) grouped by team, at the grains the slide uses:
// monthly (primary) + weekly (consecutive p8, rotation) + a shared weekly/daily
// attendance headcount (the day/week grain for the inherently-monthly aspects).
// numbers stay numbers so the tab holds real numbers (USER_ENTERED). Engine
// functions (showupBlock, newOldMonthly, rotationSummary, streakMonthCrosstab,
// streakWeek, attendanceCrosstab, distinctTeams) and BUCKETS come from engine.gs
// -- read INSIDE functions, never at top level, since cross-file const load order
// isn't guaranteed (BUCKETS could be in its temporal dead zone at load time).
const ROTATION_COLS = ['month', 'team', 'population', 'rotation', 'non_rotation',
                       'oneday_nonrot', 'rotation%', 'non_rotation%', 'oneday%'];
const STREAK_COLS = ['month', 'active', '<10', '>10',
                     'usedto_<10', 'usedto_>10', 'never_<10', 'never_>10'];

function numCell_(v) { return v == null ? '' : v; }

// wide count+% block for Show up (rows = buckets + Sum, cols = months then %).
function showupGrid_(slim) {
  const bucketOrder = BUCKETS.map(function (b) { return b[0] + '-' + b[1]; }).concat(['Sum Month']);
  const res = showupBlock(slim);
  const ml = res.monthLabels;
  const grid = [['bucket'].concat(ml, ml.map(function (m) { return m + ' %'; }))];
  bucketOrder.forEach(function (b) {
    const row = [b];
    ml.forEach(function (m) { row.push(numCell_(res.counts[b][m])); });
    ml.forEach(function (m) { row.push(numCell_(res.pct[b][m])); });
    grid.push(row);
  });
  return grid;
}

// wide New/Old block (rows Old, New counts then Old %, New %, cols = months).
function newOldGrid_(slim) {
  const res = newOldMonthly(slim);
  const ml = res.monthLabels;
  const grid = [['face'].concat(ml, ml.map(function (m) { return m + ' %'; }))];
  ['Old', 'New'].forEach(function (f) {
    const row = [f];
    ml.forEach(function (m) { row.push(numCell_(res.counts[f][m])); });
    ml.forEach(function (m) { row.push(numCell_(res.pct[f + ' %'][m])); });
    grid.push(row);
  });
  return grid;
}

function objRowsGrid_(objs, cols) {
  const grid = [cols.slice()];
  objs.forEach(function (o) { grid.push(cols.map(function (c) { return numCell_(o[c]); })); });
  return grid;
}

// weekly consecutive as metric rows x week cols (slide p8 orientation).
function streakWeekGrid_(slim, team) {
  const wk = streakWeek(slim, team);
  const weeks = wk.map(function (r) { return r.week; });
  const grid = [['metric'].concat(weeks)];
  ['active', '>=3', '<3', '>=3%'].forEach(function (metric) {
    grid.push([metric].concat(wk.map(function (r) { return numCell_(r[metric]); })));
  });
  return grid;
}

// attendance headcount: All + per-team rows x period (day|week) cols.
function attendanceGrid_(slim, period) {
  const res = attendanceCrosstab(slim, period);
  const pl = res.periodLabels;
  const grid = [['team'].concat(pl)];
  grid.push(['All'].concat(pl.map(function (p) { return numCell_(res.allRow[p]); })));
  res.teams.forEach(function (t) {
    grid.push([t].concat(pl.map(function (p) { return numCell_(res.counts[t][p]); })));
  });
  return grid;
}

// Each aspect is its OWN tab. A tab stacks the aspect at monthly / weekly / daily
// grain, grouped by team. Where the metric is inherently monthly (buckets,
// new/old), the weekly/daily grain is the attendance headcount (distinct workers
// present per week/day, per team) -- the shared non-degenerate day/week view.
// gridAppender_ returns a {push,label,spacer,byTeam,grid} builder over one grid.
function gridBuilder_(slim) {
  const grid = [];
  return {
    grid: grid,
    push: function (rows) { rows.forEach(function (r) { grid.push(r); }); },
    label: function (t) { grid.push([t]); },
    spacer: function () { grid.push([]); },
    byTeam: function (fn) {
      distinctTeams(slim).forEach(function (t) {
        grid.push(['  team: ' + t]);
        fn(slim.filter(function (r) { return r.team === t; })).forEach(function (r) { grid.push(r); });
      });
    },
  };
}

// shared weekly + daily attendance headcount block (the day/week grain).
function attendanceBlock_(b, slim) {
  b.spacer();
  b.label('WEEKLY  (attendance headcount by team)');
  b.push(attendanceGrid_(slim, 'week'));
  b.spacer();
  b.label('DAILY  (attendance headcount by team)');
  b.push(attendanceGrid_(slim, 'day'));
}

function newOldTabGrid_(slim) {
  const b = gridBuilder_(slim);
  if (!slim.length) return [['(no rows for this SOC)']];
  b.label('NEW / OLD FACE  (monthly; Old = >=10 days at one station)');
  b.push(newOldGrid_(slim));
  b.byTeam(newOldGrid_);
  attendanceBlock_(b, slim);
  return b.grid;
}

function showUpTabGrid_(slim) {
  const b = gridBuilder_(slim);
  if (!slim.length) return [['(no rows for this SOC)']];
  b.label('SHOW UP  (monthly; day-count buckets)');
  b.push(showupGrid_(slim));
  b.byTeam(showupGrid_);
  attendanceBlock_(b, slim);
  return b.grid;
}

function consecutiveTabGrid_(slim) {
  const b = gridBuilder_(slim);
  if (!slim.length) return [['(no rows for this SOC)']];
  b.label('3-DAY CONSECUTIVE  (monthly)');
  b.push(objRowsGrid_(streakMonthCrosstab(slim), STREAK_COLS));
  distinctTeams(slim).forEach(function (t) {
    b.grid.push(['  team: ' + t]);
    objRowsGrid_(streakMonthCrosstab(slim, t), STREAK_COLS).forEach(function (r) { b.grid.push(r); });
  });
  b.spacer();
  b.label('3-DAY CONSECUTIVE  (weekly; >=3 consecutive)');
  b.push(streakWeekGrid_(slim));
  b.byTeam(function (s) { return streakWeekGrid_(s); });
  b.spacer();
  b.label('DAILY  (attendance headcount by team)');
  b.push(attendanceGrid_(slim, 'day'));
  return b.grid;
}

function rotationTabGrid_(slim) {
  const b = gridBuilder_(slim);
  if (!slim.length) return [['(no rows for this SOC)']];
  b.label('ROTATION  (monthly; per team)');
  b.push(objRowsGrid_(rotationSummary(slim), ROTATION_COLS));
  b.spacer();
  b.label('ROTATION  (weekly; per team)');
  b.push(objRowsGrid_(rotationSummary(slim, 'week'), ROTATION_COLS));
  b.spacer();
  b.label('DAILY  (attendance headcount by team)');
  b.push(attendanceGrid_(slim, 'day'));
  return b.grid;
}

// aspect tab name -> its grid builder, in ASPECT_TABS order.
function aspectGridFor_(tabName, slim) {
  if (tabName === 'New-Old Face') return newOldTabGrid_(slim);
  if (tabName === 'Show Up') return showUpTabGrid_(slim);
  if (tabName === 'Consecutive') return consecutiveTabGrid_(slim);
  if (tabName === 'Rotation') return rotationTabGrid_(slim);
  throw new Error('unknown aspect tab: ' + tabName);
}

// collapse to one row per (name, date), keeping the earliest clock-in (garbled/
// missing sorts last) -- the same rule cleanRaw uses within a single tab, here
// applied across a vendor's tabs. Month-boundary overlap: a 'Mar 26' tab and an
// 'Apr 26' tab can both carry the same Apr-1 show-up (confirmed live, SPT).
// Worker names are vendor-prefixed, so (name,date) never collides across vendors.
// SEP + parseClockMinutes come from engine.gs (global at call time).
function dedupByNameDate_(rows) {
  const withClock = rows.map(function (r, i) {
    return { r: r, c: parseClockMinutes(r.clockin == null ? '' : r.clockin), i: i };
  });
  withClock.sort(function (a, b) {
    const ca = a.c == null ? Infinity : a.c, cb = b.c == null ? Infinity : b.c;
    return ca !== cb ? ca - cb : a.i - b.i;
  });
  const seen = {};
  const out = [];
  for (var j = 0; j < withClock.length; j++) {
    const k = withClock[j].r.name + SEP + withClock[j].r.date.key;
    if (seen[k]) continue;
    seen[k] = true;
    out.push(withClock[j].r);
  }
  return out;
}

// resize a summary tab to its actual grid, then write it. values.update (unlike
// values.append) does NOT auto-grow, so the grid must be sized first; sizing to
// exactly the content also keeps the workbook well under the 10M-cell cap (the
// daily-attendance section makes some tabs wide -- one column per calendar day).
function writeSummaryTab_(ss, sheetId, tabName, grid) {
  let width = 1;
  grid.forEach(function (r) { if (r.length > width) width = r.length; });
  const rect = grid.map(function (r) {
    const c = r.slice();
    while (c.length < width) c.push('');
    return c;
  });
  const rows = Math.max(1, rect.length);
  Sheets.Spreadsheets.batchUpdate({ requests: [{ updateSheetProperties: {
    properties: { sheetId: sheetId, gridProperties: { rowCount: rows, columnCount: width } },
    fields: 'gridProperties.rowCount,gridProperties.columnCount',
  } }] }, ss.getId());
  Sheets.Spreadsheets.Values.update(
    { values: rect }, ss.getId(), quoted_(tabName) + '!A1',
    { valueInputOption: 'USER_ENTERED' });
}

// ------------------------------------------------------------------ main sync
function sync() {
  const conf = cfg_();
  const files = discoverFiles_(conf.departments, conf.skipVendors);

  // stream: per file, append its raw rows to that (year, dept) sheet's raw tab and
  // release; keep only the slim {name,date,team,clockin} slice for the summaries.
  // One spreadsheet per (year, dept), keyed "<year><dept>".
  const socData = {};

  function socCtx_(year, dept) {
    const k = year + SEP + dept;
    if (!socData[k]) {
      const ss = findOrCreateSocSheet_(conf.folderId, year, dept);
      const sheetIds = prepareSocSheet_(ss);
      socData[k] = { ss: ss, sheetIds: sheetIds, slim: [], year: year, dept: dept };
    }
    return socData[k];
  }

  files.forEach(function (f) {
    const read = readMonthTabs_(f.id, f.year.slice(-2));
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
      if (cleaned.droppedNoDate) {
        Logger.log("dropped " + cleaned.droppedNoDate + " undated row(s) in '" +
          f.name + "' tab '" + t + "' (no date in either column)");
      }
      cleaned.forEach(function (r) {
        r.vendor = f.vendor;
        const y = String(r.date.y);
        (rowsByYear[y] = rowsByYear[y] || []).push(r);
      });
    });
    Object.keys(rowsByYear).forEach(function (y) {
      const ctx = socCtx_(y, f.dept);
      // dedup one row per (name,date) across THIS file's tabs before writing the
      // raw tab -- month-boundary overlap (a 'Mar 26' tab carrying the same Apr-1
      // show-up as 'Apr 26', confirmed live for SPT). Keeps earliest clock-in.
      const rows = dedupByNameDate_(rowsByYear[y]);
      appendRawRows_(ctx.ss, rows);
      rows.forEach(function (r) {
        ctx.slim.push({ name: r.name, date: r.date, team: r.team, clockin: r.clockin });
      });
    });
  });

  // per (year, dept): dedup the slim slice, then write the 4 aspect tabs into that
  // SOC's own spreadsheet. Per-file dedup above already removes within-vendor
  // overlap; this final dedup guarantees the engine's one-row-per-(name,date)
  // contract before the summaries.
  const result = {};
  Object.keys(socData).forEach(function (k) {
    const ctx = socData[k];
    const slim = dedupByNameDate_(ctx.slim);
    ASPECT_TABS.forEach(function (tab) {
      writeSummaryTab_(ctx.ss, ctx.sheetIds[tab], tab, aspectGridFor_(tab, slim));
    });
    const names = {};
    slim.forEach(function (r) { names[r.name] = true; });
    result[socSheetTitle_(ctx.year, ctx.dept)] = {
      spreadsheetId: ctx.ss.getId(), rows: slim.length, workers: Object.keys(names).length };
  });

  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

// ------------------------------------------------------------------ ops helpers
// discover + clean, log counts, write NOTHING. Safe to run any time.
function dryRun() {
  const conf = cfg_();
  const files = discoverFiles_(conf.departments, conf.skipVendors);
  const report = [];
  files.forEach(function (f) {
    const read = readMonthTabs_(f.id, f.year.slice(-2));
    let rows = 0;
    read.titles.forEach(function (t) {
      const v = read.valuesByTitle[t];
      if (v && v.length) {
        let cleaned;
        try { cleaned = loadRawFromValues(v); }
        catch (e) { throw new Error("'" + f.name + "' tab '" + t + "': " + e.message); }
        rows += cleaned.length;
        if (cleaned.droppedNoDate) {
          Logger.log("dropped " + cleaned.droppedNoDate + " undated row(s) in '" +
            f.name + "' tab '" + t + "' (no date in either column)");
        }
      }
    });
    report.push({ name: f.name, dept: f.dept, vendor: f.vendor, tabs: read.titles.length, rows: rows });
  });
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

// dump the first N rows of one vendor's tab so a header/schema problem can be
// SEEN before guessing a fix. vendorHint/tabHint are case-insensitive substrings.
function debugHeaderRows(vendorHint, tabHint, nRows) {
  const conf = cfg_();
  const files = discoverFiles_(conf.departments, conf.skipVendors);
  const f = files.filter(function (x) {
    return x.vendor.toLowerCase().indexOf(String(vendorHint).toLowerCase()) >= 0;
  })[0];
  if (!f) { Logger.log('no file matching vendor ' + vendorHint); return; }
  const meta = retryRead_(function () {
    return Sheets.Spreadsheets.get(f.id, { fields: 'sheets.properties.title' });
  });
  const title = (meta.sheets || []).map(function (s) { return s.properties.title; })
    .filter(function (t) { return t.toLowerCase().indexOf(String(tabHint).toLowerCase()) >= 0; })[0];
  if (!title) { Logger.log('no tab matching ' + tabHint + ' in ' + f.name); return; }
  const resp = retryRead_(function () {
    return Sheets.Spreadsheets.Values.get(f.id, quoted_(title) + '!A1:J' + (nRows || 5));
  });
  const rows = resp.values || [];
  Logger.log(f.name + ' | tab ' + title);
  rows.forEach(function (r, i) { Logger.log('row ' + i + ': ' + JSON.stringify(r)); });
  return rows;
}

// zero-arg wrapper (the Run button can't pass args) -- dumps DSR 'Jan 26'.
function debugDSR() { return debugHeaderRows('DSR', 'Jan 26', 5); }

// for one vendor/tab: report the shift name -> team mapping observed among rows
// that HAVE a team, and how many rows are MISSING a team per shift name. Shows
// exactly why a backfill is ambiguous (which teams a shift maps to) before deciding.
function debugShiftTeam(vendorHint, tabHint, deptHint) {
  const conf = cfg_();
  const files = discoverFiles_(conf.departments, conf.skipVendors);
  const f = files.filter(function (x) {
    return x.vendor.toLowerCase().indexOf(String(vendorHint).toLowerCase()) >= 0 &&
      (!deptHint || x.dept === String(deptHint).toUpperCase());
  })[0];
  if (!f) { Logger.log('no file matching vendor ' + vendorHint + ' dept ' + deptHint); return; }
  const meta = retryRead_(function () {
    return Sheets.Spreadsheets.get(f.id, { fields: 'sheets.properties.title' });
  });
  const title = (meta.sheets || []).map(function (s) { return s.properties.title; })
    .filter(function (t) { return t.toLowerCase().indexOf(String(tabHint).toLowerCase()) >= 0; })[0];
  if (!title) { Logger.log('no tab ' + tabHint + ' in ' + f.name); return; }
  const resp = retryRead_(function () {
    return Sheets.Spreadsheets.Values.get(f.id, quoted_(title) + '!A:J');
  });
  const objs = rowsToRawObjects(resp.values || []);
  const haveTeam = {};   // shift -> {team: count}
  const needTeam = {};   // shift -> count of blank-team rows
  objs.forEach(function (r) {
    const shift = r['shift name'] == null ? '(blank)' : String(r['shift name']).trim();
    const team = clearSentinel(r['team']);
    if (team == null) { needTeam[shift] = (needTeam[shift] || 0) + 1; return; }
    (haveTeam[shift] = haveTeam[shift] || {})[team] = (haveTeam[shift][team] || 0) + 1;
  });
  Logger.log(f.name + ' | tab ' + title);
  Logger.log('shift name -> teams seen (among rows WITH a team):');
  Object.keys(haveTeam).sort().forEach(function (s) {
    Logger.log('  ' + JSON.stringify(s) + ' -> ' + JSON.stringify(haveTeam[s]));
  });
  Logger.log('rows MISSING team, by shift name:');
  Object.keys(needTeam).sort().forEach(function (s) {
    Logger.log('  ' + JSON.stringify(s) + ' -> ' + needTeam[s] + ' row(s)');
  });
}

function debugSPT() { return debugShiftTeam('SPT', 'Jul 26', 'SOCW'); }

// dump the rows whose BOTH date columns fail to parse, with the raw contents of
// every field -- so a "no usable date" throw can be diagnosed (what's actually
// in วันที่ / วันที่.1) before deciding how to handle it.
function debugBadDates(vendorHint, tabHint, deptHint) {
  const conf = cfg_();
  const files = discoverFiles_(conf.departments, conf.skipVendors);
  const f = files.filter(function (x) {
    return x.vendor.toLowerCase().indexOf(String(vendorHint).toLowerCase()) >= 0 &&
      (!deptHint || x.dept === String(deptHint).toUpperCase());
  })[0];
  if (!f) { Logger.log('no file matching vendor ' + vendorHint + ' dept ' + deptHint); return; }
  const meta = retryRead_(function () {
    return Sheets.Spreadsheets.get(f.id, { fields: 'sheets.properties.title' });
  });
  const title = (meta.sheets || []).map(function (s) { return s.properties.title; })
    .filter(function (t) { return t.toLowerCase().indexOf(String(tabHint).toLowerCase()) >= 0; })[0];
  if (!title) { Logger.log('no tab ' + tabHint + ' in ' + f.name); return; }
  const resp = retryRead_(function () {
    return Sheets.Spreadsheets.Values.get(f.id, quoted_(title) + '!A:J');
  });
  const objs = rowsToRawObjects(resp.values || []);
  const bad = [];
  objs.forEach(function (r) {
    if (r['ค้นหา'] == null || r['ค้นหา'] === 'ค้นหา') return;   // must have a real name
    const d1 = dateCell(r['วันที่'], parseDayFirst);
    const d2 = dateCell(r['วันที่.1'], parseISO);
    if (!d1 && !d2) bad.push(r);
  });
  Logger.log(f.name + ' | tab ' + title + ' | bad-date rows: ' + bad.length);
  bad.slice(0, 12).forEach(function (r, i) {
    Logger.log(i + ': วันที่=' + JSON.stringify(r['วันที่']) + ' | วันที่.1=' + JSON.stringify(r['วันที่.1']) +
      ' | name=' + JSON.stringify(r['ค้นหา']) + ' | clock=' + JSON.stringify(r['เข้างาน']) +
      ' | shift=' + JSON.stringify(r['shift name']) + ' | Shift_id=' + JSON.stringify(r['Shift_id']) +
      ' | team=' + JSON.stringify(r['team']));
  });
}

function debugPNK() { return debugBadDates('PNK', 'Jul 26', 'SOCN'); }

// test the auto-create in isolation (makes one SOC sheet, then delete it by hand).
function createYearSheet(year) {
  const conf = cfg_();
  const dept = conf.departments[0];
  const ss = findOrCreateSocSheet_(conf.folderId, String(year), dept);
  Logger.log('Sheet id for ' + socSheetTitle_(year, dept) + ': ' + ss.getId());
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
