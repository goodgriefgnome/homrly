import { describe, expect, it } from 'vitest'
import { mergeTiles, segment, tileOrigins } from '../src/segmentation.js'
import { fixture, haveModels, localModels, readGray } from './helpers.js'

describe('tileOrigins', () => {
  it('clamps the last row and column of tiles to the image', () => {
    expect(tileOrigins(500, 700, 320, 320)).toEqual([
      [0, 0], [0, 320], [0, 380],
      [180, 0], [180, 320], [180, 380],
    ])
  })

  it('starts tiles before the image when it is smaller than a tile', () => {
    expect(tileOrigins(100, 200, 320, 320)).toEqual([[-220, -120]])
  })
})

describe('mergeTiles', () => {
  it('averages overlapping tiles and truncates to a class', () => {
    // A 1x3 image with 2-pixel tiles stepping by 1. Like homr's loop, the tiles start at
    // x = 0, 1 and 1 again, since the last start is clamped to width - winSize.
    const tiles = [Uint8Array.of(5, 4, 0, 0), Uint8Array.of(1, 2, 0, 0), Uint8Array.of(3, 3, 0, 0)]
    const merged = mergeTiles(tiles, 1, 3, 2, 1)
    // Pixel 1: (4 + 1 + 3) / 3 = 2.67, pixel 2: (2 + 3) / 2 = 2.5, both truncated to 2
    expect([...merged.data]).toEqual([5, 2, 2])
  })
})

describe.skipIf(!haveModels).each(['piano', 'photo'])('segment %s', (name) => {
  it('matches homr', { timeout: 120_000 }, async () => {
    const image = readGray(fixture(`${name}.preprocessed.png`))
    const expected = readGray(fixture(`${name}.segmentation.png`))
    const models = localModels()
    try {
      const result = await segment(await models.session('segnet'), image)
      expect([result.width, result.height]).toEqual([expected.width, expected.height])
      let differing = 0
      for (let i = 0; i < result.data.length; i++) if (result.data[i] !== expected.data[i]) differing++
      console.log(`segment: ${differing} of ${result.data.length} pixels differ from homr`)
      // onnxruntime-web and homr's onnxruntime can round differently, which flips a few
      // pixels at class boundaries
      expect(differing / result.data.length).toBeLessThan(1e-4)
    } finally {
      await models.release()
    }
  })
})
