import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In local dev, proxy /chat and /health to the FastAPI server (port 8000).
// On Vercel, rewrites in vercel.json handle routing automatically.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/chat': 'http://localhost:8000',
      '/health': 'http://localhost:8000',
    },
  },
})
