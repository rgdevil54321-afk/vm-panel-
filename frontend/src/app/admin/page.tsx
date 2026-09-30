"use client"

import { FormEvent, useCallback, useEffect, useState } from "react"
import Link from "next/link"
import {
  addKnowledge,
  AdminStats,
  ApiKeyRecord,
  createKey,
  deleteKnowledge,
  DEFAULT_ADMIN_TOKEN,
  fetchStats,
  KnowledgeDocument,
  KnowledgeSearchResult,
  listKeys,
  listKnowledge,
  revokeKey,
  searchKnowledge,
} from "@/lib/api"

type Tab = "keys" | "knowledge" | "stats"

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString()
}

function shortId(id: string): string {
  return `${id.slice(0, 10)}...`
}

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>("keys")
  const [adminToken, setAdminToken] = useState(DEFAULT_ADMIN_TOKEN)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [keys, setKeys] = useState<ApiKeyRecord[]>([])
  const [newKeyName, setNewKeyName] = useState("")
  const [createdKey, setCreatedKey] = useState<string | null>(null)

  const [docs, setDocs] = useState<KnowledgeDocument[]>([])
  const [docTitle, setDocTitle] = useState("")
  const [docContent, setDocContent] = useState("")
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<KnowledgeSearchResult[] | null>(null)

  const [stats, setStats] = useState<AdminStats | null>(null)

  const loadKeys = useCallback(async () => {
    try {
      setError(null)
      const data = await listKeys(adminToken)
      setKeys(data.keys)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load keys")
    }
  }, [adminToken])

  const loadKnowledge = useCallback(async () => {
    try {
      setError(null)
      const data = await listKnowledge()
      setDocs(data.documents)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load knowledge")
    }
  }, [])

  const loadStats = useCallback(async () => {
    try {
      setError(null)
      setStats(await fetchStats(adminToken))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load stats")
    }
  }, [adminToken])

  useEffect(() => {
    if (tab === "keys") loadKeys()
    if (tab === "knowledge") loadKnowledge()
    if (tab === "stats") loadStats()
  }, [tab, loadKeys, loadKnowledge, loadStats])

  async function handleCreateKey(event: FormEvent) {
    event.preventDefault()
    try {
      setError(null)
      const created = await createKey(adminToken, newKeyName.trim() || "default")
      setCreatedKey(created.id)
      setNewKeyName("")
      await loadKeys()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create key")
    }
  }

  async function handleRevoke(id: string) {
    try {
      setError(null)
      await revokeKey(adminToken, id)
      await loadKeys()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke key")
    }
  }

  async function handleAddDoc(event: FormEvent) {
    event.preventDefault()
    if (!docContent.trim()) return
    try {
      setError(null)
      const created = await addKnowledge(undefined, docTitle.trim() || "Untitled", docContent)
      setNotice(`Stored document ${shortId(created.id)}`)
      setDocTitle("")
      setDocContent("")
      await loadKnowledge()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to store document")
    }
  }

  async function handleSearch(event: FormEvent) {
    event.preventDefault()
    if (!query.trim()) {
      setResults(null)
      return
    }
    try {
      setError(null)
      const data = await searchKnowledge(undefined, query)
      setResults(data.results)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed")
    }
  }

  async function handleDeleteDoc(id: string) {
    try {
      setError(null)
      await deleteKnowledge(undefined, id)
      setResults((current) => (current ? current.filter((r) => r.id !== id) : current))
      await loadKnowledge()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete document")
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col px-6 py-10">
      <header className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold">Admin Dashboard</h1>
          <p className="mt-2 text-gray-400">Keys, knowledge base, and usage stats</p>
        </div>
        <Link
          href="/"
          className="rounded-md border border-gray-700 px-4 py-2 text-sm text-gray-300 transition hover:border-gray-500 hover:text-white"
        >
          Chat
        </Link>
      </header>

      <section className="mb-6 flex flex-wrap items-center gap-3">
        {(["keys", "knowledge", "stats"] as Tab[]).map((item) => (
          <button
            key={item}
            onClick={() => setTab(item)}
            className={
              tab === item
                ? "rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white"
                : "rounded-md border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:border-gray-500 hover:text-white"
            }
          >
            {item === "keys" ? "API Keys" : item === "knowledge" ? "Knowledge Base" : "Usage Stats"}
          </button>
        ))}
        <input
          value={adminToken}
          onChange={(event) => setAdminToken(event.target.value)}
          placeholder="Admin token"
          className="ml-auto w-56 rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 outline-none focus:border-indigo-500"
        />
      </section>

      {error && (
        <p className="mb-4 rounded-md border border-red-900 bg-red-950 px-4 py-2 text-sm text-red-300">
          {error}
        </p>
      )}
      {notice && (
        <p className="mb-4 rounded-md border border-emerald-900 bg-emerald-950 px-4 py-2 text-sm text-emerald-300">
          {notice}
        </p>
      )}

      {tab === "keys" && (
        <section className="space-y-6">
          <form onSubmit={handleCreateKey} className="flex gap-3">
            <input
              value={newKeyName}
              onChange={(event) => setNewKeyName(event.target.value)}
              placeholder="Key name"
              className="flex-1 rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none focus:border-indigo-500"
            />
            <button
              type="submit"
              className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
            >
              Create Key
            </button>
          </form>

          {createdKey && (
            <p className="rounded-md border border-indigo-900 bg-indigo-950 px-4 py-3 text-sm break-all text-indigo-200">
              New key (copy now, shown once): <span className="font-mono">{createdKey}</span>
            </p>
          )}

          <div className="overflow-hidden rounded-xl border border-gray-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-900 text-xs uppercase tracking-wide text-gray-400">
                <tr>
                  <th className="px-4 py-3">Key</th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Created</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {keys.map((key) => (
                  <tr key={key.id} className="bg-gray-900/40">
                    <td className="px-4 py-3 font-mono text-xs text-gray-300">{shortId(key.id)}</td>
                    <td className="px-4 py-3">{key.name}</td>
                    <td className="px-4 py-3 text-gray-400">{formatTime(key.created_at)}</td>
                    <td className="px-4 py-3">
                      <span
                        className={
                          key.is_active
                            ? "rounded-full bg-emerald-950 px-2 py-1 text-xs text-emerald-300"
                            : "rounded-full bg-red-950 px-2 py-1 text-xs text-red-300"
                        }
                      >
                        {key.is_active ? "Active" : "Revoked"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {key.is_active === 1 && (
                        <button
                          onClick={() => handleRevoke(key.id)}
                          className="rounded-md border border-red-900 px-3 py-1 text-xs text-red-300 hover:bg-red-950"
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {keys.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-gray-500">
                      No API keys yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === "knowledge" && (
        <section className="space-y-6">
          <form onSubmit={handleAddDoc} className="space-y-3 rounded-xl border border-gray-800 p-4">
            <input
              value={docTitle}
              onChange={(event) => setDocTitle(event.target.value)}
              placeholder="Title"
              className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none focus:border-indigo-500"
            />
            <textarea
              value={docContent}
              onChange={(event) => setDocContent(event.target.value)}
              placeholder="Paste documentation, runbooks, notes..."
              rows={4}
              className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none focus:border-indigo-500"
            />
            <button
              type="submit"
              disabled={!docContent.trim()}
              className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Add Document
            </button>
          </form>

          <form onSubmit={handleSearch} className="flex gap-3">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search the knowledge base..."
              className="flex-1 rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none focus:border-indigo-500"
            />
            <button
              type="submit"
              className="rounded-md border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:border-gray-500 hover:text-white"
            >
              Search
            </button>
          </form>

          {results && (
            <div className="space-y-3">
              {results.length === 0 && <p className="text-sm text-gray-500">No matches</p>}
              {results.map((result) => (
                <div key={result.id} className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
                  <div className="flex items-center justify-between">
                    <p className="font-semibold">{result.title}</p>
                    <span className="text-xs text-gray-500">score {result.score}</span>
                  </div>
                  <p className="mt-2 text-sm text-gray-400">{result.snippet}</p>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-3">
            {docs.map((doc) => (
              <div
                key={doc.id}
                className="flex items-center justify-between rounded-xl border border-gray-800 bg-gray-900/40 px-4 py-3"
              >
                <div>
                  <p className="text-sm font-semibold">{doc.title}</p>
                  <p className="text-xs text-gray-500">
                    {doc.size} chars | stored {formatTime(doc.updated_at)}
                  </p>
                </div>
                <button
                  onClick={() => handleDeleteDoc(doc.id)}
                  className="rounded-md border border-red-900 px-3 py-1 text-xs text-red-300 hover:bg-red-950"
                >
                  Delete
                </button>
              </div>
            ))}
            {docs.length === 0 && <p className="text-sm text-gray-500">No documents stored</p>}
          </div>
        </section>
      )}

      {tab === "stats" && (
        <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {stats &&
            (
              [
                { label: "Active Keys", value: stats.active_keys },
                { label: "Total Keys", value: stats.total_keys },
                { label: "Knowledge Docs", value: stats.knowledge_documents },
                { label: "Memory Sessions", value: stats.memory_sessions },
                { label: "Contexts", value: stats.contexts },
                { label: "Total Requests", value: stats.total_requests },
                { label: "Prompt Tokens", value: stats.prompt_tokens },
                { label: "Completion Tokens", value: stats.completion_tokens },
              ] as { label: string; value: number }[]
            ).map((item) => (
              <div key={item.label} className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
                <p className="text-2xl font-bold">{item.value}</p>
                <p className="mt-1 text-xs uppercase tracking-wide text-gray-500">{item.label}</p>
              </div>
            ))}
          {!stats && <p className="text-sm text-gray-500">Loading stats...</p>}
        </section>
      )}
    </main>
  )
}
