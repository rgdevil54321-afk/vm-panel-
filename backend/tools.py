import os
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import require_api_key

router = APIRouter(prefix="/v1/tools", dependencies=[Depends(require_api_key)])

TOOL_WORKSPACE = Path(os.getenv("TOOL_WORKSPACE", os.path.join("data", "workspace"))).resolve()
TOOL_WORKSPACE.mkdir(parents=True, exist_ok=True)


class ReadRequest(BaseModel):
    path: str


class WriteRequest(BaseModel):
    path: str
    content: str


class ListRequest(BaseModel):
    path: str = ""


class DeleteRequest(BaseModel):
    path: str


def _resolve(path: str) -> Path:
    full = (TOOL_WORKSPACE / path).resolve()
    if full != TOOL_WORKSPACE and not full.is_relative_to(TOOL_WORKSPACE):
        raise HTTPException(status_code=400, detail="Path escapes the workspace")
    return full


@router.post("/read")
async def read_file(payload: ReadRequest):
    target = _resolve(payload.path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return {"path": payload.path, "content": target.read_text(encoding="utf-8", errors="replace")}


@router.post("/write")
async def write_file(payload: WriteRequest):
    target = _resolve(payload.path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(payload.content, encoding="utf-8")
    return {"path": payload.path, "bytes": len(payload.content.encode("utf-8"))}


@router.post("/list")
async def list_files(payload: ListRequest):
    target = _resolve(payload.path)
    if not target.exists():
        raise HTTPException(status_code=404, detail="Directory not found")
    entries = []
    for child in sorted(target.iterdir()):
        entries.append(
            {
                "name": child.name,
                "type": "directory" if child.is_dir() else "file",
                "size": child.stat().st_size if child.is_file() else 0,
            }
        )
    return {"path": payload.path, "entries": entries}


@router.post("/delete")
async def delete_path(payload: DeleteRequest):
    target = _resolve(payload.path)
    if not target.exists():
        raise HTTPException(status_code=404, detail="Path not found")
    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()
    return {"path": payload.path, "deleted": True}
