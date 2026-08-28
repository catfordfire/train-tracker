import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 8888,
    proxy: {
      '/api': 'http://backend:8889',
      '/health': 'http://backend:8889',
    }
  },
  build: {
    outDir: 'dist',
  },
  define: {
    __API_URL__: JSON.stringify(process.env.VITE_API_URL || ''),
    __STADIA_API_KEY__: JSON.stringify(process.env.VITE_STADIA_API_KEY || ''),
  }
})
