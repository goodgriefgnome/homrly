// Port of homr/staff_detection.py.
import { RotatedBoundingBox, createRotatedBoundingBox } from './bounding-boxes.js'

/**
 * Wide fragments (large x dimension) which are curved tend to be filtered by later steps.
 * They are split into smaller parts instead, which better follow the angles of the curve.
 */
export function breakWideFragments(fragments: RotatedBoundingBox[], limit = 100): RotatedBoundingBox[] {
  const result: RotatedBoundingBox[] = []
  for (const fragment of fragments) {
    let remaining = fragment
    while (remaining.size[0] > limit) {
      const points: Array<[number, number]> = []
      for (let i = 0; i < remaining.contours.length; i += 2) {
        points.push([remaining.contours[i]!, remaining.contours[i + 1]!])
      }
      const minX = Math.min(...points.map((p) => p[0]))
      // Stable sorts by x, like Python's sorted
      const left = points.filter((p) => p[0] < minX + limit).sort((a, b) => a[0] - b[0])
      const right = points.filter((p) => p[0] >= minX + limit).sort((a, b) => a[0] - b[0])
      if (left.length === 0 || right.length === 0) break
      // Keep the parts connected: the first point of the right side goes to the left side,
      // and the last point of the (extended) left side to the right side
      left.push(right[0]!)
      right.push(left[left.length - 1]!)
      result.push(createRotatedBoundingBox(Int32Array.from(left.flat()), remaining.debugId))
      remaining = createRotatedBoundingBox(Int32Array.from(right.flat()), remaining.debugId)
    }
    result.push(remaining)
  }
  return result
}
