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
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_inferences_created_at ON inferences(created_at DESC);
"""


def _conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = _conn()
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()


def save_inference(*, model, prompt, response_text, is_json, parsed_json,
                   image_b64, image_mime, duration_ms, ollama_meta):
    conn = _conn()
    cursor = conn.execute(
        "INSERT INTO inferences "
        "(model, prompt, response_text, is_json, parsed_json, image_b64, image_mime, duration_ms, ollama_meta) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            model, prompt, response_text, int(is_json),
            json.dumps(parsed_json) if parsed_json is not None else None,
            image_b64, image_mime, duration_ms,
            json.dumps(ollama_meta) if ollama_meta is not None else None,
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
        "SELECT id, model, prompt, response_text, is_json, duration_ms, created_at "
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
    d["is_json"] = bool(d["is_json"])
    return d
