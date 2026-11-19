// Port of homr/bounding_boxes.py.
import { cvSync } from './cv.js'
import {
  boxPolygon,
  concatContours,
  ellipse2Poly,
  findContours,
  fitEllipse,
  minAreaRect,
  polygonsOverlap,
  rotatedRectangleIntersection,
  type Contour,
  type RotatedRect,
  type Vec2,
} from './geometry.js'
import type { Mask } from './predictions.js'

const toleranceForStaffLineDetection = (unitSize: number) => unitSize / 3
const maxLineGapSize = (unitSize: number) => 5 * unitSize

/** Python's floor division for floats. */
const floorDiv = (a: number, b: number) => Math.floor(a / b)

export function calculateEdgesOfRotatedRectangle([[cx, cy], [w, h]]: RotatedRect): [Vec2, Vec2, Vec2, Vec2] {
  const hw = w / 2
  const hh = h / 2
  return [
    [cx - hw, cy - hh],
    [cx - hw, cy + hh],
    [cx + hw, cy - hh],
    [cx + hw, cy + hh],
  ]
}

export abstract class AnyPolygon {
  constructor(public polygon: Int32Array) {}
}

/** An axis-aligned box (x1, y1, x2, y2). */
export class BoundingBox extends AnyPolygon {
  readonly center: Vec2
  readonly size: Vec2
  readonly rotatedBox: RotatedRect

  constructor(
    readonly box: readonly [number, number, number, number],
    readonly contours: Contour,
    readonly debugId = 0,
  ) {
    const center: Vec2 = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]
    const size: Vec2 = [box[2] - box[0], box[3] - box[1]]
    const rotatedBox: RotatedRect = [center, size, 0]
    super(boxPolygon(rotatedBox))
    this.center = center
    this.size = size
    this.rotatedBox = rotatedBox
  }

  increaseSizeInEachDimension(increase: number, imageWidth: number, imageHeight: number): BoundingBox {
    return new BoundingBox(
      [
        Math.max(this.box[0] - increase, 0),
        Math.max(this.box[1] - increase, 0),
        Math.min(this.box[2] + increase, imageWidth),
        Math.min(this.box[3] + increase, imageHeight),
      ],
      this.contours,
      this.debugId,
    )
  }
}

/** Normalizes OpenCV's angle to [-45, 45], swapping width and height where needed. */
function normalizeBox([[cx, cy], [w, h], angle]: RotatedRect): RotatedRect {
  if (angle > 135) return [[cx, cy], [w, h], angle - 180]
  if (angle < -135) return [[cx, cy], [w, h], angle + 180]
  if (angle > 45) return [[cx, cy], [h, w], angle - 90]
  if (angle < -45) return [[cx, cy], [h, w], angle + 90]
  return [[cx, cy], [w, h], angle]
}

export function sameRect(a: RotatedRect, b: RotatedRect): boolean {
  return a[0][0] === b[0][0] && a[0][1] === b[0][1] && a[1][0] === b[1][0] && a[1][1] === b[1][1] && a[2] === b[2]
}

export abstract class AngledBoundingBox extends AnyPolygon {
  readonly box: RotatedRect
  readonly center: Vec2
  readonly size: Vec2
  readonly angle: number
  readonly topLeft: Vec2
  readonly bottomLeft: Vec2
  readonly topRight: Vec2
  readonly bottomRight: Vec2

  constructor(
    box: RotatedRect,
    readonly contours: Contour,
    polygon: Int32Array,
    readonly debugId = 0,
  ) {
    super(polygon)
    this.box = normalizeBox(box)
    this.center = this.box[0]
    this.size = this.box[1]
    this.angle = this.box[2]
    ;[this.topLeft, this.bottomLeft, this.topRight, this.bottomRight] = calculateEdgesOfRotatedRectangle(this.box)
  }

  isOverlapping(other: AngledBoundingBox | BoundingBox): boolean {
    if (!this.canShapesPossiblyTouch(other)) return false
    return polygonsOverlap(this.polygon, other.polygon)
  }

  isOverlappingWithAny(others: readonly AngledBoundingBox[]): boolean {
    return others.some((other) => this.isOverlapping(other))
  }

  /** A fast check: false means the shapes do not touch, true that they might. */
  protected canShapesPossiblyTouch(other: AngledBoundingBox | BoundingBox): boolean {
    const [center1, axes1] = this.box
    const [center2, axes2] = other instanceof BoundingBox ? other.rotatedBox : other.box
    const distance = Math.sqrt((center1[0] - center2[0]) ** 2 + (center1[1] - center2[1]) ** 2)
    return !(distance > Math.max(...axes1) + Math.max(...axes2))
  }

  /** Python's __eq__: equal when the boxes are equal. */
  equals(other: unknown): boolean {
    return other instanceof AngledBoundingBox && sameRect(this.box, other.box)
  }

  /** A key for Python's __hash__, which hashes the box. */
  key(): string {
    return JSON.stringify(this.box)
  }
}

export class RotatedBoundingBox extends AngledBoundingBox {
  constructor(box: RotatedRect, contours: Contour, debugId = 0) {
    // homr computes the polygon from the box before normalizing its angle
    super(box, contours, boxPolygon(box), debugId)
  }

  isIntersecting(other: RotatedBoundingBox): boolean {
    if (!this.canShapesPossiblyTouch(other)) return false
    return rotatedRectangleIntersection(this.box, other.box) !== 0
  }

  ensureMinDimension(minWidth: number, minHeight: number): RotatedBoundingBox {
    const [center, [w, h], angle] = this.box
    return new RotatedBoundingBox([center, [Math.max(w, minWidth), Math.max(h, minHeight)], angle], this.contours, this.debugId)
  }

  makeBoxThicker(thickness: number): RotatedBoundingBox {
    if (thickness <= 0) return this
    const [center, [w, h], angle] = this.box
    return new RotatedBoundingBox([center, [w + thickness, h + thickness], angle], this.contours, this.debugId)
  }

  moveToXHorizontalBy(xDelta: number): RotatedBoundingBox {
    return new RotatedBoundingBox(
      [[this.center[0] + xDelta, this.center[1]], this.box[1], this.box[2]],
      this.contours,
      this.debugId,
    )
  }

  makeBoxTaller(thickness: number): RotatedBoundingBox {
    const [center, [w, h], angle] = this.box
    return new RotatedBoundingBox([center, [w, h + thickness], angle], this.contours, this.debugId)
  }

  makeBoxTallerKeepCenter(thickness: number): RotatedBoundingBox {
    const [[cx, cy], [w, h], angle] = this.box
    return new RotatedBoundingBox(
      [[cx, cy - floorDiv(thickness, 2)], [w, h + thickness], angle],
      this.contours,
      this.debugId,
    )
  }

  getCenterExtrapolated(x: number): number {
    return (x - this.box[0][0]) * Math.tan((this.box[2] / 180) * Math.PI) + this.box[0][1]
  }

  isOverlappingExtrapolated(other: RotatedBoundingBox, unitSize: number): boolean {
    const [left, right] = this.box[0][0] > other.box[0][0] ? [other, this] : [this, other]
    const centerX = (left.center[0] + right.center[0]) * 0.5
    const tolerance = toleranceForStaffLineDetection(unitSize)
    const maxGap = maxLineGapSize(unitSize)
    if (
      centerX - left.center[0] - floorDiv(left.size[0], 2) > maxGap ||
      right.center[0] - centerX - floorDiv(right.size[0], 2) > maxGap
    ) {
      return false
    }
    const leftAngle = Math.tan((left.box[2] * Math.PI) / 180)
    const rightAngle = Math.tan((right.box[2] * Math.PI) / 180)
    const leftY = (centerX - left.box[0][0]) * leftAngle + left.box[0][1]
    const rightY = (centerX - right.box[0][0]) * rightAngle + right.box[0][1]
    return Math.abs(leftY - rightY) <= tolerance
  }
}

export class BoundingEllipse extends AngledBoundingBox {
  constructor(box: RotatedRect, contours: Contour, debugId = 0) {
    const [[cx, cy], [w, h], angle] = box
    super(
      box,
      contours,
      ellipse2Poly([Math.trunc(cx), Math.trunc(cy)], [Math.trunc(w / 2), Math.trunc(h / 2)], Math.trunc(angle), 0, 360, 1),
      debugId,
    )
  }

  makeBoxThicker(thickness: number): BoundingEllipse {
    const [center, [w, h], angle] = this.box
    return new BoundingEllipse([center, [w + thickness, h + thickness], angle], this.contours, this.debugId)
  }

  makeBoxTaller(thickness: number): RotatedBoundingBox {
    const [center, [w, h], angle] = this.box
    return new RotatedBoundingBox([center, [w, h + thickness], angle], this.contours, this.debugId)
  }
}

function hasValidSize([, [w, h]]: RotatedRect): boolean {
  return !Number.isNaN(w) && !Number.isNaN(h) && w > 0 && h > 0
}

export interface BoxFilter {
  skipMerging?: boolean
  minSize?: Vec2
  maxSize?: Vec2
}

export function createRotatedBoundingBoxes(
  img: Mask,
  { skipMerging = false, minSize, maxSize, thickenBoxes }: BoxFilter & { thickenBoxes?: number } = {},
): RotatedBoundingBox[] {
  const cv = cvSync()
  const contours = findContours(img, cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE)
  let boxes: RotatedBoundingBox[] = []
  contours.forEach((contour, i) => {
    const fit = minAreaRect(contour)
    if (!hasValidSize(fit)) return
    const box = new RotatedBoundingBox(fit, contour, i)
    if (minSize && (box.size[0] < minSize[0] || box.size[1] < minSize[1])) return
    if (maxSize) {
      if (maxSize[0] > 0 && box.size[0] > maxSize[0]) return
      if (maxSize[1] > 0 && box.size[1] > maxSize[1]) return
    }
    boxes.push(box)
  })
  if (skipMerging) return boxes
  if (thickenBoxes !== undefined) boxes = boxes.map((b) => b.makeBoxThicker(thickenBoxes))
  return getBoxForWholeGroup(mergeOverlayingBoundingBoxes(boxes))
}

export function createRotatedBoundingBox(contour: Contour, debugId: number): RotatedBoundingBox {
  return new RotatedBoundingBox(minAreaRect(contour), contour, debugId)
}

export function createBoundingEllipses(
  img: Mask,
  { skipMerging = false, minSize, maxSize }: BoxFilter = {},
): BoundingEllipse[] {
  const cv = cvSync()
  const contours = findContours(img, cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE)
  const boxes: BoundingEllipse[] = []
  contours.forEach((contour, i) => {
    // fitEllipse needs at least 5 points
    if (contour.length / 2 < 5) return
    const fit = fitEllipse(contour)
    if (!hasValidSize(fit)) return
    const box = new BoundingEllipse(fit, contour, i)
    if (minSize && (box.size[0] < minSize[0] || box.size[1] < minSize[1])) return
    if (maxSize && (box.size[0] > maxSize[0] || box.size[1] > maxSize[1])) return
    boxes.push(box)
  })
  if (skipMerging) return boxes
  return getEllipseForWholeGroup(mergeOverlayingBoundingBoxes(boxes))
}

function doGroupsOverlap(group1: AngledBoundingBox[], group2: AngledBoundingBox[]): boolean {
  return group1.some((box1) => group2.some((box2) => box1.isOverlapping(box2)))
}

function getEllipseForWholeGroup(groups: AngledBoundingBox[][]): BoundingEllipse[] {
  return groups.map((group) => {
    const contour = concatContours(group.map((b) => b.contours))
    return new BoundingEllipse(minAreaRect(contour), contour)
  })
}

function getBoxForWholeGroup(groups: AngledBoundingBox[][]): RotatedBoundingBox[] {
  return groups.map((group) => {
    const contour = concatContours(group.map((b) => b.contours))
    return new RotatedBoundingBox(minAreaRect(contour), contour)
  })
}

class UnionFind {
  private readonly parent: number[]
  private readonly rank: number[]

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i)
    this.rank = new Array<number>(n).fill(0)
  }

  find(x: number): number {
    if (this.parent[x] !== x) this.parent[x] = this.find(this.parent[x]!)
    return this.parent[x]!
  }

  union(x: number, y: number): void {
    const rootX = this.find(x)
    const rootY = this.find(y)
    if (rootX === rootY) return
    if (this.rank[rootX]! > this.rank[rootY]!) {
      this.parent[rootY] = rootX
    } else if (this.rank[rootX]! < this.rank[rootY]!) {
      this.parent[rootX] = rootY
    } else {
      this.parent[rootY] = rootX
      this.rank[rootX]!++
    }
  }
}

function mergeGroupsOptimized<T extends AngledBoundingBox>(groups: T[][]): T[][] {
  const n = groups.length
  const uf = new UnionFind(n)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (doGroupsOverlap(groups[i]!, groups[j]!)) uf.union(i, j)
    }
  }
  const merged = new Map<number, T[]>()
  for (let i = 0; i < n; i++) {
    const root = uf.find(i)
    if (!merged.has(root)) merged.set(root, [])
    merged.get(root)!.push(...groups[i]!)
  }
  return [...merged.values()]
}

export function mergeOverlayingBoundingBoxes<T extends AngledBoundingBox>(boxes: readonly T[]): T[][] {
  return mergeGroupsOptimized(boxes.map((box) => [box]))
}
