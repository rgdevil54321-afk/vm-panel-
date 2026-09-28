"""
Pytest configuration
"""

import pytest
from unittest.mock import patch


@pytest.fixture
def mock_groq_provider():
    """Mock Groq provider."""
    with patch("main.groq") as mock:
        yield mock
