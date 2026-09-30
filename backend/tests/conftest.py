"""
Pytest configuration
"""

import os
import tempfile
from unittest.mock import AsyncMock, patch

os.environ.setdefault(
    "API_KEY_FILE",
    os.path.join(tempfile.mkdtemp(prefix="venlix-test-"), "api_keys.db"),
)
os.environ["ADMIN_TOKEN"] = "test-admin-token"
os.environ["RATE_LIMIT_ENABLED"] = "false"
os.environ["REQUIRE_API_KEY"] = "false"

import pytest
from httpx import ASGITransport, AsyncClient

from main import app


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as async_client:
        yield async_client


MOCK_COMPLETION = {
    "choices": [
        {
            "index": 0,
            "message": {"role": "assistant", "content": "Hello from mock provider"},
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 3, "completion_tokens": 5, "total_tokens": 8},
}


@pytest.fixture
def mock_groq_provider():
    with patch("main.groq") as mock:
        mock.chat_completion = AsyncMock(return_value=MOCK_COMPLETION)
        yield mock
