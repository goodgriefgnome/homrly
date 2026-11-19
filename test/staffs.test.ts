import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadCv } from '../src/cv.js'
import type { RotatedRect } from '../src/geometry.js'
import { detectSingleStaffs, type SingleStaffs } from '../src/pipeline.js'
import { finishPredictions, predictionsFromClasses } from '../src/predictions.js'
import { fixture, readBgr, readGray } from './helpers.js'

type ReferenceStaff = {
  grid: Array<[number, number[], number]>
  average_unit_size: number
  notes: Array<[RotatedRect, number, RotatedRect | null, number | null]>
}

describe.each(['piano', 'photo'])('staffs on %s', (name) => {
  const reference: ReferenceStaff[] = JSON.parse(readFileSync(fixture(`${name}.staffs.json`), 'utf8'))
  let result: SingleStaffs

  beforeAll(async () => {
    const cv = await loadCv()
    const predictions = finishPredictions(
      cv,
      predictionsFromClasses(
        readBgr(fixture(`${name}.png`)),
        readGray(fixture(`${name}.preprocessed.png`)),
        readGray(fixture(`${name}.segmentation.png`)),
      ),
    )
    result = detectSingleStaffs(predictions)
  })

  it('finds the same staffs as homr', () => {
    expect(result.staffs.map((s) => s.grid.map((p) => [p.x, p.y, p.angle]))).toEqual(reference.map((s) => s.grid))
    expect(result.staffs.map((s) => s.averageUnitSize)).toEqual(reference.map((s) => s.average_unit_size))
  })

  it('puts the same notes on them', () => {
    expect(
      result.staffs.map((s) =>
        s.getNotes().map((n) => [n.box.box, n.position, n.stem?.box ?? null, n.stemDirection ?? null]),
      ),
    ).toEqual(reference.map((s) => s.notes))
  })
})
