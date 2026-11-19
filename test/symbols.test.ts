import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import type { AngledBoundingBox } from '../src/bounding-boxes.js'
import { loadCv } from '../src/cv.js'
import type { RotatedRect } from '../src/geometry.js'
import { finishPredictions, predictionsFromClasses } from '../src/predictions.js'
import { breakWideFragments } from '../src/staff-detection.js'
import { combineNoteheadsWithStems, detectBarLines, predictSymbols } from '../src/symbols.js'
import { fixture, readBgr, readGray } from './helpers.js'

type Reference = {
  noteheads: RotatedRect[]
  staff_fragments: RotatedRect[]
  clefs_keys: RotatedRect[]
  stems_rest: RotatedRect[]
  bar_lines: RotatedRect[]
  broken_staff_fragments: RotatedRect[]
  noteheads_with_stems: Array<[RotatedRect, RotatedRect | null, number | null]>
  average_note_head_height: number
  bar_line_boxes: RotatedRect[]
}

const boxes = (list: AngledBoundingBox[]) => list.map((b) => b.box)

describe('symbols on the piano fixture', () => {
  const reference: Reference = JSON.parse(readFileSync(fixture('piano.symbols.json'), 'utf8'))
  let symbols: ReturnType<typeof predictSymbols>

  beforeAll(async () => {
    const cv = await loadCv()
    const predictions = finishPredictions(
      cv,
      predictionsFromClasses(
        readBgr(fixture('piano.png')),
        readGray(fixture('piano.preprocessed.png')),
        readGray(fixture('piano.segmentation.png')),
      ),
    )
    symbols = predictSymbols(predictions)
  })

  it('finds the same boxes as homr', () => {
    expect(boxes(symbols.noteheads)).toEqual(reference.noteheads)
    expect(boxes(symbols.staffFragments)).toEqual(reference.staff_fragments)
    expect(boxes(symbols.clefsKeys)).toEqual(reference.clefs_keys)
    expect(boxes(symbols.stemsRest)).toEqual(reference.stems_rest)
    expect(boxes(symbols.barLines)).toEqual(reference.bar_lines)
  })

  it('breaks wide staff fragments like homr', () => {
    expect(boxes(breakWideFragments(symbols.staffFragments))).toEqual(reference.broken_staff_fragments)
  })

  it('combines noteheads with stems and finds bar lines like homr', () => {
    const withStems = combineNoteheadsWithStems(symbols.noteheads, symbols.stemsRest)
    expect(withStems.map((n) => [n.notehead.box, n.stem?.box ?? null, n.stemDirection ?? null])).toEqual(
      reference.noteheads_with_stems,
    )
    const heights = withStems.map((n) => n.notehead.size[1]).sort((a, b) => a - b)
    const mid = heights.length >> 1
    const average = heights.length % 2 ? heights[mid]! : (heights[mid - 1]! + heights[mid]!) / 2
    expect(average).toBe(reference.average_note_head_height)

    const noteheads = withStems.map((n) => n.notehead)
    const stems = withStems.flatMap((n) => (n.stem ? [n.stem] : []))
    const barLinesOrRests = symbols.barLines.filter(
      (line) => !line.isOverlappingWithAny(noteheads) && !line.isOverlappingWithAny(stems),
    )
    expect(boxes(detectBarLines(barLinesOrRests, average))).toEqual(reference.bar_line_boxes)
  })
})
