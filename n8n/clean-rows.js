/**
 * n8n Code node "Clean Rows".
 * Mode: "Run Once for Each Item". Language: JavaScript.
 *
 * HOW TO BUILD THIS NODE:
 *   Paste the FULL contents of engine.js first, then paste THIS footer at the
 *   very bottom (same pattern as running engine.js's self-tests). engine.js
 *   defines loadRawFromValues + all the date/cleaning helpers this uses.
 *
 * Sits in the read chain:
 *   [Parse Titles] -> [Get Tabs] -> [Build Ranges] -> [Batch Read] -> THIS
 * For ONE vendor file it: takes that file's values:batchGet response, cleans
 * every month tab through the engine (same cleaning as render/test.py), tags
 * each row with its department + vendor, and emits one item carrying all the
 * cleaned rows for that file. The next stage ("Compute") aggregates across
 * every file's item.
 *
 * The file's id/dept/vendor/monthTabs are carried through from [Build Ranges]
 * via the paired item -- the [Batch Read] HTTP response replaced this item's
 * json with the raw batchGet payload, so $('Build Ranges').item.json is how we
 * get the context back. IMPORTANT: the upstream node MUST be named exactly
 * "Build Ranges".
 */

// ======================= paste engine.js ABOVE this line =======================

const ctx = $('Build Ranges').item.json;      // {id, name, dept, vendor, year, monthTabs}
const resp = $json;                            // { valueRanges: [{range, values:[...]}, ...] }

const ranges = resp.valueRanges || [];
const monthTabs = ctx.monthTabs || [];

// valueRanges come back in the SAME order as the requested ranges (= monthTabs
// order); match by position, exactly like app.py _batch_get_month_tabs.
const rows = [];
for (let i = 0; i < monthTabs.length; i++) {
  const values = (ranges[i] && ranges[i].values) || [];
  if (!values.length) continue;                // empty/future month tab -- skip
  let cleaned;
  try {
    cleaned = loadRawFromValues(values);
  } catch (e) {
    // prefix with file/tab/dept/vendor so a live failure is diagnosable
    // without opening the sheet (mirrors app.py's run_sync wrapping).
    throw new Error(`'${ctx.name}' tab '${monthTabs[i]}' (dept=${ctx.dept}, vendor=${ctx.vendor}): ${e.message}`);
  }
  for (const r of cleaned) {
    r.dept = ctx.dept;
    r.vendor = ctx.vendor;
    rows.push(r);
  }
}

if (!rows.length) {
  throw new Error(
    `'${ctx.name}' (dept=${ctx.dept}, vendor=${ctx.vendor}) matched discovery but produced ` +
    `no cleaned rows across ${monthTabs.length} month tab(s) -- schema drift or an empty file`
  );
}

return [{
  json: {
    dept: ctx.dept,
    vendor: ctx.vendor,
    name: ctx.name,
    count: rows.length,
    rows: rows,
  },
}];
