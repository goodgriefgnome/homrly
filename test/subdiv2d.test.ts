import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Subdiv2D } from '../src/subdiv2d.js'
import { fixture } from './helpers.js'

describe('Subdiv2D', () => {
  it("gives OpenCV's triangles in OpenCV's order", () => {
    const cases: Array<{ rect: number[]; points: number[][]; triangles: number[][] }> = JSON.parse(
      readFileSync(fixture('units/subdiv.json'), 'utf8'),
    )
    const wrong = cases.flatMap((c, i) => {
      const subdiv = new Subdiv2D(c.rect[0]!, c.rect[1]!, c.rect[2]!, c.rect[3]!)
      for (const [x, y] of c.points) subdiv.insert(x!, y!)
      return JSON.stringify(subdiv.getTriangleList()) === JSON.stringify(c.triangles) ? [] : [i]
    })
    expect(wrong).toEqual([])
  })
})
