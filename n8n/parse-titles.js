/**
 * n8n Code node: parse & validate raw vendor-file titles.
 * Mode: "Run Once for All Items". Language: JavaScript.
 *
 * INPUT  : items from a Google Drive "Search" node that lists every
 *          spreadsheet whose name contains "_Daily name list_".
 *          Each input item is expected to have json.id and json.name.
 *          (If your Drive node nests them, adjust `fileId`/`fileName` below.)
 * OUTPUT : one item per valid vendor file: {id, name, dept, vendor, year}.
 *
 * Mirrors render/app.py's discovery validation: a file that matched the
 * loose "_Daily name list_" search but does NOT match the strict
 * "[DEPT YEAR]_Daily name list_VENDOR" pattern, or whose department isn't
 * recognized, is a HARD ERROR (throw) -- silently skipping a malformed
 * match is exactly what caused the original undercount bug.
 */

// Edit this list if departments are ever added/renamed (successor-editable):
const KNOWN_DEPARTMENTS = ["SOCN", "SOCE", "SOCW", "FSOCW"];

const RAW_TITLE_RE = /^\[([A-Za-z]+)\s+(\d{4})\]_Daily name list_(.+)$/;

const known = new Set(KNOWN_DEPARTMENTS.map((d) => d.toUpperCase()));

// Accept either shape:
//  - HTTP Request to the Drive API: one item whose json has a `files` array
//  - Google Drive node: one item per file (json.id / json.name)
const files = [];
for (const item of items) {
  const j = item.json || {};
  if (Array.isArray(j.files)) {
    for (const f of j.files) files.push(f);
  } else {
    files.push(j);
  }
}

const out = [];
for (const f of files) {
  const fileId = f.id != null ? f.id : f.fileId;
  const fileName = f.name != null ? f.name : (f.title != null ? f.title : f.fileName);

  if (fileId == null || fileName == null) {
    throw new Error(
      "input item has no id/name -- point this node at the Drive search HTTP " +
      "Request (or Drive node). Got keys: " + JSON.stringify(Object.keys(f))
    );
  }

  const m = String(fileName).trim().match(RAW_TITLE_RE);
  if (!m) {
    throw new Error(
      `'${fileName}' (id ${fileId}) matched the raw discovery search but doesn't match the ` +
      `expected '[DEPT YEAR]_Daily name list_VENDOR' pattern -- rename it or narrow the search`
    );
  }
  const dept = m[1].toUpperCase();
  const year = m[2];
  const vendor = m[3].trim();
  if (!known.has(dept)) {
    throw new Error(
      `unrecognized department '${dept}' parsed from '${fileName}' -- ` +
      `expected one of ${JSON.stringify([...known].sort())}`
    );
  }

  out.push({ json: { id: fileId, name: fileName, dept: dept, vendor: vendor, year: year } });
}

if (out.length === 0) {
  throw new Error(
    "no raw vendor spreadsheets found -- check that the Drive search query is " +
    "`name contains \"_Daily name list_\"` and that the files are shared with the " +
    "Google account this workflow authenticates as"
  );
}

return out;
