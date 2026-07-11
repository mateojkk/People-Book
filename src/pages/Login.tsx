import { useNavigate } from 'react-router-dom'
import { useCurrentAccount } from '@mysten/dapp-kit'
import { useEffect } from 'react'
import AuthScreen from '../components/AuthScreen'

export default function Login() {
  const navigate = useNavigate()
  const account = useCurrentAccount()

  useEffect(() => {
    // If we're on the login page but the user has already completed setup,
    // we should redirect them to the chat page.
    if (account) {
      const savedName = localStorage.getItem(`username_${account.address}`)
      const savedAccountId = localStorage.getItem(`memwal_account_${account.address}`)
      const savedPrivateKey = localStorage.getItem(`memwal_key_${account.address}`)
      if (savedName && savedAccountId && savedPrivateKey) {
        navigate('/')
      }
    }
  }, [account, navigate])

  const handleUsernamePicked = (name: string, accountId: string, privateKey: string) => {
    if (account) {
      localStorage.setItem(`username_${account.address}`, name)
      localStorage.setItem(`memwal_account_${account.address}`, accountId)
      localStorage.setItem(`memwal_key_${account.address}`, privateKey)
      navigate('/')
    }
  }

  return (
    <div className="app">
      <AuthScreen onUsernamePicked={handleUsernamePicked} />
    </div>
  )
}
