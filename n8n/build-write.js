/**
 * n8n Code node "Build Write".
 * Mode: "Run Once for Each Item". Language: JavaScript.
 * (No engine.js needed here -- this is pure request-body assembly.)
 *
 * Sits at the end of the write chain:
 *   [Compute Tabs] -> [Get Central Meta] (HTTP GET the central spreadsheet's
 *   sheet list) -> THIS -> [Prepare] -> [Clear] -> [Write Dept] -> [Write Summary]
 *
 * It builds the four Google Sheets API request bodies that reproduce app.py's
 * per-year write exactly:
 *   prepareBody  -> spreadsheets.batchUpdate : add any missing tab, resize
 *                   every target tab to fit its grid (values:batchUpdate does
 *                   NOT grow a sheet, so this sizing is mandatory).
 *   clearBody    -> values:batchClear       : wipe all 7 tabs (recompute from
 *                   scratch, no stale rows).
 *   deptBody     -> values:batchUpdate RAW   : 4 department tabs (IDs like
 *                   Shift_id/team must not be reinterpreted as numbers).
 *   summaryBody  -> values:batchUpdate USER_ENTERED : 3 summary tabs (counts/
 *                   percentages land as real numbers, no leading apostrophe).
 *
 * Inputs it reads (by node name -- keep these names exact):
 *   $('Compute Tabs').item.json  -> {year, departments, summaryTabs, tabs}
 *   $json                        -> [Get Central Meta] response, the spreadsheet
 *                                   with sheets[].properties.{sheetId,title}
 *   $('Central').item.json.centralId -> the spreadsheet id for this year
 */

const compute = $('Compute Tabs').item.json;   // {year, departments, summaryTabs, tabs}
const meta = $json;                             // { sheets: [{properties:{sheetId,title}}], ... }
// Central is a single-item node upstream of the per-file fan-out, so .first()
// (not .item) -- paired-item lineage isn't reliable back across the aggregation.
const centralId = $('Central').first().json.centralId;

if (!centralId) throw new Error("Central.centralId is empty -- the find/create-central branch didn't set it");

const tabs = compute.tabs;
const deptNames = compute.departments;          // written RAW
const summaryNames = compute.summaryTabs;       // written USER_ENTERED
const allTitles = deptNames.concat(summaryNames);

const existing = {};
for (const s of (meta.sheets || [])) {
  if (s.properties && s.properties.title != null) existing[s.properties.title] = s.properties.sheetId;
}

function quoted(t) { return "'" + String(t).replace(/'/g, "''") + "'"; }

// size a tab to comfortably fit its grid (+buffer); values:batchUpdate can't grow it
function neededSize(grid) {
  const dataRows = grid ? grid.length : 1;
  const dataCols = (grid && grid[0]) ? grid[0].length : 1;
  return { rowCount: Math.max(dataRows + 50, 100), columnCount: Math.max(dataCols + 2, 26) };
}

// 1) prepare: add missing tabs, resize existing ones to fit
const requests = [];
for (const title of allTitles) {
  const size = neededSize(tabs[title]);
  if (title in existing) {
    requests.push({
      updateSheetProperties: {
        properties: { sheetId: existing[title], gridProperties: size },
        fields: "gridProperties.rowCount,gridProperties.columnCount",
      },
    });
  } else {
    requests.push({ addSheet: { properties: { title: title, gridProperties: size } } });
  }
}
const prepareBody = { requests: requests };

// 2) clear all 7 tabs
const clearBody = { ranges: allTitles.map(quoted) };

// 3) department values -- RAW
const deptBody = {
  valueInputOption: "RAW",
  data: deptNames.map((t) => ({ range: quoted(t) + "!A1", values: tabs[t] })),
};

// 4) summary values -- USER_ENTERED
const summaryBody = {
  valueInputOption: "USER_ENTERED",
  data: summaryNames.map((t) => ({ range: quoted(t) + "!A1", values: tabs[t] })),
};

return [{
  json: {
    centralId: centralId,
    year: compute.year,
    prepareBody: prepareBody,
    clearBody: clearBody,
    deptBody: deptBody,
    summaryBody: summaryBody,
  },
}];
