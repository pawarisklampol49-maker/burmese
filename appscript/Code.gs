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
    // Vendors that supply THAI workers. Everything NOT in this list is treated as
    // BURMESE (the user's chosen default -- no fail-fast). Summaries split each
    // scope into "... Burmese" / "... Thai" rows. Add a new Thai vendor here (no
    // code change); a new vendor left off the list simply counts as Burmese.
    THAI_VENDORS: 'PPO,WAS,RG,YSL,BigBoom',
  });
  Logger.log('Script properties set.');
}
// deletes the retired SKIP_VENDORS property (those 5 are now Thai, not skipped).
// One-time cleanup helper -- harmless to run more than once.
function migrateSkipVendors() {
  PropertiesService.getScriptProperties().deleteProperty('SKIP_VENDORS');
  Logger.log('Removed retired SKIP_VENDORS property.');
}

function cfg_() {
  const props = PropertiesService.getScriptProperties();
  const folderId = props.getProperty('CENTRAL_FOLDER_ID');
  const deptsRaw = props.getProperty('RAW_DEPARTMENTS');
  if (!folderId) throw new Error('Script Property CENTRAL_FOLDER_ID is not set -- run initProperties()');
  if (!deptsRaw) throw new Error('Script Property RAW_DEPARTMENTS is not set -- run initProperties()');
  const departments = deptsRaw.split(',').map(function (s) { return s.trim().toUpperCase(); }).filter(Boolean);
  // Thai-vendor allowlist (case-insensitive on the vendor token parsed from the
  // title). A vendor in this set -> its workers are Thai; anything else -> Burmese.
  const thaiRaw = props.getProperty('THAI_VENDORS') || '';
  const thaiVendors = {};
  thaiRaw.split(',').map(function (s) { return s.trim().toUpperCase(); }).filter(Boolean)
    .forEach(function (v) { thaiVendors[v] = true; });
  return { folderId: folderId, departments: departments, thaiVendors: thaiVendors };
}

// Burmese unless the vendor is in the Thai allowlist (user's chosen default).
function nationalityOf_(vendor, thaiVendors) {
  return thaiVendors[String(vendor).toUpperCase()] ? 'Thai' : 'Burmese';
}

// ------------------------------------------------------------------ discovery
const RAW_TITLE_RE = /^\[([A-Za-z]+)\s+(\d{4})\]_Daily name list_(.+)$/;

// mirrors render/app.py _list_raw_candidates + _parse_raw_title / n8n Parse Titles:
// a loose match that fails the strict pattern or has an unknown department is a
// HARD ERROR (silent-skip is what caused the original 7.3x undercount).
function discoverFiles_(knownDepts, thaiVendors) {
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
    const vendor = m[3].trim();
    if (!known[dept]) {
      throw new Error("unrecognized department '" + dept + "' parsed from '" + name +
        "' -- expected one of " + JSON.stringify(Object.keys(known).sort()));
    }
    // every discovered vendor is INCLUDED now (no skip). Tag its nationality:
    // Thai if listed in THAI_VENDORS, else Burmese.
    out.push({ id: f.getId(), name: name, dept: dept, year: m[2], vendor: vendor,
      nationality: nationalityOf_(vendor, thaiVendors || {}) });
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
  let resp;
  try {
    resp = retryRead_(function () {
      return Sheets.Spreadsheets.Values.batchGet(fileId, { ranges: ranges, majorDimension: 'ROWS' });
    });
  } catch (e) {
    // The metadata get() above already succeeded on this fileId, so the file EXISTS
    // and is readable -- a 404 here is NOT "file missing". Name the file id and the
    // exact month tabs requested so the culprit can be opened and inspected directly.
    throw new Error('batchGet failed for spreadsheet ' + fileId + ' on tabs ' +
      JSON.stringify(titles) + ' -- ' + e.message);
  }
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
// One tab PER ASPECT, each carrying every grain that means something (user
// request: day/week/month everywhere it can): Show Up = monthly buckets + WEEKLY
// buckets (1-2/3-4/5-7 days) + daily head count; New/Old = monthly + weekly +
// daily (presence counted by the MONTHLY verdict); Rotation = monthly + weekly +
// daily (presence by the monthly Reading-B status -- a worker has one team per
// day, so nothing can rotate WITHIN a day); Consecutive = monthly + weekly only
// (user: keep as is). DAILY blocks are PLAIN NUMBERS -- a per-person daily
// drill-down copies ~2x the raw log and overflowed a Names file live; the daily
// roster is the raw tab filtered by date. Monthly/weekly COUNTS are =HYPERLINKs
// to the people behind them in that aspect's Names file. Members are one
// REPRESENTATIVE raw row per counted person and come from the engine's *Members/
// *Presence functions, asserted (self-tests) to match the counts. Engine globals
// (showupMembers, showupWeekMembers, newOldMembers, newOldPresence,
// streakMonthMembers, streakWeekMembers, rotationMembers, rotationPresenceDay,
// distinctTeams, monthLabel, round2, BUCKETS, WEEK_BUCKETS) come from engine.gs
// -- read INSIDE functions, never at top level (cross-file const load order
// isn't guaranteed).

// chronological month labels present in the slice ("2026-03" sorts, then -> "Mar").
function monthOrder_(slim) {
  const seen = {};
  slim.forEach(function (r) { seen[r.date.month] = true; });
  return Object.keys(seen).sort().map(monthLabel);
}

// all show-up days present in the slice, sorted ("YYYY-MM-DD" sorts = chronological).
// Shared column set for every daily block, so columns align across scopes.
function dayOrder_(slim) {
  const seen = {};
  slim.forEach(function (r) { seen[r.date.key] = true; });
  return Object.keys(seen).sort();
}

// all ISO weeks present in the slice as "W<n>" labels, numerically sorted -- the
// shared column set for the weekly Show Up / New-Old sections (same labels the
// engine's week-keyed members use).
function weeksOf_(slim) {
  const seen = {};
  slim.forEach(function (r) { seen['W' + r.date.iso.week] = true; });
  return sortPeriodKeys_(Object.keys(seen));
}

// ---- visualization: fixed team scope + cell formatting -----------------------
// The 8 operational teams the user wants summaries scoped to (per-request, Show Up
// only for now -- see CLAUDE.md). This is DIFFERENT from distinctTeams(slim): that
// stays data-driven (used for the "raw"/drill-down side); VIS_TEAMS is a fixed
// allowlist that filters OUT noise teams (a stray "Helper", or a shift-name-as-team
// fallback) from the visualized summary. Order here is the display order.
const VIS_TEAMS = ['IB', 'CBS', 'mCBS', 'MS', 'OBI', 'OBC', 'OBS', 'OBD'];

// the VIS_TEAMS that actually appear in this SOC's data, in VIS_TEAMS order.
function visibleTeams_(slim) {
  const present = {};
  distinctTeams(slim).forEach(function (t) { present[t] = true; });
  return VIS_TEAMS.filter(function (t) { return present[t]; });
}

// the "All <DEPT>" scope label -- the combined (not-grouped-by-team) row. Dept is
// SOCN/SOCE/SOCW, so this is "All SOCN"/"All SOCE"/"All SOCW", NOT a hardcoded
// "All SOCN" (that was a bug -- the same code runs for all three SOCs).
function allLabel_(dept) { return 'All ' + dept; }
// is this scope the combined "All <DEPT>" row (vs a single team)? Team names are
// the fixed VIS_TEAMS list, none of which start with "All ", so the prefix test
// reliably distinguishes the two without threading the exact label everywhere.
// (Works with the nationality suffix too: "All SOCN Burmese" still starts "All ".)
function isAllScope_(scope) { return /^All /.test(scope); }

// ---- nationality (Thai / Burmese) --------------------------------------------
// Each summary scope is split by worker nationality (from the vendor, see
// nationalityOf_), interleaved per base scope: "All <DEPT> Burmese",
// "All <DEPT> Thai", "IB Burmese", "IB Thai", ... A base/nationality pair with no
// rows is skipped, so a Burmese-only SOC shows no empty Thai blocks.
const NATIONALITIES = ['Burmese', 'Thai'];   // display order, Burmese first

function presentNationalities_(slim) {
  const seen = {};
  slim.forEach(function (r) { seen[r.nationality] = true; });
  return NATIONALITIES.filter(function (n) { return seen[n]; });
}
function filterNat_(slim, nat) {
  return slim.filter(function (r) { return r.nationality === nat; });
}

// base scopes (All <DEPT> + each visible team) x present nationalities ->
// [{ label, natSlim, team }], team null for the All scope.
function natScopes_(slim, teams, allLabel) {
  const nats = presentNationalities_(slim);
  const byNat = {};
  nats.forEach(function (n) { byNat[n] = filterNat_(slim, n); });
  const bases = [{ name: allLabel, team: null }]
    .concat(teams.map(function (t) { return { name: t, team: t }; }));
  const out = [];
  bases.forEach(function (base) {
    nats.forEach(function (n) {
      const ns = byNat[n];
      const hasRows = base.team == null ? ns.length > 0 : ns.some(function (r) { return r.team === base.team; });
      if (hasRows) out.push({ label: base.name + ' ' + n, natSlim: ns, team: base.team });
    });
  });
  return out;
}

// team x nationality rows for the Rotation tab (which has no All scope), interleaved
// per team: "IB Burmese", "IB Thai", "CBS Burmese", ...
function natTeams_(teams, nats) {
  const out = [];
  teams.forEach(function (t) { nats.forEach(function (n) { out.push({ team: t, nat: n, label: t + ' ' + n }); }); });
  return out;
}

// sort period keys: ISO months ("2026-03") sort lexically = chronologically;
// week keys ("W7") need numeric sort on the number after "W".
function sortPeriodKeys_(keys) {
  if (keys.length && /^W/.test(keys[0])) {
    return keys.slice().sort(function (a, b) { return parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10); });
  }
  return keys.slice().sort();
}
function unionPeriodKeys_(memByNat) {
  const s = {};
  Object.keys(memByNat).forEach(function (n) { Object.keys(memByNat[n]).forEach(function (k) { s[k] = true; }); });
  return sortPeriodKeys_(Object.keys(s));
}

// cell background/font colors, matching the reference layout the user shared.
const FMT = {
  headerAllBg: '#c9daf8',       // light blue -- the "All SOCN" scope header
  headerTeamBg: '#fce5cd',      // light orange -- a per-team scope header
  headerBucketBg: '#f3f3f3',    // light gray -- a bucket-group header (table B)
  increaseBg: '#d9ead3', increaseFg: '#38761d',   // light green bg / dark green text
  decreaseBg: '#f4cccc', decreaseFg: '#cc0000',   // light red bg / dark red text
  oneDayFg: '#b45f06',          // dark orange -- the "1 day in month" block title
};
// a month-over-month move of at least this many percentage points is "notable"
// enough to flag with color + border in the by-bucket trend table.
const TREND_THRESHOLD_PTS = 5;

// format instructions are collected as plain objects with grid-relative (0-based)
// row/col -- the actual sheetId isn't known until write time, so building real
// Sheets API requests happens in writeSummaryTab_, not here.
function fmtCell_(formats, row, col, opts) {
  formats.push(Object.assign({ row: row, col: col }, opts));
}
function fmtRange_(formats, row, colStart, colEnd, opts) {
  // colStart/colEnd inclusive, 0-based -- used for the trend box border.
  formats.push(Object.assign({ row: row, col: colStart, colEnd: colEnd }, opts));
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

// numeric percentage (or null when den == 0) -- shared by pctCell_ (display, with
// a "%" sign) and the trend-detection logic in renderShowupByBucket_, which needs
// the raw number to compute a month-over-month delta.
function pctNum_(num, den) { return den ? round2(num / den * 100) : null; }
// percent cell WITH a "%" sign. Written USER_ENTERED, so "45.11%" lands as a real
// percentage number (Sheets stores 0.4511, displays 45.11%). Blank when den == 0.
function pctCell_(num, den) { const n = pctNum_(num, den); return n == null ? '' : n + '%'; }

// ---- Show up (monthly day-count buckets) ------------------------------------
// a FUNCTION, not a top-level const: BUCKETS comes from engine.gs, and Apps
// Script loads .gs files in filename order ("Code.gs" before "engine.gs"), so a
// top-level `const X = BUCKETS.map(...)` here throws "BUCKETS is not defined" --
// hit live. Same reason every other engine global is read inside functions, never
// at Code.gs's top level (see the summaries-section comment above).
function showupBucketLabels_() { return BUCKETS.map(function (b) { return b[0] + '-' + b[1]; }); }
function weekBucketLabels_() { return WEEK_BUCKETS.map(function (b) { return b[0] + '-' + b[1]; }); }

// per-scope, per-month denominator: total across all buckets for that month
// (excludes days outside 1-30). Shared by both the by-team and by-bucket tables
// so their percentages are computed identically.
function showupSums_(mem, months) {
  const buckets = showupBucketLabels_();
  const sums = {};
  months.forEach(function (m) {
    var s = 0; buckets.forEach(function (bk) { s += ((mem[m] && mem[m][bk]) || []).length; }); sums[m] = s;
  });
  return sums;
}

// Table A: grouped BY TEAM -- one block per scope (All, then each visible team),
// buckets as rows, months as columns (counts, then %).
function renderShowup_(grid, formats, nc, scope, mem, months) {
  const buckets = showupBucketLabels_();
  const headerRow = grid.length;
  grid.push([scope]);
  fmtCell_(formats, headerRow, 0, { bg: isAllScope_(scope) ? FMT.headerAllBg : FMT.headerTeamBg, bold: true });
  grid.push(['bucket'].concat(months, months.map(function (m) { return m + ' %'; })));
  const sums = showupSums_(mem, months);
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
  // plain number, not a link: this is just the buckets above added together --
  // linking it would duplicate every one of those already-linked names a second
  // time in the Names file for no reason ("same data, waste of memory").
  const sumRow = ['Sum Month'];
  months.forEach(function (m) { sumRow.push(sums[m]); });
  months.forEach(function () { sumRow.push('100%'); });
  grid.push(sumRow);
  grid.push([]);
}

// Weekly analog of the by-team table: one block per scope, WEEK_BUCKETS
// (1-2/3-4/5-7 days) as rows, ISO weeks as columns (counts, then %). Same
// layout rules as renderShowup_, including the plain (never linked) sum row.
function renderShowupWeek_(grid, formats, nc, scope, mem, weeks) {
  const buckets = weekBucketLabels_();
  const headerRow = grid.length;
  grid.push([scope]);
  fmtCell_(formats, headerRow, 0, { bg: isAllScope_(scope) ? FMT.headerAllBg : FMT.headerTeamBg, bold: true });
  grid.push(['bucket'].concat(weeks, weeks.map(function (w) { return w + ' %'; })));
  const sums = {};
  weeks.forEach(function (w) {
    var s = 0; buckets.forEach(function (bk) { s += ((mem[w] && mem[w][bk]) || []).length; }); sums[w] = s;
  });
  buckets.forEach(function (bk) {
    const row = [bk];
    weeks.forEach(function (w) {
      const names = (mem[w] && mem[w][bk]) || [];
      row.push(nc.link(names.length, scope + '|showupW|' + w + '|' + bk,
        'Show up (weekly) | ' + w + ' | ' + bk + ' days | ' + scope, names));
    });
    weeks.forEach(function (w) { row.push(pctCell_(((mem[w] && mem[w][bk]) || []).length, sums[w])); });
    grid.push(row);
  });
  const sumRow = ['Sum Week'];
  weeks.forEach(function (w) { sumRow.push(sums[w]); });
  weeks.forEach(function () { sumRow.push('100%'); });
  grid.push(sumRow);
  grid.push([]);
}

// Generic "label x month" percentage block with a last-two-months trend flag
// (color + box + increases/decreases label past TREND_THRESHOLD_PTS). Shared by
// Show Up's by-bucket table, New/Old's by-category table, and Rotation's trend
// summary so the trend RULE lives in exactly one place. `rows`: [{label, pct:
// {monthLabel: numberOrNull}}]. `title`/`titleColor` (optional) push one colored
// title row first. Any row whose label is an "All <DEPT> ..." scope gets its label
// cell highlighted (both nationality All-rows, via isAllScope_).
function renderTrendPctBlock_(grid, formats, title, titleColor, colHeaderLabel, rows, months) {
  const firstMonthCol = 1, lastMonthCol = firstMonthCol + months.length - 1;
  const trendCol = firstMonthCol + months.length;   // one column past the % values
  if (title) {
    const r = grid.length;
    grid.push([title]);
    fmtCell_(formats, r, 0, { fg: titleColor, bold: true });
  }
  grid.push([colHeaderLabel || ''].concat(months));

  rows.forEach(function (row) {
    const gridRow = [row.label];
    months.forEach(function (m) { const n = row.pct[m]; gridRow.push(n == null ? '' : n + '%'); });
    const rowIdx = grid.length;
    grid.push(gridRow);
    if (isAllScope_(row.label)) fmtCell_(formats, rowIdx, 0, { bg: FMT.headerAllBg, bold: true });

    // trend flag: last two months only, both present, delta past threshold.
    if (months.length >= 2) {
      const prevM = months[months.length - 2], lastM = months[months.length - 1];
      const prevN = row.pct[prevM], lastN = row.pct[lastM];
      if (prevN != null && lastN != null && Math.abs(lastN - prevN) >= TREND_THRESHOLD_PTS) {
        const up = lastN > prevN;
        const bg = up ? FMT.increaseBg : FMT.decreaseBg, fg = up ? FMT.increaseFg : FMT.decreaseFg;
        fmtCell_(formats, rowIdx, lastMonthCol - 1, { bg: bg, fg: fg });   // prev-month cell
        fmtCell_(formats, rowIdx, lastMonthCol, { bg: bg, fg: fg });      // last-month cell
        fmtRange_(formats, rowIdx, lastMonthCol - 1, lastMonthCol, { border: true });
        gridRow[trendCol] = up ? 'increases' : 'decreases';
        fmtCell_(formats, rowIdx, trendCol, { fg: fg, bold: true });
      }
    }
  });
  grid.push([]);
}

// Table B: grouped BY BUCKET (the "date range" view) -- one block per bucket,
// rows = All + each visible team, columns = months (% only, matches the
// reference layout), via the shared trend block above.
function renderShowupByBucket_(grid, formats, scopes, months) {
  // scopes: [{label, mem}, ...] -- the "All <DEPT>" scope first, then each visible team.
  showupBucketLabels_().forEach(function (bk, bi) {
    const titleRow = grid.length;
    grid.push(['Show up >=' + BUCKETS[bi][0] + ' and <=' + BUCKETS[bi][1] + ' days']);
    fmtCell_(formats, titleRow, 0, { bg: FMT.headerBucketBg, bold: true });
    const rows = scopes.map(function (s) {
      const sums = showupSums_(s.mem, months);
      const pct = {};
      months.forEach(function (m) { pct[m] = pctNum_(((s.mem[m] && s.mem[m][bk]) || []).length, sums[m]); });
      return { label: s.label, pct: pct };
    });
    renderTrendPctBlock_(grid, formats, null, null, 'team', rows, months);
  });
}

// Daily head count: distinct workers present each day, per nationality scope (All
// <DEPT> + each team, split Burmese/Thai). PLAIN COUNTS, not clickable: a
// per-person daily drill-down copies ~2x the entire raw log and overflows even a
// dedicated Names file's 10M cap (hit live) -- the daily roster is already the raw
// tab, filtered by date. Computed directly from the slice (distinct names per day)
// so it needs no engine helper.
function renderHeadcount_(grid, natScopes, days) {
  grid.push(['DAILY HEAD COUNT  (distinct workers present each day -- plain counts; the daily roster is the raw tab, filtered by date)'], []);
  grid.push(['team'].concat(days));
  natScopes.forEach(function (sc) {
    const rows = sc.team == null ? sc.natSlim : sc.natSlim.filter(function (r) { return r.team === sc.team; });
    const perDay = {};   // day -> { name: true }
    rows.forEach(function (r) { (perDay[r.date.key] = perDay[r.date.key] || {})[r.name] = true; });
    const row = [sc.label];
    days.forEach(function (d) { row.push(perDay[d] ? Object.keys(perDay[d]).length : 0); });
    grid.push(row);
  });
  grid.push([]);
}

function showUpTabGrid_(slim, nc, dept) {
  if (!slim.length) return { grid: [['(no rows for this SOC)']], formats: [] };
  const grid = [['SHOW UP  (monthly day-count buckets; click a number to see those people)'], []];
  const formats = [];
  const months = monthOrder_(slim);
  const teams = visibleTeams_(slim);   // fixed 8-team scope (see VIS_TEAMS)
  const scopes = natScopes_(slim, teams, allLabel_(dept));   // All <DEPT> + teams, split Burmese/Thai

  scopes.forEach(function (sc) {
    renderShowup_(grid, formats, nc, sc.label, showupMembers(sc.natSlim, sc.team), months);
  });

  grid.push(['SHOW UP BY DATE RANGE  (same data, grouped by bucket -- teams as rows; colored cells flag a >=' +
    TREND_THRESHOLD_PTS + '-point move from the prior month)'], []);
  const bucketScopes = scopes.map(function (sc) {
    return { label: sc.label, mem: showupMembers(sc.natSlim, sc.team) };
  });
  renderShowupByBucket_(grid, formats, bucketScopes, months);

  // weekly day-count buckets (1-2/3-4/5-7 -- a week has at most 7 days), same
  // scope blocks as the monthly table, ISO weeks as columns, counts clickable.
  grid.push(['SHOW UP  (weekly day-count buckets; click a number to see those people)'], []);
  const weeks = weeksOf_(slim);
  scopes.forEach(function (sc) {
    renderShowupWeek_(grid, formats, nc, sc.label, showupWeekMembers(sc.natSlim, sc.team), weeks);
  });

  // daily head count -- all days present across the SOC, sorted
  renderHeadcount_(grid, scopes, dayOrder_(slim));
  return { grid: grid, formats: formats };
}

// ---- New / Old face (monthly) -----------------------------------------------
// Old (experienced) = fixed to ONE station AND >=10 days that month; New = fixed to
// ONE station AND <10 days. ROTATED workers (>1 station) are EXCLUDED from both --
// they belong to the Rotation tab -- the rule from engine.gs (newOldFace_ returns
// null for rotated). Same two-table + trend treatment as Show Up.
const NEWOLD_FACES = ['Old', 'New'];

// Table A: grouped BY TEAM -- one block per scope (All <DEPT>, then each team),
// Old/New as rows, months as columns (counts, then %).
function renderNewOld_(grid, formats, nc, scope, mem, months) {
  const headerRow = grid.length;
  grid.push([scope]);
  fmtCell_(formats, headerRow, 0, { bg: isAllScope_(scope) ? FMT.headerAllBg : FMT.headerTeamBg, bold: true });
  grid.push(['face'].concat(months, months.map(function (m) { return m + ' %'; })));
  NEWOLD_FACES.forEach(function (face) {
    const row = [face];
    months.forEach(function (m) {
      const names = (mem[m] && mem[m][face]) || [];
      row.push(nc.link(names.length, scope + '|newold|' + m + '|' + face,
        'New/Old | ' + m + ' | ' + face + ' | ' + scope, names));
    });
    months.forEach(function (m) {
      const o = ((mem[m] && mem[m].Old) || []).length, n = ((mem[m] && mem[m].New) || []).length;
      row.push(pctCell_(face === 'Old' ? o : n, o + n));
    });
    grid.push(row);
  });
  grid.push([]);
}

// Table B: grouped BY FACE (Old block, then New block) -- rows = All <DEPT> + each
// team, columns = months (% only), with the shared last-two-months trend flag.
function renderNewOldByCategory_(grid, formats, scopes, months) {
  const titles = { Old: 'Old face (experienced: one station, >=10 days)',
                   New: 'New face (inexperienced: one station, <10 days)' };
  const colors = { Old: FMT.increaseFg, New: FMT.oneDayFg };
  NEWOLD_FACES.forEach(function (face) {
    const rows = scopes.map(function (s) {
      const pct = {};
      months.forEach(function (m) {
        const o = ((s.mem[m] && s.mem[m].Old) || []).length, n = ((s.mem[m] && s.mem[m].New) || []).length;
        pct[m] = pctNum_(face === 'Old' ? o : n, o + n);
      });
      return { label: s.label, pct: pct };
    });
    renderTrendPctBlock_(grid, formats, titles[face], colors[face], 'team', rows, months);
  });
}

// Daily New/Old presence, PLAIN NUMBERS (same no-daily-drill-down rule as the
// head count): one table per face, scopes as rows, days as columns. The verdict
// is the MONTHLY one -- "showed up that day and he is old face -> count him as
// old face" (user's rule); rotated workers are excluded like everywhere else on
// this tab, so Old + New per day <= that day's head count.
function renderFaceDaily_(grid, scopes, days) {
  const memByScope = scopes.map(function (sc) {
    return { label: sc.label, mem: newOldPresence(sc.natSlim, 'day', sc.team) };
  });
  NEWOLD_FACES.forEach(function (face) {
    grid.push(['DAILY ' + face.toUpperCase() + ' FACE  (present that day, ' + face + ' by their month verdict)']);
    grid.push(['team'].concat(days));
    memByScope.forEach(function (s) {
      const row = [s.label];
      days.forEach(function (d) { row.push(((s.mem[d] && s.mem[d][face]) || []).length); });
      grid.push(row);
    });
    grid.push([]);
  });
}

function newOldTabGrid_(slim, nc, dept) {
  if (!slim.length) return { grid: [['(no rows for this SOC)']], formats: [] };
  const grid = [['NEW / OLD FACE  (monthly; Old = fixed to one station AND >=10 days; <10 days = New; rotated workers excluded -- see Rotation tab; click a number to see those people)'], []];
  const formats = [];
  const months = monthOrder_(slim);
  const teams = visibleTeams_(slim);   // fixed 8-team scope, same as Show Up/Consecutive
  const scopes = natScopes_(slim, teams, allLabel_(dept));   // All <DEPT> + teams, split Burmese/Thai

  scopes.forEach(function (sc) {
    renderNewOld_(grid, formats, nc, sc.label, newOldMembers(sc.natSlim, sc.team), months);
  });

  grid.push(['NEW / OLD FACE BY CATEGORY  (teams as rows; colored cells flag a >=' +
    TREND_THRESHOLD_PTS + '-point move from the prior month)'], []);
  const catScopes = scopes.map(function (sc) {
    return { label: sc.label, mem: newOldMembers(sc.natSlim, sc.team) };
  });
  renderNewOldByCategory_(grid, formats, catScopes, months);

  // weekly: same blocks as the monthly table, ISO weeks as columns. The verdict
  // stays MONTHLY (there is no weekly >=10-days rule); the week only picks WHO
  // was present. Reuses renderNewOld_ verbatim -- mem is keyed by week label.
  grid.push(['NEW / OLD FACE  (weekly -- workers present that ISO week, by their month verdict; click a number to see those people)'], []);
  const weeks = weeksOf_(slim);
  scopes.forEach(function (sc) {
    renderNewOld_(grid, formats, nc, sc.label, newOldPresence(sc.natSlim, 'week', sc.team), weeks);
  });

  // daily: plain counts (not clickable -- see renderHeadcount_'s rationale)
  grid.push(['NEW / OLD FACE  (daily -- workers present each day, by their month verdict; plain counts: the daily roster is the raw tab, filtered by date)'], []);
  renderFaceDaily_(grid, scopes, dayOrder_(slim));

  return { grid: grid, formats: formats };
}

// ---- 3-day consecutive (monthly + weekly) -----------------------------------
// Layout matches the user's reference sheet: per scope, a COUNTS section (3
// blocks -- the plain <10/>10 split, then that same split conditioned on "ever
// had a >=3-day run" vs "never did"), then a PERCENTAGES section mirroring it.
// Block 2 and block 3 percentages share block 1's denominator (that month's
// total active headcount) -- confirmed against the reference numbers -- since
// all three blocks partition the SAME population, just by a different question.
// Each block's Total/sum row is a PLAIN NUMBER, never a link: it's a
// recombination of the two cells already linked right above it, so linking it
// again would duplicate that same member list into the Names file a second
// time for nothing -- exactly the "same data, waste of memory" the user flagged.
// Only the six core category cells (the real distinct groups) are drillable.

// total active workers that month/week = low + high (== the 'active' category).
function streakActive_(mem, key) { return ((mem[key] && mem[key]['<10']) || []).length + ((mem[key] && mem[key]['>10']) || []).length; }

function renderStreakCountBlock_(grid, formats, nc, scope, mem, months, title, titleColor, lowKey, highKey, keyPrefix) {
  if (title) {
    const r = grid.length;
    grid.push([title]);
    fmtCell_(formats, r, 0, { fg: titleColor, bold: true });
  }
  grid.push([''].concat(months));
  const lowRow = ['Show up < 10 days'], highRow = ['Show up > 10 days'];
  months.forEach(function (m) {
    const lowNames = (mem[m] && mem[m][lowKey]) || [];
    const highNames = (mem[m] && mem[m][highKey]) || [];
    lowRow.push(nc.link(lowNames.length, scope + '|streakM|' + m + '|' + lowKey,
      'Consecutive (monthly) | ' + m + ' | ' + lowKey + ' | ' + scope, lowNames));
    highRow.push(nc.link(highNames.length, scope + '|streakM|' + m + '|' + highKey,
      'Consecutive (monthly) | ' + m + ' | ' + highKey + ' | ' + scope, highNames));
  });
  grid.push(lowRow, highRow);
  const totalRow = ['Total'];
  months.forEach(function (m) {
    totalRow.push(((mem[m] && mem[m][lowKey]) || []).length + ((mem[m] && mem[m][highKey]) || []).length);
  });
  grid.push(totalRow);
  grid.push([]);
}

function renderStreakPctBlock_(grid, formats, mem, months, title, titleColor, lowKey, highKey) {
  if (title) {
    const r = grid.length;
    grid.push([title]);
    fmtCell_(formats, r, 0, { fg: titleColor, bold: true });
  }
  grid.push([''].concat(months));
  const lowRow = ['Show up < 10 days'], highRow = ['Show up > 10 days'];
  months.forEach(function (m) {
    const denom = streakActive_(mem, m);
    lowRow.push(pctCell_(((mem[m] && mem[m][lowKey]) || []).length, denom));
    highRow.push(pctCell_(((mem[m] && mem[m][highKey]) || []).length, denom));
  });
  grid.push(lowRow, highRow);
  grid.push([]);
}

function renderStreakMonth_(grid, formats, nc, scope, mem, months) {
  const headerRow = grid.length;
  grid.push([scope]);
  fmtCell_(formats, headerRow, 0, { bg: isAllScope_(scope) ? FMT.headerAllBg : FMT.headerTeamBg, bold: true });

  renderStreakCountBlock_(grid, formats, nc, scope, mem, months, null, null, '<10', '>10', 'streakM');
  renderStreakCountBlock_(grid, formats, nc, scope, mem, months,
    'Used to work for at least 3 consecutive days (at least one period)', FMT.increaseFg, 'usedto_<10', 'usedto_>10', 'streakM');
  renderStreakCountBlock_(grid, formats, nc, scope, mem, months,
    'Never work for at least 3 consecutive days (at least one period)', FMT.decreaseFg, 'never_<10', 'never_>10', 'streakM');

  renderStreakPctBlock_(grid, formats, mem, months, null, null, '<10', '>10');
  renderStreakPctBlock_(grid, formats, mem, months,
    'Used to work for at least 3 consecutive days (at least one period)', FMT.increaseFg, 'usedto_<10', 'usedto_>10');
  renderStreakPctBlock_(grid, formats, mem, months,
    'Never work for at least 3 consecutive days (at least one period)', FMT.decreaseFg, 'never_<10', 'never_>10');

  // validation row: block2 + block3 should sum to 100% -- they partition the same
  // population as block1, just split by a different question (streak history).
  const totalPctRow = [''];
  months.forEach(function (m) {
    const denom = streakActive_(mem, m);
    const n = ((mem[m] && mem[m]['usedto_<10']) || []).length + ((mem[m] && mem[m]['usedto_>10']) || []).length +
              ((mem[m] && mem[m]['never_<10']) || []).length + ((mem[m] && mem[m]['never_>10']) || []).length;
    totalPctRow.push(pctCell_(n, denom));
  });
  grid.push(totalPctRow);
  grid.push([]);
}

function weekOrder_(mem) {
  return Object.keys(mem).sort(function (a, b) { return parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10); });
}

// weekly: transposed vs the old layout -- categories as ROWS (">=3 days
// consecutive" / "< 3 days and non-consecutive"), weeks as COLUMNS, counts then
// percentages. Same "no link on the derived total" rule as the monthly blocks.
function renderStreakWeek_(grid, formats, nc, scope, mem) {
  const weeks = weekOrder_(mem);
  const headerRow = grid.length;
  grid.push([scope]);
  fmtCell_(formats, headerRow, 0, { bg: isAllScope_(scope) ? FMT.headerAllBg : FMT.headerTeamBg, bold: true });

  grid.push([''].concat(weeks));
  const hiRow = ['>=3 days consecutive'], loRow = ['< 3 days and non-consecutive'];
  weeks.forEach(function (w) {
    const hiNames = (mem[w] && mem[w]['>=3']) || [];
    const loNames = (mem[w] && mem[w]['<3']) || [];
    hiRow.push(nc.link(hiNames.length, scope + '|streakW|' + w + '|>=3',
      'Consecutive (weekly) | ' + w + ' | >=3 | ' + scope, hiNames));
    loRow.push(nc.link(loNames.length, scope + '|streakW|' + w + '|<3',
      'Consecutive (weekly) | ' + w + ' | <3 | ' + scope, loNames));
  });
  grid.push(hiRow, loRow);
  const totalRow = ['Total'];
  weeks.forEach(function (w) {
    totalRow.push(((mem[w] && mem[w]['>=3']) || []).length + ((mem[w] && mem[w]['<3']) || []).length);
  });
  grid.push(totalRow);
  grid.push([]);

  grid.push([''].concat(weeks));
  const hiPctRow = ['>=3 days consecutive'], loPctRow = ['< 3 days and non-consecutive'];
  weeks.forEach(function (w) {
    const denom = ((mem[w] && mem[w]['>=3']) || []).length + ((mem[w] && mem[w]['<3']) || []).length;
    hiPctRow.push(pctCell_(((mem[w] && mem[w]['>=3']) || []).length, denom));
    loPctRow.push(pctCell_(((mem[w] && mem[w]['<3']) || []).length, denom));
  });
  grid.push(hiPctRow, loPctRow);
  grid.push([]);
}

function consecutiveTabGrid_(slim, nc, dept) {
  if (!slim.length) return { grid: [['(no rows for this SOC)']], formats: [] };
  const grid = [['3-DAY CONSECUTIVE  (monthly; click a number to see those people)'], []];
  const formats = [];
  const months = monthOrder_(slim);
  const teams = visibleTeams_(slim);   // fixed 8-team scope, same as Show Up
  const scopes = natScopes_(slim, teams, allLabel_(dept));   // All <DEPT> + teams, split Burmese/Thai

  scopes.forEach(function (sc) {
    renderStreakMonth_(grid, formats, nc, sc.label, streakMonthMembers(sc.natSlim, sc.team), months);
  });

  grid.push(['3-DAY CONSECUTIVE  (weekly)'], []);
  scopes.forEach(function (sc) {
    renderStreakWeek_(grid, formats, nc, sc.label, streakWeekMembers(sc.natSlim, sc.team));
  });
  return { grid: grid, formats: formats };
}

// ---- Rotation (monthly + weekly) --------------------------------------------
// Redesigned to match the user's reference sheet: per-period DETAIL blocks (one
// block per month/week, teams as rows, 7 columns in the reference's order), plus
// a TREND-SUMMARY section (3 stacked blocks -- Rotation%, Non Rotation%, and the
// "show up only 1 day" % -- teams as rows, periods as columns) via the SAME
// last-two-months trend rule as Show Up's by-bucket table (renderTrendPctBlock_).
// No "All SOCN" row: rotation is inherently about movement BETWEEN teams, so an
// aggregate would double-count a worker who rotated across several -- the
// reference sheet doesn't show one either.
const ROT_DETAIL_COLS = ['Non Rotation', 'Rotation', 'Non Rotation and show up 1 day in month',
                         'Non Rotation and show up 1 day in month', 'Total', 'Non Rotation', 'Rotation'];

function rotationCell_(mem, periodLabel, team) {
  return (mem[periodLabel] && mem[periodLabel][team]) ||
    { population: [], rotation: [], non_rotation: [], oneday_nonrot: [] };
}

// one block per period: (team x nationality) as rows, the 7 reference columns.
// Total (col 5) is PLAIN, not linked -- it's Non Rotation + Rotation recombined,
// and linking a recombination duplicates those same names in the Names file for
// nothing (the same "waste of memory" issue fixed elsewhere this session). memByNat
// maps nationality -> its rotationMembers; each natTeam row reads its own nat's mem.
function renderRotationDetail_(grid, formats, nc, natTeams, memByNat, periodKeys, dispFn, grainKey) {
  periodKeys.forEach(function (pk) {
    const disp = dispFn(pk);
    grid.push([''].concat(ROT_DETAIL_COLS.map(function () { return disp; })));
    grid.push([''].concat(ROT_DETAIL_COLS));
    natTeams.forEach(function (nt) {
      const cell = rotationCell_(memByNat[nt.nat], pk, nt.team);
      const pop = cell.population.length, rot = cell.rotation.length,
            non = cell.non_rotation.length, one = cell.oneday_nonrot.length;
      const row = [nt.label];
      row.push(nc.link(non, grainKey + '|' + pk + '|' + nt.label + '|non_rotation',
        'Rotation (' + grainKey + ') | ' + disp + ' | ' + nt.label + ' | Non Rotation', cell.non_rotation));
      row.push(nc.link(rot, grainKey + '|' + pk + '|' + nt.label + '|rotation',
        'Rotation (' + grainKey + ') | ' + disp + ' | ' + nt.label + ' | Rotation', cell.rotation));
      row.push(nc.link(one, grainKey + '|' + pk + '|' + nt.label + '|oneday',
        'Rotation (' + grainKey + ') | ' + disp + ' | ' + nt.label + ' | Non Rotation and show up 1 day', cell.oneday_nonrot));
      row.push(pctCell_(one, non));
      row.push(pop);
      row.push(pctCell_(non, pop));
      row.push(pctCell_(rot, pop));
      grid.push(row);
    });
    grid.push([]);
  });
}

// trend-summary: 3 stacked blocks (Rotation%, Non Rotation%, 1-day-only%),
// (team x nationality) as rows, periods as columns -- not linked (derived straight
// from the detail blocks above; same anti-duplication reasoning).
function renderRotationTrend_(grid, formats, natTeams, memByNat, periodKeys, dispFn) {
  const periods = periodKeys.map(dispFn);
  function rowsFor(metric) {
    return natTeams.map(function (nt) {
      const pct = {};
      periodKeys.forEach(function (pk) {
        const cell = rotationCell_(memByNat[nt.nat], pk, nt.team);
        const pop = cell.population.length, rot = cell.rotation.length,
              non = cell.non_rotation.length, one = cell.oneday_nonrot.length;
        pct[dispFn(pk)] = metric === 'rotation' ? pctNum_(rot, pop)
          : metric === 'non_rotation' ? pctNum_(non, pop) : pctNum_(one, non);
      });
      return { label: nt.label, pct: pct };
    });
  }
  renderTrendPctBlock_(grid, formats, 'Rotation', null, '', rowsFor('rotation'), periods);
  renderTrendPctBlock_(grid, formats, 'Non Rotation', FMT.increaseFg, '', rowsFor('non_rotation'), periods);
  renderTrendPctBlock_(grid, formats, 'Non rotation worker who come to work only 1 day in a month', FMT.oneDayFg, '', rowsFor('oneday'), periods);
}

// Daily rotation presence, PLAIN NUMBERS (same no-daily-drill-down rule as the
// head count): one table per status, (team x nationality) as rows, days as
// columns. A worker has exactly ONE team per day, so nothing rotates WITHIN a
// day -- each cell counts workers present at that team that day by their MONTH
// Reading-B status (user-confirmed), and rotation + non_rotation per (day, team)
// partition that day's head count at the team.
function renderRotationDaily_(grid, natTeams, dayByNat, days) {
  [['DAILY ROTATION  (present that day, rotated within that month)', 'rotation'],
   ['DAILY NON ROTATION  (present that day, not rotated that month)', 'non_rotation']].forEach(function (spec) {
    grid.push([spec[0]]);
    grid.push(['team'].concat(days));
    natTeams.forEach(function (nt) {
      const mem = dayByNat[nt.nat];
      const row = [nt.label];
      days.forEach(function (d) {
        row.push(((mem[d] && mem[d][nt.team] && mem[d][nt.team][spec[1]]) || []).length);
      });
      grid.push(row);
    });
    grid.push([]);
  });
}

function rotationTabGrid_(slim, nc, dept) {   // no "All <dept>" row (would double-count rotators); split by nationality
  if (!slim.length) return { grid: [['(no rows for this SOC)']], formats: [] };
  const grid = [['ROTATION  (monthly, per team; click a number to see those people)'], []];
  const formats = [];
  const teams = visibleTeams_(slim);
  const nats = presentNationalities_(slim);
  const natTeams = natTeams_(teams, nats);   // "IB Burmese", "IB Thai", "CBS Burmese", ...

  // rotationMembers per nationality (keyed by period -> team -> members);
  // rotationPresenceDay per nationality for the daily block.
  const monthByNat = {}, weekByNat = {}, dayByNat = {};
  nats.forEach(function (n) {
    const ns = filterNat_(slim, n);
    monthByNat[n] = rotationMembers(ns);
    weekByNat[n] = rotationMembers(ns, 'week');
    dayByNat[n] = rotationPresenceDay(ns);
  });

  const monthKeys = unionPeriodKeys_(monthByNat);   // ISO "YYYY-MM", chronological
  renderRotationDetail_(grid, formats, nc, natTeams, monthByNat, monthKeys, monthLabel, 'rotM');
  grid.push(['ROTATION  (monthly trend summary)'], []);
  renderRotationTrend_(grid, formats, natTeams, monthByNat, monthKeys, monthLabel);

  grid.push(['ROTATION  (weekly, per team)'], []);
  const weekKeys = unionPeriodKeys_(weekByNat);     // "W7" ...
  renderRotationDetail_(grid, formats, nc, natTeams, weekByNat, weekKeys, function (k) { return k; }, 'rotW');
  grid.push(['ROTATION  (weekly trend summary)'], []);
  renderRotationTrend_(grid, formats, natTeams, weekByNat, weekKeys, function (k) { return k; });

  // daily: plain counts (not clickable -- see renderHeadcount_'s rationale)
  grid.push(['ROTATION  (daily, per team -- plain counts: the daily roster is the raw tab, filtered by date)'], []);
  renderRotationDaily_(grid, natTeams, dayByNat, dayOrder_(slim));

  return { grid: grid, formats: formats };
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

// hex "#rrggbb" -> {red,green,blue} in 0..1, the shape the Sheets API wants.
function hexColor_(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 };
}

// turn one abstract format instruction (grid-relative row/col from fmtCell_ /
// fmtRange_) into real Sheets API request(s) against this tab's sheetId.
function formatRequests_(sheetId, f) {
  const out = [];
  const endCol = (f.colEnd == null ? f.col : f.colEnd) + 1;
  if (f.bg != null || f.fg != null || f.bold != null) {
    const cell = { userEnteredFormat: {} };
    const fields = [];
    if (f.bg != null) { cell.userEnteredFormat.backgroundColor = hexColor_(f.bg); fields.push('userEnteredFormat.backgroundColor'); }
    if (f.fg != null || f.bold != null) {
      cell.userEnteredFormat.textFormat = {};
      if (f.fg != null) { cell.userEnteredFormat.textFormat.foregroundColor = hexColor_(f.fg); fields.push('userEnteredFormat.textFormat.foregroundColor'); }
      if (f.bold != null) { cell.userEnteredFormat.textFormat.bold = f.bold; fields.push('userEnteredFormat.textFormat.bold'); }
    }
    out.push({ repeatCell: {
      range: { sheetId: sheetId, startRowIndex: f.row, endRowIndex: f.row + 1, startColumnIndex: f.col, endColumnIndex: endCol },
      cell: cell, fields: fields.join(','),
    } });
  }
  if (f.border) {
    const range = { sheetId: sheetId, startRowIndex: f.row, endRowIndex: f.row + 1, startColumnIndex: f.col, endColumnIndex: endCol };
    const style = { style: 'SOLID_MEDIUM', color: { red: 0, green: 0, blue: 0 } };
    out.push({ updateBorders: { range: range, top: style, bottom: style, left: style, right: style } });
  }
  return out;
}

// resize a tab to its actual grid, then write it. values.update (unlike
// values.append) does NOT auto-grow, so the grid must be sized first; sizing to
// exactly the content also keeps the workbook well under the 10M-cell cap. The
// aspect tabs use USER_ENTERED (so the =HYPERLINK counts become live links); the
// Names tab passes RAW so a worker name that happens to start with "="/"-"/"+"
// is stored literally, not misread as a formula. formats (optional) is the list
// of cell-coloring instructions built by fmtCell_/fmtRange_ (Show Up so far) --
// applied last, in one batchUpdate, after the values are in place.
function writeSummaryTab_(ss, sheetId, tabName, grid, inputOption, formats) {
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
  // -- the request is simply too big. NOTE the binding limit here is the ~10MB
  // per-REQUEST payload cap, NOT the 10M-cells-per-workbook cap (that's total,
  // across all tabs, and is handled by splitting Names into separate files). So
  // the chunk is sized to keep each request comfortably under ~10MB: 50k rows x 8
  // short RAW cells ~= 5-6MB. Going much higher (e.g. 80k) re-risks the 500.
  // Each chunk targets a fixed A<start> range so a retry is idempotent. Rows are
  // padded to the common width per chunk (not up front) to avoid one giant rect.
  const io = inputOption || 'USER_ENTERED';
  const CHUNK = 50000;
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
  if (formats && formats.length) {
    var requests = [];
    formats.forEach(function (f) { requests = requests.concat(formatRequests_(sheetId, f)); });
    retryWrite_(function () { return Sheets.Spreadsheets.batchUpdate({ requests: requests }, id); });
  }
  // auto-fit column widths to their content ("text should fit cell" -- long
  // headers like "Non Rotation and show up 1 day in month" were getting clipped
  // at the default column width). Only for the aspect tabs (USER_ENTERED): the
  // Names files (RAW) are hundreds of thousands of rows and this is purely
  // cosmetic there, not worth the extra API call on an already-heavy write.
  if (io === 'USER_ENTERED') {
    retryWrite_(function () {
      return Sheets.Spreadsheets.batchUpdate({ requests: [{ autoResizeDimensions: {
        dimensions: { sheetId: sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: width },
      } }] }, id);
    });
  }
}

// ------------------------------------------------------------------ main sync
// ONE DEPARTMENT PER EXECUTION. Measured live (2026-07-15, half-year data): a full
// all-departments sync took 29.7 min -- 23 min of it reading the 28 vendor files +
// appending raw rows, ~7 min summaries -- so a full year would blow the ~30-min
// execution ceiling. The three SOCs share nothing (separate vendor files in,
// separate central files out), so the daily schedule runs one dept per execution
// (~1/3 the work, and bounded: a year's file set caps at 12 months). Triggers
// can't pass arguments, so each dept gets a thin named wrapper; installTrigger()
// installs one staggered daily trigger per department.
function syncSOCN() { return runSync_('SOCN'); }
function syncSOCE() { return runSync_('SOCE'); }
function syncSOCW() { return runSync_('SOCW'); }

// manual all-departments run (smoke tests / small data). The daily schedule uses
// the per-dept wrappers above -- on full data this one exceeds the execution limit.
function sync() { return runSync_(null); }

function runSync_(deptFilter) {
  // ---- timing instrumentation: pinpoint where a long run spends its time so the
  // right lever gets pulled. Measured: read+append dominates (78%), not the Names
  // writes. Keep until the per-dept split is confirmed comfortably under the limit.
  const T0 = Date.now();
  function since_() { return ((Date.now() - T0) / 1000).toFixed(1) + 's'; }

  const conf = cfg_();
  let files = discoverFiles_(conf.departments, conf.thaiVendors);
  if (deptFilter) {
    // discovery stays global (cheap, and keeps its strict validation over EVERY
    // file title); the filter only narrows which files this execution processes.
    files = files.filter(function (f) { return f.dept === deptFilter; });
    if (!files.length) {
      throw new Error("no raw vendor spreadsheets found for department '" + deptFilter + "'");
    }
  }
  Logger.log('[t] discovery done: ' + files.length + ' files' +
    (deptFilter ? ' for ' + deptFilter : '') + ' @ ' + since_());

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
    const tf = Date.now();
    let read;
    try {
      read = readMonthTabs_(f.id, f.year.slice(-2));
    } catch (e) {
      throw new Error("reading '" + f.name + "' (id=" + f.id + ", dept=" + f.dept +
        ", vendor=" + f.vendor + "): " + e.message);
    }
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
        r.nationality = f.nationality;   // Thai/Burmese, from the vendor
        const y = String(r.date.y);
        (rowsByYear[y] = rowsByYear[y] || []).push(r);
      });
    });
    let fileRows = 0;
    Object.keys(rowsByYear).forEach(function (y) {
      const ctx = socCtx_(y, f.dept);
      // dedup one row per (name,date) across THIS file's tabs before writing the
      // raw tab -- month-boundary overlap (a 'Mar 26' tab carrying the same Apr-1
      // show-up as 'Apr 26', confirmed live for SPT). Keeps earliest clock-in.
      const rows = dedupByNameDate_(rowsByYear[y]);
      appendRawRows_(ctx.ss, rows);
      fileRows += rows.length;
      // slim slice carries the full raw-column set (not just name/date/team) so the
      // Names drill-down can render every raw column for each counted person.
      rows.forEach(function (r) {
        ctx.slim.push({ name: r.name, date: r.date, team: r.team, clockin: r.clockin,
          vendor: r.vendor, shift_name: r.shift_name, shift_id: r.shift_id, month: r.month,
          nationality: r.nationality });
      });
    });
    Logger.log('[t] ' + f.dept + '/' + f.vendor + ': ' + read.titles.length + ' tabs, ' +
      fileRows + ' rows, ' + ((Date.now() - tf) / 1000).toFixed(1) + 's @ ' + since_());
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
  Logger.log('[t] all files read + raw appended @ ' + since_());
  const result = {};
  Object.keys(socData).forEach(function (k) {
    const ctx = socData[k];
    const slim = dedupByNameDate_(ctx.slim);
    const namesIds = {};
    ASPECT_TABS.forEach(function (tab) {
      const nf = ctx.namesFiles[tab];
      const nc = namesCollector_(nf.ss.getId(), nf.gid);
      const tb = Date.now();
      const built = aspectGrids[tab](slim, nc, ctx.dept);   // {grid, formats}; dept -> "All <DEPT>" label
      const buildS = ((Date.now() - tb) / 1000).toFixed(1);
      const tw = Date.now();
      writeSummaryTab_(ctx.ss, ctx.sheetIds[tab], tab, built.grid, 'USER_ENTERED', built.formats);
      const sumS = ((Date.now() - tw) / 1000).toFixed(1);
      const tn = Date.now();
      writeSummaryTab_(nf.ss, nf.gid, NAMES_TAB, nc.rows, 'RAW');
      const namesS = ((Date.now() - tn) / 1000).toFixed(1);
      Logger.log('[t] ' + ctx.dept + '/' + tab + ': build=' + buildS + 's write=' +
        sumS + 's names=' + namesS + 's (' + nc.rows.length + ' name rows) @ ' + since_());
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
  const files = discoverFiles_(conf.departments, conf.thaiVendors);
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
  const files = discoverFiles_(conf.departments, conf.thaiVendors);
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
  const files = discoverFiles_(conf.departments, conf.thaiVendors);
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
  const files = discoverFiles_(conf.departments, conf.thaiVendors);
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

// install (idempotently) ONE daily time-based trigger PER DEPARTMENT, staggered
// an hour apart (11:00 / 12:00 / 13:00) -- a full all-departments sync exceeds
// the execution-time limit on full data, so each dept runs in its own execution
// (see the note above runSync_). Deletes any previous sync/syncDEPT triggers
// first. Departments come from RAW_DEPARTMENTS; each must have a syncDEPT
// wrapper (triggers can't pass arguments), so a dept without one is a hard
// error here, not a silent no-trigger.
function installTrigger() {
  const conf = cfg_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (/^sync/.test(t.getHandlerFunction())) ScriptApp.deleteTrigger(t);
  });
  conf.departments.forEach(function (d, i) {
    const fn = 'sync' + d;
    if (typeof globalThis[fn] !== 'function') {
      throw new Error("no trigger wrapper '" + fn + "' for department '" + d +
        "' -- add `function " + fn + "() { return runSync_('" + d + "'); }` to Code.gs");
    }
    ScriptApp.newTrigger(fn).timeBased().everyDays(1).atHour(11 + i).create();
    Logger.log('Daily trigger installed: ' + fn + '() ~' + (11 + i) + ':00 (project time zone).');
  });
}
