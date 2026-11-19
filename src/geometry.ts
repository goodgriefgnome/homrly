// OpenCV geometry that homr uses, on plain arrays. Contours and polygons are Int32Arrays of
// interleaved x, y coordinates.
import { cvSync, withMats } from './cv.js'
import type { Mask } from './predictions.js'

export type Vec2 = readonly [number, number]
/** OpenCV's RotatedRect as Python's cv2 gives it: ((cx, cy), (width, height), angle). */
export type RotatedRect = readonly [Vec2, Vec2, number]

export type Contour = Int32Array

function contourMat(cv: ReturnType<typeof cvSync>, points: Contour) {
  const mat = new cv.Mat(points.length / 2, 1, cv.CV_32SC2)
  mat.data32S.set(points)
  return mat
}

function toRect(r: { center: { x: number; y: number }; size: { width: number; height: number }; angle: number }): RotatedRect {
  return [[r.center.x, r.center.y], [r.size.width, r.size.height], r.angle]
}

function fromRect(cv: ReturnType<typeof cvSync>, [[cx, cy], [w, h], angle]: RotatedRect) {
  return new cv.RotatedRect(new cv.Point(cx, cy), new cv.Size(w, h), angle)
}

export function minAreaRect(points: Contour): RotatedRect {
  const cv = cvSync()
  return withMats(cv, (s) => toRect(cv.minAreaRect(s.track(contourMat(cv, points)))))
}

export function fitEllipse(points: Contour): RotatedRect {
  const cv = cvSync()
  return withMats(cv, (s) => toRect(cv.fitEllipse(s.track(contourMat(cv, points)))))
}

/** cv2.boxPoints(rect) as float32 corners. */
export function boxPoints(rect: RotatedRect): Array<[number, number]> {
  const cv = cvSync()
  const points: Array<{ x: number; y: number }> = cv.RotatedRect.points(fromRect(cv, rect))
  return points.map((p) => [p.x, p.y])
}

/** cv2.boxPoints(rect).astype(np.int64): the corners truncated toward zero. */
export function boxPolygon(rect: RotatedRect): Int32Array {
  return Int32Array.from(boxPoints(rect).flat().map(Math.trunc))
}

export function ellipse2Poly(
  center: Vec2,
  axes: Vec2,
  angle: number,
  arcStart: number,
  arcEnd: number,
  delta: number,
): Int32Array {
  const cv = cvSync()
  const points = new cv.PointVector()
  try {
    cv.ellipse2Poly(
      new cv.Point(center[0], center[1]),
      new cv.Size(axes[0], axes[1]),
      angle,
      arcStart,
      arcEnd,
      delta,
      points,
    )
    const out = new Int32Array(points.size() * 2)
    for (let i = 0; i < points.size(); i++) {
      const p = points.get(i)
      out[2 * i] = p.x
      out[2 * i + 1] = p.y
    }
    return out
  } finally {
    points.delete()
  }
}

/** cv2.findContours on a mask: the contours, in OpenCV's order. */
export function findContours(mask: Mask, mode: number, method: number): Contour[] {
  const cv = cvSync()
  return withMats(cv, (s) => {
    const image = s.track(new cv.Mat(mask.height, mask.width, cv.CV_8UC1))
    image.data.set(mask.data)
    const contours = s.track(new cv.MatVector())
    cv.findContours(image, contours, s.empty(), mode, method)
    const result: Contour[] = []
    for (let i = 0; i < contours.size(); i++) {
      const c = s.track(contours.get(i))
      result.push(new Int32Array(c.data32S))
    }
    return result
  })
}

/** cv2.rotatedRectangleIntersection(a, b)[0]: INTERSECT_NONE (0), PARTIAL (1) or FULL (2). */
export function rotatedRectangleIntersection(a: RotatedRect, b: RotatedRect): number {
  const cv = cvSync()
  return withMats(cv, (s) => cv.rotatedRectangleIntersection(fromRect(cv, a), fromRect(cv, b), s.empty()))
}

/**
 * Port of cv2.pointPolygonTest(contour, pt, measureDist=False) for integer contours:
 * 1 inside, 0 on an edge, -1 outside.
 */
export function pointPolygonTest(contour: Int32Array, px: number, py: number): number {
  const total = contour.length / 2
  if (total === 0) return -1
  // cvRound rounds halves to even
  const ix = roundHalfEven(px)
  const iy = roundHalfEven(py)
  let counter = 0
  let vx = contour[2 * (total - 1)]!
  let vy = contour[2 * (total - 1) + 1]!
  for (let i = 0; i < total; i++) {
    const v0x = vx
    const v0y = vy
    vx = contour[2 * i]!
    vy = contour[2 * i + 1]!
    if ((v0y <= iy && vy <= iy) || (v0y > iy && vy > iy) || (v0x < ix && vx < ix)) {
      if (
        iy === vy &&
        (ix === vx || (iy === v0y && ((v0x <= ix && ix <= vx) || (vx <= ix && ix <= v0x))))
      ) {
        return 0
      }
      continue
    }
    let dist = (iy - v0y) * (vx - v0x) - (ix - v0x) * (vy - v0y)
    if (dist === 0) return 0
    if (vy < v0y) dist = -dist
    if (dist > 0) counter++
  }
  return counter % 2 === 0 ? -1 : 1
}

function roundHalfEven(x: number): number {
  const r = Math.round(x)
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r
}

/**
 * cv2.intersectConvexConvex(a, b)[0] on float32 copies of integer polygons: the area of
 * their intersection. OpenCV itself is used because homr also passes polygons which are not
 * strictly convex, and OpenCV's results for those are what homr's results depend on.
 */
export function intersectConvexConvexArea(a: Int32Array, b: Int32Array): number {
  const cv = cvSync()
  return withMats(cv, (s) => {
    const pa = s.track(new cv.Mat(a.length / 2, 1, cv.CV_32FC2))
    pa.data32F.set(a)
    const pb = s.track(new cv.Mat(b.length / 2, 1, cv.CV_32FC2))
    pb.data32F.set(b)
    return cv.intersectConvexConvex(pa, pb, s.empty(), true)
  })
}

/** Port of homr's do_polygons_overlap. */
export function polygonsOverlap(a: Int32Array, b: Int32Array): boolean {
  if (intersectConvexConvexArea(a, b) > 0) return true
  // Polygons which merely touch count as overlapping: check the corners, edges included
  for (let i = 0; i < a.length; i += 2) if (pointPolygonTest(b, a[i]!, a[i + 1]!) >= 0) return true
  for (let i = 0; i < b.length; i += 2) if (pointPolygonTest(a, b[i]!, b[i + 1]!) >= 0) return true
  return false
}

/** np.concatenate of contours. */
export function concatContours(contours: Contour[]): Contour {
  const out = new Int32Array(contours.reduce((n, c) => n + c.length, 0))
  let offset = 0
  for (const c of contours) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}
