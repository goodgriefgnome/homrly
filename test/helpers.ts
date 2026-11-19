import { existsSync, readFileSync } from 'node:fs'
import { decode } from 'fast-png'
import { MODELS, Models } from '../src/models.js'
import type { GrayImage } from '../src/image.js'

export const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url)

/** Reads an 8-bit single-channel PNG. */
export function readGray(url: URL): GrayImage {
  const png = decode(readFileSync(url))
  if (png.channels !== 1 || png.depth !== 8) {
    throw new Error(`${url.pathname}: expected 8-bit grayscale, got ${png.channels} channels`)
  }
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) }
}

const modelsDir = new URL('../models/', import.meta.url)

/** True when `npm run fetch-models` has downloaded every model. */
export const haveModels = Object.values(MODELS).every((m) => existsSync(new URL(m.file, modelsDir)))

export const localModels = () =>
  new Models(async (file) => readFileSync(new URL(file, modelsDir)))
