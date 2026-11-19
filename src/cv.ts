// A build of OpenCV with only what homrly uses, see tools/opencv/build.sh
import opencv from '../vendor/opencv/opencv.mjs'

/** The opencv.js module. Its typings are loose, so most calls go through `any`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CV = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Mat = any

let loaded: CV | undefined

/** Waits for opencv.js to finish initializing and returns it. */
export async function loadCv(): Promise<CV> {
  loaded ??= await opencv
  return loaded
}

/** opencv.js once loadCv() has finished, for code that cannot wait for it. */
export function cvSync(): CV {
  if (!loaded) throw new Error('opencv.js is not loaded yet, await loadCv() first')
  return loaded
}

/** Tracks Mats so that they can be freed together; opencv.js does not free them itself. */
export class MatScope {
  private readonly mats: Mat[] = []

  constructor(readonly cv: CV) {}

  /** Registers a Mat for deletion and returns it. */
  track<T extends Mat>(mat: T): T {
    this.mats.push(mat)
    return mat
  }

  /** An empty Mat. */
  empty(): Mat {
    return this.track(new this.cv.Mat())
  }

  /** A Mat holding a copy of interleaved 8-bit pixels. */
  fromU8(data: Uint8Array, width: number, height: number, channels: 1 | 3): Mat {
    const type = channels === 1 ? this.cv.CV_8UC1 : this.cv.CV_8UC3
    const mat = this.track(new this.cv.Mat(height, width, type))
    mat.data.set(data)
    return mat
  }

  delete(): void {
    for (const mat of this.mats.splice(0)) if (!mat.isDeleted()) mat.delete()
  }
}

/** Runs `fn` with a scope whose Mats are deleted afterwards. */
export function withMats<T>(cv: CV, fn: (scope: MatScope) => T): T {
  const scope = new MatScope(cv)
  try {
    return fn(scope)
  } finally {
    scope.delete()
  }
}

/** A copy of a continuous 8-bit Mat's pixels. */
export function matToU8(mat: Mat): Uint8Array {
  return new Uint8Array(mat.data)
}
