// Downloads homr's ONNX models into models/ and checks them against the pinned hashes.
// Usage: node scripts/fetch-models.mjs [model names...]   (default: all)
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { unzipSync } from 'fflate'
import { MODELS } from '../src/model-files.ts'

const release = 'https://github.com/liebharc/homr/releases/download/onnx_checkpoints/'
const dir = new URL('../models/', import.meta.url)
mkdirSync(dir, { recursive: true })

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const names = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(MODELS)

for (const name of names) {
  const model = MODELS[name]
  if (!model) throw new Error(`Unknown model ${name}; known: ${Object.keys(MODELS).join(', ')}`)
  const target = new URL(model.file, dir)
  if (existsSync(target) && sha256(readFileSync(target)) === model.sha256) {
    console.log(`${name}: up to date`)
    continue
  }
  const zipName = model.file.replace(/\.onnx$/, '.zip')
  console.log(`${name}: downloading ${zipName}`)
  const response = await fetch(release + zipName)
  if (!response.ok) throw new Error(`${zipName}: HTTP ${response.status}`)
  const entries = unzipSync(new Uint8Array(await response.arrayBuffer()))
  const bytes = Object.entries(entries).find(([path]) => path.endsWith(model.file))?.[1]
  if (!bytes) throw new Error(`${zipName} does not contain ${model.file}`)
  const hash = sha256(bytes)
  if (hash !== model.sha256) throw new Error(`${model.file}: SHA-256 ${hash}, expected ${model.sha256}`)
  writeFileSync(target, bytes)
}
