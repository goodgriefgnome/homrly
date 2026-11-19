// Port of homr/transformer/vocabulary.py: the symbols the transformer reads and their
// clean-up. The token lists themselves are in vocabulary-data.ts.
import { Fraction } from './fraction.js'

export const nonote = '.'
export const empty = '_' // for decorations on a note, if there is no decoration

export const DYNAMICS_MODIFIER = [
  'piu',
  'dolce',
  'poco',
  'espress',
  'subito',
  'atempo',
  'leggiero',
  'pocopiu',
  'sempre',
]

// Clefs with a small 8 above (8va) or below (8vb). Pitches are always the written pitches.
export const OCTAVE_CLEFS = ['clef_G2_8vb', 'clef_G2_8va', 'clef_F4_8vb', 'clef_F4_8va']
export const OCTAVE_SHIFTS = ['octaveShift_8va', 'octaveShift_8vb']
export const OCTAVE_SHIFT_STOP = 'octaveShiftStop'

export const SLURS = ['slurStart_slurStop', 'slurStart', 'slurStop']
// State of the primary beam of a note. Secondary beams follow from the durations.
export const BEAMS = ['beamStart', 'beamContinue', 'beamStop']

/** Octaves between written and sounding pitch, e.g. -1 for clef_G2_8vb. */
export function octavesOfClef(clef: string): number {
  if (clef.endsWith('_8vb')) return -1
  if (clef.endsWith('_8va')) return 1
  return 0
}

/** Octaves between written and sounding pitch, e.g. 1 for octaveShift_8va. */
export function octavesOfShift(shift: string): number {
  if (shift === 'octaveShift_8va') return 1
  if (shift === 'octaveShift_8vb') return -1
  return 0
}

/** Moves a pitch like C4 by whole octaves. */
export function transposeOctaves(pitch: string, octaves: number): string {
  if (octaves === 0 || pitch.length !== 2 || !/[0-9]/.test(pitch[1]!)) return pitch
  return pitch[0]! + String(Number(pitch[1]) + octaves)
}

export const isLowerPosition = (position: string) => position.startsWith('lower')
export const isUpperOrHasNoPosition = (position: string) => !isLowerPosition(position)

const startsWithAny = (s: string, prefixes: readonly string[]) => prefixes.some((p) => s.startsWith(p))

/** Splits combined articulations, keeping dynamic modifiers like dynamic_dolce intact. */
export function splitArticulations(articulation: string): string[] {
  const parts = articulation.split('_').filter((p) => p)
  const result: string[] = []
  let index = 0
  while (index < parts.length) {
    if (parts[index] === 'dynamic' && index + 1 < parts.length && DYNAMICS_MODIFIER.includes(parts[index + 1]!)) {
      result.push(`dynamic_${parts[index + 1]}`)
      index += 2
    } else {
      result.push(parts[index]!)
      index++
    }
  }
  return result
}

/** Notes of an eighth or shorter can have a beam. */
export function isBeamable(symbol: EncodedSymbol): boolean {
  return symbol.rhythm.startsWith('note') && symbol.getDuration().kern >= 8
}

/** Splits the value of the slur branch, e.g. into ["slurStart", "beamStop"]. */
export function splitSlurAndBeam(value: string): [string, string] {
  if (value === nonote || value === empty) return [value, empty]
  const parts = value.split('_')
  const beams = parts.filter((p) => BEAMS.includes(p))
  const slurs = parts.filter((p) => !BEAMS.includes(p))
  return [slurs.join('_') || empty, beams[0] ?? empty]
}

export function hasRhythmSymbolAPosition(rhythm: string): boolean {
  return startsWithAny(rhythm, ['note', 'rest', 'clef', 'dynamic', 'octaveShift'])
}

export class SymbolDuration {
  readonly actualNotes: number
  readonly normalNotes: number
  readonly fraction: Fraction

  constructor(
    readonly baseDuration: Fraction,
    readonly dots: number,
    actualNotes: number,
    normalNotes: number,
    readonly kern: number,
  ) {
    const actionNormal = new Fraction(actualNotes, normalNotes)
    this.actualNotes = actionNormal.numerator
    this.normalNotes = actionNormal.denominator
    this.fraction = this.toFraction()
  }

  /** The duration relative to a whole note. */
  private toFraction(): Fraction {
    let dur = this.baseDuration
    let add = dur.div(2)
    for (let i = 0; i < this.dots; i++) {
      dur = dur.add(add)
      add = add.div(2)
    }
    if (this.actualNotes !== this.normalNotes) dur = dur.mul(new Fraction(this.normalNotes, this.actualNotes))
    return dur
  }
}

/** The largest power of two <= n. */
export function priorPowerOfTwo(n: number): number {
  // This produces wrong rhythms, but at least it produces something
  if (n < 1) return 1
  return 2 ** Math.floor(Math.log2(n))
}

/** Parses a Humdrum **kern duration. */
export function kernToSymbolDuration(kern: string): SymbolDuration {
  if (kern.endsWith('m')) return new SymbolDuration(new Fraction(1), 0, 1, 1, 4) // multirest
  let i = 0
  while (i < kern.length && /[0-9]/.test(kern[i]!)) i++
  const baseStr = kern.slice(0, i)
  const rest = kern.slice(i)
  const base = baseStr ? Number(baseStr) : 4
  const dots = [...rest].filter((c) => c === '.').length
  if (kern.includes('G')) return new SymbolDuration(new Fraction(0), dots, 1, 1, base) // grace note
  if (base === 0) return new SymbolDuration(new Fraction(1), dots, 1, 1, base) // whole measure rest
  if ((base & (base - 1)) === 0) return new SymbolDuration(new Fraction(1, base), dots, 1, 1, base)
  // A tuplet
  const normalNotes = priorPowerOfTwo(base)
  return new SymbolDuration(new Fraction(1, normalNotes), dots, base, normalNotes, normalNotes)
}

/** A musical symbol, split into the decoder's branches. */
export class EncodedSymbol {
  /** Derived from the transformer's attention, imprecise. */
  coordinates: ArrayLike<number> | undefined
  /** The coordinates mapped back to the input image. */
  imageCoordinates: [number, number] | undefined
  private duration: SymbolDuration | undefined

  constructor(
    public rhythm: string,
    public pitch = nonote,
    public lift = nonote,
    public articulation = nonote,
    public slur = nonote,
    public position = nonote,
    coordinates?: ArrayLike<number>,
  ) {
    this.coordinates = coordinates
  }

  /** copy.copy */
  copy(): EncodedSymbol {
    const result = new EncodedSymbol(this.rhythm, this.pitch, this.lift, this.articulation, this.slur, this.position, this.coordinates)
    result.imageCoordinates = this.imageCoordinates
    result.duration = this.duration
    return result
  }

  /** A copy with a new rhythm, whose duration is computed again. */
  withRhythm(rhythm: string): EncodedSymbol {
    const result = this.copy()
    result.rhythm = rhythm
    result.duration = undefined
    return result
  }

  isTuplet(): boolean {
    return this.removeTuplet().rhythm !== this.rhythm
  }

  removeTuplet(): EncodedSymbol {
    const match = /^(note|rest)_(\d+)(.*)$/s.exec(this.rhythm)
    if (!match) return this
    let duration = Number(match[2])
    if (duration % 3 === 0) duration = Math.floor(duration / 3) * 2
    else if (duration % 5 === 0) duration = Math.floor(duration / 5) * 4
    else if (duration % 7 === 0) duration = Math.floor(duration / 7) * 4
    else return this
    return this.withRhythm(`${match[1]}_${duration}${match[3]}`)
  }

  changeLift(lift: string): EncodedSymbol {
    const result = this.copy()
    result.lift = lift
    return result
  }

  toUpperPosition(): EncodedSymbol {
    if (isUpperOrHasNoPosition(this.position)) return this
    const result = this.copy()
    result.position = this.position.replace('lower', 'upper')
    return result
  }

  isValid(): boolean {
    const hasPosition = hasRhythmSymbolAPosition(this.rhythm)
    return [this.lift, this.articulation, this.pitch, this.slur, this.position].every((s) => (s !== nonote) === hasPosition)
  }

  addArticulations(articulations: string[]): EncodedSymbol {
    const all = [...articulations, ...splitArticulations(this.articulation)]
    const result = this.copy()
    result.articulation = all.sort().join('_')
    return result
  }

  addSlurs(slurs: string[]): EncodedSymbol {
    const all = [...slurs, ...this.slur.split('_').filter((s) => s)]
    const result = this.copy()
    result.slur = all.sort().join('_')
    return result
  }

  stripArticulations(toBeRemoved: string[], removeAll = false): [string[], EncodedSymbol] {
    if (this.articulation === nonote && !hasRhythmSymbolAPosition(this.rhythm)) return [[], this.copy()]
    const stripped: string[] = []
    const remaining: string[] = []
    for (const a of splitArticulations(this.articulation)) {
      if (removeAll || toBeRemoved.includes(a)) stripped.push(a)
      else remaining.push(a)
    }
    const result = this.copy()
    result.articulation = remaining.length > 0 ? remaining.join('_') : empty
    return [stripped, result]
  }

  stripSlurs(toBeRemoved: string[], removeAll = false): [string[], EncodedSymbol] {
    if (this.slur === nonote && !hasRhythmSymbolAPosition(this.rhythm)) return [[], this.copy()]
    const stripped: string[] = []
    const remaining: string[] = []
    for (const s of this.slur.split('_')) {
      if (!s) continue
      if (removeAll || toBeRemoved.includes(s)) stripped.push(s)
      else remaining.push(s)
    }
    const result = this.copy()
    result.slur = remaining.length > 0 ? remaining.join('_') : empty
    return [stripped, result]
  }

  getDuration(): SymbolDuration {
    if (this.duration) return this.duration
    if (!startsWithAny(this.rhythm, ['note', 'rest'])) {
      // homr warns: only notes and rests have durations
      return new SymbolDuration(new Fraction(0), 0, 1, 1, 1)
    }
    this.duration = kernToSymbolDuration(this.rhythm.split('_')[1]!)
    return this.duration
  }

  toString(): string {
    return [this.rhythm, this.pitch, this.lift, this.articulation, this.slur, this.position].join(' ')
  }

  equals(other: unknown): boolean {
    return other instanceof EncodedSymbol && this.toString() === other.toString()
  }
}

/** Python's sorted() of EncodedSymbols, whose __lt__ compares their strings in reverse. */
export function sortSymbols(symbols: EncodedSymbol[]): EncodedSymbol[] {
  return [...symbols].sort((a, b) => {
    const sa = a.toString()
    const sb = b.toString()
    return sa > sb ? -1 : sa < sb ? 1 : 0
  })
}

function removeRedundantClefsKeysAndTimeSignatures(chords: EncodedSymbol[][]): EncodedSymbol[][] {
  let clefUpper = ''
  let clefLower = ''
  let key = ''
  let time = ''
  return chords.map((chord) => {
    const result: EncodedSymbol[] = []
    for (const symbol of chord) {
      if (symbol.rhythm.startsWith('clef')) {
        if (isUpperOrHasNoPosition(symbol.position)) {
          if (symbol.rhythm !== clefUpper) {
            clefUpper = symbol.rhythm
            result.push(symbol)
          }
        } else if (symbol.rhythm !== clefLower) {
          clefLower = symbol.rhythm
          result.push(symbol)
        }
      } else if (symbol.rhythm.startsWith('keySignature')) {
        if (symbol.rhythm !== key) {
          key = symbol.rhythm
          result.push(symbol)
        }
      } else if (symbol.rhythm.startsWith('timeSignature')) {
        if (symbol.rhythm !== time) {
          time = symbol.rhythm
          result.push(symbol)
        }
      } else {
        result.push(symbol)
      }
    }
    return result
  })
}

function removeDuplicatedPitches(chord: EncodedSymbol[]): EncodedSymbol[] {
  if (chord.length <= 1 || !startsWithAny(chord[0]!.rhythm, ['note', 'rest'])) return chord
  const byPitch = new Map<string, EncodedSymbol>()
  const order: string[] = []
  for (const symbol of chord) {
    const key = `${symbol.pitch} ${symbol.position}`
    const existing = byPitch.get(key)
    if (existing) {
      // homr stores the longer note under the pitch alone, so it is never used
      if (symbol.getDuration().fraction.gt(existing.getDuration().fraction)) byPitch.set(symbol.pitch, symbol)
    } else {
      byPitch.set(key, symbol)
      order.push(key)
    }
  }
  return order.map((k) => byPitch.get(k)!)
}

function groupIntoChords(symbols: EncodedSymbol[]): EncodedSymbol[][] {
  const chords: EncodedSymbol[][] = []
  let isInChord = false
  for (const symbol of symbols) {
    if (symbol.rhythm === 'chord') {
      isInChord = true
    } else if (isInChord && chords.length > 0) {
      chords[chords.length - 1]!.push(symbol)
      isInChord = false
    } else {
      chords.push([symbol])
    }
  }
  return chords
}

function flattenChords(chords: EncodedSymbol[][]): EncodedSymbol[] {
  const result: EncodedSymbol[] = []
  for (const chord of chords) {
    let isInChord = false
    for (const symbol of chord) {
      if (isInChord) result.push(new EncodedSymbol('chord'))
      result.push(symbol)
      isInChord = true
    }
  }
  return result
}

function groupIntoMeasures(chords: EncodedSymbol[][]): EncodedSymbol[][][] {
  const measures: EncodedSymbol[][][] = []
  let current: EncodedSymbol[][] = []
  for (const chord of chords) {
    current.push(chord)
    if (chord.length > 0 && (chord[0]!.rhythm.includes('barline') || chord[0]!.rhythm.includes('repeat'))) {
      measures.push(current)
      current = []
    }
  }
  if (current.length > 0) measures.push(current)
  return measures
}

function durationOfMeasure(measure: EncodedSymbol[][]): Fraction {
  let total = new Fraction(0)
  for (const chord of measure) {
    let duration = new Fraction(0)
    for (const symbol of chord) {
      if (startsWithAny(symbol.rhythm, ['note', 'rest'])) {
        const fraction = symbol.getDuration().fraction
        if (fraction.gt(0) && (fraction.lt(duration) || duration.eq(0))) duration = fraction
      }
    }
    total = total.add(duration)
  }
  return total
}

function typicalDurationOfMeasures(measures: EncodedSymbol[][][]): Fraction {
  const durations = measures.map(durationOfMeasure)
  if (durations.length === 0) return new Fraction(0)
  return [...durations].sort((a, b) => a.compare(b))[Math.floor(durations.length / 2)]!
}

/** The transformer tends to add too many tuplets; removes them by the length of a measure. */
function fixOverEagerTuplets(chords: EncodedSymbol[][]): EncodedSymbol[][] {
  const measures = groupIntoMeasures(chords)
  const typical = typicalDurationOfMeasures(measures)
  return measures
    .map((measure) =>
      durationOfMeasure(measure).lt(typical) ? measure.map((chord) => chord.map((s) => s.removeTuplet())) : measure,
    )
    .flat()
}

/** Decided per staff line, as a voice can join single staffs and grand staffs. */
function onlyKeepLowerStaffIfThereIsAClef(chords: EncodedSymbol[][]): EncodedSymbol[][] {
  let hasLowerClef = false
  let lineStart = 0
  return chords.map((chord, i) => {
    if (chord.some((s) => s.rhythm === 'newline')) {
      hasLowerClef = false
      lineStart = i + 1
    }
    return chord.map((symbol) => {
      if (hasLowerClef) return symbol
      if (i - lineStart < 5 && symbol.rhythm.startsWith('clef') && isLowerPosition(symbol.position)) {
        hasLowerClef = true
        return symbol
      }
      return symbol.toUpperPosition()
    })
  })
}

export function removeDuplicatedSymbols(symbols: EncodedSymbol[], cleanupTuplets = true): EncodedSymbol[] {
  let chords = groupIntoChords(symbols)
  if (cleanupTuplets) {
    chords = fixOverEagerTuplets(chords)
    chords = onlyKeepLowerStaffIfThereIsAClef(chords)
  }
  chords = chords.map(removeDuplicatedPitches)
  chords = removeRedundantClefsKeysAndTimeSignatures(chords)
  return flattenChords(chords)
}

export function sortTokenChords(symbols: EncodedSymbol[], keepChordSymbol = false): EncodedSymbol[][] {
  const chords: EncodedSymbol[][] = []
  let isInChord = false
  for (const symbol of symbols) {
    if (symbol.rhythm === 'chord') {
      isInChord = true
    } else if (isInChord && chords.length > 0) {
      if (keepChordSymbol) chords[chords.length - 1]!.push(new EncodedSymbol('chord'))
      chords[chords.length - 1]!.push(symbol)
      isInChord = false
    } else {
      chords.push([symbol])
    }
  }
  return chords.map(sortSymbols)
}
