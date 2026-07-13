/**
 * n8n Code node "Build Ranges".
 * Mode: "Run Once for Each Item". Language: JavaScript.
 *
 * Sits between:
 *   [Get Tabs]  (HTTP GET spreadsheets/{id}?fields=sheets.properties.title)
 *   -> THIS node
 *   -> [Batch Read] (HTTP GET {{ $json.batchGetUrl }})
 *
 * For the current file it: reads the tab titles from the Get Tabs response,
 * keeps only the month tabs ("Jun 26" / "July 26"), and builds the
 * values:batchGet URL that reads every one of them in a single API call.
 * The file's id/dept/vendor/year are carried through from the "Parse Titles"
 * node (paired item), since the HTTP response replaced this item's json.
 *
 * IMPORTANT: this references $('Parse Titles') by node name -- your parse
 * Code node MUST be named exactly "Parse Titles" (rename it if needed).
 */

const MONTH_NAMES = new Set();
["january", "february", "march", "april", "may", "june", "july",
 "august", "september", "october", "november", "december"].forEach((full) => {
  MONTH_NAMES.add(full);
  MONTH_NAMES.add(full.slice(0, 3));
});

// "Jun 26" / "July 26" -> true (matches app.py _is_month_tab: "%b %y" | "%B %y")
function isMonthTab(title) {
  const t = String(title).trim().split(/\s+/);
  if (t.length !== 2) return false;
  if (!MONTH_NAMES.has(t[0].toLowerCase())) return false;
  return /^\d{2}$/.test(t[1]);
}

// single-quote a sheet title for an A1 range ('' escapes a literal quote)
function quoted(title) {
  return "'" + String(title).replace(/'/g, "''") + "'";
}

const ctx = $('Parse Titles').item.json;      // {id, name, dept, vendor, year}
const resp = $json;                            // Get Tabs response

const sheets = (resp.sheets || []).map((s) => (s.properties && s.properties.title) || "");
const monthTabs = sheets.filter(isMonthTab);

if (monthTabs.length === 0) {
  throw new Error(
    `'${ctx.name}' (dept=${ctx.dept}, vendor=${ctx.vendor}) has no month tabs ` +
    `(looked for "Jun 26" / "July 26" style titles among: ${JSON.stringify(sheets)}) ` +
    `-- schema drift or an empty file`
  );
}

const base = `https://sheets.googleapis.com/v4/spreadsheets/${ctx.id}/values:batchGet`;
// Cap each range to columns A:J -- the engine only reads the first ~8 columns
// (วันที่..team), so pulling whole tabs just drags in junk/wide columns from
// broken formulas and bloats the response. Bounding width shrinks every read
// and defuses ultra-wide rows at the source.
const rangesQs = monthTabs.map((t) => "ranges=" + encodeURIComponent(quoted(t) + "!A:J")).join("&");
const batchGetUrl = `${base}?${rangesQs}&majorDimension=ROWS`;

return {
  json: {
    id: ctx.id, name: ctx.name, dept: ctx.dept, vendor: ctx.vendor, year: ctx.year,
    monthTabs: monthTabs,
    batchGetUrl: batchGetUrl,
  },
};
