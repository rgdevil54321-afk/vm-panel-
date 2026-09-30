"""
Tests for Tired AI API
"""

from unittest.mock import AsyncMock


async def test_health_endpoint(client):
    response = await client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"


async def test_ready_endpoint(client):
    response = await client.get("/ready")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ready"


async def test_models_endpoint(client):
    response = await client.get("/v1/models")
    assert response.status_code == 200
    data = response.json()
    assert "data" in data
    assert len(data["data"]) > 0


async def test_models_endpoint_with_valid_key(client):
    create = await client.post(
        "/admin/keys",
        headers={"X-Admin-Token": "test-admin-token"},
        json={"name": "models-test"},
    )
    api_key = create.json()["id"]
    response = await client.get("/v1/models", headers={"Authorization": f"Bearer {api_key}"})
    assert response.status_code == 200


async def test_chat_completion_with_mock_provider(client, mock_groq_provider):
    response = await client.post(
        "/v1/chat/completions",
        json={"model": "tired-ai", "messages": [{"role": "user", "content": "Hi there"}]},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["choices"][0]["message"]["content"] == "Hello from mock provider"
    assert data["usage"]["total_tokens"] == 8


async def test_chat_completion_stream_mocked(client, mock_groq_provider):
    async def fake_stream(request):
        yield b"data: chunk1"
        yield b"data: chunk2"

    mock_groq_provider.stream_completion = fake_stream
    response = await client.post(
        "/v1/chat/completions",
        json={"model": "tired-ai", "messages": [{"role": "user", "content": "Hi"}], "stream": True},
    )
    assert response.status_code == 200
    assert b"chunk1" in response.content
    assert b"chunk2" in response.content
