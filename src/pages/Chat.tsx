import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useCurrentAccount, useCurrentWallet } from '@mysten/dapp-kit'
import { useChat } from '../hooks/useChat'
import { useChatHistory } from '../hooks/useChatHistory'
import MessageBubble from '../components/MessageBubble'
import WelcomeScreen from '../components/WelcomeScreen'
import ChatInput from '../components/ChatInput'

export default function Chat() {
  const navigate = useNavigate()
  const account = useCurrentAccount()
  const { connectionStatus } = useCurrentWallet()
  const [userName, setUserName] = useState<string | null>(null)

  useEffect(() => {
    if (connectionStatus === 'connecting') return

    if (!account) {
      const timeoutId = setTimeout(() => {
        navigate('/login')
      }, 500)
      return () => clearTimeout(timeoutId)
    } else {
      const saved = localStorage.getItem(`username_${account.address}`)
      if (saved) {
        setUserName(saved)
      } else {
        navigate('/login')
      }
    }
  }, [account, connectionStatus, navigate])

  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  
  const { 
    sessions, 
    activeSessionId, 
    setActiveSessionId, 
    createNewSession, 
    updateSessionMessages 
  } = useChatHistory(account?.address)

  const activeSession = sessions.find(s => s.id === activeSessionId)
  const initialMessages = activeSession?.messages || []

  const { messages, loading, sendMessage } = useChat(
    userName, 
    activeSessionId,
    initialMessages, 
    (newMessages) => {
      if (activeSessionId) {
        updateSessionMessages(activeSessionId, newMessages)
      }
    }
  )

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = () => {
    if (!userName) return
    sendMessage(input)
    setInput('')
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // If we haven't loaded the userName yet from storage, don't render the chat to avoid jumping
  if (!userName) return null

  const todaySessions = sessions.filter(s => {
    const diff = Date.now() - s.timestamp
    return diff < 24 * 60 * 60 * 1000
  })

  const olderSessions = sessions.filter(s => {
    const diff = Date.now() - s.timestamp
    return diff >= 24 * 60 * 60 * 1000
  })

  return (
    <div className="app">
      <div className={`chat-history-sidebar ${isSidebarOpen ? 'open' : ''}`}>
        <div className="chat-history-header">
          <button className="icon-btn" onClick={() => setIsSidebarOpen(false)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          </button>
          <button className="icon-btn new-chat-btn" onClick={() => createNewSession()}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
          </button>
        </div>
        <div className="chat-history-list">
          {todaySessions.length > 0 && (
            <>
              <div className="history-group">Today</div>
              {todaySessions.map(s => (
                <div 
                  key={s.id} 
                  className="history-item"
                  style={{ background: s.id === activeSessionId ? '#ebebeb' : 'transparent', color: s.id === activeSessionId ? 'var(--text-primary)' : '' }}
                  onClick={() => setActiveSessionId(s.id)}
                >
                  {s.title}
                </div>
              ))}
            </>
          )}

          {olderSessions.length > 0 && (
            <>
              <div className="history-group">Previous</div>
              {olderSessions.map(s => (
                <div 
                  key={s.id} 
                  className="history-item"
                  style={{ background: s.id === activeSessionId ? '#ebebeb' : 'transparent', color: s.id === activeSessionId ? 'var(--text-primary)' : '' }}
                  onClick={() => setActiveSessionId(s.id)}
                >
                  {s.title}
                </div>
              ))}
            </>
          )}
        </div>
        <div className="chat-history-footer">
          <div className="user-profile">
            <div className="user-avatar">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
            </div>
            {userName}
          </div>
        </div>
      </div>

      <div className="main">
        {!isSidebarOpen && (
          <button className="sidebar-toggle-btn" onClick={() => setIsSidebarOpen(true)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          </button>
        )}

        <section className="chat-panel">
          <div className="messages">
            {messages.length === 0 ? (
              <WelcomeScreen />
            ) : (
              messages.map((msg) => (
                <MessageBubble key={msg.id} message={msg} />
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          <ChatInput
            value={input}
            loading={loading}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onSend={handleSend}
          />
        </section>
      </div>
    </div>
  )
}
