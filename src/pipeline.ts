// The stages of homr/main.py, from the segmentation onwards.
import type { RotatedBoundingBox } from './bounding-boxes.js'
import type { Note, Staff } from './model.js'
import { median } from './np.js'
import { addNotesToStaffs } from './note-detection.js'
import type { InputPredictions } from './predictions.js'
import { breakWideFragments, detectStaff, estimateUnitSizeFromClefs } from './staff-detection.js'
import { combineNoteheadsWithStems, detectBarLines, predictSymbols, type NoteheadWithStem } from './symbols.js'

export interface SingleStaffs {
  predictions: InputPredictions
  staffs: Staff[]
  notes: Note[]
  noteheadsWithStems: NoteheadWithStem[]
  barLines: RotatedBoundingBox[]
}

/** Port of main.detect_single_staffs, once the predictions are ready. */
export function detectSingleStaffs(predictions: InputPredictions): SingleStaffs {
  const symbols = predictSymbols(predictions)
  const staffFragments = breakWideFragments(symbols.staffFragments)
  const noteheadsWithStems = combineNoteheadsWithStems(symbols.noteheads, symbols.stemsRest)
  let averageNoteHeadHeight: number
  if (noteheadsWithStems.length > 0) {
    averageNoteHeadHeight = median(noteheadsWithStems.map((n) => n.notehead.size[1]))
  } else {
    const unitSize = estimateUnitSizeFromClefs(staffFragments, symbols.clefsKeys)
    if (unitSize === undefined) throw new Error('No noteheads or clefs found')
    averageNoteHeadHeight = unitSize
  }
  const noteheads = noteheadsWithStems.map((n) => n.notehead)
  const stems = noteheadsWithStems.flatMap((n) => (n.stem ? [n.stem] : []))
  const barLinesOrRests = symbols.barLines.filter(
    (line) => !line.isOverlappingWithAny(noteheads) && !line.isOverlappingWithAny(stems),
  )
  const barLines = detectBarLines(barLinesOrRests, averageNoteHeadHeight)
  const staffs = detectStaff(predictions.staff, staffFragments, symbols.clefsKeys, barLines, predictions.symbols)
  if (staffs.length === 0) throw new Error('No staffs found')
  const notes = addNotesToStaffs(staffs, noteheadsWithStems, predictions.notehead)
  return { predictions, staffs, notes, noteheadsWithStems, barLines }
}
