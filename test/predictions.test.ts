import { describe, expect, it } from 'vitest'
import { loadCv } from '../src/cv.js'
import { createNoiseMask } from '../src/noise-filtering.js'
import { finishPredictions, predictionsFromClasses } from '../src/predictions.js'
import { countDifferences, fixture, readBgr, readGray } from './helpers.js'

describe('noise filtering', () => {
  it('blanks the same cells as homr', () => {
    const input = readGray(fixture('units/noise.input.png'))
    const expected = readGray(fixture('units/noise.mask.png'))
    const mask = createNoiseMask(input.data.map((v) => v * 255), input.width, input.height)
    expect(mask).toBeDefined()
    expect(countDifferences(mask!, expected.data)).toBe(0)
  })
})

describe.each(['piano', 'photo'])('finishPredictions on %s', (name) => {
  it('gives the same staff mask as homr', { timeout: 60_000 }, async () => {
    const cv = await loadCv()
    const classes = readGray(fixture(`${name}.segmentation.png`))
    const preprocessed = readGray(fixture(`${name}.preprocessed.png`))
    const original = readBgr(fixture(`${name}.png`)) // only carried along here
    const predictions = finishPredictions(cv, predictionsFromClasses(original, preprocessed, classes))
    const expected = readGray(fixture(`${name}.staff.png`))
    expect(countDifferences(predictions.staff.data, expected.data)).toBe(0)
  })
})
