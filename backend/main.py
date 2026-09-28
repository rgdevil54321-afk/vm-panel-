"""
Tired AI API Service - OpenAI-Compatible API

This is the backend API service that provides an OpenAI-compatible
interface for Groq, Ollama, and other providers.
"""

import os
import uuid
import logging
import hashlib
import secrets
from datetime import datetime, timedelta
from typing import Optional, Dict, Any, List
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Depends, Header, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
import httpx
import sqlite3

# Configuration
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "")
API_KEY_FILE = os.getenv("API_KEY_FILE", "api_keys.db")
RATE_LIMIT_ENABLED = os.getenv("RATE_LIMIT_ENABLED", "true").lower() == "true"
RATE_LIMIT_REQUESTS = int(os.getenv("RATE_LIMIT_REQUESTS", "30"))
RATE_LIMIT_WINDOW = int(os.getenv("RATE_LIMIT_WINDOW", "60"))

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


# Database setup
def init_db():
    """Initialize SQLite database."""
    conn = sqlite3.connect(API_KEY_FILE)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS api_keys (
            id TEXT PRIMARY KEY,
            name TEXT,
            created_at INTEGER,
            expires_at INTEGER,
            is_active INTEGER DEFAULT 1
        )
    ''')
    conn.commit()
    conn.close()


init_db()


# Request models
class Message(BaseModel):
    role: str
    content: str


class ChatCompletionRequest(BaseModel):
    model: str = "tired-ai"
    messages: List[Message]
    temperature: float = 0.7
    max_tokens: Optional[int] = None
    stream: bool = False
    stop: Optional[List[str]] = None


# Response models
class Model(BaseModel):
    id: str
    object: str = "model"
    created: int = 0
    owned_by: str = "tired-ai"


class ModelList(BaseModel):
    object: str = "list"
    data: List[Model]


class ChatCompletionResponse(BaseModel):
    id: str
    object: str = "chat.completion"
    created: int
    model: str
    choices: List[Dict[str, Any]]
    usage: Dict[str, Any]


class ErrorResponse(BaseModel):
    error: Dict[str, Any]


# Rate limiting
class RateLimiter:
    def __init__(self, max_requests: int, window: int):
        self.max_requests = max_requests
        self.window = window
        self.requests: Dict[str, List[int]] = {}
    
    def is_allowed(self, api_key: str) -> bool:
        if not RATE_LIMIT_ENABLED:
            return True
        
        now = int(datetime.now().timestamp())
        window_start = now - self.window
        
        if api_key not in self.requests:
            self.requests[api_key] = []
        
        # Clean old requests
        self.requests[api_key] = [ts for ts in self.requests[api_key] if ts > window_start]
        
        if len(self.requests[api_key]) >= self.max_requests:
            return False
        
        self.requests[api_key].append(now)
        return True


rate_limiter = RateLimiter(RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW)


# API Key validation
def get_api_key(request: Request) -> Optional[str]:
    """Extract API key from request."""
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        return auth_header[7:]
    return request.headers.get("x-api-key")


def validate_api_key(api_key: str) -> bool:
    """Validate API key."""
    if not api_key:
        return False
    
    conn = sqlite3.connect(API_KEY_FILE)
    cursor = conn.cursor()
    cursor.execute(
        "SELECT is_active, expires_at FROM api_keys WHERE id = ?",
        (api_key,)
    )
    result = cursor.fetchone()
    conn.close()
    
    if not result:
        return False
    
    is_active, expires_at = result
    if not is_active:
        return False
    
    if expires_at and int(datetime.now().timestamp()) > expires_at:
        return False
    
    return True


# Provider implementations
class GroqProvider:
    """Groq API provider."""
    
    def __init__(self):
        self.api_key = GROQ_API_KEY
        self.model = GROQ_MODEL
        self.base_url = "https://api.groq.com/openai/v1"
    
    async def chat_completion(self, request: ChatCompletionRequest, stream: bool = False):
        """Send chat completion request to Groq."""
        if not self.api_key:
            raise HTTPException(status_code=500, detail="Groq API key not configured")
        
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }
        
        payload = {
            "model": self.model,
            "messages": [{"role": m.role, "content": m.content} for m in request.messages],
            "temperature": request.temperature,
        }
        
        if request.max_tokens:
            payload["max_tokens"] = request.max_tokens
        
        if request.stop:
            payload["stop"] = request.stop
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{self.base_url}/chat/completions",
                headers=headers,
                json=payload
            )
            
            if response.status_code != 200:
                raise HTTPException(status_code=response.status_code, detail="Provider error")
            
            return response.json()


class OllamaProvider:
    """Ollama API provider."""
    
    def __init__(self):
        self.base_url = OLLAMA_BASE_URL
        self.model = OLLAMA_MODEL
    
    async def chat_completion(self, request: ChatCompletionRequest, stream: bool = False):
        """Send chat completion request to Ollama."""
        if not self.model:
            raise HTTPException(status_code=500, detail="Ollama model not configured")
        
        payload = {
            "model": self.model,
            "messages": [{"role": m.role, "content": m.content} for m in request.messages],
            "options": {
                "temperature": request.temperature,
            }
        }
        
        if request.max_tokens:
            payload["options"]["num_predict"] = request.max_tokens
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{self.base_url}/api/chat",
                json=payload
            )
            
            if response.status_code != 200:
                raise HTTPException(status_code=response.status_code, detail="Provider error")
            
            return response.json()


# Global provider
groq = GroqProvider()


# FastAPI application
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan."""
    logger.info("Starting Tired AI API service...")
    yield
    logger.info("Shutting down Tired AI API service...")


app = FastAPI(
    title="Tired AI API",
    description="OpenAI-compatible API for Tired AI",
    version="1.0.0",
    lifespan=lifespan
)


# Middleware
@app.middleware("http")
async def add_request_id(request: Request, call_next):
    """Add request ID to all responses."""
    request_id = str(uuid.uuid4())
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    return response


# Health and ready endpoints
@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "healthy", "timestamp": datetime.now().isoformat()}


@app.get("/ready")
async def ready():
    """Readiness check endpoint."""
    return {"status": "ready", "model": GROQ_MODEL}


# Models endpoint
@app.get("/v1/models")
async def list_models(
    api_key: Optional[str] = Header(None)
):
    """List available models."""
    if api_key and not validate_api_key(api_key):
        raise HTTPException(status_code=401, detail="Invalid API key")
    
    return ModelList(
        data=[
            Model(id="tired-ai", owned_by="tired-ai"),
            Model(id=GROQ_MODEL, owned_by="groq"),
        ]
    )


# Chat completions endpoint
@app.post("/v1/chat/completions")
async def chat_completion(
    request: ChatCompletionRequest,
    api_key: Optional[str] = Header(None),
):
    """Create chat completion."""
    request_id = str(uuid.uuid4())
    start_time = datetime.now()
    
    # Rate limiting
    if api_key:
        if not rate_limiter.is_allowed(api_key):
            logger.warning(f"Rate limit exceeded for API key: {api_key[:8]}...")
            raise HTTPException(status_code=429, detail="Rate limit exceeded")
    
    # Validate API key if provided
    if api_key and not validate_api_key(api_key):
        logger.warning(f"Invalid API key attempt")
        raise HTTPException(status_code=401, detail="Invalid API key")
    
    try:
        # Use Groq provider
        result = await groq.chat_completion(request, stream=request.stream)
        
        if request.stream:
            async def stream_generator():
                async for chunk in result:
                    yield chunk
            
            return StreamingResponse(
                stream_generator(),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                }
            )
        else:
            # Format response to OpenAI-compatible format
            usage = result.get("usage", {})
            choices = []
            
            for choice in result.get("choices", []):
                message = choice.get("message", {})
                choices.append({
                    "index": choice.get("index", 0),
                    "message": {
                        "role": message.get("role", "assistant"),
                        "content": message.get("content", "")
                    },
                    "finish_reason": choice.get("finish_reason")
                })
            
            response = ChatCompletionResponse(
                id=request_id,
                created=int(start_time.timestamp()),
                model=request.model,
                choices=choices,
                usage={
                    "prompt_tokens": usage.get("prompt_tokens", 0),
                    "completion_tokens": usage.get("completion_tokens", 0),
                    "total_tokens": usage.get("total_tokens", 0)
                }
            )
            
            return response.dict()
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Request {request_id} failed: {str(e)}")
        raise HTTPException(status_code=500, detail="Internal server error")


# Main execution
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
