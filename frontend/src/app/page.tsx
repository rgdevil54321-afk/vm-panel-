"use client"

import { FormEvent, useState } from "react"
import Link from "next/link"
import { ApiMessage, chatCompletion } from "@/lib/api"

interface ChatEntry {
  role: "user" | "assistant"
  content: string
}

export default function Home() {
  const [entries, setEntries] = useState<ChatEntry[]>([])
  const [input, setInput] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sessionId] = useState(() => Math.random().toString(36).slice(2, 12))

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    const trimmed = input.trim()
    if (!trimmed || loading) return
    setError(null)
    setInput("")

    const withUser: ChatEntry[] = [...entries, { role: "user", content: trimmed }]
    setEntries(withUser)
    setLoading(true)

    try {
      const messages: ApiMessage[] = withUser.map((entry) => ({
        role: entry.role,
        content: entry.content,
      }))
      const result = await chatCompletion(messages, undefined, sessionId)
      const reply = result.choices[0]?.message?.content ?? "(empty response)"
      setEntries([...withUser, { role: "assistant", content: reply }])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed")
      setEntries(entries)
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col px-6 py-10">
      <header className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-4xl font-bold">Tired AI</h1>
          <p className="mt-2 text-gray-400">AI Assistant for Coding &amp; Infrastructure</p>
        </div>
        <Link
          href="/admin"
          className="rounded-md border border-gray-700 px-4 py-2 text-sm text-gray-300 transition hover:border-gray-500 hover:text-white"
        >
          Admin
        </Link>
      </header>

      <section className="flex-1 space-y-4 overflow-y-auto rounded-xl border border-gray-800 bg-gray-900/40 p-6">
        {entries.length === 0 && (
          <p className="text-sm text-gray-500">
            Ask anything. Conversation memory is stored per session on the backend.
          </p>
        )}
        {entries.map((entry, index) => (
          <div
            key={index}
            className={
              entry.role === "user"
                ? "ml-auto max-w-[80%] rounded-xl bg-indigo-600/80 px-4 py-3 text-sm text-white"
                : "mr-auto max-w-[80%] rounded-xl bg-gray-800 px-4 py-3 text-sm text-gray-100"
            }
          >
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-400">
              {entry.role}
            </p>
            <p className="whitespace-pre-wrap">{entry.content}</p>
          </div>
        ))}
        {loading && <p className="text-sm text-gray-500">Thinking...</p>}
      </section>

      {error && (
        <p className="mt-4 rounded-md border border-red-900 bg-red-950 px-4 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <form onSubmit={handleSubmit} className="mt-6 flex gap-3">
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Type a message..."
          className="flex-1 rounded-lg border border-gray-700 bg-gray-900 px-4 py-3 text-sm text-gray-100 outline-none transition focus:border-indigo-500"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="rounded-lg bg-indigo-600 px-6 py-3 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </main>
  )
}
