import json
import re
from typing import Dict

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth import require_api_key
from store import get_conn, now_ts

router = APIRouter(prefix="/v1/context", dependencies=[Depends(require_api_key)])

PROJECT_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class ContextPayload(BaseModel):
    files: Dict[str, str] = Field(default_factory=dict)
    instructions: str = ""


@router.put("/{project}")
async def save_context(project: str, payload: ContextPayload):
    if not PROJECT_NAME_RE.match(project):
        raise HTTPException(status_code=400, detail="Invalid project name")
    updated_at = now_ts()
    conn = get_conn()
    conn.execute(
        "INSERT INTO contexts (project, files, instructions, updated_at) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(project) DO UPDATE SET files = excluded.files, "
        "instructions = excluded.instructions, updated_at = excluded.updated_at",
        (project, json.dumps(payload.files), payload.instructions, updated_at),
    )
    conn.commit()
    conn.close()
    return {"project": project, "file_count": len(payload.files), "updated_at": updated_at}


@router.get("")
async def list_contexts():
    conn = get_conn()
    rows = conn.execute("SELECT project, updated_at FROM contexts ORDER BY updated_at DESC").fetchall()
    conn.close()
    return {"projects": [dict(row) for row in rows]}


@router.get("/{project}")
async def read_context(project: str):
    conn = get_conn()
    row = conn.execute(
        "SELECT project, files, instructions, updated_at FROM contexts WHERE project = ?",
        (project,),
    ).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Project context not found")
    return {
        "project": row["project"],
        "files": json.loads(row["files"]),
        "instructions": row["instructions"],
        "updated_at": row["updated_at"],
    }


@router.delete("/{project}")
async def delete_context(project: str):
    conn = get_conn()
    cursor = conn.execute("DELETE FROM contexts WHERE project = ?", (project,))
    conn.commit()
    conn.close()
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Project context not found")
    return {"project": project, "deleted": True}
