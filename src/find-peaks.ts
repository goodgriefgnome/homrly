// Port of homr/find_peaks.py, homr's replacement for scipy.signal.find_peaks.

export interface FindPeaksOptions {
  height?: number
  distance?: number
  prominence?: number
}

export function findPeaks(x: ArrayLike<number>, { height, distance, prominence }: FindPeaksOptions = {}): number[] {
  const n = x.length
  if (n < 3) return []
  // Local maxima, the middle of plateaus
  let peaks: number[] = []
  let i = 1
  while (i < n - 1) {
    if (x[i]! > x[i - 1]!) {
      let j = i
      while (j < n - 1 && x[j] === x[j + 1]) j++
      if (j < n - 1 && x[j]! > x[j + 1]!) peaks.push(Math.floor((i + j) / 2))
      i = j + 1
    } else if (x[i] === x[i - 1]) {
      let j = i
      while (j < n - 1 && x[j] === x[j + 1]) j++
      if (j < n - 1 && x[j]! > x[j + 1]!) peaks.push(Math.floor((i + j) / 2))
      i = j + 1
    } else {
      i++
    }
  }
  if (height !== undefined) peaks = peaks.filter((p) => x[p]! >= height)
  if (prominence !== undefined) {
    peaks = peaks.filter((peak) => {
      let leftMin = x[peak]!
      for (let k = peak - 1; k >= 0; k--) {
        if (x[k]! > x[peak]!) break
        leftMin = Math.min(leftMin, x[k]!)
      }
      let rightMin = x[peak]!
      for (let k = peak + 1; k < n; k++) {
        if (x[k]! > x[peak]!) break
        rightMin = Math.min(rightMin, x[k]!)
      }
      return x[peak]! - Math.max(leftMin, rightMin) >= prominence
    })
  }
  if (distance !== undefined && peaks.length > 1) {
    // np.argsort(x[peaks])[::-1]: highest first. numpy's default sort is not stable for
    // long arrays, so the order of equal heights can differ from homr's for those.
    const order = peaks.map((_, k) => k).sort((a, b) => x[peaks[a]!]! - x[peaks[b]!]!).reverse()
    const keep: number[] = []
    for (const k of order) {
      const peak = peaks[k]!
      if (keep.every((kept) => Math.abs(kept - peak) >= distance)) keep.push(peak)
    }
    peaks = keep.sort((a, b) => a - b)
  }
  return peaks
}
