// Helpers that reproduce numpy's results, including its float32 rounding.

const f = Math.fround

/** np.median of float32 values: the middle value, or the float32 mean of the two middle ones. */
export function medianF32(values: Float32Array): number {
  const n = values.length
  if (n === 0) return NaN
  const sorted = Float32Array.from(values).sort()
  const mid = n >> 1
  return n % 2 === 1 ? sorted[mid]! : f(f(sorted[mid - 1]! + sorted[mid]!) / 2)
}

/** np.median of integers, which numpy computes in float64. */
export function medianInt(values: ArrayLike<number>): number {
  const n = values.length
  if (n === 0) return NaN
  const sorted = Float64Array.from(values).sort()
  const mid = n >> 1
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}
