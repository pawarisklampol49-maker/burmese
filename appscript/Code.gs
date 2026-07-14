/**
 * SOC worker-analysis sync -- standalone Google Apps Script.
 *
 * This is the whole automation: it discovers the vendor spreadsheets, cleans
 * every month tab with the shared engine (engine.gs), and writes, per SOC per
 * year, a main results file "<YEAR>_<DEPT>" (raw tab + 4 aspect summary tabs) and
 * a separate drill-down file "<YEAR>_<DEPT>_Names". It replaces the Render service
 * and the n8n workflow: everything runs inside Google, so the vendor data never
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

// retry an idempotent WRITE through transient Google API errors -- live runs hit
// "Internal error encountered" (a 500) on values.update mid-sync. Every write here
// targets a fixed range with fixed data (or a fixed grid resize), so repeating it
// is safe. Backoff 2s/4s/8s (a touch longer than reads -- writes are heavier and
// the 500s tend to be brief server hiccups). A truly fatal error (e.g. the 10M cap)
// just exhausts the 4 tries and re-throws, same message.
function retryWrite_(fn) {
  var lastErr;
  for (var attempt = 1; attempt <= 4; attempt++) {
    try { return fn(); }
    catch (e) {
      lastErr = e;
      if (attempt < 4) Utilities.sleep(2000 * Math.pow(2, attempt - 1));
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
// Per SOC per year, in the central folder:
//   - "<YEAR>_<DEPT>"                  (e.g. "2026_SOCN") -- the main results file,
//     5 tabs: "raw" + one per aspect.
//   - "<YEAR>_<DEPT>_<ASPECT>_Names"   (e.g. "2026_SOCN_ShowUp_Names") -- ONE
//     drill-down file PER ASPECT (4 of them), each a single "Names" tab.
// The drill-down detail is split into SEPARATE spreadsheet files because Google's
// 10,000,000-cell cap is PER WORKBOOK (shared across all tabs, NOT per tab). The
// detail is large -- each counted person is a full 8-column raw row, and every
// number is drillable at both the "All" scope and each team -- so a single detail
// file overflowed the cap live. One file PER ASPECT gives each aspect its own 10M
// budget (splitting into per-aspect *tabs* in one file would NOT help: same shared
// budget). Every count in an aspect tab is a cross-file =HYPERLINK (full URL) that
// opens that aspect's Names file at the number's block -- the full 8 raw columns,
// one row per counted person, groups 2 blank rows apart.
const RAW_TAB = 'raw';
const ASPECT_TABS = ['New-Old Face', 'Show Up', 'Consecutive', 'Rotation'];
const SOC_TABS = [RAW_TAB].concat(ASPECT_TABS);   // the main file's 5 tabs
const NAMES_TAB = 'Names';                        // the sole tab in each Names file
// aspect tab -> filename token for its drill-down file (no spaces/punctuation).
const ASPECT_NAME_SUFFIX = {
  'New-Old Face': 'NewOld', 'Show Up': 'ShowUp', 'Consecutive': 'Consecutive', 'Rotation': 'Rotation',
};
const RAW_TAB_HEADER = ['Date show up', 'Month show up', 'Sub-con name', 'Name',
                        'Clock in', 'shift name', 'Shift_id', 'team'];

function socSheetTitle_(year, dept) { return String(year) + '_' + dept; }
function socNamesTitle_(year, dept, suffix) { return socSheetTitle_(year, dept) + '_' + suffix + '_Names'; }

// find the spreadsheet with this exact title in the central folder, or CREATE it
// (the standalone-script payoff: runs as the user, so create/move works where
// the service account's ~0-quota gc.create() failed).
function findOrCreateSheet_(folderId, title) {
  const folder = DriveApp.getFolderById(folderId);
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
  SpreadsheetApp.flush();   // commit the create/move from findOrCreateSheet_ first
  const allTitles = SOC_TABS.slice();   // raw + 4 aspects (the Names file is separate)
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

// reset the separate Names file to a single "Names" tab (baseline grid, cleared),
// deleting any strays (default "Sheet1", old layout). Same Advanced-Sheets-only
// discipline as prepareSocSheet_. Returns the Names tab's sheetId (gid), needed to
// build the cross-file =HYPERLINK targets. writeSummaryTab_ resizes it at write time.
function prepareNamesSheet_(ss) {
  const id = ss.getId();
  SpreadsheetApp.flush();   // commit the create/move first
  const meta = Sheets.Spreadsheets.get(id, { fields: 'sheets.properties(sheetId,title)' });
  const existing = {};
  (meta.sheets || []).forEach(function (s) { existing[s.properties.title] = s.properties.sheetId; });

  const requests = [];
  if (NAMES_TAB in existing) {
    requests.push({ updateSheetProperties: {
      properties: { sheetId: existing[NAMES_TAB], gridProperties: { rowCount: 1, columnCount: 1 } },
      fields: 'gridProperties.rowCount,gridProperties.columnCount',
    } });
  } else {
    requests.push({ addSheet: { properties: { title: NAMES_TAB, gridProperties: { rowCount: 1, columnCount: 1 } } } });
  }
  Object.keys(existing).forEach(function (t) {
    if (t !== NAMES_TAB) requests.push({ deleteSheet: { sheetId: existing[t] } });
  });
  if (requests.length) Sheets.Spreadsheets.batchUpdate({ requests: requests }, id);
  Sheets.Spreadsheets.Values.batchClear({ ranges: [quoted_(NAMES_TAB)] }, id);

  const meta2 = Sheets.Spreadsheets.get(id, { fields: 'sheets.properties(sheetId,title)' });
  let gid = null;
  (meta2.sheets || []).forEach(function (s) { if (s.properties.title === NAMES_TAB) gid = s.properties.sheetId; });
  return gid;
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
// One tab PER ASPECT (monthly for all; Consecutive & Rotation also weekly; Show Up
// also carries a daily head-count block, the one metric meaningful per day). Every
// COUNT is a =HYPERLINK that jumps to the people behind it, listed in the Names tab
// (the drill-down). Members are one REPRESENTATIVE raw row per counted person and
// come from the engine's *Members functions, asserted (self-tests) to match the
// counts. Engine globals (showupMembers, newOldMembers, streakMonthMembers,
// streakWeekMembers, rotationMembers, attendanceMembers, distinctTeams, monthLabel,
// round2, BUCKETS) come from engine.gs -- read INSIDE functions, never at top level
// (cross-file const load order isn't guaranteed). No daily view for the bucket/
// rotation/consecutive aspects: those can't run on a single day.

// chronological month labels present in the slice ("2026-03" sorts, then -> "Mar").
function monthOrder_(slim) {
  const seen = {};
  slim.forEach(function (r) { seen[r.date.month] = true; });
  return Object.keys(seen).sort().map(monthLabel);
}

// The Names tab collector, shared across all 4 aspect tabs of one SOC. Each count
// registers its group ONCE (header + names, single column) and every summary cell
// that references it links to the same block. link() returns the HYPERLINK string
// (or a plain 0 for an empty count, no link). Groups accrue in first-seen order;
// their Names-tab row is known immediately, so no backfill is needed.
// one member rendered as the 8 raw columns (same mapping appendRawRows_ uses), so
// the drill-down shows the full raw context, not a bare name. Members are engine
// row objects carrying {date, month, vendor, name, clockin, shift_name, shift_id,
// team} -- the slim slice is widened in sync() to include all of these.
function rawRowCells_(r) {
  return [r.date.key, blank_(r.month), blank_(r.vendor), blank_(r.name),
          blank_(r.clockin), blank_(r.shift_name), blank_(r.shift_id), blank_(r.team)];
}

function namesCollector_(namesFileId, namesGid) {
  const rows = [['DETAIL -- the people behind each number (opened by clicking a count in a summary tab)']];
  const keyToRow = {};
  // cross-file link: the detail lives in a SEPARATE spreadsheet (its own 10M
  // budget), so this is a full-URL HYPERLINK to that file's Names tab at the
  // group's row, not an in-workbook "#gid" anchor. Clicking opens the Names file.
  const base = 'https://docs.google.com/spreadsheets/d/' + namesFileId + '/edit#gid=' + namesGid + '&range=A';
  return {
    rows: rows,
    // members: engine ROW objects (one per counted person), so the row count in
    // the block equals the number clicked. Each group is: a title row (the
    // HYPERLINK target), the raw-column header, one row per member, then 2 blank
    // rows separating it from the next group.
    link: function (count, key, title, members) {
      if (!count) return 0;
      if (!(key in keyToRow)) {
        keyToRow[key] = rows.length + 1;           // 1-based title row (the link target)
        rows.push([title + '  (' + members.length + ')']);
        rows.push(RAW_TAB_HEADER.slice());
        members.forEach(function (m) { rows.push(rawRowCells_(m)); });
        rows.push([]);
        rows.push([]);
      }
      return '=HYPERLINK("' + base + keyToRow[key] + '",' + count + ')';
    },
  };
}

// percent cell WITH a "%" sign. Written USER_ENTERED, so "45.11%" lands as a real
// percentage number (Sheets stores 0.4511, displays 45.11%). Blank when den == 0.
function pctCell_(num, den) { return den ? round2(num / den * 100) + '%' : ''; }

// ---- Show up (monthly day-count buckets) ------------------------------------
function renderShowup_(grid, nc, slim, scope, mem, months) {
  const buckets = BUCKETS.map(function (b) { return b[0] + '-' + b[1]; });
  grid.push([scope]);
  grid.push(['bucket'].concat(months, months.map(function (m) { return m + ' %'; })));
  const sums = {};
  months.forEach(function (m) {
    var s = 0; buckets.forEach(function (bk) { s += ((mem[m] && mem[m][bk]) || []).length; }); sums[m] = s;
  });
  buckets.forEach(function (bk) {
    const row = [bk];
    months.forEach(function (m) {
      const names = (mem[m] && mem[m][bk]) || [];
      row.push(nc.link(names.length, scope + '|showup|' + m + '|' + bk,
        'Show up | ' + m + ' | ' + bk + ' days | ' + scope, names));
    });
    months.forEach(function (m) { row.push(pctCell_(((mem[m] && mem[m][bk]) || []).length, sums[m])); });
    grid.push(row);
  });
  const sumRow = ['Sum Month'];
  months.forEach(function (m) {
    var names = []; buckets.forEach(function (bk) { names = names.concat((mem[m] && mem[m][bk]) || []); });
    sumRow.push(nc.link(names.length, scope + '|showup|' + m + '|sum',
      'Show up | ' + m + ' | all buckets | ' + scope, names));
  });
  months.forEach(function () { sumRow.push('100%'); });
  grid.push(sumRow);
  grid.push([]);
}

// Daily head count: distinct workers present each day, per team + an All row.
// The one metric that's meaningful at the daily grain (buckets/rotation/streaks
// can't run on a single day). PLAIN COUNTS, not clickable: a per-person daily
// drill-down copies ~2x the entire raw log (one block per day x team, plus per
// day x All) and overflows even a dedicated Names file's 10M-cell cap (hit live).
// The daily roster is already the raw tab, filtered by date -- no drill-down needed.
function renderHeadcount_(grid, slim) {
  const ct = attendanceCrosstab(slim, 'day');           // {teams, periodLabels, counts, allRow}
  const days = ct.periodLabels;                          // sorted YYYY-MM-DD
  grid.push(['DAILY HEAD COUNT  (distinct workers present each day -- plain counts; the daily roster is the raw tab, filtered by date)'], []);
  grid.push(['team'].concat(days));
  ct.teams.forEach(function (t) {
    const row = ['team ' + t];
    days.forEach(function (d) { row.push((ct.counts[t] && ct.counts[t][d]) || 0); });
    grid.push(row);
  });
  const allRow = ['All'];
  days.forEach(function (d) { allRow.push(ct.allRow[d] || 0); });
  grid.push(allRow);
  grid.push([]);
}

function showUpTabGrid_(slim, nc) {
  if (!slim.length) return [['(no rows for this SOC)']];
  const grid = [['SHOW UP  (monthly day-count buckets; click a number to see those people)'], []];
  const months = monthOrder_(slim);
  renderShowup_(grid, nc, slim, 'All', showupMembers(slim), months);
  distinctTeams(slim).forEach(function (t) {
    renderShowup_(grid, nc, slim, 'team ' + t, showupMembers(slim, t), months);
  });
  renderHeadcount_(grid, slim);
  return grid;
}

// ---- New / Old face (monthly) -----------------------------------------------
function renderNewOld_(grid, nc, scope, mem, months) {
  grid.push([scope]);
  grid.push(['face'].concat(months, months.map(function (m) { return m + ' %'; })));
  ['Old', 'New'].forEach(function (face) {
    const row = [face];
    months.forEach(function (m) {
      const names = (mem[m] && mem[m][face]) || [];
      row.push(nc.link(names.length, scope + '|newold|' + m + '|' + face,
        'New/Old | ' + m + ' | ' + face + ' | ' + scope, names));
    });
    months.forEach(function (m) {
      const o = (mem[m] && mem[m].Old || []).length, n = (mem[m] && mem[m].New || []).length;
      row.push(pctCell_(face === 'Old' ? o : n, o + n));
    });
    grid.push(row);
  });
  grid.push([]);
}

function newOldTabGrid_(slim, nc) {
  if (!slim.length) return [['(no rows for this SOC)']];
  const grid = [['NEW / OLD FACE  (monthly; Old = >=10 days at one station; click a number to see those people)'], []];
  const months = monthOrder_(slim);
  renderNewOld_(grid, nc, 'All', newOldMembers(slim), months);
  distinctTeams(slim).forEach(function (t) {
    renderNewOld_(grid, nc, 'team ' + t, newOldMembers(slim, t), months);
  });
  return grid;
}

// ---- 3-day consecutive (monthly + weekly) -----------------------------------
const STREAK_CATS = ['active', '<10', '>10', 'usedto_<10', 'usedto_>10', 'never_<10', 'never_>10'];
const STREAKW_CATS = ['active', '>=3', '<3'];

function renderStreakMonth_(grid, nc, scope, mem, months) {
  grid.push([scope]);
  grid.push(['month'].concat(STREAK_CATS));
  months.forEach(function (m) {
    const row = [m];
    STREAK_CATS.forEach(function (cat) {
      const names = (mem[m] && mem[m][cat]) || [];
      row.push(nc.link(names.length, scope + '|streakM|' + m + '|' + cat,
        'Consecutive (monthly) | ' + m + ' | ' + cat + ' | ' + scope, names));
    });
    grid.push(row);
  });
  grid.push([]);
}

function renderStreakWeek_(grid, nc, scope, mem) {
  const weeks = Object.keys(mem).sort(function (a, b) { return parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10); });
  grid.push([scope]);
  grid.push(['week'].concat(STREAKW_CATS));
  weeks.forEach(function (w) {
    const row = [w];
    STREAKW_CATS.forEach(function (cat) {
      const names = (mem[w] && mem[w][cat]) || [];
      row.push(nc.link(names.length, scope + '|streakW|' + w + '|' + cat,
        'Consecutive (weekly) | ' + w + ' | ' + cat + ' | ' + scope, names));
    });
    grid.push(row);
  });
  grid.push([]);
}

function consecutiveTabGrid_(slim, nc) {
  if (!slim.length) return [['(no rows for this SOC)']];
  const grid = [['3-DAY CONSECUTIVE  (monthly; click a number to see those people)'], []];
  const months = monthOrder_(slim);
  renderStreakMonth_(grid, nc, 'All', streakMonthMembers(slim), months);
  distinctTeams(slim).forEach(function (t) {
    renderStreakMonth_(grid, nc, 'team ' + t, streakMonthMembers(slim, t), months);
  });
  grid.push(['3-DAY CONSECUTIVE  (weekly; >=3 consecutive)'], []);
  renderStreakWeek_(grid, nc, 'All', streakWeekMembers(slim));
  distinctTeams(slim).forEach(function (t) {
    renderStreakWeek_(grid, nc, 'team ' + t, streakWeekMembers(slim, t));
  });
  return grid;
}

// ---- Rotation (monthly + weekly) --------------------------------------------
const ROT_COUNT_COLS = ['population', 'rotation', 'non_rotation', 'oneday_nonrot'];

function rotationDisp_(label) { return /^\d{4}-\d{2}$/.test(label) ? monthLabel(label) : label; }

function renderRotation_(grid, nc, mem, grain) {
  grid.push(['period', 'team'].concat(ROT_COUNT_COLS, ['rotation%', 'non_rotation%', 'oneday%']));
  Object.keys(mem).forEach(function (label) {
    const disp = rotationDisp_(label), teamObj = mem[label];
    Object.keys(teamObj).sort().forEach(function (t) {
      const cell = teamObj[t];
      const pop = cell.population.length, rot = cell.rotation.length,
            non = cell.non_rotation.length, one = cell.oneday_nonrot.length;
      const row = [disp, t];
      ROT_COUNT_COLS.forEach(function (col) {
        row.push(nc.link(cell[col].length, grain + '|' + label + '|' + t + '|' + col,
          'Rotation (' + grain + ') | ' + disp + ' | ' + t + ' | ' + col, cell[col]));
      });
      row.push(pctCell_(rot, pop), pctCell_(non, pop), non ? round2(one / non * 100) + '%' : '');
      grid.push(row);
    });
  });
  grid.push([]);
}

function rotationTabGrid_(slim, nc) {
  if (!slim.length) return [['(no rows for this SOC)']];
  const grid = [['ROTATION  (monthly, per team; click a number to see those people)'], []];
  renderRotation_(grid, nc, rotationMembers(slim), 'monthly');
  grid.push(['ROTATION  (weekly, per team)'], []);
  renderRotation_(grid, nc, rotationMembers(slim, 'week'), 'weekly');
  return grid;
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

// resize a tab to its actual grid, then write it. values.update (unlike
// values.append) does NOT auto-grow, so the grid must be sized first; sizing to
// exactly the content also keeps the workbook well under the 10M-cell cap. The
// aspect tabs use USER_ENTERED (so the =HYPERLINK counts become live links); the
// Names tab passes RAW so a worker name that happens to start with "="/"-"/"+"
// is stored literally, not misread as a formula.
function writeSummaryTab_(ss, sheetId, tabName, grid, inputOption) {
  let width = 1;
  grid.forEach(function (r) { if (r.length > width) width = r.length; });
  const rows = Math.max(1, grid.length);
  const id = ss.getId();
  // resize the grid to exactly the content (values.update does NOT auto-grow).
  retryWrite_(function () {
    return Sheets.Spreadsheets.batchUpdate({ requests: [{ updateSheetProperties: {
      properties: { sheetId: sheetId, gridProperties: { rowCount: rows, columnCount: width } },
      fields: 'gridProperties.rowCount,gridProperties.columnCount',
    } }] }, id);
  });
  // Write in ROW CHUNKS. A single values.update of a very large grid (the Names
  // files reach hundreds of thousands of rows) fails with a 500 "Internal error"
  // -- the request is simply too big. Chunking keeps each request small; each
  // targets a fixed A<start> range so a retry is idempotent. Rows are padded to
  // the common width per chunk (not up front) to avoid building one giant rect.
  const io = inputOption || 'USER_ENTERED';
  const CHUNK = 20000;
  for (var start = 0; start < grid.length; start += CHUNK) {
    const slice = grid.slice(start, start + CHUNK).map(function (r) {
      const c = r.slice();
      while (c.length < width) c.push('');
      return c;
    });
    const at = start + 1;   // 1-based first row of this chunk
    retryWrite_(function () {
      return Sheets.Spreadsheets.Values.update(
        { values: slice }, id, quoted_(tabName) + '!A' + at, { valueInputOption: io });
    });
  }
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
      // main file (raw + aspects) and one SEPARATE Names file PER ASPECT (each its
      // own 10M budget). All created/reset once per (year, dept).
      const ss = findOrCreateSheet_(conf.folderId, socSheetTitle_(year, dept));
      const sheetIds = prepareSocSheet_(ss);
      const namesFiles = {};   // aspect tab -> { ss, gid }
      ASPECT_TABS.forEach(function (tab) {
        const nss = findOrCreateSheet_(conf.folderId, socNamesTitle_(year, dept, ASPECT_NAME_SUFFIX[tab]));
        namesFiles[tab] = { ss: nss, gid: prepareNamesSheet_(nss) };
      });
      socData[k] = { ss: ss, sheetIds: sheetIds, namesFiles: namesFiles,
        slim: [], year: year, dept: dept };
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
      // slim slice carries the full raw-column set (not just name/date/team) so the
      // Names drill-down can render every raw column for each counted person.
      rows.forEach(function (r) {
        ctx.slim.push({ name: r.name, date: r.date, team: r.team, clockin: r.clockin,
          vendor: r.vendor, shift_name: r.shift_name, shift_id: r.shift_id, month: r.month });
      });
    });
  });

  // per (year, dept): dedup the slim slice, then for each aspect write its summary
  // tab (to the MAIN file; its counts are cross-file links into that aspect's own
  // Names file) and its Names tab (to that aspect's SEPARATE file). Per-file dedup
  // above already removes within-vendor overlap; this final dedup guarantees the
  // engine's one-row-per-(name,date) contract before the summaries. Each aspect
  // gets its OWN collector so its links target its OWN Names file.
  const aspectGrids = {
    'New-Old Face': newOldTabGrid_, 'Show Up': showUpTabGrid_,
    'Consecutive': consecutiveTabGrid_, 'Rotation': rotationTabGrid_,
  };
  const result = {};
  Object.keys(socData).forEach(function (k) {
    const ctx = socData[k];
    const slim = dedupByNameDate_(ctx.slim);
    const namesIds = {};
    ASPECT_TABS.forEach(function (tab) {
      const nf = ctx.namesFiles[tab];
      const nc = namesCollector_(nf.ss.getId(), nf.gid);
      writeSummaryTab_(ctx.ss, ctx.sheetIds[tab], tab, aspectGrids[tab](slim, nc));
      writeSummaryTab_(nf.ss, nf.gid, NAMES_TAB, nc.rows, 'RAW');
      namesIds[tab] = nf.ss.getId();
    });
    const names = {};
    slim.forEach(function (r) { names[r.name] = true; });
    result[socSheetTitle_(ctx.year, ctx.dept)] = {
      spreadsheetId: ctx.ss.getId(), namesSpreadsheetIds: namesIds,
      rows: slim.length, workers: Object.keys(names).length };
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
  const ss = findOrCreateSheet_(conf.folderId, socSheetTitle_(String(year), dept));
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
