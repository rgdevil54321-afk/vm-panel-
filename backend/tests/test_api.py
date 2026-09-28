"""
Tests for Tired AI API
"""

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_health_endpoint():
    """Test health endpoint returns healthy status."""
    async with AsyncClient() as client:
        response = await client.get("http://localhost:8000/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "healthy"


@pytest.mark.asyncio
async def test_ready_endpoint():
    """Test ready endpoint returns ready status."""
    async with AsyncClient() as client:
        response = await client.get("http://localhost:8000/ready")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ready"


@pytest.mark.asyncio
async def test_models_endpoint():
    """Test models endpoint returns available models."""
    async with AsyncClient() as client:
        response = await client.get("http://localhost:8000/v1/models")
        assert response.status_code == 200
        data = response.json()
        assert "data" in data
        assert len(data["data"]) > 0
