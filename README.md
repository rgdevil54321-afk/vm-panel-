# TIRED AI

A specialized AI coding and infrastructure assistant that exposes an OpenAI-compatible API.

## Architecture

```
            TIRED AI
                │
      ┌─────────┴─────────┐
      │                   │
   Frontend            Backend
                          │
                   Agent / AI Layer
                          │
                   Provider Manager
                          │
            ┌─────────────┼─────────────┐
            │             │             │
           Groq         Ollama     OpenAI-Compatible
```

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

3. Install dependencies:
```bash
cd backend
pip install -r requirements.txt
```

4. Run the server:
```bash
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### Frontend

1. Navigate to frontend directory:
```bash
cd frontend
```

2. Install dependencies:
```bash
npm install
```

3. Run development server:
```bash
npm run dev
```

## API Endpoints

### Health Check
```
GET /health
```

### Readiness
```
GET /ready
```

### Models
```
GET /v1/models
Authorization: Bearer YOUR_API_KEY
```

### Chat Completions
```
POST /v1/chat/completions
Authorization: Bearer YOUR_API_KEY

{
  "model": "tired-ai",
  "messages": [{"role": "user", "content": "Hello"}]
}
```

## Docker

```bash
docker-compose up --build
```

## License

MIT
