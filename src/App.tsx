import { Routes, Route } from 'react-router-dom'
import './App.css'
import Login from './pages/Login'
import Chat from './pages/Chat'

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Chat />} />
    </Routes>
  )
}
