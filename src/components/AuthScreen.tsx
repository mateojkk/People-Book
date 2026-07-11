import { useState } from 'react'
import { ConnectButton, useCurrentAccount } from '@mysten/dapp-kit'

export default function AuthScreen({ onUsernamePicked }: { onUsernamePicked?: (name: string, accountId: string, privateKey: string) => void }) {
  const account = useCurrentAccount()
  const [name, setName] = useState('')
  const [accountId, setAccountId] = useState('')
  const [privateKey, setPrivateKey] = useState('')

  if (account && onUsernamePicked) {
    const isFormValid = name.trim() && accountId.trim() && privateKey.trim()
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', width: '100%', background: 'var(--bg-base)' }}>
        <div style={{ padding: '2.5rem', background: 'var(--bg-card)', borderRadius: '12px', border: '1px solid var(--border)', width: '380px', textAlign: 'center', boxShadow: '0 4px 20px rgba(0,0,0,0.03)' }}>
          <h2 style={{ margin: '0 0 1rem 0', fontWeight: 500, color: 'var(--text-primary)' }}>Agent Setup</h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '2rem', fontSize: '0.95rem', lineHeight: '1.5', fontWeight: 300 }}>
            Connect your Walrus Memory account.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (isFormValid) onUsernamePicked(name.trim(), accountId.trim(), privateKey.trim())
            }}
            style={{ display: 'flex', flexDirection: 'column', gap: '1rem', textAlign: 'left' }}
          >
            <div>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>Username</label>
              <input
                type="text"
                placeholder="e.g. Mateo"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                style={{ width: '100%', padding: '0.8rem', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: '1rem', fontWeight: 400, boxSizing: 'border-box' }}
              />
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>MemWal Account ID</label>
              <input
                type="text"
                placeholder="0x..."
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                style={{ width: '100%', padding: '0.8rem', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: '1rem', fontWeight: 400, boxSizing: 'border-box' }}
              />
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>MemWal Private Key</label>
              <input
                type="password"
                placeholder="Paste your delegate private key..."
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                style={{ width: '100%', padding: '0.8rem', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: '1rem', fontWeight: 400, boxSizing: 'border-box' }}
              />
            </div>
            <button 
              type="submit" 
              disabled={!isFormValid}
              style={{ marginTop: '1rem', padding: '0.8rem', borderRadius: '8px', border: 'none', background: isFormValid ? 'var(--accent)' : 'var(--border)', color: isFormValid ? '#fff' : 'var(--text-muted)', fontSize: '1rem', cursor: isFormValid ? 'pointer' : 'not-allowed', fontWeight: 500 }}
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
