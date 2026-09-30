import uuid
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import require_api_key
from store import get_conn, now_ts, tokenize

router = APIRouter(prefix="/v1/knowledge", dependencies=[Depends(require_api_key)])


class KnowledgeCreate(BaseModel):
    title: str
    content: str


class KnowledgeSearch(BaseModel):
    query: str
    top_k: int = 5


def _score(tokens: List[str], title: str, content: str) -> int:
    content_lower = content.lower()
    title_lower = title.lower()
    score = 0
    for token in tokens:
        score += content_lower.count(token) + 2 * title_lower.count(token)
    return score


def _snippet(content: str, tokens: List[str]) -> str:
    content_lower = content.lower()
    index = -1
    for token in tokens:
        index = content_lower.find(token)
        if index != -1:
            break
    if index == -1:
        return content[:160]
    start = max(0, index - 60)
    end = min(len(content), index + 140)
    return content[start:end]


@router.post("")
async def add_document(payload: KnowledgeCreate):
    if not payload.content.strip():
        raise HTTPException(status_code=400, detail="Content is empty")
    doc_id = uuid.uuid4().hex
    created_at = now_ts()
    conn = get_conn()
    conn.execute(
        "INSERT INTO knowledge (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        (doc_id, payload.title, payload.content, created_at, created_at),
    )
    conn.commit()
    conn.close()
    return {"id": doc_id, "title": payload.title, "size": len(payload.content), "created_at": created_at}


@router.get("")
async def list_documents():
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, title, created_at, updated_at, LENGTH(content) AS size FROM knowledge ORDER BY updated_at DESC"
    ).fetchall()
    conn.close()
    return {"documents": [dict(row) for row in rows]}


@router.post("/search")
async def search_documents(payload: KnowledgeSearch):
    tokens = tokenize(payload.query)
    if not tokens:
        return {"results": []}
    conn = get_conn()
    rows = conn.execute("SELECT id, title, content FROM knowledge").fetchall()
    conn.close()
    results = []
    for row in rows:
        score = _score(tokens, row["title"], row["content"])
        if score > 0:
            results.append(
                {
                    "id": row["id"],
                    "title": row["title"],
                    "score": score,
                    "snippet": _snippet(row["content"], tokens),
                }
            )
    results.sort(key=lambda r: r["score"], reverse=True)
    return {"results": results[: max(1, payload.top_k)]}


@router.get("/{doc_id}")
async def get_document(doc_id: str):
    conn = get_conn()
    row = conn.execute(
        "SELECT id, title, content, created_at, updated_at FROM knowledge WHERE id = ?",
        (doc_id,),
    ).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Document not found")
    return dict(row)


@router.delete("/{doc_id}")
async def delete_document(doc_id: str):
    conn = get_conn()
    cursor = conn.execute("DELETE FROM knowledge WHERE id = ?", (doc_id,))
    conn.commit()
    conn.close()
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Document not found")
    return {"id": doc_id, "status": "deleted"}
