import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadCv } from '../src/cv.js'
import { Staff, StaffPoint, type MultiStaff } from '../src/model.js'
import { detectSingleStaffs } from '../src/pipeline.js'
import { finishPredictions, predictionsFromClasses, type InputPredictions } from '../src/predictions.js'
import {
  groupStaffs,
  horizontalPairs,
  joinPiecesWithModel,
  joinStaffPieces,
  predictHorizontalRelations,
  predictVerticalRelations,
} from '../src/staff-relations.js'
import { repairSystems } from '../src/system-repair.js'
import { fixture, haveModels, localModels, readBgr, readGray } from './helpers.js'

type ReferenceSystem = {
  certain: boolean
  staffs: Array<{ is_grandstaff: boolean; grid: Array<[number, number[], number]>; notes: number }>
}
type Reference = {
  horizontal_pairs: Array<[number, number]>
  joined: Array<{ grid: Array<[number, number[], number]> }>
  vertical_pairs: Array<[number, number]>
  probabilities: number[][]
  systems: ReferenceSystem[]
  repaired: ReferenceSystem[]
}

const grid = (s: Staff) => s.grid.map((p) => [p.x, p.y, p.angle])
const systemJson = (m: MultiStaff) => ({
  certain: m.certain,
  staffs: m.staffs.map((s) => ({ is_grandstaff: s.isGrandstaff, grid: grid(s), notes: s.getNotes().length })),
})

describe.skipIf(!haveModels).each(['piano', 'photo'])('systems on %s', (name) => {
  const reference: Reference = JSON.parse(readFileSync(fixture(`${name}.systems.json`), 'utf8'))
  let predictions: InputPredictions
  let staffs: Staff[]

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
    staffs = detectSingleStaffs(predictions).staffs
  })

  it('groups the staffs into the same systems as homr', { timeout: 60_000 }, async () => {
    const models = localModels()
    try {
      expect(horizontalPairs(staffs)).toEqual(reference.horizontal_pairs)
      const joined = await joinPiecesWithModel(models, predictions, staffs)
      expect(joined.map(grid)).toEqual(reference.joined.map((s) => s.grid))
      const { pairs, probabilities } = await predictVerticalRelations(models, predictions, joined)
      expect(pairs).toEqual(reference.vertical_pairs)
      probabilities.flat().forEach((p, i) => expect(p).toBeCloseTo(reference.probabilities.flat()[i]!, 4))
      const systems = groupStaffs(joined, pairs, probabilities)
      expect(systems.map(systemJson)).toEqual(reference.systems)
      expect(repairSystems(systems).map(systemJson)).toEqual(reference.repaired)
    } finally {
      await models.release()
    }
  })
})

describe.skipIf(!haveModels)('staff pieces', () => {
  it('joins pieces of the piano staffs like homr', { timeout: 60_000 }, async () => {
    const reference: {
      pieces: Array<Array<[number, number[], number]>>
      pairs: Array<[number, number]>
      features: number[][]
      crop_sums: number[]
      probabilities: number[][]
      joined: number[][]
    } = JSON.parse(readFileSync(fixture('units/staff_pieces.json'), 'utf8'))
    const cv = await loadCv()
    const predictions = finishPredictions(
      cv,
      predictionsFromClasses(
        readBgr(fixture('piano.png')),
        readGray(fixture('piano.preprocessed.png')),
        readGray(fixture('piano.segmentation.png')),
      ),
    )
    const pieces = reference.pieces.map((grid) => new Staff(grid.map(([x, y, a]) => new StaffPoint(x, y, a))))
    const models = localModels()
    try {
      const { pairs, crops, feats, probabilities } = await predictHorizontalRelations(models, predictions, pieces)
      expect(pairs).toEqual(reference.pairs)
      const size = crops.length / pairs.length
      reference.crop_sums.forEach((sum, k) => {
        expect(crops.subarray(k * size, (k + 1) * size).reduce((a, b) => a + b, 0)).toBeCloseTo(sum, 2)
      })
      Array.from(feats).forEach((f, i) => expect(f).toBeCloseTo(reference.features.flat()[i]!, 5))
      probabilities.flat().forEach((p, i) => expect(p).toBeCloseTo(reference.probabilities.flat()[i]!, 4))
      expect(joinStaffPieces(pieces, pairs, probabilities).map((s) => s.grid.map((p) => p.x))).toEqual(reference.joined)
    } finally {
      await models.release()
    }
  })
})
