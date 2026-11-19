// Port of homr/point_mapping.py: maps points back through the pipeline's image transformations.

export type Point = [number, number]
export type PointMapping = (point: Point) => Point

export const identity: PointMapping = (point) => point

/** Inverse of cropping an image at the top left corner (x, y). */
export const undoCrop =
  (x: number, y: number): PointMapping =>
  ([px, py]) => [px + x, py + y]

/** Inverse of resizing an image from one size to another. */
export function undoResize(
  before: { width: number; height: number },
  after: { width: number; height: number },
): PointMapping {
  const scaleX = after.width / before.width
  const scaleY = after.height / before.height
  return ([px, py]) => [px / scaleX, py / scaleY]
}

/** Applies the mappings in order, so list the inverse of the last transformation first. */
export const chain =
  (...mappings: PointMapping[]): PointMapping =>
  (point) =>
    mappings.reduce((p, m) => m(p), point)
