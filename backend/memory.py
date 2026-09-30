from typing import List, Optional, Dict, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import require_api_key
from store import get_conn, now_ts

router = APIRouter(prefix="/v1/memory", dependencies=[Depends(require_api_key)])


class MemoryMessage(BaseModel):
    role: str = "user"
    content: str


class MemoryAdd(BaseModel):
    messages: List[MemoryMessage]


def append_message(session_id: str, role: str, content: str) -> None:
    conn = get_conn()
    conn.execute(
        "INSERT INTO memories (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
        (session_id, role, content, now_ts()),
    )
    conn.commit()
    conn.close()


def get_messages(session_id: str) -> List[Dict[str, Any]]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT role, content, created_at FROM memories WHERE session_id = ? ORDER BY id",
        (session_id,),
    ).fetchall()
    conn.close()
    return [dict(row) for row in rows]


def clear_messages(session_id: str) -> int:
    conn = get_conn()
    cursor = conn.execute("DELETE FROM memories WHERE session_id = ?", (session_id,))
    conn.commit()
    conn.close()
    return cursor.rowcount


def build_summary(messages: List[Dict[str, Any]]) -> str:
    if not messages:
        return ""
    counts: Dict[str, int] = {}
    for message in messages:
        counts[message["role"]] = counts.get(message["role"], 0) + 1
    breakdown = ", ".join(f"{role}: {n}" for role, n in counts.items())
    first_user = next((m["content"] for m in messages if m["role"] == "user"), "")
    latest = messages[-1]["content"]
    summary = f"{len(messages)} messages ({breakdown})"
    if first_user:
        summary += f" | goal: {first_user[:200]}"
    if latest:
        summary += f" | latest: {latest[:160]}"
    return summary


@router.get("/sessions")
async def list_sessions():
    conn = get_conn()
    rows = conn.execute(
        "SELECT session_id, COUNT(*) AS message_count, MAX(created_at) AS updated_at "
        "FROM memories GROUP BY session_id ORDER BY updated_at DESC"
    ).fetchall()
    conn.close()
    return {"sessions": [dict(row) for row in rows]}


@router.post("/{session_id}")
async def add_memory(session_id: str, payload: MemoryAdd):
    if not payload.messages:
        raise HTTPException(status_code=400, detail="No messages provided")
    for message in payload.messages:
        append_message(session_id, message.role, message.content)
    return {"session_id": session_id, "stored": len(payload.messages)}


@router.get("/{session_id}")
async def read_memory(session_id: str):
    messages = get_messages(session_id)
    return {
        "session_id": session_id,
        "messages": messages,
        "summary": build_summary(messages),
    }


@router.delete("/{session_id}")
async def delete_memory(session_id: str):
    deleted = clear_messages(session_id)
    if deleted == 0:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"session_id": session_id, "deleted": deleted}
