import secrets
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import require_admin
from store import get_conn, now_ts

router = APIRouter(prefix="/admin", dependencies=[Depends(require_admin)])


class ApiKeyCreate(BaseModel):
    name: str = "default"
    expires_days: Optional[int] = None


@router.post("/keys")
async def create_key(payload: ApiKeyCreate):
    key = "vlix-" + secrets.token_urlsafe(32)
    created_at = now_ts()
    expires_at = created_at + payload.expires_days * 86400 if payload.expires_days else None
    conn = get_conn()
    conn.execute(
        "INSERT INTO api_keys (id, name, created_at, expires_at, is_active) VALUES (?, ?, ?, ?, 1)",
        (key, payload.name, created_at, expires_at),
    )
    conn.commit()
    conn.close()
    return {"id": key, "name": payload.name, "created_at": created_at, "expires_at": expires_at}


@router.get("/keys")
async def list_keys():
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, name, created_at, expires_at, is_active FROM api_keys ORDER BY created_at DESC"
    ).fetchall()
    conn.close()
    return {"keys": [dict(row) for row in rows]}


@router.delete("/keys/{key_id}")
async def revoke_key(key_id: str):
    conn = get_conn()
    cursor = conn.execute("UPDATE api_keys SET is_active = 0 WHERE id = ?", (key_id,))
    conn.commit()
    conn.close()
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Key not found")
    return {"id": key_id, "status": "revoked"}


@router.get("/stats")
async def admin_stats():
    conn = get_conn()

    def count(sql: str) -> int:
        return conn.execute(sql).fetchone()[0]

    stats = {
        "active_keys": count("SELECT COUNT(*) FROM api_keys WHERE is_active = 1"),
        "total_keys": count("SELECT COUNT(*) FROM api_keys"),
        "knowledge_documents": count("SELECT COUNT(*) FROM knowledge"),
        "memory_sessions": count("SELECT COUNT(DISTINCT session_id) FROM memories"),
        "contexts": count("SELECT COUNT(*) FROM contexts"),
        "total_requests": count("SELECT COUNT(*) FROM request_logs"),
        "prompt_tokens": count("SELECT COALESCE(SUM(prompt_tokens), 0) FROM request_logs"),
        "completion_tokens": count("SELECT COALESCE(SUM(completion_tokens), 0) FROM request_logs"),
    }
    conn.close()
    return stats
