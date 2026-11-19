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

/** numpy's pairwise summation of float64 values, which np.sum and np.mean use. */
export function pairwiseSum(a: ArrayLike<number>, start = 0, n = a.length - start): number {
  if (n < 8) {
    let res = 0
    for (let i = 0; i < n; i++) res += a[start + i]!
    return res
  }
  if (n <= 128) {
    const r = [0, 0, 0, 0, 0, 0, 0, 0].map((_, j) => a[start + j]!)
    let i = 8
    for (; i < n - (n % 8); i += 8) {
      for (let j = 0; j < 8; j++) r[j]! += a[start + i + j]!
    }
    let res = r[0]! + r[1]! + (r[2]! + r[3]!) + (r[4]! + r[5]! + (r[6]! + r[7]!))
    for (; i < n; i++) res += a[start + i]!
    return res
  }
  let n2 = Math.floor(n / 2)
  n2 -= n2 % 8
  return pairwiseSum(a, start, n2) + pairwiseSum(a, start + n2, n - n2)
}

/** np.mean of float64 values. */
export function mean(a: ArrayLike<number>): number {
  return pairwiseSum(a) / a.length
}

/** np.std of float64 values (ddof 0). */
export function std(a: ArrayLike<number>): number {
  const m = mean(a)
  const squares = Array.from(a, (v) => (v - m) * (v - m))
  return Math.sqrt(pairwiseSum(squares) / a.length)
}

/** np.median of float64 values. */
export function median(a: ArrayLike<number>): number {
  const n = a.length
  if (n === 0) return NaN
  const sorted = Float64Array.from(a).sort()
  const mid = n >> 1
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** np.diff. */
export function diff(a: readonly number[]): number[] {
  return a.slice(1).map((v, i) => v - a[i]!)
}

/** Python's round() for floats: halves go to the even neighbour. */
export function pyRound(x: number): number {
  const r = Math.round(x)
  // Math.round rounds halves up; Python rounds them to even
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r
}
