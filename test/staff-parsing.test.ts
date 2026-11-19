import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadCv } from '../src/cv.js'
import type { MultiStaff } from '../src/model.js'
import type { Models } from '../src/models.js'
import { detectSystems } from '../src/pipeline.js'
import { finishPredictions, predictionsFromClasses, type InputPredictions } from '../src/predictions.js'
import { StaffRegions, parseStaffs, prepareStaffImage } from '../src/staff-parsing.js'
import { readStaff } from '../src/transformer.js'
import { countDifferences, fixture, haveModels, localModels, readBgr, readGray } from './helpers.js'

describe.skipIf(!haveModels).each(['piano', 'photo'])('staff parsing on %s', (name) => {
  const reference: { staffs: string[][]; voices: string[][] } = JSON.parse(
    readFileSync(fixture(`${name}.tokens.json`), 'utf8'),
  )
  let models: Models
  let predictions: InputPredictions
  let systems: MultiStaff[]

  beforeAll(async () => {
    const cv = await loadCv()
    predictions = finishPredictions(
      cv,
      predictionsFromClasses(
        readBgr(fixture(`${name}.png`)),
        readGray(fixture(`${name}.preprocessed.png`)),
        readGray(fixture(`${name}.segmentation.png`)),
      ),
    )
    models = localModels()
    systems = await detectSystems(models, predictions)
  }, 60_000)

  it('prepares the same staff images as homr', () => {
    const regions = new StaffRegions(systems)
    systems
      .flatMap((row) => row.staffs)
      .forEach((staff, i) => {
        const { image } = prepareStaffImage(staff, predictions.preprocessed, regions)
        const expected = readGray(fixture(`${name}.staff-${i}.png`))
        expect([image.width, image.height]).toEqual([expected.width, expected.height])
        // Native OpenCV warps with float32 SIMD code whose rounding depends on the CPU, so
        // homr's own staff images differ by a gray level here and there between machines
        let maxDifference = 0
        image.data.forEach((v, k) => (maxDifference = Math.max(maxDifference, Math.abs(v - expected.data[k]!))))
        expect(maxDifference).toBeLessThanOrEqual(1)
        expect(countDifferences(image.data, expected.data) / image.data.length).toBeLessThan(1e-3)
      })
  })

  it('reads the same tokens as homr', { timeout: 300_000 }, async () => {
    const tokens = []
    for (let i = 0; i < reference.staffs.length; i++) {
      const symbols = await readStaff(models, readGray(fixture(`${name}.staff-${i}.png`)))
      tokens.push(symbols.map(String))
    }
    expect(tokens).toEqual(reference.staffs)
  })

  it('joins them into the same voices as homr', { timeout: 300_000 }, async () => {
    const voices = await parseStaffs(models, systems, predictions.preprocessed)
    expect(voices.map((v) => v.map(String))).toEqual(reference.voices)
    await models.release()
  })
})
