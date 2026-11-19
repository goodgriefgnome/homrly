// Runs the recognition off the main thread.
import * as ort from 'onnxruntime-web'
import type { RgbaPixels } from '../src/image.js'
import { recognize, type Stage } from '../src/recognize.js'

export type WorkerRequest = { image: RgbaPixels; base: string }
export type WorkerMessage =
  | { type: 'stage'; stage: Stage; staff?: number; staffs?: number }
  | { type: 'download'; loaded: number; total: number }
  | { type: 'result'; lilypond: string; seconds: number }
  | { type: 'error'; message: string }

/** models/manifest.json: each model file as parts, to stay under the host's file size limit. */
type Manifest = Record<string, { size: number; parts: string[] }>

const post = (message: WorkerMessage) => self.postMessage(message)

async function cacheOrNull(): Promise<Cache | null> {
  try {
    return 'caches' in self ? await caches.open('homrly-models-v1') : null
  } catch {
    return null
  }
}

/** Loads every model with one progress count, from the Cache API where it was kept. */
function modelLoader(base: string): (file: string) => Promise<Uint8Array> {
  let manifest: Promise<Manifest> | undefined
  let loaded = 0
  return async (file) => {
    manifest ??= fetch(new URL('models/manifest.json', base)).then((r) => {
      if (!r.ok) throw new Error(`The model list is missing (HTTP ${r.status})`)
      return r.json()
    })
    const entries = await manifest
    const total = Object.values(entries).reduce((n, e) => n + e.size, 0)
    const entry = entries[file]
    if (!entry) throw new Error(`The model ${file} is missing`)
    const bytes = new Uint8Array(entry.size)
    let offset = 0
    const cache = await cacheOrNull()
    for (const part of entry.parts) {
      const url = new URL(`models/${part}`, base).href
      let response: Response | undefined
      try {
        response = (await cache?.match(url)) ?? undefined
      } catch {
        response = undefined
      }
      const fromCache = response !== undefined
      if (!response) {
        response = await fetch(url)
        if (!response.ok) throw new Error(`Downloading the models failed (HTTP ${response.status})`)
      }
      const chunk = new Uint8Array(await response.arrayBuffer())
      if (!fromCache) {
        try {
          await cache?.put(url, new Response(chunk))
        } catch {
          // Without the cache the models are downloaded again next time
        }
      }
      bytes.set(chunk, offset)
      offset += chunk.length
      loaded += chunk.length
      post({ type: 'download', loaded, total })
    }
    return bytes
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { image, base } = event.data
  ort.env.wasm.wasmPaths = new URL('ort/', base).href
  // Threads need cross-origin isolation, which not every host offers
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1
  const started = performance.now()
  try {
    const result = await recognize(image, {
      models: modelLoader(base),
      onProgress: ({ stage, staff, staffs }) => post({ type: 'stage', stage, staff, staffs }),
    })
    post({ type: 'result', lilypond: result.lilypond, seconds: (performance.now() - started) / 1000 })
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}
