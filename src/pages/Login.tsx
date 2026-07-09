import { useNavigate } from 'react-router-dom'
import { useCurrentAccount } from '@mysten/dapp-kit'
import { useEffect } from 'react'
import AuthScreen from '../components/AuthScreen'

export default function Login() {
  const navigate = useNavigate()
  const account = useCurrentAccount()

  useEffect(() => {
    // If we're on the login page but the user has already picked a username,
    // we should redirect them to the chat page.
    if (account) {
      const saved = localStorage.getItem(`username_${account.address}`)
      if (saved) {
        navigate('/')
      }
    }
  }, [account, navigate])

  const handleUsernamePicked = (name: string) => {
    if (account) {
      localStorage.setItem(`username_${account.address}`, name)
      navigate('/')
    }
  }

  return (
    <div className="app">
      <AuthScreen onUsernamePicked={handleUsernamePicked} />
    </div>
  )
}
