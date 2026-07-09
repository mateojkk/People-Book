import { useRef } from 'react'

interface Props {
  value: string
  loading: boolean
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onSend: () => void
}

export default function ChatInput({ value, loading, onChange, onKeyDown, onSend }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px'
    }
  }

  return (
    <div className="input-area">
      <div className="input-wrapper">
        <textarea
          ref={textareaRef}
          className="chat-input"
          placeholder="Ask me anything privately"
          value={value}
          onChange={handleChange}
          onKeyDown={onKeyDown}
          rows={1}
          disabled={loading}
        />
        <div className="input-actions-row">
          <div className="input-pills"></div>
          <button
            className="send-btn"
            onClick={onSend}
            disabled={loading || !value.trim()}
            aria-label="Send message"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <path d="M12 19V5M5 12l7-7 7 7"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
