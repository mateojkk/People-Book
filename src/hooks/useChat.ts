import { useState, useCallback, useEffect, useRef } from 'react'
import type { ChatMessage, MemoryActivity, MemoryEntry } from '../types'
import { uid } from '../lib/constants'

export function useChat(
  userName: string | null, 
  memwalAccountId: string | null,
  memwalPrivateKey: string | null,
  sessionId: string | null,
  initialMessages: ChatMessage[] = [],
  onMessagesChange?: (messages: ChatMessage[]) => void
) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages)
  const [memoryEntries, setMemoryEntries] = useState<MemoryEntry[]>([])
  const [loading, setLoading] = useState(false)

  // Sync with initialMessages ONLY when switching sessions
  useEffect(() => {
    setMessages(initialMessages)
    // We intentionally don't clear memoryEntries here, or we could if needed
  }, [sessionId])

  const onMessagesChangeRef = useRef(onMessagesChange)
  useEffect(() => {
    onMessagesChangeRef.current = onMessagesChange
  }, [onMessagesChange])

  // Call onMessagesChange whenever messages update
  useEffect(() => {
    if (onMessagesChangeRef.current) {
      onMessagesChangeRef.current(messages)
    }
  }, [messages])

  const addMemoryEntry = useCallback((act: MemoryActivity) => {
    if (act.type === 'memory_write') {
      setMemoryEntries((prev) => [
        ...prev,
        {
          id: uid(),
          tag: (act.tag as MemoryEntry['tag']) || 'ECOSYSTEM',
          entity: act.entity || 'unknown',
          status: act.status,
          text: act.text,
          timestamp: new Date(),
        },
      ])
    } else if (act.type === 'recall' && act.count && act.count > 0) {
      setMemoryEntries((prev) => [
        ...prev,
        {
          id: uid(),
          tag: 'RECALL',
          entity: `Query: "${act.query}"`,
          text: act.results?.slice(0, 2).join(' · '),
          timestamp: new Date(),
        },
      ])
    }
  }, [])

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || loading || !userName) return

    const userMsg: ChatMessage = {
      id: uid(),
      role: 'user',
      content: text.trim(),
      activities: [],
      agentSteps: [],
    }

    const assistantMsg: ChatMessage = {
      id: uid(),
      role: 'assistant',
      content: '',
      activities: [],
      agentSteps: [],
      streaming: true,
    }

    setMessages((prev) => [...prev, userMsg, assistantMsg])
    setLoading(true)

    // Capture the history safely BEFORE we do the async fetch
    const currentMessages = [...messages, userMsg]
    const history = currentMessages
      .filter(m => m.id !== assistantMsg.id && m.id !== userMsg.id)
      .map((m) => ({ role: m.role, content: m.content }))

    try {
      const response = await fetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          user_name: userName, 
          memwal_account_id: memwalAccountId,
          memwal_private_key: memwalPrivateKey,
          message: text.trim(), 
          history 
        }),
      })

      if (!response.ok || !response.body) throw new Error('Server error')

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim()
          if (!raw) continue

          let event: Record<string, unknown>
          try { event = JSON.parse(raw) } catch { continue }

          const evType = event.type as string

          if (evType === 'token') {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsg.id
                  ? { ...m, content: m.content + (event.content as string) }
                  : m
              )
            )
          } else if (evType === 'memory_write' || evType === 'recall') {
            const act = event as unknown as MemoryActivity
            addMemoryEntry(act)
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsg.id
                  ? { ...m, activities: [...m.activities, act] }
                  : m
              )
            )
          } else if (evType === 'done') {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsg.id ? { ...m, streaming: false } : m
              )
            )
          }
        }
      }
    } catch (e) {
      console.error(e)
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsg.id
            ? {
                ...m,
                content: '⚠️ Could not reach the backend. Make sure the server is running.',
                streaming: false,
              }
            : m
        )
      )
    } finally {
      setLoading(false)
      setMessages((prev) =>
        prev.map((m) => (m.streaming ? { ...m, streaming: false } : m))
      )
    }
  }, [loading, userName, memwalAccountId, memwalPrivateKey, addMemoryEntry])

  return { messages, memoryEntries, loading, sendMessage }
}
