import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MultiStaff, Staff, StaffPoint } from '../src/model.js'
import { repairSystems } from '../src/system-repair.js'
import { fixture } from './helpers.js'

type StaffJson = { is_grandstaff: boolean; x: [number, number, number]; y: number[] }
type Case = {
  systems: Array<{ certain: boolean; staffs: StaffJson[] }>
  repaired: StaffJson[][] | { error: string }
}

function staff({ is_grandstaff, x: [x0, , n], y }: StaffJson): Staff {
  const s = new Staff(Array.from({ length: n }, (_, i) => new StaffPoint(x0 + 10 * i, [...y], 0)))
  s.isGrandstaff = is_grandstaff
  return s
}

function staffJson(s: Staff): StaffJson {
  return { is_grandstaff: s.isGrandstaff, x: [s.grid[0]!.x, s.grid.at(-1)!.x, s.grid.length], y: s.grid[0]!.y }
}

describe('repairSystems', () => {
  const cases: Case[] = JSON.parse(readFileSync(fixture('units/systems.json'), 'utf8'))

  it('repairs random pages like homr', () => {
    const results = cases.map((c) => {
      const systems = c.systems.map((m) => new MultiStaff(m.staffs.map(staff), [], m.certain))
      try {
        return repairSystems(systems).map((m) => m.staffs.map(staffJson))
      } catch (e) {
        return { error: String(e) }
      }
    })
    const wrong = results.flatMap((r, i) => (JSON.stringify(r) === JSON.stringify(cases[i]!.repaired) ? [] : [i]))
    expect(wrong).toEqual([])
  })
})
