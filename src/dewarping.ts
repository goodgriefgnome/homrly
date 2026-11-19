// Port of homr/staff_dewarping.py: straightens a staff with a piecewise affine transform.
import { cvSync, withMats, type Mat } from './cv.js'
import type { GrayImage } from './image.js'
import type { Staff } from './model.js'
import { Subdiv2D } from './subdiv2d.js'

const f = Math.fround
type Pt = [number, number]
/** A triangle of float32 points. */
type Tri = [Pt, Pt, Pt]

function boundingRectF32(points: Pt[]): { x: number; y: number; width: number; height: number } {
  const cv = cvSync()
  return withMats(cv, (s) => {
    const mat = s.track(new cv.Mat(points.length, 1, cv.CV_32FC2))
    mat.data32F.set(points.flat())
    const r = cv.boundingRect(mat)
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
}

/** cv2.getAffineTransform of float32 triangles: a 2x3 matrix, row-major, or undefined if singular. */
function getAffineTransform(src: Tri, dst: Tri): number[] | undefined {
  const cv = cvSync()
  return withMats(cv, (s) => {
    const a = s.track(new cv.Mat(3, 1, cv.CV_32FC2))
    a.data32F.set(src.flat())
    const b = s.track(new cv.Mat(3, 1, cv.CV_32FC2))
    b.data32F.set(dst.flat())
    try {
      const m = s.track(cv.getAffineTransform(a, b))
      return Array.from(m.data64F as Float64Array)
    } catch {
      return undefined
    }
  })
}

/** Near-zero area, computed in float32 like numpy on float32 points. */
function isDegenerateTriangle([p0, p1, p2]: Tri): boolean {
  const v1 = [f(p1[0] - p0[0]), f(p1[1] - p0[1])]
  const v2 = [f(p2[0] - p0[0]), f(p2[1] - p0[1])]
  const area = f(Math.abs(f(f(v1[0]! * v2[1]!) - f(v1[1]! * v2[0]!))) / 2)
  return area < 1e-6
}

/** Delaunay triangulation with (a port of) OpenCV's Subdiv2D, as point indices. */
export class DelaunayTriangulation {
  readonly points: Pt[]
  readonly simplices: Array<[number, number, number]>

  constructor(points: Pt[]) {
    this.points = points.map(([x, y]): Pt => [f(x), f(y)])
    if (this.points.length < 3) throw new Error('Need at least 3 points for triangulation')
    const rect = boundingRectF32(this.points)
    const subdiv = new Subdiv2D(rect.x - 10, rect.y - 10, rect.width + 20, rect.height + 20)
    for (const [x, y] of this.points) subdiv.insert(x, y)
    this.simplices = []
    for (const t of subdiv.getTriangleList()) {
      const indices = [0, 2, 4].map((k) => this.findPointIndex(t[k]!, t[k + 1]!))
      if (indices.every((i) => i !== undefined)) this.simplices.push(indices as [number, number, number])
    }
  }

  /** The index of the closest point, if it is within 1e-3 (float32 distances, first of equal). */
  private findPointIndex(x: number, y: number): number | undefined {
    let best = 0
    let bestDistance = Infinity
    this.points.forEach(([px, py], i) => {
      const dx = f(px - x)
      const dy = f(py - y)
      const d = f(Math.sqrt(f(f(dx * dx) + f(dy * dy))))
      if (d < bestDistance) {
        bestDistance = d
        best = i
      }
    })
    return bestDistance < 1e-3 ? best : undefined
  }

  /** The first triangle which contains the point (barycentric, float32), or -1. */
  findSimplex(x: number, y: number): number {
    x = f(x)
    y = f(y)
    for (let j = 0; j < this.simplices.length; j++) {
      const [[x0, y0], [x1, y1], [x2, y2]] = this.simplices[j]!.map((i) => this.points[i]!) as Tri
      const denom = f(f(f(y1 - y2) * f(x0 - x2)) + f(f(x2 - x1) * f(y0 - y2)))
      if (Math.abs(denom) < 1e-10) continue
      const a = f(f(f(f(y1 - y2) * f(x - x2)) + f(f(x2 - x1) * f(y - y2))) / denom)
      const b = f(f(f(f(y2 - y0) * f(x - x2)) + f(f(x0 - x2) * f(y - y2))) / denom)
      const c = f(f(1 - a) - b)
      if (a >= -1e-10 && b >= -1e-10 && c >= -1e-10) return j
    }
    return -1
  }
}

function isPointInTriangle([px, py]: Pt, triangle: Tri): boolean {
  // float32, as numpy computes with float32 corners and Python floats
  const cross = (a: Pt, b: Pt) => f(f(f(b[0] - a[0]) * f(py - a[1])) - f(f(b[1] - a[1]) * f(px - a[0])))
  const d1 = cross(triangle[0], triangle[1])
  const d2 = cross(triangle[1], triangle[2])
  const d3 = cross(triangle[2], triangle[0])
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNegative && hasPositive)
}

const applyAffine = (m: number[], x: number, y: number): Pt => [m[0]! * x + m[1]! * y + m[2]!, m[3]! * x + m[4]! * y + m[5]!]

function invertAffine(m: number[]): number[] {
  // cv2.invertAffineTransform
  let d = m[0]! * m[4]! - m[1]! * m[3]!
  d = d !== 0 ? 1 / d : 0
  const a11 = m[4]! * d
  const a22 = m[0]! * d
  const a12 = -m[1]! * d
  const a21 = -m[3]! * d
  const b1 = -a11 * m[2]! - a12 * m[5]!
  const b2 = -a21 * m[2]! - a22 * m[5]!
  return [a11, a12, b1, a21, a22, b2]
}

export class PiecewiseAffineTransform {
  readonly triangulation: DelaunayTriangulation
  readonly srcPoints: Pt[]
  readonly dstPoints: Pt[]
  readonly affineMatrices: Array<number[] | undefined>

  constructor(src: Pt[], dst: Pt[]) {
    this.srcPoints = src.map(([x, y]): Pt => [f(x), f(y)])
    this.dstPoints = dst.map(([x, y]): Pt => [f(x), f(y)])
    this.triangulation = new DelaunayTriangulation(this.srcPoints)
    this.affineMatrices = this.triangulation.simplices.map((simplex) => {
      const srcTri = simplex.map((i) => this.srcPoints[i]!) as Tri
      const dstTri = simplex.map((i) => this.dstPoints[i]!) as Tri
      if (isDegenerateTriangle(srcTri) || isDegenerateTriangle(dstTri)) return undefined
      return getAffineTransform(srcTri, dstTri)
    })
  }

  transformPoint(point: Pt): Pt {
    const idx = this.triangulation.findSimplex(point[0], point[1])
    if (idx === -1) return point
    const m = this.affineMatrices[idx]
    if (!m) return point
    return applyAffine(m, f(point[0]), f(point[1]))
  }

  /** Maps a point of the warped image back, with the same triangles looked up by their destination. */
  inverseTransformPoint(point: Pt): Pt {
    for (let k = 0; k < this.triangulation.simplices.length; k++) {
      const m = this.affineMatrices[k]
      const tri = this.triangulation.simplices[k]!.map((i) => this.dstPoints[i]!) as Tri
      if (!m || !isPointInTriangle(point, tri)) continue
      return applyAffine(invertAffine(m), f(point[0]), f(point[1]))
    }
    return point
  }

  warpImage(image: GrayImage, fillColor = 1): GrayImage {
    const cv = cvSync()
    const { width, height } = image
    const output = new Uint8Array(width * height).fill(fillColor)
    withMats(cv, (s) => {
      const source: Mat = s.track(new cv.Mat(height, width, cv.CV_8UC1))
      source.data.set(image.data)
      this.triangulation.simplices.forEach((simplex, k) => {
        if (!this.affineMatrices[k]) return
        const srcTri = simplex.map((i) => this.srcPoints[i]!) as Tri
        const dstTri = simplex.map((i) => this.dstPoints[i]!) as Tri
        if (isDegenerateTriangle(srcTri) || isDegenerateTriangle(dstTri)) return
        const sr = boundingRectF32(srcTri)
        const dr = boundingRectF32(dstTri)
        if (sr.width <= 0 || sr.height <= 0 || dr.width <= 0 || dr.height <= 0) return
        const srcCropped = srcTri.map(([x, y]): Pt => [f(x - sr.x), f(y - sr.y)]) as Tri
        const dstCropped = dstTri.map(([x, y]): Pt => [f(x - dr.x), f(y - dr.y)]) as Tri
        if (isDegenerateTriangle(srcCropped) || isDegenerateTriangle(dstCropped)) return
        const warpMat = getAffineTransform(srcCropped, dstCropped)
        if (!warpMat) return
        // image[y:y+h, x:x+w], which numpy clips to the image
        const x0 = Math.max(0, Math.min(sr.x, width))
        const y0 = Math.max(0, Math.min(sr.y, height))
        const x1 = Math.max(x0, Math.min(sr.x + sr.width, width))
        const y1 = Math.max(y0, Math.min(sr.y + sr.height, height))
        if (x1 <= x0 || y1 <= y0) return
        const roi = s.track(source.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0)))
        const m = s.track(cv.matFromArray(2, 3, cv.CV_64F, warpMat))
        const warped = s.empty()
        cv.warpAffine(roi, warped, m, new cv.Size(dr.width, dr.height), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(fillColor))
        const mask = s.track(cv.Mat.zeros(dr.height, dr.width, cv.CV_8UC1))
        const corners = s.track(cv.matFromArray(3, 1, cv.CV_32SC2, dstCropped.flat().map(Math.trunc)))
        cv.fillConvexPoly(mask, corners, new cv.Scalar(255))
        const yc0 = Math.max(0, dr.y)
        const yc1 = Math.min(height, dr.y + dr.height)
        const xc0 = Math.max(0, dr.x)
        const xc1 = Math.min(width, dr.x + dr.width)
        if (yc1 <= yc0 || xc1 <= xc0) return
        const md: Uint8Array = mask.data
        const wd: Uint8Array = warped.data
        for (let y = yc0; y < yc1; y++) {
          for (let x = xc0; x < xc1; x++) {
            const i = (y - dr.y) * dr.width + (x - dr.x)
            if (md[i]! > 0) output[y * width + x] = wd[i]!
          }
        }
      })
    })
    return { width, height, data: output }
  }
}

export class StaffDewarping {
  constructor(readonly tform: PiecewiseAffineTransform | undefined) {}

  dewarp(image: GrayImage, fillColor = 1): GrayImage {
    return this.tform ? this.tform.warpImage(image, fillColor) : image
  }

  dewarpPoint(point: Pt): Pt {
    return this.tform ? this.tform.transformPoint(point) : point
  }

  undewarpPoint(point: Pt): Pt {
    return this.tform ? this.tform.inverseTransformPoint(point) : point
  }
}

function isPointOnImage([x, y]: Pt, image: GrayImage): boolean {
  const margin = 10
  return !(x < margin || x > image.width - margin || y < margin || y > image.height - margin)
}

export function calculateSpanAndOptimalPoints(staff: Staff, image: GrayImage): [Pt[][], Pt[][]] {
  const spanPoints: Pt[][] = []
  const optimalPoints: Pt[][] = []
  let firstYOffset: number | undefined
  const intervals = 6
  const step = Math.trunc(image.height / intervals)
  if (step === 0) return [spanPoints, optimalPoints]
  for (let y = 2; y < image.height - 2; y += step) {
    const linePoints: Pt[] = []
    for (let x = 2; x < image.width; x += 80) {
      const yValues = staff.getAt(x)
      if (!yValues) continue
      const yOffset = yValues.y[2]!
      let yDelta: number
      // `if not first_y_offset` in homr, so an offset of 0 counts as none
      if (!firstYOffset) {
        firstYOffset = yOffset
        yDelta = 0
      } else {
        yDelta = Math.trunc(yOffset - firstYOffset)
      }
      const point: Pt = [x, y + yDelta]
      if (isPointOnImage(point, image)) linePoints.push(point)
    }
    if (linePoints.length > 2) {
      const averageY = linePoints.reduce((sum, p) => sum + p[1], 0) / linePoints.length
      spanPoints.push(linePoints)
      optimalPoints.push(linePoints.map(([x]): Pt => [x, Math.trunc(averageY)]))
    }
  }
  return [spanPoints, optimalPoints]
}

export function calculateDewarpTransformation(image: GrayImage, source: Pt[][], destination: Pt[][]): StaffDewarping {
  const withEnds = (lines: Pt[][]) =>
    lines.map((line): Pt[] => [[0, line[0]![1]], ...line, [image.width, line[line.length - 1]![1]]])
  const withEdges = (lines: Pt[][]): Pt[][] => [
    [
      [0, 0],
      [image.width, 0],
    ],
    ...lines,
    [
      [0, image.height],
      [image.width, image.height],
    ],
  ]
  const src = withEdges(withEnds(source)).flat()
  const dst = withEdges(withEnds(destination)).flat()
  return new StaffDewarping(new PiecewiseAffineTransform(src, dst))
}

export function dewarpStaffImage(image: GrayImage, staff: Staff): StaffDewarping {
  try {
    const [span, optimal] = calculateSpanAndOptimalPoints(staff, image)
    return calculateDewarpTransformation(image, span, optimal)
  } catch {
    // homr logs "Dewarping failed" and goes on without dewarping
    return new StaffDewarping(undefined)
  }
}
