"""
Tired AI API Service - OpenAI-Compatible API

This is the backend API service that provides an OpenAI-compatible
interface for Groq, Ollama, and other providers, plus admin,
knowledge, memory, tools, and project context systems.
"""

import os
import time
import uuid
import logging
from datetime import datetime
from typing import Optional, Dict, Any, List
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import httpx

from store import init_db, log_request
from auth import get_api_key, validate_api_key, require_api_key
from admin import router as admin_router
from knowledge import router as knowledge_router
from memory import router as memory_router, append_message
from tools import router as tools_router
from context import router as context_router

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "")
RATE_LIMIT_ENABLED = os.getenv("RATE_LIMIT_ENABLED", "true").lower() == "true"
RATE_LIMIT_REQUESTS = int(os.getenv("RATE_LIMIT_REQUESTS", "30"))
RATE_LIMIT_WINDOW = int(os.getenv("RATE_LIMIT_WINDOW", "60"))

CHAT_PATH = "/v1/chat/completions"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

init_db()


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
    session_id: Optional[str] = None


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
        self.requests[api_key] = [ts for ts in self.requests[api_key] if ts > window_start]
        if len(self.requests[api_key]) >= self.max_requests:
            return False
        self.requests[api_key].append(now)
        return True


rate_limiter = RateLimiter(RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW)


class GroqProvider:
    def __init__(self):
        self.api_key = GROQ_API_KEY
        self.model = GROQ_MODEL
        self.base_url = "https://api.groq.com/openai/v1"

    def _headers(self) -> Dict[str, str]:
        if not self.api_key:
            raise HTTPException(status_code=500, detail="Groq API key not configured")
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    def _payload(self, request: ChatCompletionRequest) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "model": self.model,
            "messages": [{"role": m.role, "content": m.content} for m in request.messages],
            "temperature": request.temperature,
        }
        if request.max_tokens:
            payload["max_tokens"] = request.max_tokens
        if request.stop:
            payload["stop"] = request.stop
        return payload

    async def chat_completion(self, request: ChatCompletionRequest):
        payload = self._payload(request)
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{self.base_url}/chat/completions",
                headers=self._headers(),
                json=payload,
            )
            if response.status_code != 200:
                raise HTTPException(status_code=response.status_code, detail="Provider error")
            return response.json()

    async def stream_completion(self, request: ChatCompletionRequest):
        payload = self._payload(request)
        payload["stream"] = True
        async with httpx.AsyncClient(timeout=120.0) as client:
            async with client.stream(
                "POST",
                f"{self.base_url}/chat/completions",
                headers=self._headers(),
                json=payload,
            ) as response:
                if response.status_code != 200:
                    raise HTTPException(status_code=response.status_code, detail="Provider error")
                async for chunk in response.aiter_bytes():
                    yield chunk


class OllamaProvider:
    def __init__(self):
        self.base_url = OLLAMA_BASE_URL
        self.model = OLLAMA_MODEL

    async def chat_completion(self, request: ChatCompletionRequest):
        if not self.model:
            raise HTTPException(status_code=500, detail="Ollama model not configured")
        payload = {
            "model": self.model,
            "messages": [{"role": m.role, "content": m.content} for m in request.messages],
            "options": {
                "temperature": request.temperature,
            },
        }
        if request.max_tokens:
            payload["options"]["num_predict"] = request.max_tokens
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{self.base_url}/api/chat",
                json=payload,
            )
            if response.status_code != 200:
                raise HTTPException(status_code=response.status_code, detail="Provider error")
            return response.json()


groq = GroqProvider()
ollama = OllamaProvider()


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting Tired AI API service...")
    yield
    logger.info("Shutting down Tired AI API service...")


app = FastAPI(
    title="Tired AI API",
    description="OpenAI-compatible API for Tired AI",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in os.getenv("CORS_ORIGINS", "*").split(",") if origin.strip()],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(admin_router)
app.include_router(knowledge_router)
app.include_router(memory_router)
app.include_router(tools_router)
app.include_router(context_router)


@app.middleware("http")
async def add_request_id(request: Request, call_next):
    request_id = str(uuid.uuid4())
    start = time.time()
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    if request.url.path != CHAT_PATH:
        try:
            log_request(
                request.url.path,
                request.method,
                response.status_code,
                (time.time() - start) * 1000,
            )
        except Exception:
            pass
    return response


@app.get("/health")
async def health():
    return {"status": "healthy", "timestamp": datetime.now().isoformat()}


@app.get("/ready")
async def ready():
    return {"status": "ready", "model": GROQ_MODEL}


@app.get("/v1/models")
async def list_models(api_key: Optional[str] = Depends(get_api_key)):
    if api_key and not validate_api_key(api_key):
        raise HTTPException(status_code=401, detail="Invalid API key")
    return ModelList(
        data=[
            Model(id="tired-ai", owned_by="tired-ai"),
            Model(id=GROQ_MODEL, owned_by="groq"),
        ]
    )


@app.post("/v1/chat/completions")
async def chat_completion(
    request: ChatCompletionRequest,
    api_key: Optional[str] = Depends(get_api_key),
):
    request_id = str(uuid.uuid4())
    start_time = time.time()

    if api_key:
        if not rate_limiter.is_allowed(api_key):
            logger.warning(f"Rate limit exceeded for API key: {api_key[:8]}...")
            raise HTTPException(status_code=429, detail="Rate limit exceeded")
        if not validate_api_key(api_key):
            logger.warning("Invalid API key attempt")
            raise HTTPException(status_code=401, detail="Invalid API key")

    try:
        if request.stream:
            return StreamingResponse(
                groq.stream_completion(request),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                },
            )

        result = await groq.chat_completion(request)

        usage = result.get("usage", {})
        choices = []
        for choice in result.get("choices", []):
            message = choice.get("message", {})
            choices.append(
                {
                    "index": choice.get("index", 0),
                    "message": {
                        "role": message.get("role", "assistant"),
                        "content": message.get("content", ""),
                    },
                    "finish_reason": choice.get("finish_reason"),
                }
            )

        if request.session_id and choices:
            try:
                user_messages = [m for m in request.messages if m.role == "user"]
                user_content = user_messages[-1].content if user_messages else ""
                if user_content:
                    append_message(request.session_id, "user", user_content)
                append_message(request.session_id, "assistant", choices[0]["message"]["content"])
            except Exception as exc:
                logger.warning(f"Failed to store memory for session: {exc}")

        try:
            log_request(
                CHAT_PATH,
                "POST",
                200,
                (time.time() - start_time) * 1000,
                usage.get("prompt_tokens", 0),
                usage.get("completion_tokens", 0),
            )
        except Exception:
            pass

        response = ChatCompletionResponse(
            id=request_id,
            created=int(start_time),
            model=request.model,
            choices=choices,
            usage={
                "prompt_tokens": usage.get("prompt_tokens", 0),
                "completion_tokens": usage.get("completion_tokens", 0),
                "total_tokens": usage.get("total_tokens", 0),
            },
        )
        return response.model_dump()

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Request {request_id} failed: {str(e)}")
        raise HTTPException(status_code=500, detail="Internal server error")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
