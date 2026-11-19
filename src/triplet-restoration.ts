// Port of homr/triplet_restoration.py: restores triplets which are printed without their "3".
// See homr's module documentation for the reasoning: a measure whose voices don't carry on
// where their previous notes ended is checked with three notes in a row taken as a triplet.
import { Fraction } from './fraction.js'
import { EncodedSymbol, sortTokenChords } from './vocabulary.js'

/** A note or rest of a measure: its voice, its duration and its index in the symbols. */
type Note = [voice: string, duration: Fraction, index: number]
type Measure = Note[][]
/** The indices of the notes of three chords in a row (sorted), and whether they are off the beat. */
type Three = [indices: number[], offBeat: boolean]

const MAX_THREES_IN_A_ROW = 4
const MIN_TRIPLETS_ON_A_PAGE = 3
const MAX_MEASURE_LENGTH = 2
const PLAIN = /^(note|rest)_(4|8|16|32|64)$/

const isNoteOrRest = (rhythm: string) => rhythm.startsWith('note') || rhythm.startsWith('rest')
const setKey = (indices: Iterable<number>) => [...new Set(indices)].sort((a, b) => a - b).join(',')
const fromKey = (key: string) => (key === '' ? [] : key.split(',').map(Number))

function asTriplet(symbol: EncodedSymbol): EncodedSymbol {
  const match = PLAIN.exec(symbol.rhythm)
  if (!match) return symbol
  return symbol.withRhythm(`${match[1]}_${Math.floor((Number(match[2]) * 3) / 2)}`)
}

function splitIntoMeasures(symbols: EncodedSymbol[]): Measure[] {
  const indexOf = new Map<EncodedSymbol, number>()
  symbols.forEach((s, i) => indexOf.set(s, i))
  const measures: Measure[] = [[]]
  for (const chord of sortTokenChords(symbols)) {
    const rhythm = chord[0]!.rhythm
    if (rhythm.includes('barline') || rhythm.includes('repeat')) {
      measures.push([])
    } else if (isNoteOrRest(rhythm) && !rhythm.endsWith('m')) {
      measures[measures.length - 1]!.push(
        chord
          .filter((s) => isNoteOrRest(s.rhythm))
          .map((s): Note => [s.position, s.getDuration().fraction, indexOf.get(s)!]),
      )
    }
  }
  return measures
}

/**
 * Times the measure like the MusicXML generator: a chord starts when the earliest note
 * which is still sounding ends. Yields the start of every chord with the voice and end of
 * each of its notes.
 */
function* play(measure: Measure, triplets: Set<number> = new Set()): Generator<[Fraction, Array<[string, Fraction]>]> {
  let clock = new Fraction(0)
  let sounding: Fraction[] = []
  for (const chord of measure) {
    const notes: Array<[string, Fraction]> = []
    for (const [voice, duration, index] of chord) {
      const played = triplets.has(index) ? duration.mul(2).div(3) : duration
      if (played.gt(0)) notes.push([voice, clock.add(played)])
    }
    yield [clock, notes]
    if (notes.length > 0) {
      sounding.push(...notes.map(([, end]) => end))
      clock = Fraction.min(...sounding.filter((end) => end.gt(clock)))
      sounding = sounding.filter((end) => end.gt(clock))
    }
  }
}

/** The places where a voice does not carry on where its previous note ended, and their size. */
function countBreaks(measure: Measure, triplets: Set<number> = new Set()): [number, Fraction] {
  const endOfVoice = new Map<string, Fraction>()
  let breaks = 0
  let size = new Fraction(0)
  for (const [start, notes] of play(measure, triplets)) {
    const ends = new Map<string, Fraction>()
    for (const [voice, end] of notes) ends.set(voice, Fraction.max(ends.get(voice) ?? end, end))
    for (const voice of ends.keys()) {
      const previous = endOfVoice.get(voice)
      if (previous && !previous.eq(start)) {
        breaks++
        size = size.add(start.sub(previous).abs())
      }
    }
    for (const [voice, end] of ends) endOfVoice.set(voice, end)
  }
  if (endOfVoice.size > 0) {
    const endOfMeasure = Fraction.max(...endOfVoice.values())
    for (const end of endOfVoice.values()) {
      if (!end.eq(endOfMeasure)) {
        breaks++
        size = size.add(endOfMeasure.sub(end))
      }
    }
  }
  return [breaks, size]
}

function lengthOf(measure: Measure): Fraction {
  let result = new Fraction(0)
  for (const [, notes] of play(measure)) for (const [, end] of notes) if (end.gt(result)) result = end
  return result
}

/** Threes by their places and note value, as "places|value". */
type ThreesByPlace = Map<string, { places: number[]; value: string; indices: string; offBeat: boolean }>

/**
 * Three chords in a row in one voice with the same plain note value. Voices which go
 * through the same three chords with the same value form one three.
 */
function findSingleThrees(measure: Measure, symbols: EncodedSymbol[]): ThreesByPlace {
  const found: ThreesByPlace = new Map()
  const voices = [...new Set(measure.flatMap((chord) => chord.map(([voice]) => voice)))].sort()
  for (const voice of voices) {
    const chords = measure
      .map((chord, place): [number, number[]] => [place, chord.filter(([v]) => v === voice).map(([, , i]) => i)])
      .filter(([, notes]) => notes.length > 0)
    const values = chords.map(([, notes]) => {
      const matches = notes.map((index) => PLAIN.exec(symbols[index]!.rhythm))
      const plain = new Set(matches.filter((m) => m !== null).map((m) => m![2]!))
      return matches.every((m) => m !== null) && plain.size === 1 ? [...plain][0]! : undefined
    })
    let startOfRun = 0
    values.forEach((value, i) => {
      if (i > 0 && (value === undefined || value !== values[i - 1])) startOfRun = i
      const next3 = values.slice(i, i + 3)
      if (value === undefined || next3.length !== 3 || next3.some((v) => v !== value)) return
      const inVoice = chords.slice(i, i + 3).flatMap(([, notes]) => notes)
      if (!inVoice.some((index) => symbols[index]!.rhythm.startsWith('note'))) return
      const places = chords.slice(i, i + 3).map(([place]) => place)
      const key = `${places.join(',')}|${value}`
      const existing = found.get(key)
      const indices = setKey([...(existing ? fromKey(existing.indices) : []), ...inVoice])
      found.set(key, { places, value, indices, offBeat: (existing?.offBeat ?? false) || (i - startOfRun) % 3 !== 0 })
    })
  }
  return found
}

/** Extends each run of threes by the three which directly follows it in the same voices. */
function addFollowingThree(inARow: ThreesByPlace, single: ThreesByPlace, measure: Measure, symbols: EncodedSymbol[]): ThreesByPlace {
  const longer: ThreesByPlace = new Map()
  for (const { places, value, indices, offBeat } of inARow.values()) {
    const own = fromKey(indices)
    const voices = new Set(own.map((index) => symbols[index]!.position))
    let nextPlace: number | undefined
    for (let place = places[places.length - 1]! + 1; place < measure.length; place++) {
      if (measure[place]!.some(([voice]) => voices.has(voice))) {
        nextPlace = place
        break
      }
    }
    for (const next of single.values()) {
      const nextIndices = fromKey(next.indices)
      const nextVoices = new Set(nextIndices.map((index) => symbols[index]!.position))
      if (
        next.value === value &&
        next.places[0] === nextPlace &&
        !nextIndices.some((i) => own.includes(i)) &&
        nextVoices.size === voices.size &&
        [...nextVoices].every((v) => voices.has(v))
      ) {
        const allPlaces = [...places, ...next.places]
        longer.set(`${allPlaces.join(',')}|${value}`, {
          places: allPlaces,
          value,
          indices: setKey([...own, ...nextIndices]),
          offBeat,
        })
      }
    }
  }
  return longer
}

/** Lexicographic comparison of number lists, like Python's list comparison. */
function compareLists(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!
  return a.length - b.length
}

/** The threes of a measure, and the threes which directly follow each other as one. */
function findThrees(measure: Measure, symbols: EncodedSymbol[]): Three[] {
  const single = findSingleThrees(measure, symbols)
  // dict(single.values()): later threes with the same notes overwrite the off-beat flag
  const threes = new Map<string, boolean>()
  for (const t of single.values()) threes.set(t.indices, t.offBeat)
  let inARow = single
  for (let k = 0; k < MAX_THREES_IN_A_ROW - 1; k++) {
    inARow = addFollowingThree(inARow, single, measure, symbols)
    for (const t of inARow.values()) if (!threes.has(t.indices)) threes.set(t.indices, t.offBeat)
  }
  return [...threes.entries()]
    .map(([key, offBeat]): Three => [fromKey(key), offBeat])
    .sort((a, b) => compareLists(a[0], b[0]))
}

/** Takes threes as triplets, the most helpful first, while each leaves fewer breaks. */
function chooseTriplets(measure: Measure, symbols: EncodedSymbol[]): number[][] {
  const chosen: number[][] = []
  let triplets = new Set<number>()
  let breaks = countBreaks(measure)
  if (breaks[0] === 0 || lengthOf(measure).gt(MAX_MEASURE_LENGTH)) return []
  const threes = findThrees(measure, symbols)
  for (;;) {
    const trials = threes
      .filter(([indices]) => !indices.some((i) => triplets.has(i)))
      .map(([indices, offBeat]) => ({ breaks: countBreaks(measure, new Set([...triplets, ...indices])), offBeat, indices }))
    if (trials.length === 0) break
    // min by (breaks, size), off beat, sorted indices; the first of equal ones
    let best = trials[0]!
    for (const t of trials.slice(1)) {
      const c =
        t.breaks[0] - best.breaks[0] ||
        t.breaks[1].compare(best.breaks[1]) ||
        Number(t.offBeat) - Number(best.offBeat) ||
        compareLists(t.indices, best.indices)
      if (c < 0) best = t
    }
    if (best.breaks[0] >= breaks[0]) break
    chosen.push(best.indices)
    triplets = new Set([...triplets, ...best.indices])
    breaks = best.breaks
  }
  return chosen
}

const noteValue = (symbols: EncodedSymbol[], indices: number[]) => symbols[Math.min(...indices)]!.rhythm.split('_')[1]!

/** The symbols of one voice of a page, with the triplets read as plain notes restored. */
export function restoreUnmarkedTriplets(symbols: EncodedSymbol[]): EncodedSymbol[] {
  const chosen = splitIntoMeasures(symbols).map((m) => chooseTriplets(m, symbols))
  const shown = new Map<string, number>()
  for (const inMeasure of chosen) {
    for (const indices of inMeasure) {
      const v = noteValue(symbols, indices)
      shown.set(v, (shown.get(v) ?? 0) + 1)
    }
  }
  const triplets = new Set<number>()
  for (const inMeasure of chosen) {
    for (const indices of inMeasure) {
      if ((shown.get(noteValue(symbols, indices)) ?? 0) >= MIN_TRIPLETS_ON_A_PAGE) for (const i of indices) triplets.add(i)
    }
  }
  return symbols.map((s, i) => (triplets.has(i) ? asTriplet(s) : s))
}
