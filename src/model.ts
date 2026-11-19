// Port of homr/model.py: what the pipeline finds on the page.
import {
  AngledBoundingBox,
  BoundingBox,
  BoundingEllipse,
  RotatedBoundingBox,
} from './bounding-boxes.js'
import type { Vec2 } from './geometry.js'
import { diff, mean, median } from './np.js'
import type { PointMapping } from './point-mapping.js'
import { StemDirection } from './symbols.js'

export const numberOfLinesOnAStaff = 5
const maxNumberOfLedgerLines = 4
const staffPositionTolerance = 50

export abstract class SymbolOnStaff {
  constructor(public center: Vec2) {}

  abstract copy(): SymbolOnStaff

  transformCoordinates(transformation: PointMapping): this {
    const copy = this.copy() as this
    copy.center = transformation([this.center[0], this.center[1]])
    return copy
  }
}

export class Accidental extends SymbolOnStaff {
  constructor(
    readonly box: BoundingBox,
    readonly position: number,
  ) {
    super(box.center)
  }

  copy(): Accidental {
    return new Accidental(this.box, this.position)
  }
}

export class Rest extends SymbolOnStaff {
  hasDot = false

  constructor(readonly box: BoundingBox) {
    super(box.center)
  }

  copy(): Rest {
    return new Rest(this.box)
  }
}

export class Note extends SymbolOnStaff {
  hasDot = false
  beams: RotatedBoundingBox[] = []
  flags: RotatedBoundingBox[] = []

  constructor(
    readonly box: BoundingEllipse,
    readonly position: number,
    readonly stem: RotatedBoundingBox | undefined,
    readonly stemDirection: StemDirection | undefined,
  ) {
    super(box.center)
  }

  copy(): Note {
    return new Note(this.box, this.position, this.stem, this.stemDirection)
  }
}

export class BarLine extends SymbolOnStaff {
  constructor(readonly box: RotatedBoundingBox) {
    super(box.center)
  }

  copy(): BarLine {
    return new BarLine(this.box)
  }
}

export class Clef extends SymbolOnStaff {
  constructor(readonly box: BoundingBox) {
    super(box.center)
  }

  copy(): Clef {
    return new Clef(this.box)
  }
}

export class StaffPoint {
  readonly averageUnitSize: number

  constructor(
    readonly x: number,
    readonly y: number[],
    readonly angle: number,
  ) {
    if (y.length % numberOfLinesOnAStaff !== 0) throw new Error('A staff must consist of 5, 10, ... lines')
    this.averageUnitSize = mean(diff(y))
  }

  merge(other: StaffPoint): StaffPoint {
    if (Math.abs(this.x - other.x) > 1e-3) throw new Error("Can't merge points at different positions")
    return new StaffPoint(this.x, [...this.y, ...other.y].sort((a, b) => a - b), (this.angle + other.angle) / 2)
  }

  findPositionInUnitSizes(box: AngledBoundingBox): number {
    const cy = box.center[1]
    // np.argmin: the first of equal minima
    let closest = 0
    for (let i = 1; i < this.y.length; i++) {
      if (Math.abs(this.y[i]! - cy) < Math.abs(this.y[closest]! - cy)) closest = i
    }
    const distance = this.y[closest]! - cy
    const distanceInUnitSizes = pyRoundInt((2 * distance) / this.averageUnitSize)
    return 2 * (this.y.length - closest) + distanceInUnitSizes - 1
  }

  transformCoordinates(transformation: PointMapping): StaffPoint {
    const xy = this.y.map((y) => transformation([this.x, y]))
    return new StaffPoint(mean(xy.map(([x]) => x)), xy.map(([, y]) => y), this.angle)
  }
}

/** Python's round() to an int. */
function pyRoundInt(x: number): number {
  const r = Math.round(x)
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r
}

export class Staff {
  readonly minX: number
  readonly maxX: number
  readonly minY: number
  readonly maxY: number
  readonly averageUnitSize: number
  symbols: SymbolOnStaff[] = []
  isGrandstaff = false
  private readonly yTolerance: number

  constructor(readonly grid: StaffPoint[]) {
    this.minX = grid[0]!.x
    this.maxX = grid[grid.length - 1]!.x
    this.minY = Math.min(...grid.map((p) => Math.min(...p.y)))
    this.maxY = Math.max(...grid.map((p) => Math.max(...p.y)))
    this.averageUnitSize = median(grid.map((p) => p.averageUnitSize))
    this.yTolerance = maxNumberOfLedgerLines * this.averageUnitSize
  }

  isOnStaffZone(item: AngledBoundingBox): boolean {
    const point = this.getAt(item.center[0])
    if (!point) return false
    return !(
      item.center[1] > point.y[point.y.length - 1]! + this.yTolerance ||
      item.center[1] < point.y[0]! - this.yTolerance
    )
  }

  merge(other: Staff): Staff {
    const gridA = new Map<number, StaffPoint>()
    for (const p of this.grid) gridA.set(pyRoundInt(p.x), p)
    const gridB = new Map<number, StaffPoint>()
    for (const p of other.grid) gridB.set(pyRoundInt(p.x), p)
    const xs = [...gridA.keys()].filter((x) => gridB.has(x)).sort((a, b) => a - b)
    const result = new Staff(xs.map((x) => gridA.get(x)!.merge(gridB.get(x)!)))
    result.symbols.push(...this.symbols, ...other.symbols)
    result.isGrandstaff = true
    return result
  }

  /** Inverse of merge: splits a grand staff into its upper and lower staff. */
  split(): [Staff, Staff] | undefined {
    const lines = numberOfLinesOnAStaff
    const grid = this.grid.filter((p) => p.y.length === 2 * lines)
    if (grid.length === 0) return undefined
    const upper = new Staff(grid.map((p) => new StaffPoint(p.x, p.y.slice(0, lines), p.angle)))
    const lower = new Staff(grid.map((p) => new StaffPoint(p.x, p.y.slice(lines), p.angle)))
    const boundary = median(grid.map((p) => (p.y[lines - 1]! + p.y[lines]!) / 2))
    for (const symbol of this.symbols) (symbol.center[1] < boundary ? upper : lower).addSymbol(symbol)
    return [upper, lower]
  }

  addSymbol(symbol: SymbolOnStaff): void {
    this.symbols.push(symbol)
  }

  getAt(x: number): StaffPoint | undefined {
    let closest = this.grid[0]!
    for (const p of this.grid) if (Math.abs(p.x - x) < Math.abs(closest.x - x)) closest = p
    return Math.abs(closest.x - x) > staffPositionTolerance ? undefined : closest
  }

  getNotes(): Note[] {
    return this.symbols.filter((s): s is Note => s instanceof Note)
  }

  extendToXRange(minX: number, maxX: number): Staff {
    const grid = [...this.grid]
    if (minX >= 0 && minX < grid[0]!.x) grid.unshift(new StaffPoint(minX, grid[0]!.y, grid[0]!.angle))
    const last = grid[grid.length - 1]!
    if (maxX >= 0 && maxX > last.x) grid.push(new StaffPoint(maxX, last.y, last.angle))
    return new Staff(grid)
  }

  copy(): Staff {
    return new Staff(this.grid)
  }

  transformCoordinates(transformation: PointMapping): Staff {
    const copy = new Staff(this.grid.map((p) => p.transformCoordinates(transformation)))
    copy.symbols = this.symbols.map((s) => s.transformCoordinates(transformation))
    copy.isGrandstaff = this.isGrandstaff
    return copy
  }
}

/** A grand staff or a staff with multiple voices. */
export class MultiStaff {
  readonly staffs: Staff[]

  constructor(
    staffs: Staff[],
    readonly connections: RotatedBoundingBox[],
    /** The staff relation model is sure that the staffs of this system belong together */
    readonly certain = false,
  ) {
    // Stable, like Python's sorted
    this.staffs = [...staffs].sort((a, b) => a.minY - b.minY)
  }

  merge(other: MultiStaff): MultiStaff {
    // Staff has no __eq__ in homr, so `in` compares identity
    const staffs: Staff[] = []
    for (const s of [...this.staffs, ...other.staffs]) if (!staffs.includes(s)) staffs.push(s)
    const connections: RotatedBoundingBox[] = []
    for (const c of [...this.connections, ...other.connections]) {
      if (!connections.some((x) => x.equals(c))) connections.push(c)
    }
    return new MultiStaff(staffs, connections)
  }

  breakApart(): MultiStaff[] {
    return this.staffs.map((s) => new MultiStaff([s], []))
  }
}
