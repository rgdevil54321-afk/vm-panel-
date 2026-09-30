"""
Tests for Phase 2: admin, knowledge, memory, tools, and context
"""

ADMIN_HEADERS = {"X-Admin-Token": "test-admin-token"}


async def test_admin_requires_token(client):
    response = await client.get("/admin/keys")
    assert response.status_code == 403


async def test_create_list_revoke_key(client):
    create = await client.post(
        "/admin/keys", headers=ADMIN_HEADERS, json={"name": "ci", "expires_days": 7}
    )
    assert create.status_code == 200
    key = create.json()
    assert key["id"].startswith("vlix-")

    listing = await client.get("/admin/keys", headers=ADMIN_HEADERS)
    assert listing.status_code == 200
    assert any(k["id"] == key["id"] for k in listing.json()["keys"])

    revoke = await client.delete(f"/admin/keys/{key['id']}", headers=ADMIN_HEADERS)
    assert revoke.status_code == 200

    after = await client.get("/admin/keys", headers=ADMIN_HEADERS)
    revoked = [k for k in after.json()["keys"] if k["id"] == key["id"]]
    assert revoked and revoked[0]["is_active"] == 0


async def test_admin_stats(client):
    response = await client.get("/admin/stats", headers=ADMIN_HEADERS)
    assert response.status_code == 200
    stats = response.json()
    for field in (
        "active_keys",
        "total_keys",
        "knowledge_documents",
        "memory_sessions",
        "contexts",
        "total_requests",
        "prompt_tokens",
        "completion_tokens",
    ):
        assert field in stats


async def test_invalid_key_rejected(client):
    response = await client.get("/v1/models", headers={"Authorization": "Bearer vlix-not-real"})
    assert response.status_code == 401


async def test_knowledge_crud_and_search(client):
    add = await client.post(
        "/v1/knowledge",
        json={"title": "Deploy guide", "content": "Deploy with docker-compose up --build on port 8000"},
    )
    assert add.status_code == 200
    doc_id = add.json()["id"]

    listing = await client.get("/v1/knowledge")
    assert any(d["id"] == doc_id for d in listing.json()["documents"])

    got = await client.get(f"/v1/knowledge/{doc_id}")
    assert got.status_code == 200
    assert got.json()["title"] == "Deploy guide"

    search = await client.post("/v1/knowledge/search", json={"query": "docker deploy", "top_k": 3})
    assert search.status_code == 200
    results = search.json()["results"]
    assert results and results[0]["id"] == doc_id

    deleted = await client.delete(f"/v1/knowledge/{doc_id}")
    assert deleted.status_code == 200
    missing = await client.get(f"/v1/knowledge/{doc_id}")
    assert missing.status_code == 404


async def test_memory_flow(client, mock_groq_provider):
    chat = await client.post(
        "/v1/chat/completions",
        json={
            "model": "tired-ai",
            "messages": [{"role": "user", "content": "Remember the plan"}],
            "session_id": "sess-1",
        },
    )
    assert chat.status_code == 200
    mock_groq_provider.chat_completion.assert_awaited()

    stored = await client.get("/v1/memory/sess-1")
    assert stored.status_code == 200
    data = stored.json()
    assert len(data["messages"]) == 2
    assert "goal" in data["summary"]

    sessions = await client.get("/v1/memory/sessions")
    assert any(s["session_id"] == "sess-1" for s in sessions.json()["sessions"])

    cleared = await client.delete("/v1/memory/sess-1")
    assert cleared.status_code == 200
    assert cleared.json()["deleted"] == 2


async def test_memory_requires_messages(client):
    response = await client.post("/v1/memory/sess-empty", json={"messages": []})
    assert response.status_code == 400


async def test_tools_workspace_roundtrip(client):
    write = await client.post("/v1/tools/write", json={"path": "notes/hello.txt", "content": "hi"})
    assert write.status_code == 200

    lst = await client.post("/v1/tools/list", json={})
    assert lst.status_code == 200
    names = [e["name"] for e in lst.json()["entries"]]
    assert "notes" in names

    read = await client.post("/v1/tools/read", json={"path": "notes/hello.txt"})
    assert read.status_code == 200
    assert read.json()["content"] == "hi"

    escape = await client.post("/v1/tools/read", json={"path": "../secrets.txt"})
    assert escape.status_code == 400

    delete = await client.post("/v1/tools/delete", json={"path": "notes"})
    assert delete.status_code == 200


async def test_tools_read_missing_file(client):
    response = await client.post("/v1/tools/read", json={"path": "does-not-exist.txt"})
    assert response.status_code == 404


async def test_context_flow(client):
    put = await client.put(
        "/v1/context/myproject",
        json={"files": {"README.md": "# hi"}, "instructions": "be brief"},
    )
    assert put.status_code == 200
    assert put.json()["file_count"] == 1

    got = await client.get("/v1/context/myproject")
    assert got.status_code == 200
    assert got.json()["files"]["README.md"] == "# hi"

    listing = await client.get("/v1/context")
    assert any(p["project"] == "myproject" for p in listing.json()["projects"])

    removed = await client.delete("/v1/context/myproject")
    assert removed.status_code == 200

    gone = await client.get("/v1/context/myproject")
    assert gone.status_code == 404


async def test_context_rejects_bad_name(client):
    response = await client.put("/v1/context/bad%20name", json={"files": {}})
    assert response.status_code == 400
