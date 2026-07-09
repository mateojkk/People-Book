import type { ChatMessage } from '../types'
import ActivityBadges from './ActivityBadges'
import TypingIndicator from './TypingIndicator'

const CURSOR_STYLE: React.CSSProperties = {
  display: 'inline-block',
  width: 2,
  height: '1em',
  background: 'var(--accent)',
  marginLeft: 2,
  animation: 'pulse-dot 0.8s ease infinite',
  verticalAlign: 'text-bottom',
}

interface Props {
  message: ChatMessage
}

export default function MessageBubble({ message: msg }: Props) {
  return (
    <div className={`message ${msg.role}`}>
      {msg.role === 'assistant' && (
        <div className="message-avatar">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/>
            <path d="M2 17l10 5 10-5"/>
            <path d="M2 12l10 5 10-5"/>
          </svg>
        </div>
      )}

      <div className="message-content-wrapper">
        {msg.streaming && msg.content === '' ? (
          <TypingIndicator />
        ) : (
          <div className="message-bubble">
            {msg.content.split('\n').map((line, i, arr) => (
              <span key={i}>
                {line}
                {i < arr.length - 1 && <br />}
              </span>
            ))}
            {msg.streaming && <span style={CURSOR_STYLE} />}
          </div>
        )}

        {msg.role === 'assistant' && msg.activities.length > 0 && (
          <ActivityBadges activities={msg.activities} />
        )}
      </div>
    </div>
  )
}
