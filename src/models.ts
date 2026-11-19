import * as ort from 'onnxruntime-web'

import { MODELS } from './model-files.js'

export { MODELS }

export type ModelName = keyof typeof MODELS

/** Where model bytes come from: a URL prefix, or a function that returns a model's bytes. */
export type ModelSource = string | ((file: string) => Promise<ArrayBuffer | Uint8Array>)

function loader(source: ModelSource): (file: string) => Promise<ArrayBuffer | Uint8Array> {
  if (typeof source !== 'string') return source
  const base = source.endsWith('/') ? source : `${source}/`
  return async (file) => {
    const response = await fetch(base + file)
    if (!response.ok) throw new Error(`Fetching model ${file} failed: HTTP ${response.status}`)
    return response.arrayBuffer()
  }
}

/** Creates each model's inference session on first use and keeps it. */
export class Models {
  private readonly load: (file: string) => Promise<ArrayBuffer | Uint8Array>
  private readonly sessions = new Map<ModelName, Promise<ort.InferenceSession>>()

  constructor(
    source: ModelSource,
    private readonly options: ort.InferenceSession.SessionOptions = {},
  ) {
    this.load = loader(source)
  }

  session(name: ModelName): Promise<ort.InferenceSession> {
    let session = this.sessions.get(name)
    if (!session) {
      session = this.load(MODELS[name].file).then((bytes) =>
        ort.InferenceSession.create(
          bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
          this.options,
        ),
      )
      // Let a later call retry a failed load
      session.catch(() => this.sessions.delete(name))
      this.sessions.set(name, session)
    }
    return session
  }

  async release(): Promise<void> {
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(sessions.map(async (s) => (await s).release()))
  }
}
