import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { autocrop } from '../src/autocrop.js'
import { loadCv } from '../src/cv.js'
import { preprocess, roundHalfEven, targetImageSize } from '../src/preprocess.js'
import { countDifferences, fixture, readBgr, readGray } from './helpers.js'

describe('targetImageSize', () => {
  it('rounds halves to even like Python', () => {
    expect([roundHalfEven(2.5), roundHalfEven(3.5), roundHalfEven(-2.5), roundHalfEven(2.4)]).toEqual([2, 4, -2, 2])
    expect(targetImageSize(1920, 1000)).toEqual([1920, 1000])
    expect(targetImageSize(1242, 1754)).toEqual([1920, 2711])
  })
})

describe.each(['piano', 'photo'])('preprocess %s', (name) => {
  it('crops like homr', { timeout: 60_000 }, async () => {
    const cv = await loadCv()
    const expected = JSON.parse(readFileSync(fixture(`${name}.autocrop.json`), 'utf8'))
    const { image, offset } = autocrop(cv, readBgr(fixture(`${name}.png`)))
    expect({ x: offset[0], y: offset[1], width: image.width, height: image.height }).toEqual(expected)
  })

  it('produces the same image as homr', { timeout: 60_000 }, async () => {
    const cv = await loadCv()
    const { preprocessed } = preprocess(cv, readBgr(fixture(`${name}.png`)))
    const expected = readGray(fixture(`${name}.preprocessed.png`))
    expect([preprocessed.width, preprocessed.height]).toEqual([expected.width, expected.height])
    expect(countDifferences(preprocessed.data, expected.data)).toBe(0)
  })
})
