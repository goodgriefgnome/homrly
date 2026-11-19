import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defaultClientConditions, defineConfig, type Plugin } from 'vite'

// Cross-origin isolation lets onnxruntime-web run on several threads
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

/** The headers for what the middlewares serve: the workers of the threads need them too. */
function setHeaders(res: { setHeader(name: string, value: string): void }, type: string): void {
  res.setHeader('Content-Type', type)
  for (const [name, value] of Object.entries(isolation)) res.setHeader(name, value)
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
}

const modelsDir = fileURLToPath(new URL('../models/', import.meta.url))
const ortDir = fileURLToPath(new URL('../node_modules/onnxruntime-web/dist/', import.meta.url))
// The CPU build of onnxruntime-web, which the page serves at ort/ (see the worker)
const ortFiles = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']

/**
 * Serves onnxruntime-web's loader and WebAssembly at ort/. They are loaded by URL rather
 * than bundled, as onnxruntime-web starts its threads from the loader's URL.
 */
function serveOrt(): Plugin {
  return {
    name: 'homrly-ort',
    configureServer(server) {
      server.middlewares.use('/ort/', (req, res, next) => {
        const name = (req.url ?? '').split('?')[0]!.replace(/^\//, '')
        if (!ortFiles.includes(name)) return next()
        setHeaders(res, name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
        createReadStream(ortDir + name).pipe(res)
      })
    },
    generateBundle() {
      for (const name of ortFiles) {
        this.emitFile({ type: 'asset', fileName: `ort/${name}`, source: readFileSync(ortDir + name) })
      }
    },
  }
}

/** Serves the models downloaded by `npm run fetch-models` at /models/ during development. */
function serveModels(): Plugin {
  return {
    name: 'homrly-models',
    configureServer(server) {
      server.middlewares.use('/models/', middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use('/models/', middleware)
    },
  }
}

function middleware(
  req: { url?: string },
  res: { setHeader(name: string, value: string): void } & NodeJS.WritableStream,
  next: () => void,
): void {
  const name = decodeURIComponent((req.url ?? '').split('?')[0]!.replace(/^\//, ''))
  const file = modelsDir + name
  if (!/^[\w.-]+\.onnx$/.test(name) || !existsSync(file)) return next()
  setHeaders(res, 'application/octet-stream')
  res.setHeader('Content-Length', String(statSync(file).size))
  createReadStream(file).pipe(res)
}


export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [serveModels(), serveOrt()],
  resolve: {
    // The CPU build, which loads its WebAssembly from ort.env.wasm.wasmPaths
    alias: [{ find: /^onnxruntime-web$/, replacement: 'onnxruntime-web/wasm' }],
    conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions],
  },
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  build: { outDir: '../dist-demo', emptyOutDir: true, target: 'es2022' },
})
