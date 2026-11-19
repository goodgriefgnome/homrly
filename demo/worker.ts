// Runs the recognition off the main thread.
import * as ort from 'onnxruntime-web'
import { recognize, type Progress } from '../src/recognize.js'
import type { RgbaPixels } from '../src/image.js'

export type Request = { image: RgbaPixels; modelsUrl: string; ortUrl: string; title: string }
export type Response =
  | { type: 'progress'; progress: Omit<Progress, 'staffImage'>; staffImage?: ImageData }
  | { type: 'download'; file: string; loaded: number; total: number }
  | { type: 'result'; musicXml: string; lilypond: string; seconds: number }
  | { type: 'error'; message: string }

const post = (message: Response, transfer: Transferable[] = []) => self.postMessage(message, { transfer })


/** Fetches a model, keeping it in the Cache API so that it is downloaded only once. */
async function loadModel(baseUrl: string, file: string): Promise<ArrayBuffer> {
  const url = new URL(file, baseUrl).href
  const cache = 'caches' in self ? await caches.open('homrly-models') : undefined
  const cached = await cache?.match(url)
  if (cached) return cached.arrayBuffer()
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`Fetching ${file} failed: HTTP ${response.status}`)
  const total = Number(response.headers.get('Content-Length') ?? 0)
  const chunks: Uint8Array[] = []
  let loaded = 0
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.length
    post({ type: 'download', file, loaded, total })
  }
  const bytes = new Uint8Array(loaded)
  let offset = 0
  for (const c of chunks) {
    bytes.set(c, offset)
    offset += c.length
  }
  await cache?.put(url, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }))
  return bytes.buffer
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const { image, modelsUrl, ortUrl, title } = event.data
  ort.env.wasm.wasmPaths = ortUrl
  // Threads need cross-origin isolation (the COOP and COEP headers)
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1
  const started = performance.now()
  try {
    const result = await recognize(image, {
      models: (file) => loadModel(modelsUrl, file),
      title,
      onProgress: ({ staffImage, ...progress }) => {
        if (!staffImage) return post({ type: 'progress', progress })
        // Gray to RGBA for display
        const rgba = new Uint8ClampedArray(staffImage.width * staffImage.height * 4)
        staffImage.data.forEach((v, i) => rgba.set([v, v, v, 255], i * 4))
        const imageData = new ImageData(rgba, staffImage.width, staffImage.height)
        post({ type: 'progress', progress, staffImage: imageData }, [rgba.buffer])
      },
    })
    post({ type: 'result', musicXml: result.musicXml, lilypond: result.lilypond, seconds: (performance.now() - started) / 1000 })
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}
