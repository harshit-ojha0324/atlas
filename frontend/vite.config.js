import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The built UI is served by the API itself (same origin, no CORS). For
// `npm run dev`, API paths are proxied to the API on :8000 to keep it that way.
const api = 'http://localhost:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(['/documents', '/search', '/ask'].map(p => [p, api])),
  },
})
