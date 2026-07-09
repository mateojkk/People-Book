import { useState } from 'react'
import { ConnectButton, useCurrentAccount } from '@mysten/dapp-kit'

export default function AuthScreen({ onUsernamePicked }: { onUsernamePicked?: (name: string) => void }) {
  const account = useCurrentAccount()
  const [name, setName] = useState('')

  if (account && onUsernamePicked) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', width: '100%', background: 'var(--bg-base)' }}>
        <div style={{ padding: '2.5rem', background: 'var(--bg-card)', borderRadius: '12px', border: '1px solid var(--border)', width: '380px', textAlign: 'center', boxShadow: '0 4px 20px rgba(0,0,0,0.03)' }}>
          <h2 style={{ margin: '0 0 1rem 0', fontWeight: 500, color: 'var(--text-primary)' }}>Pick a Username</h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '2rem', fontSize: '0.95rem', lineHeight: '1.5', fontWeight: 300 }}>
            What should Luna call you?
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (name.trim()) onUsernamePicked(name.trim())
            }}
            style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
          >
            <input
              type="text"
              placeholder="e.g. Mateo"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              style={{ padding: '0.8rem', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: '1rem', fontWeight: 400 }}
            />
            <button 
              type="submit" 
              disabled={!name.trim()}
              style={{ padding: '0.8rem', borderRadius: '8px', border: 'none', background: name.trim() ? 'var(--accent)' : 'var(--border)', color: name.trim() ? '#fff' : 'var(--text-muted)', fontSize: '1rem', cursor: name.trim() ? 'pointer' : 'not-allowed', fontWeight: 500 }}
            >
              Continue
            </button>
          </form>
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', width: '100%', background: 'var(--bg-base)' }}>
      <div style={{ padding: '2.5rem', background: 'var(--bg-card)', borderRadius: '12px', border: '1px solid var(--border)', width: '380px', textAlign: 'center', boxShadow: '0 4px 20px rgba(0,0,0,0.03)' }}>
        <h2 style={{ margin: '0 0 2rem 0', fontWeight: 500, color: 'var(--text-primary)' }}>Sign in to Luna</h2>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <ConnectButton />
        </div>
      </div>
    </div>
  )
}
