import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig, type Plugin } from 'vite'

// Cross-origin isolation (SharedArrayBuffer -> multithreaded WASM). Production hosts must send the same two headers
// (see public/_headers for Cloudflare Pages / Netlify).
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  // Safari is stricter than Chrome about worker scripts under require-corp
  'Cross-Origin-Resource-Policy': 'same-origin',
}

// server.headers only reaches 200 responses: Vite's 304 Not Modified replies (cached pre-bundled deps, which Safari
// revalidates) went out without them, and Safari then refused the nested onnxruntime worker. A middleware that sets
// the headers before anything else runs covers every response, 304 and 404 included.
const isolationHeaders = (): Plugin => {
  const middleware = (_req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => {
    for (const [k, v] of Object.entries(isolation)) res.setHeader(k, v)
    next()
  }
  return {
    name: 'isolation-headers',
    configureServer: (server) => void server.middlewares.stack.unshift({ route: '', handle: middleware as never }),
    configurePreviewServer: (server) => void server.middlewares.stack.unshift({ route: '', handle: middleware as never }),
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    isolationHeaders(),
    react(),
    babel({ presets: [reactCompilerPreset()] })
  ],
})
