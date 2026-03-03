import sqlite3
import json
import os

DB_PATH = os.getenv("SATEI_DB", os.path.join(os.path.dirname(__file__), "satei.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS inferences (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    model         TEXT NOT NULL,
    prompt        TEXT NOT NULL,
    response_text TEXT NOT NULL,
    is_json       INTEGER NOT NULL DEFAULT 0,
    parsed_json   TEXT,
    image_b64     TEXT NOT NULL,
    image_mime    TEXT DEFAULT 'image/png',
    duration_ms   INTEGER NOT NULL,
    ollama_meta   TEXT,
    status        TEXT NOT NULL DEFAULT 'success',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_inferences_created_at ON inferences(created_at DESC);

CREATE TABLE IF NOT EXISTS experiments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    prompt     TEXT NOT NULL,
    model      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS experiment_tests (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    experiment_id INTEGER NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
    label         TEXT NOT NULL DEFAULT '',
    image_b64     TEXT NOT NULL,
    image_mime    TEXT NOT NULL DEFAULT 'image/png',
    sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_experiment_tests_experiment
    ON experiment_tests(experiment_id, sort_order);

CREATE TABLE IF NOT EXISTS test_criteria (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    test_id        INTEGER NOT NULL REFERENCES experiment_tests(id) ON DELETE CASCADE,
    json_key       TEXT NOT NULL,
    expected_value TEXT NOT NULL,
    match_mode     TEXT NOT NULL DEFAULT 'exact'
);

CREATE INDEX IF NOT EXISTS idx_test_criteria_test ON test_criteria(test_id);

CREATE TABLE IF NOT EXISTS experiment_runs (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    experiment_id     INTEGER NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
    started_at        TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at      TEXT,
    total_duration_ms INTEGER DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'running'
);

CREATE INDEX IF NOT EXISTS idx_experiment_runs_experiment
    ON experiment_runs(experiment_id);

CREATE TABLE IF NOT EXISTS test_results (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id           INTEGER NOT NULL REFERENCES experiment_runs(id) ON DELETE CASCADE,
    test_id          INTEGER NOT NULL REFERENCES experiment_tests(id) ON DELETE CASCADE,
    response_text    TEXT NOT NULL,
    is_json          INTEGER NOT NULL DEFAULT 0,
    parsed_json      TEXT,
    duration_ms      INTEGER NOT NULL,
    ollama_meta      TEXT,
    passed           INTEGER NOT NULL DEFAULT 0,
    criteria_results TEXT
);

CREATE INDEX IF NOT EXISTS idx_test_results_run ON test_results(run_id);
"""


def _conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = _conn()
    conn.executescript(SCHEMA)
    # Migration: add status column to existing inferences table
    try:
        conn.execute("ALTER TABLE inferences ADD COLUMN status TEXT NOT NULL DEFAULT 'success'")
        conn.commit()
    except Exception:
        pass  # Column already exists
    conn.close()


# ── Inferences ───────────────────────────────────────────────

def save_inference(*, model, prompt, response_text, is_json, parsed_json,
                   image_b64, image_mime, duration_ms, ollama_meta,
                   status="success"):
    conn = _conn()
    cursor = conn.execute(
        "INSERT INTO inferences "
        "(model, prompt, response_text, is_json, parsed_json, image_b64, image_mime, duration_ms, ollama_meta, status) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            model, prompt, response_text, int(is_json),
            json.dumps(parsed_json) if parsed_json is not None else None,
            image_b64, image_mime, duration_ms,
            json.dumps(ollama_meta) if ollama_meta is not None else None,
            status,
        ),
    )
    conn.commit()
    row_id = cursor.lastrowid
    row = conn.execute("SELECT * FROM inferences WHERE id = ?", (row_id,)).fetchone()
    conn.close()
    return _row_to_dict(row)


def get_history(page=1, per_page=20):
    conn = _conn()
    total = conn.execute("SELECT COUNT(*) FROM inferences").fetchone()[0]
    offset = (page - 1) * per_page
    rows = conn.execute(
        "SELECT id, model, prompt, response_text, is_json, duration_ms, status, created_at "
        "FROM inferences ORDER BY created_at DESC LIMIT ? OFFSET ?",
        (per_page, offset),
    ).fetchall()
    conn.close()
    return {
        "items": [dict(r) for r in rows],
        "total": total,
        "page": page,
        "per_page": per_page,
    }


def get_inference(inference_id):
    conn = _conn()
    row = conn.execute("SELECT * FROM inferences WHERE id = ?", (inference_id,)).fetchone()
    conn.close()
    if row is None:
        return None
    return _row_to_dict(row)


def delete_inference(inference_id):
    conn = _conn()
    conn.execute("DELETE FROM inferences WHERE id = ?", (inference_id,))
    conn.commit()
    conn.close()


def _row_to_dict(row):
    d = dict(row)
    if d.get("parsed_json"):
        d["parsed_json"] = json.loads(d["parsed_json"])
    if d.get("ollama_meta"):
        d["ollama_meta"] = json.loads(d["ollama_meta"])
    if "is_json" in d:
        d["is_json"] = bool(d["is_json"])
    return d


# ── Experiments ──────────────────────────────────────────────

def save_experiment(*, name, prompt, model):
    conn = _conn()
    cursor = conn.execute(
        "INSERT INTO experiments (name, prompt, model) VALUES (?, ?, ?)",
        (name, prompt, model),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM experiments WHERE id = ?", (cursor.lastrowid,)).fetchone()
    conn.close()
    return dict(row)


def get_experiments():
    conn = _conn()
    rows = conn.execute(
        "SELECT e.*, "
        "(SELECT COUNT(*) FROM experiment_tests WHERE experiment_id = e.id) AS test_count, "
        "(SELECT er.id FROM experiment_runs er WHERE er.experiment_id = e.id ORDER BY er.started_at DESC LIMIT 1) AS latest_run_id, "
        "(SELECT er.status FROM experiment_runs er WHERE er.experiment_id = e.id ORDER BY er.started_at DESC LIMIT 1) AS latest_run_status, "
        "(SELECT er.started_at FROM experiment_runs er WHERE er.experiment_id = e.id ORDER BY er.started_at DESC LIMIT 1) AS latest_run_at "
        "FROM experiments e ORDER BY e.created_at DESC"
    ).fetchall()
    items = []
    for r in rows:
        d = dict(r)
        # Get pass count for latest run
        if d.get("latest_run_id"):
            run_stats = conn.execute(
                "SELECT COUNT(*) AS total, SUM(passed) AS passed "
                "FROM test_results WHERE run_id = ?",
                (d["latest_run_id"],),
            ).fetchone()
            d["latest_run_passed"] = run_stats["passed"] or 0
            d["latest_run_total"] = run_stats["total"] or 0
        items.append(d)
    conn.close()
    return {"items": items}


def get_experiment(experiment_id):
    conn = _conn()
    row = conn.execute("SELECT * FROM experiments WHERE id = ?", (experiment_id,)).fetchone()
    if row is None:
        conn.close()
        return None
    exp = dict(row)

    # Get tests with criteria
    tests = conn.execute(
        "SELECT id, experiment_id, label, image_mime, sort_order "
        "FROM experiment_tests WHERE experiment_id = ? ORDER BY sort_order, id",
        (experiment_id,),
    ).fetchall()
    exp["tests"] = []
    for t in tests:
        td = dict(t)
        criteria = conn.execute(
            "SELECT * FROM test_criteria WHERE test_id = ?", (t["id"],)
        ).fetchall()
        td["criteria"] = [dict(c) for c in criteria]
        exp["tests"].append(td)

    conn.close()
    return exp


def get_experiment_with_images(experiment_id):
    """Like get_experiment but includes image_b64 for running tests."""
    conn = _conn()
    row = conn.execute("SELECT * FROM experiments WHERE id = ?", (experiment_id,)).fetchone()
    if row is None:
        conn.close()
        return None
    exp = dict(row)

    tests = conn.execute(
        "SELECT * FROM experiment_tests WHERE experiment_id = ? ORDER BY sort_order, id",
        (experiment_id,),
    ).fetchall()
    exp["tests"] = []
    for t in tests:
        td = dict(t)
        criteria = conn.execute(
            "SELECT * FROM test_criteria WHERE test_id = ?", (t["id"],)
        ).fetchall()
        td["criteria"] = [dict(c) for c in criteria]
        exp["tests"].append(td)

    conn.close()
    return exp


def update_experiment(experiment_id, *, name, prompt, model):
    conn = _conn()
    conn.execute(
        "UPDATE experiments SET name = ?, prompt = ?, model = ? WHERE id = ?",
        (name, prompt, model, experiment_id),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM experiments WHERE id = ?", (experiment_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def delete_experiment(experiment_id):
    conn = _conn()
    conn.execute("DELETE FROM experiments WHERE id = ?", (experiment_id,))
    conn.commit()
    conn.close()


# ── Tests ────────────────────────────────────────────────────

def save_test(*, experiment_id, label, image_b64, image_mime, criteria):
    conn = _conn()
    max_order = conn.execute(
        "SELECT COALESCE(MAX(sort_order), -1) FROM experiment_tests WHERE experiment_id = ?",
        (experiment_id,),
    ).fetchone()[0]

    cursor = conn.execute(
        "INSERT INTO experiment_tests (experiment_id, label, image_b64, image_mime, sort_order) "
        "VALUES (?, ?, ?, ?, ?)",
        (experiment_id, label, image_b64, image_mime, max_order + 1),
    )
    test_id = cursor.lastrowid

    for c in criteria:
        conn.execute(
            "INSERT INTO test_criteria (test_id, json_key, expected_value, match_mode) "
            "VALUES (?, ?, ?, ?)",
            (test_id, c["json_key"], c["expected_value"], c.get("match_mode", "exact")),
        )

    conn.commit()

    # Fetch created test with criteria
    test_row = conn.execute(
        "SELECT id, experiment_id, label, image_mime, sort_order "
        "FROM experiment_tests WHERE id = ?", (test_id,)
    ).fetchone()
    td = dict(test_row)
    criteria_rows = conn.execute(
        "SELECT * FROM test_criteria WHERE test_id = ?", (test_id,)
    ).fetchall()
    td["criteria"] = [dict(c) for c in criteria_rows]
    conn.close()
    return td


def get_test_image(test_id):
    conn = _conn()
    row = conn.execute(
        "SELECT image_b64, image_mime FROM experiment_tests WHERE id = ?", (test_id,)
    ).fetchone()
    conn.close()
    if row is None:
        return None
    return dict(row)


def delete_test(test_id):
    conn = _conn()
    conn.execute("DELETE FROM experiment_tests WHERE id = ?", (test_id,))
    conn.commit()
    conn.close()


# ── Runs ─────────────────────────────────────────────────────

def create_run(experiment_id):
    conn = _conn()
    cursor = conn.execute(
        "INSERT INTO experiment_runs (experiment_id) VALUES (?)",
        (experiment_id,),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM experiment_runs WHERE id = ?", (cursor.lastrowid,)).fetchone()
    conn.close()
    return dict(row)


def save_test_result(*, run_id, test_id, response_text, is_json, parsed_json,
                     duration_ms, ollama_meta, passed, criteria_results):
    conn = _conn()
    conn.execute(
        "INSERT INTO test_results "
        "(run_id, test_id, response_text, is_json, parsed_json, duration_ms, ollama_meta, passed, criteria_results) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            run_id, test_id, response_text, int(is_json),
            json.dumps(parsed_json) if parsed_json is not None else None,
            duration_ms,
            json.dumps(ollama_meta) if ollama_meta is not None else None,
            int(passed),
            json.dumps(criteria_results) if criteria_results is not None else None,
        ),
    )
    conn.commit()
    conn.close()


def complete_run(run_id, total_duration_ms):
    conn = _conn()
    conn.execute(
        "UPDATE experiment_runs SET status = 'completed', completed_at = datetime('now'), "
        "total_duration_ms = ? WHERE id = ?",
        (total_duration_ms, run_id),
    )
    conn.commit()
    conn.close()


def fail_run(run_id):
    conn = _conn()
    conn.execute(
        "UPDATE experiment_runs SET status = 'failed', completed_at = datetime('now') WHERE id = ?",
        (run_id,),
    )
    conn.commit()
    conn.close()


def get_runs(experiment_id):
    conn = _conn()
    rows = conn.execute(
        "SELECT er.*, "
        "(SELECT COUNT(*) FROM test_results WHERE run_id = er.id) AS results_count, "
        "(SELECT SUM(passed) FROM test_results WHERE run_id = er.id) AS passed_count "
        "FROM experiment_runs er WHERE er.experiment_id = ? ORDER BY er.started_at DESC",
        (experiment_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_run_detail(run_id):
    conn = _conn()
    run_row = conn.execute("SELECT * FROM experiment_runs WHERE id = ?", (run_id,)).fetchone()
    if run_row is None:
        conn.close()
        return None
    run = dict(run_row)

    results = conn.execute(
        "SELECT tr.*, et.label, et.image_mime "
        "FROM test_results tr "
        "JOIN experiment_tests et ON tr.test_id = et.id "
        "WHERE tr.run_id = ? ORDER BY et.sort_order, et.id",
        (run_id,),
    ).fetchall()

    run["results"] = []
    for r in results:
        d = dict(r)
        if d.get("parsed_json"):
            d["parsed_json"] = json.loads(d["parsed_json"])
        if d.get("ollama_meta"):
            d["ollama_meta"] = json.loads(d["ollama_meta"])
        if d.get("criteria_results"):
            d["criteria_results"] = json.loads(d["criteria_results"])
        d["is_json"] = bool(d["is_json"])
        d["passed"] = bool(d["passed"])
        # Get criteria for this test
        criteria = conn.execute(
            "SELECT * FROM test_criteria WHERE test_id = ?", (d["test_id"],)
        ).fetchall()
        d["criteria"] = [dict(c) for c in criteria]
        run["results"].append(d)

    conn.close()
    return run


def get_latest_run(experiment_id):
    conn = _conn()
    row = conn.execute(
        "SELECT id FROM experiment_runs WHERE experiment_id = ? ORDER BY started_at DESC LIMIT 1",
        (experiment_id,),
    ).fetchone()
    conn.close()
    if row is None:
        return None
    return get_run_detail(row["id"])
