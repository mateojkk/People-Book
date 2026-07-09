import { useState, useEffect, useCallback } from 'react'
import type { ChatSession, ChatMessage } from '../types'
import { uid } from '../lib/constants'

export function useChatHistory(address: string | undefined) {
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)

  const getStorageKey = useCallback(() => {
    return address ? `history_${address}` : null
  }, [address])

  // Load from local storage
  useEffect(() => {
    const key = getStorageKey()
    if (!key) {
      setSessions([])
      setActiveSessionId(null)
      return
    }

    try {
      const stored = localStorage.getItem(key)
      if (stored) {
        const parsed = JSON.parse(stored) as ChatSession[]
        setSessions(parsed)
        if (parsed.length > 0) {
          // Default to the most recent session
          setActiveSessionId(parsed[0].id)
        } else {
          // Create an initial session
          createNewSession()
        }
      } else {
        createNewSession()
      }
    } catch (e) {
      console.error('Failed to parse chat history', e)
      createNewSession()
    }
  }, [getStorageKey])

  const createNewSession = () => {
    const newSession: ChatSession = {
      id: uid(),
      title: 'New Chat',
      timestamp: Date.now(),
      messages: [],
    }
    setSessions(prev => {
      const updated = [newSession, ...prev]
      const key = getStorageKey()
      if (key) localStorage.setItem(key, JSON.stringify(updated))
      return updated
    })
    setActiveSessionId(newSession.id)
    return newSession.id
  }

  const updateSessionMessages = (id: string, messages: ChatMessage[]) => {
    setSessions(prev => {
      const updated = prev.map(s => {
        if (s.id === id) {
          // Auto-title based on the first user message
          let title = s.title
          if (title === 'New Chat' && messages.length > 0) {
            const firstUserMsg = messages.find(m => m.role === 'user')
            if (firstUserMsg) {
              title = firstUserMsg.content.slice(0, 30)
              if (firstUserMsg.content.length > 30) title += '...'
            }
          }
          return { ...s, messages, title, timestamp: Date.now() }
        }
        return s
      })
      // Sort so most recent is at the top
      updated.sort((a, b) => b.timestamp - a.timestamp)
      const key = getStorageKey()
      if (key) localStorage.setItem(key, JSON.stringify(updated))
      return updated
    })
  }

  const deleteSession = (id: string) => {
    setSessions(prev => {
      const updated = prev.filter(s => s.id !== id)
      if (updated.length === 0) {
        // We'll let useEffect handle this or just manually recreate one
      }
      const key = getStorageKey()
      if (key) localStorage.setItem(key, JSON.stringify(updated))
      return updated
    })
    if (activeSessionId === id) {
      setActiveSessionId(null)
    }
  }

  return {
    sessions,
    activeSessionId,
    setActiveSessionId,
    createNewSession,
    updateSessionMessages,
    deleteSession
  }
}
