// Port of homr/note_detection.py: add_notes_to_staffs and splitting clumps of noteheads.
import { BoundingEllipse } from './bounding-boxes.js'
import { Note, type Staff } from './model.js'
import { pyRound } from './np.js'
import type { Mask } from './predictions.js'
import { NoteheadWithStem } from './symbols.js'

const noteheadSizeRatio = 1.285714 // width / height

type Rect = [number, number, number, number]

/** The [start, stop) a Python slice start:stop selects in a sequence of length n. */
function pySlice(start: number, stop: number, n: number): [number, number] {
  const clamp = (v: number) => (v < 0 ? Math.max(v + n, 0) : Math.min(v, n))
  return [clamp(start), clamp(stop)]
}

/** Shrinks the box vertically to the noteheads in it, with a pixel of margin. */
function adjustBbox(bbox: Rect, noteheads: Mask): Rect {
  const [y0, y1] = pySlice(bbox[1], bbox[3], noteheads.height)
  const [x0, x1] = pySlice(bbox[0], bbox[2], noteheads.width)
  let top = -1
  let bottom = -1
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (noteheads.data[y * noteheads.width + x]! > 0) {
        if (top < 0) top = y - y0
        bottom = y - y0
        break
      }
    }
  }
  // An invalid note, which is eliminated later by its zero height
  if (top < 0) return bbox
  return [bbox[0], top + bbox[1] - 1, bbox[2], bottom + bbox[1] + 1]
}

function getCenter(bbox: Rect): [number, number] {
  return [pyRound((bbox[0] + bbox[2]) / 2), pyRound((bbox[1] + bbox[3]) / 2)]
}

function checkBboxSize(bbox: Rect, noteheads: Mask, unitSize: number): Rect[] {
  const w = bbox[2] - bbox[0]
  const h = bbox[3] - bbox[1]
  const [cenX] = getCenter(bbox)
  const noteW = noteheadSizeRatio * unitSize
  const noteH = unitSize
  let newBbox: Rect[] = []
  if (Math.abs(w - noteW) > Math.abs(w - noteW * 2)) {
    // At least two notes, one left and one right; their top and bottom can differ
    const left = adjustBbox([bbox[0], bbox[1], cenX, bbox[3]], noteheads)
    const right = adjustBbox([cenX, bbox[1], bbox[2], bbox[3]], noteheads)
    newBbox.push(...checkBboxSize(left, noteheads, unitSize))
    newBbox.push(...checkBboxSize(right, noteheads, unitSize))
  }
  if (newBbox.length > 0) {
    // homr checks the results once more
    newBbox = newBbox.flatMap((box) => checkBboxSize(box, noteheads, unitSize))
  } else {
    const numNotes = pyRound(h / noteH)
    if (numNotes > 0) {
      const subH = Math.floor(h / numNotes)
      for (let i = 0; i < numNotes; i++) {
        newBbox.push([bbox[0], bbox[1] + i * subH, bbox[2], bbox[1] + (i + 1) * subH])
      }
    }
  }
  return newBbox
}

/** Noteheads might be clumped together by the notehead detection. */
function splitClumpsOfNoteheads(notehead: NoteheadWithStem, noteheads: Mask, staff: Staff): NoteheadWithStem[] {
  const n = notehead.notehead
  const bbox: Rect = [
    Math.trunc(n.topLeft[0]),
    Math.trunc(n.topLeft[1]),
    Math.trunc(n.bottomRight[0]),
    Math.trunc(n.bottomRight[1]),
  ]
  const split = checkBboxSize(bbox, noteheads, staff.averageUnitSize)
  if (split.length <= 1) return [notehead]
  return split.map((box) => {
    const center = getCenter(box)
    const size: [number, number] = [box[2] - box[0], box[3] - box[1]]
    return new NoteheadWithStem(
      new BoundingEllipse([center, size, 0], n.contours, n.debugId),
      notehead.stem,
      notehead.stemDirection,
    )
  })
}

export function addNotesToStaffs(staffs: Staff[], noteheads: NoteheadWithStem[], noteheadPred: Mask): Note[] {
  const result: Note[] = []
  for (const staff of staffs) {
    for (const chunk of noteheads) {
      if (!staff.isOnStaffZone(chunk.notehead)) continue
      const center = chunk.notehead.center
      let point = staff.getAt(center[0])
      if (!point) continue
      const unit = point.averageUnitSize
      if (chunk.notehead.size[0] < 0.5 * unit || chunk.notehead.size[1] < 0.5 * unit) continue
      for (const notehead of splitClumpsOfNoteheads(chunk, noteheadPred, staff)) {
        point = staff.getAt(center[0])
        if (!point) continue
        const u = point.averageUnitSize
        const [w, h] = notehead.notehead.size
        if (w < 0.5 * u || w > 3 * u || h < 0.5 * u || h > 2 * u) continue
        const position = point.findPositionInUnitSizes(notehead.notehead)
        const note = new Note(notehead.notehead, position, notehead.stem, notehead.stemDirection)
        result.push(note)
        staff.addSymbol(note)
      }
    }
  }
  return result
}
