import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadCv } from '../src/cv.js'
import { pointPolygonTest, polygonsOverlap } from '../src/geometry.js'
import { fixture } from './helpers.js'

describe('polygonsOverlap', () => {
  beforeAll(() => loadCv())

  it("agrees with homr's do_polygons_overlap on random boxes and ellipses", () => {
    const cases: Array<[number[], number[], boolean]> = JSON.parse(
      readFileSync(fixture('units/overlaps.json'), 'utf8'),
    )
    const wrong = cases.filter(([a, b, expected]) => polygonsOverlap(Int32Array.from(a), Int32Array.from(b)) !== expected)
    expect(wrong).toEqual([])
  })
})

describe('pointPolygonTest', () => {
  const square = Int32Array.of(0, 0, 10, 0, 10, 10, 0, 10)
  it('tells inside, edge and outside apart', () => {
    expect(pointPolygonTest(square, 5, 5)).toBe(1)
    expect(pointPolygonTest(square, 10, 5)).toBe(0)
    expect(pointPolygonTest(square, 0, 0)).toBe(0)
    expect(pointPolygonTest(square, 11, 5)).toBe(-1)
  })
})
