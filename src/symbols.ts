// Port of main.predict_symbols, bar_line_detection.py and
// note_detection.combine_noteheads_with_stems.
import {
  BoundingEllipse,
  RotatedBoundingBox,
  createBoundingEllipses,
  createRotatedBoundingBoxes,
} from './bounding-boxes.js'
import { cvSync, withMats } from './cv.js'
import type { InputPredictions, Mask } from './predictions.js'

export enum StemDirection {
  Up = 1,
  Down = 2,
}

export interface PredictedSymbols {
  noteheads: BoundingEllipse[]
  staffFragments: RotatedBoundingBox[]
  clefsKeys: RotatedBoundingBox[]
  stemsRest: RotatedBoundingBox[]
  barLines: RotatedBoundingBox[]
}

/** bar_line_detection.prepare_bar_line_image: dilation with a 5 (tall) by 3 kernel. */
export function prepareBarLineImage(image: Mask): Mask {
  const cv = cvSync()
  return withMats(cv, (s) => {
    const src = s.track(new cv.Mat(image.height, image.width, cv.CV_8UC1))
    src.data.set(image.data)
    const out = s.empty()
    cv.dilate(src, out, s.track(cv.Mat.ones(5, 3, cv.CV_8U)))
    return { width: image.width, height: image.height, data: new Uint8Array(out.data) }
  })
}

export function predictSymbols(predictions: InputPredictions): PredictedSymbols {
  return {
    noteheads: createBoundingEllipses(predictions.notehead, { minSize: [4, 4] }),
    staffFragments: createRotatedBoundingBoxes(predictions.staff, {
      skipMerging: true,
      minSize: [5, 1],
      maxSize: [10000, 100],
    }),
    clefsKeys: createRotatedBoundingBoxes(predictions.clefsKeys, { minSize: [20, 40], maxSize: [1000, 1000] }),
    stemsRest: createRotatedBoundingBoxes(predictions.stemsRest),
    barLines: createRotatedBoundingBoxes(prepareBarLineImage(predictions.stemsRest), {
      skipMerging: true,
      minSize: [1, 5],
    }),
  }
}

/** bar_line_detection.detect_bar_lines: filters bar line candidates by their size. */
export function detectBarLines(barLines: RotatedBoundingBox[], unitSize: number): RotatedBoundingBox[] {
  return barLines.filter((line) => !(line.size[1] < 3 * unitSize) && !(line.size[0] > 2 * unitSize))
}

export class NoteheadWithStem {
  constructor(
    readonly notehead: BoundingEllipse,
    readonly stem: RotatedBoundingBox | undefined,
    readonly stemDirection: StemDirection | undefined = undefined,
  ) {}
}

/**
 * Combines noteheads with their stems, as this tells which vertical lines are stems and
 * which are bar lines.
 */
export function combineNoteheadsWithStems(
  noteheads: BoundingEllipse[],
  stems: RotatedBoundingBox[],
): NoteheadWithStem[] {
  const sorted = [...noteheads].sort((a, b) => a.box[0][1] - b.box[0][1])
  return sorted.map((notehead) => {
    const thickened = notehead.makeBoxThicker(15)
    const stem = stems.find((s) => s.isOverlapping(thickened))
    if (!stem) return new NoteheadWithStem(notehead, undefined, undefined)
    const direction = stem.center[1] < notehead.center[1] ? StemDirection.Up : StemDirection.Down
    return new NoteheadWithStem(notehead, stem, direction)
  })
}
