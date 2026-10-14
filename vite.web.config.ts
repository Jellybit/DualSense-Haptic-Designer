// Browser-only build of the renderer (Chrome/Edge). The desktop app still uses electron-vite.
// assets/ is served as the public dir, so the bundled model is at models/dualsense.glb.
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  publicDir: resolve(__dirname, 'assets'),
  plugins: [react()],
  worker: { format: 'es' },
  server: { host: 'localhost', port: 5174 },
  preview: { host: 'localhost', port: 5174 },
  build: { outDir: resolve(__dirname, 'out/web'), emptyOutDir: true },
})
