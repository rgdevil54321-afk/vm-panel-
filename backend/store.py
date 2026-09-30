import os
import re
import sqlite3
from datetime import datetime

DB_FILE = os.getenv("API_KEY_FILE", "api_keys.db")


def now_ts() -> int:
    return int(datetime.now().timestamp())


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = get_conn()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS api_keys (
            id TEXT PRIMARY KEY,
            name TEXT,
            created_at INTEGER,
            expires_at INTEGER,
            is_active INTEGER DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            role TEXT,
            content TEXT,
            created_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS knowledge (
            id TEXT PRIMARY KEY,
            title TEXT,
            content TEXT,
            created_at INTEGER,
            updated_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS contexts (
            project TEXT PRIMARY KEY,
            files TEXT,
            instructions TEXT,
            updated_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS request_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER,
            path TEXT,
            method TEXT,
            status INTEGER,
            api_key TEXT,
            latency_ms REAL,
            prompt_tokens INTEGER,
            completion_tokens INTEGER
        );
        """
    )
    conn.commit()
    conn.close()


def log_request(
    path: str,
    method: str,
    status: int,
    latency_ms: float,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
) -> None:
    conn = get_conn()
    conn.execute(
        "INSERT INTO request_logs (ts, path, method, status, api_key, latency_ms, prompt_tokens, completion_tokens) "
        "VALUES (?, ?, ?, ?, NULL, ?, ?, ?)",
        (now_ts(), path, method, status, latency_ms, prompt_tokens, completion_tokens),
    )
    conn.commit()
    conn.close()


def tokenize(text: str) -> list:
    return re.findall(r"[a-z0-9]+", text.lower())
