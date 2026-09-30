# TIRED AI

A specialized AI coding and infrastructure assistant that exposes an OpenAI-compatible API, with an admin dashboard, knowledge base, session memory, sandboxed agent tools, and project context storage.

## Architecture

```
            TIRED AI
                |
      +---------+---------+
      |                   |
   Frontend            Backend
  (Next.js 14)       (FastAPI)
                           |
              +------------+------------+-------------+
              |            |            |             |
           Providers   Knowledge    Memory        Tools /
           (Groq,      Base         (sessions +   Context
            Ollama)    (keyword     summaries)    (sandboxed
                       search)                    workspace)
                           |
                    SQLite (api_keys, knowledge, memories, contexts, request_logs)
```

## Implemented Phases

- Phase 1: OpenAI-compatible API (`/health`, `/ready`, `/v1/models`, `/v1/chat/completions`), Groq + Ollama providers, API key auth, rate limiting, request IDs, Docker.
- Phase 2: Admin API (key management + usage stats), knowledge base with keyword search, session memory with summaries, sandboxed file tools, project context store, real SSE streaming, request logging, CORS.
- Phase 3: Next.js chat UI and admin dashboard (keys, knowledge, stats).

## Quick Start

### Backend

1. Copy environment variables:
```bash
cp backend/.env.example backend/.env
```

2. Set your API keys in `backend/.env`:
```
GROQ_API_KEY=your_groq_api_key
GROQ_MODEL=openai/gpt-oss-120b
```

3. Install dependencies and run:
```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

4. Run the tests:
```bash
python -m pytest tests
```

### Frontend

1. Copy environment variables:
```bash
cp frontend/.env.example frontend/.env.local
```

2. Install dependencies and run:
```bash
cd frontend
npm install
npm run dev
```

- Chat UI: http://localhost:3000
- Admin dashboard: http://localhost:3000/admin

## Environment Variables (backend)

| Variable | Default | Purpose |
|---|---|---|
| `GROQ_API_KEY` | - | Groq provider credential |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Groq model id |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama endpoint |
| `OLLAMA_MODEL` | - | Ollama model (enables Ollama provider) |
| `ADMIN_TOKEN` | `vlix-admin-token` | Token for `/admin/*` via `X-Admin-Token` header |
| `REQUIRE_API_KEY` | `false` | When `true`, `/v1/*` data endpoints need a valid API key |
| `RATE_LIMIT_ENABLED` / `_REQUESTS` / `_WINDOW` | `true` / `30` / `60` | Per-key rate limiting |
| `API_KEY_FILE` | `api_keys.db` | SQLite database path |
| `TOOL_WORKSPACE` | `data/workspace` | Root of sandboxed file tools (path traversal blocked) |
| `CORS_ORIGINS` | `*` | Comma-separated allowed origins |

## API Endpoints

### Health & Meta
```
GET  /health            -> {"status": "healthy"}
GET  /ready             -> {"status": "ready", "model": ...}
```

### Chat (OpenAI-compatible)
```
POST /v1/chat/completions
Authorization: Bearer <api_key>            (optional)
{
  "model": "tired-ai",
  "messages": [{"role": "user", "content": "Hello"}],
  "temperature": 0.7,
  "max_tokens": null,
  "stream": false,
  "stop": [],
  "session_id": "my-session"               (optional, stores memory)
}
```
- `stream: true` proxies Groq SSE chunks as `text/event-stream`.

### Models
```
GET  /v1/models
Authorization: Bearer <api_key>            (validates if provided)
```

### Admin (header: `X-Admin-Token: <ADMIN_TOKEN>`)
```
POST   /admin/keys          {"name": "ci", "expires_days": 7}  -> full key shown once, prefix `vlix-`
GET    /admin/keys          -> all keys with active/revoked status
DELETE /admin/keys/{key_id} -> revokes key (sets is_active = 0)
GET    /admin/stats         -> keys, docs, sessions, contexts, requests, token usage
```

### Knowledge Base
```
POST   /v1/knowledge         {"title": "...", "content": "..."}
GET    /v1/knowledge         -> document index (id, title, size, timestamps)
GET    /v1/knowledge/{id}    -> full document
DELETE /v1/knowledge/{id}
POST   /v1/knowledge/search  {"query": "...", "top_k": 5} -> scored keyword search with snippets
```

### Memory
```
GET    /v1/memory/sessions      -> all sessions with message counts
POST   /v1/memory/{session_id}  {"messages": [{"role": "user", "content": "..."}]}
GET    /v1/memory/{session_id}  -> messages + generated summary
DELETE /v1/memory/{session_id}
```

### Tools (sandboxed to `TOOL_WORKSPACE`)
```
POST /v1/tools/read   {"path": "notes/x.txt"}
POST /v1/tools/write  {"path": "notes/x.txt", "content": "..."}
POST /v1/tools/list   {"path": ""}
POST /v1/tools/delete {"path": "notes/x.txt"}
```
Paths resolving outside the workspace return `400`.

### Project Context
```
PUT    /v1/context/{project}  {"files": {"README.md": "..."}, "instructions": "..."}
GET    /v1/context            -> project index
GET    /v1/context/{project}
DELETE /v1/context/{project}
```

## Default Auth Behavior

With `REQUIRE_API_KEY=false`, `/v1/*` endpoints work without a key (bootstrap mode). Create keys in the admin dashboard, set `REQUIRE_API_KEY=true` to lock access. Invalid but provided keys are always rejected with `401`.

## Docker

```bash
docker-compose up --build
```

## License

MIT
