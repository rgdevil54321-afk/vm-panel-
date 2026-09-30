export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

export const DEFAULT_ADMIN_TOKEN =
  process.env.NEXT_PUBLIC_ADMIN_TOKEN ?? "vlix-admin-token"

export interface ApiMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export interface ChatChoice {
  index: number
  message: { role: string; content: string }
  finish_reason: string | null
}

export interface ChatCompletionResponse {
  id: string
  created: number
  model: string
  choices: ChatChoice[]
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export interface ApiKeyRecord {
  id: string
  name: string
  created_at: number
  expires_at: number | null
  is_active: number
}

export interface KnowledgeDocument {
  id: string
  title: string
  created_at: number
  updated_at: number
  size: number
}

export interface KnowledgeSearchResult {
  id: string
  title: string
  score: number
  snippet: string
}

export interface AdminStats {
  active_keys: number
  total_keys: number
  knowledge_documents: number
  memory_sessions: number
  contexts: number
  total_requests: number
  prompt_tokens: number
  completion_tokens: number
}

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `Request failed (${res.status})`
    try {
      const body = (await res.json()) as { detail?: unknown }
      if (body && typeof body.detail === "string") {
        detail = body.detail
      }
    } catch {
      // keep default detail
    }
    throw new Error(detail)
  }
  return (await res.json()) as T
}

export function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
}

export async function chatCompletion(
  messages: ApiMessage[],
  apiKey?: string,
  sessionId?: string
): Promise<ChatCompletionResponse> {
  const res = await fetch(`${API_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(apiKey) },
    body: JSON.stringify({
      model: "tired-ai",
      messages,
      ...(sessionId ? { session_id: sessionId } : {}),
    }),
  })
  return parse<ChatCompletionResponse>(res)
}

export async function listKeys(adminToken: string): Promise<{ keys: ApiKeyRecord[] }> {
  const res = await fetch(`${API_URL}/admin/keys`, {
    headers: { "X-Admin-Token": adminToken },
  })
  return parse<{ keys: ApiKeyRecord[] }>(res)
}

export async function createKey(
  adminToken: string,
  name: string
): Promise<ApiKeyRecord> {
  const res = await fetch(`${API_URL}/admin/keys`, {
    method: "POST",
    headers: { "X-Admin-Token": adminToken, "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  })
  return parse<ApiKeyRecord>(res)
}

export async function revokeKey(
  adminToken: string,
  id: string
): Promise<{ id: string; status: string }> {
  const res = await fetch(`${API_URL}/admin/keys/${id}`, {
    method: "DELETE",
    headers: { "X-Admin-Token": adminToken },
  })
  return parse<{ id: string; status: string }>(res)
}

export async function fetchStats(adminToken: string): Promise<AdminStats> {
  const res = await fetch(`${API_URL}/admin/stats`, {
    headers: { "X-Admin-Token": adminToken },
  })
  return parse<AdminStats>(res)
}

export async function listKnowledge(apiKey?: string): Promise<{ documents: KnowledgeDocument[] }> {
  const res = await fetch(`${API_URL}/v1/knowledge`, {
    headers: authHeaders(apiKey),
  })
  return parse<{ documents: KnowledgeDocument[] }>(res)
}

export async function addKnowledge(
  apiKey: string | undefined,
  title: string,
  content: string
): Promise<{ id: string; title: string; size: number }> {
  const res = await fetch(`${API_URL}/v1/knowledge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(apiKey) },
    body: JSON.stringify({ title, content }),
  })
  return parse<{ id: string; title: string; size: number }>(res)
}

export async function deleteKnowledge(
  apiKey: string | undefined,
  id: string
): Promise<{ id: string; status: string }> {
  const res = await fetch(`${API_URL}/v1/knowledge/${id}`, {
    method: "DELETE",
    headers: authHeaders(apiKey),
  })
  return parse<{ id: string; status: string }>(res)
}

export async function searchKnowledge(
  apiKey: string | undefined,
  query: string
): Promise<{ results: KnowledgeSearchResult[] }> {
  const res = await fetch(`${API_URL}/v1/knowledge/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(apiKey) },
    body: JSON.stringify({ query }),
  })
  return parse<{ results: KnowledgeSearchResult[] }>(res)
}
