"""
Tests for app.py's discovery/parsing/write logic, using mocked Google APIs
(no live credentials). Run: python render/test_sync.py
"""
import datetime as dt
import os

import pandas as pd

os.environ.setdefault("GOOGLE_SERVICE_ACCOUNT_JSON", "{}")
os.environ.setdefault("CENTRAL_FOLDER_ID", "fake-central-folder")
os.environ.setdefault("RAW_DEPARTMENTS", "SOCN,SOCE,SOCW,FSOCW")
os.environ.setdefault("SYNC_TOKEN", "test-token")

import app


def _fake_raw_values(rows):
    """rows: list of (name, date, team) -> a gspread worksheet.get_all_values()-style
    grid (header + string rows), matching the real export's column set including
    the duplicate วันที่ header app._mangle_dupe_cols is meant to handle."""
    header = ["วันที่", "ค้นหา", "เข้างาน", "shift name", "วันที่", "BTS", "Shift_id", "team"]
    out = [header]
    for name, date, team in rows:
        out.append([
            date.strftime("%d %b %y"), name, "09:00", "Test Shift",
            date.strftime("%Y-%m-%d"), "SITE", "SH-1", team,
        ])
    return out


# ---------------------------------------------------------------- pure functions
def test_parse_raw_title():
    assert app._parse_raw_title("[SOCE 2026]_Daily name list_BTS") == ("SOCE", "2026", "BTS")
    assert app._parse_raw_title("[socn 2027]_Daily name list_CYD") == ("SOCN", "2027", "CYD")
    assert app._parse_raw_title("random file") is None
    assert app._parse_raw_title("[SOCE2026]_Daily name list_BTS") is None      # no space before year
    assert app._parse_raw_title("[SOCE 26]_Daily name list_BTS") is None       # year not 4 digits
    assert app._parse_raw_title("[SOCE 2026]_Daily name list_") is None        # empty vendor
    print("test_parse_raw_title passed")


def test_to_raw_tab():
    df = pd.DataFrame([{
        "name": "alice", "date": dt.date(2026, 6, 1), "team": "IB",
        "clockin": "09:00", "shift_name": "Inbound", "shift_id": "IB-1",
        "month": "Jun", "vendor": "BTS", "department": "SOCE",
    }])
    out = app._to_raw_tab(df)
    assert list(out.columns) == ["Date show up", "Month show up", "Sub-con name", "Name",
                                  "Clock in", "shift name", "Shift_id", "team"]
    assert out.iloc[0]["Sub-con name"] == "BTS"
    assert out.iloc[0]["Name"] == "alice"

    empty = app._to_raw_tab(df.iloc[0:0])
    assert list(empty.columns) == list(app.RAW_TAB_COLUMNS.values())
    assert len(empty) == 0
    print("test_to_raw_tab passed")


def test_list_raw_candidates_pagination():
    page1 = {"files": [{"id": "1", "name": "[SOCE 2026]_Daily name list_BTS"}], "nextPageToken": "p2"}
    page2 = {"files": [{"id": "2", "name": "[SOCE 2026]_Daily name list_CYD"}]}

    class FakeExec:
        def __init__(self, resp):
            self._resp = resp

        def execute(self):
            return self._resp

    class FakeFilesList:
        def __init__(self):
            self.calls = 0

        def __call__(self, **kwargs):
            self.calls += 1
            return FakeExec(page1 if self.calls == 1 else page2)

    class FakeFiles:
        def __init__(self):
            self.list = FakeFilesList()

    class FakeDrive:
        def __init__(self):
            self._files = FakeFiles()

        def files(self):
            return self._files

    files = app._list_raw_candidates(FakeDrive())
    assert [f["id"] for f in files] == ["1", "2"]
    print("test_list_raw_candidates_pagination passed")


# ---------------------------------------------------------------- end-to-end mock
class FakeWorksheet:
    def __init__(self, title, values=None):
        self.title = title
        self._values = values or []
        self.written = None

    def get_all_values(self):
        return self._values

    def clear(self):
        pass

    def update(self, values):
        self.written = values


class FakeSpreadsheetRaw:
    def __init__(self, tabs):
        self._tabs = tabs

    def worksheets(self):
        return self._tabs


class FakeCentralSpreadsheet:
    def __init__(self, id_):
        self.id = id_
        self._tabs = {}

    def worksheets(self):
        return list(self._tabs.values())

    def worksheet(self, name):
        return self._tabs[name]

    def add_worksheet(self, name, rows, cols):
        ws = FakeWorksheet(name)
        self._tabs[name] = ws
        return ws


class FakeClient:
    """No create() -- app.py no longer auto-creates central spreadsheets (a bare
    service account has ~0 Drive storage quota, confirmed live; see _find_central's
    docstring). Tests must pre-populate `centrals` for the "found" path."""

    def __init__(self, raw_files, centrals=None):
        self._raw_files = raw_files
        self.centrals = centrals or {}

    def open_by_key(self, file_id):
        if file_id in self._raw_files:
            return self._raw_files[file_id]
        return self.centrals[file_id]

    def list_spreadsheet_files(self, title, folder_id):
        return [{"id": title}] if title in self.centrals else []


class FakeDriveNoop:
    """run_sync() only uses `drive` via _list_raw_candidates, which this test
    bypasses by monkeypatching app._clients directly -- placeholder only."""


def test_run_sync_end_to_end_multi_vendor():
    def d(day):
        return dt.date(2026, 6, day)

    bts_values = _fake_raw_values([
        ("alice", d(1), "IB"), ("alice", d(2), "IB"), ("bob", d(1), "MS"),
    ])
    cyd_values = _fake_raw_values([
        ("carol", d(3), "IB"), ("dave", d(4), "OBD"),
    ])
    raw_files = {
        "bts-id": FakeSpreadsheetRaw([FakeWorksheet("Jun 26", bts_values), FakeWorksheet("Notes", [])]),
        "cyd-id": FakeSpreadsheetRaw([FakeWorksheet("Jun 26", cyd_values)]),
    }
    # central sheet must already exist -- app.py no longer creates it (quota)
    fake_client = FakeClient(raw_files, centrals={"2026": FakeCentralSpreadsheet("2026")})
    candidates = [
        {"id": "bts-id", "name": "[SOCE 2026]_Daily name list_BTS"},
        {"id": "cyd-id", "name": "[SOCE 2026]_Daily name list_CYD"},
    ]

    app._clients = lambda: (fake_client, FakeDriveNoop())
    app._list_raw_candidates = lambda drive: candidates

    result = app.run_sync()

    assert result["years"].keys() == {"2026"}
    y = result["years"]["2026"]
    assert y["workers"] == 4          # alice, bob, carol, dave
    assert y["rows"] == 5
    assert y["departments"] == ["SOCE"]

    central = fake_client.centrals["2026"]
    assert set(central._tabs.keys()) == {"SOCN", "SOCE", "SOCW", "FSOCW", "Summary_1", "Summary_Rotation", "Summary_5"}

    soce_written = central.worksheet("SOCE").written
    assert soce_written[0] == list(app.RAW_TAB_COLUMNS.values())
    assert len(soce_written) - 1 == 5   # header + 5 data rows
    vendors_written = {row[2] for row in soce_written[1:]}   # "Sub-con name" column
    assert vendors_written == {"BTS", "CYD"}

    # a known department with zero rows this year still gets a header-only tab
    socn_written = central.worksheet("SOCN").written
    assert socn_written == [list(app.RAW_TAB_COLUMNS.values())]

    print("test_run_sync_end_to_end_multi_vendor passed")


def test_run_sync_throws_on_unmatched_title():
    candidates = [{"id": "x", "name": "not a match"}]
    app._clients = lambda: (FakeClient({}), FakeDriveNoop())
    app._list_raw_candidates = lambda drive: candidates
    try:
        app.run_sync()
        raise AssertionError("expected ValueError for unmatched title")
    except ValueError as e:
        assert "doesn't match" in str(e)
    print("test_run_sync_throws_on_unmatched_title passed")


def test_run_sync_throws_on_unknown_department():
    candidates = [{"id": "x", "name": "[ZZZZ 2026]_Daily name list_BTS"}]
    app._clients = lambda: (FakeClient({}), FakeDriveNoop())
    app._list_raw_candidates = lambda drive: candidates
    try:
        app.run_sync()
        raise AssertionError("expected ValueError for unrecognized department")
    except ValueError as e:
        assert "unrecognized department" in str(e)
    print("test_run_sync_throws_on_unknown_department passed")


def test_run_sync_throws_on_zero_matches():
    app._clients = lambda: (FakeClient({}), FakeDriveNoop())
    app._list_raw_candidates = lambda drive: []
    try:
        app.run_sync()
        raise AssertionError("expected RuntimeError for zero matches")
    except RuntimeError as e:
        assert "no raw vendor spreadsheets found" in str(e)
    print("test_run_sync_throws_on_zero_matches passed")


def test_run_sync_throws_when_central_missing():
    def d(day):
        return dt.date(2026, 6, day)

    values = _fake_raw_values([("alice", d(1), "IB")])
    raw_files = {"bts-id": FakeSpreadsheetRaw([FakeWorksheet("Jun 26", values)])}
    # centrals left empty -- app.py must not try to create one (quota) and
    # must instead throw a clear, actionable error
    fake_client = FakeClient(raw_files)
    candidates = [{"id": "bts-id", "name": "[SOCE 2026]_Daily name list_BTS"}]

    app._clients = lambda: (fake_client, FakeDriveNoop())
    app._list_raw_candidates = lambda drive: candidates
    try:
        app.run_sync()
        raise AssertionError("expected ValueError for missing central spreadsheet")
    except ValueError as e:
        assert "no spreadsheet titled '2026'" in str(e)
        assert "quota" in str(e)
    print("test_run_sync_throws_when_central_missing passed")


if __name__ == "__main__":
    test_parse_raw_title()
    test_to_raw_tab()
    test_list_raw_candidates_pagination()
    test_run_sync_end_to_end_multi_vendor()
    test_run_sync_throws_on_unmatched_title()
    test_run_sync_throws_on_unknown_department()
    test_run_sync_throws_on_zero_matches()
    test_run_sync_throws_when_central_missing()
    print("\nAll sync tests passed.")
