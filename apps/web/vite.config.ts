import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileViewerRenderers } from '@file-viewer/vite-plugin'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), fileViewerRenderers({ copyAssets: true })],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
