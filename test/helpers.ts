import { existsSync, readFileSync } from 'node:fs'
import { decode } from 'fast-png'
import { MODELS, Models } from '../src/models.js'
import type { BgrImage, GrayImage } from '../src/image.js'

export const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url)

/** Reads an 8-bit single-channel PNG. */
export function readGray(url: URL): GrayImage {
  const png = decode(readFileSync(url))
  if (png.channels !== 1 || png.depth !== 8) {
    throw new Error(`${url.pathname}: expected 8-bit grayscale, got ${png.channels} channels`)
  }
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) }
}

/** Reads an 8-bit RGB or RGBA PNG as BGR, like cv2.imread. */
export function readBgr(url: URL): BgrImage {
  const png = decode(readFileSync(url))
  if ((png.channels !== 3 && png.channels !== 4) || png.depth !== 8) {
    throw new Error(`${url.pathname}: expected 8-bit RGB, got ${png.channels} channels`)
  }
  const n = png.width * png.height
  const data = new Uint8Array(n * 3)
  for (let i = 0; i < n; i++) {
    data[3 * i] = png.data[png.channels * i + 2]!
    data[3 * i + 1] = png.data[png.channels * i + 1]!
    data[3 * i + 2] = png.data[png.channels * i]!
  }
  return { width: png.width, height: png.height, data }
}

/** Number of positions where two arrays differ. */
export function countDifferences(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let n = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++
  return n
}

const modelsDir = new URL('../models/', import.meta.url)

/** True when `npm run fetch-models` has downloaded every model. */
export const haveModels = Object.values(MODELS).every((m) => existsSync(new URL(m.file, modelsDir)))

export const localModels = () =>
  new Models(async (file) => readFileSync(new URL(file, modelsDir)))
