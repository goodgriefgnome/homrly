// Port of homr/music_xml_generator.py: writes the voices read by the transformer as MusicXML.
import { Fraction } from './fraction.js'
import {
  EncodedSymbol,
  OCTAVE_SHIFT_STOP,
  SymbolDuration,
  empty,
  isLowerPosition,
  nonote,
  octavesOfClef,
  octavesOfShift,
  sortTokenChords,
  splitSlurAndBeam,
  transposeOctaves,
} from './vocabulary.js'
import { XmlElement, subElement, toXmlString } from './xml.js'

const durationOfQuarter = 16
const startsWithAny = (s: string, prefixes: readonly string[]) => prefixes.some((p) => s.startsWith(p))
const isNoteOrRest = (rhythm: string) => startsWithAny(rhythm, ['note', 'rest'])
/** int(Fraction): truncates toward zero. */
const int = (f: Fraction) => Math.trunc(f.numerator / f.denominator)
const ZERO = new Fraction(0)

/** Python's round() for floats: halves to even. */
function pyRound(x: number): number {
  const r = Math.round(x)
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r
}

class ConversionState {
  beats = 4 * durationOfQuarter
  tremoloState = 'stop'
  voltaNumber = 1
  lastVoltaMeasure = -10
  /** Octaves between written and sounding pitch per staff, from octave clefs and shifts */
  clefOctaves = new Map<number, number>()
  shiftOctaves = new Map<number, number>()

  constructor(
    readonly division: number,
    public nominator: Fraction,
  ) {}

  soundingPitch(writtenPitch: string, staff: number): string {
    return transposeOctaves(writtenPitch, (this.clefOctaves.get(staff) ?? 0) + (this.shiftOctaves.get(staff) ?? 0))
  }

  startVolta(measureNo: number): number {
    this.voltaNumber = measureNo === this.lastVoltaMeasure + 1 ? this.voltaNumber + 1 : 1
    return this.voltaNumber
  }

  stopVolta(measureNo: number): number {
    this.lastVoltaMeasure = measureNo
    return this.voltaNumber
  }

  toggleTremoloState(): string {
    this.tremoloState = this.tremoloState === 'start' ? 'stop' : 'start'
    return this.tremoloState
  }
}

class SymbolChord {
  /** Tuplet start or stop by position (e.g. upper2); voices have their own tuplets */
  readonly tupletMarks: Map<string, string>

  constructor(
    readonly symbols: EncodedSymbol[],
    tupletMarks?: Map<string, string>,
  ) {
    this.tupletMarks = tupletMarks ?? new Map()
  }

  markFor(symbol: EncodedSymbol): string {
    return this.tupletMarks.get(symbol.position) ?? ''
  }

  isBarline(): boolean {
    if (this.symbols.length === 0) return false
    const first = this.symbols[0]!.rhythm
    return first.includes('barline') || first.includes('repeat')
  }

  /** Splits by position; voices of only rests go first, the last chord advances time. */
  intoPositions(): SymbolChord[] {
    const buckets = new Map<string, EncodedSymbol[]>()
    for (const s of this.symbols) {
      if (!buckets.has(s.position)) buckets.set(s.position, [])
      buckets.get(s.position)!.push(s)
    }
    const chords = [...buckets.values()].map((symbols) => new SymbolChord(symbols, this.tupletMarks))
    // sort(key=all rests, reverse=True) is stable: chords of only rests first
    const onlyRests = (c: SymbolChord) => c.symbols.every((s) => s.rhythm.startsWith('rest'))
    return [...chords.filter(onlyRests), ...chords.filter((c) => !onlyRests(c))]
  }
}

export interface XmlGeneratorArguments {
  largePage?: boolean
  metronome?: number
  tempo?: number
}

export type TimeSignature = [string, string]

function buildIdentification(): XmlElement {
  const ident = new XmlElement('identification')
  const enc = subElement(ident, 'encoding')
  subElement(enc, 'software', {}, 'homr')
  return ident
}

/**
 * The voices as a MusicXML document. inheritedTimes: the time signature in force at the end
 * of the previous page, per part, for a page that continues a score.
 */
export function generateXml(
  args: XmlGeneratorArguments,
  staffs: EncodedSymbol[][],
  title: string,
  inheritedTimes?: Array<TimeSignature | undefined>,
): XmlElement {
  const root = new XmlElement('score-partwise', { version: '4.0' })
  root.append(buildWork(title))
  root.append(buildIdentification())
  root.append(buildDefaults(args))
  const hasTwoStavesByPart = staffs.map(voiceHasTwoStaves)
  root.append(buildPartList(hasTwoStavesByPart))
  const parts = staffs.map((staff, index) =>
    buildPart(args, staff, index, hasTwoStavesByPart[index]!, inheritedTimes && index < inheritedTimes.length ? inheritedTimes[index] : undefined),
  )
  shortenMeasureRestsInPickup(parts)
  root.extend(parts)
  return root
}

/** The voices as a MusicXML string, as homr writes it. */
export function generateMusicXml(staffs: EncodedSymbol[][], title = '', args: XmlGeneratorArguments = {}): string {
  return toXmlString(generateXml(args, staffs, title))
}

const toInt = (s: string | undefined) => {
  const v = Number.parseInt(s ?? '', 10)
  return Number.isNaN(v) ? 0 : v
}

/** The length of a measure in quarter notes: where its last note ends. */
function measureLength(measure: XmlElement, divisions: number): Fraction {
  let position = 0
  let end = 0
  for (const child of measure.children) {
    const duration = toInt(child.findtext('duration', '0') || '0')
    if (child.tag === 'note' && !child.find('chord')) position += duration
    else if (child.tag === 'forward') position += duration
    else if (child.tag === 'backup') position -= duration
    end = Math.max(end, position)
  }
  return new Fraction(end, Math.max(divisions, 1))
}

/** Shortens whole-measure rests in a pickup measure to the pickup's length. */
function shortenMeasureRestsInPickup(parts: XmlElement[]): void {
  const firsts: Array<[XmlElement, number]> = []
  for (const part of parts) {
    const measure = part.find('measure')
    const divisions = toInt(part.findtext('measure/attributes/divisions', '0') || '0')
    if (!measure || divisions <= 0) return
    firsts.push([measure, divisions])
  }
  const lengths = firsts.map(([m, d]) => measureLength(m, d))
  const played = firsts.flatMap(([measure], i) =>
    measure.findall('note').some((n) => !n.find('rest')) ? [lengths[i]!] : [],
  )
  if (played.length === 0) return
  const pickup = Fraction.max(...played)
  firsts.forEach(([measure, divisions], i) => {
    const notes = measure.findall('note')
    if (notes.length === 0) {
      addPickupRests(measure, pickup, divisions)
      return
    }
    const onlyMeasureRests = notes.every((n) => n.find('rest')?.get('measure') === 'yes')
    if (!onlyMeasureRests || lengths[i]!.le(pickup)) return
    const duration = String(Math.max(1, int(pickup.mul(divisions))))
    for (const child of measure.children) {
      if (child.tag === 'note' || child.tag === 'backup') child.find('duration')!.text = duration
    }
  })
}

/** A rest of the pickup's length on each staff of an empty first measure. */
function addPickupRests(measure: XmlElement, pickup: Fraction, divisions: number): void {
  const staves = toInt(measure.findtext('attributes/staves', '1') || '1')
  const duration = String(Math.max(1, int(pickup.mul(divisions))))
  for (let staff = 1; staff <= staves; staff++) {
    if (staff > 1) subElement(subElement(measure, 'backup'), 'duration', {}, duration)
    const note = subElement(measure, 'note')
    subElement(note, 'rest', { measure: 'yes' })
    subElement(note, 'duration', {}, duration)
    subElement(note, 'voice', {}, staff === 1 ? '1' : '5')
    subElement(note, 'staff', {}, String(staff))
  }
}

/** The last time signature of each part, e.g. to continue a score on the next page. */
export function lastTimeSignatures(root: XmlElement): Array<TimeSignature | undefined> {
  return [...root.iter('part')].map((part) => {
    const times = [...part.iter('time')]
    const last = times[times.length - 1]
    return last ? [last.findtext('beats', '')!, last.findtext('beat-type', '')!] : undefined
  })
}

/** True if any symbol uses the lower staff (e.g. piano left hand / bass clef). */
function voiceHasTwoStaves(voice: EncodedSymbol[]): boolean {
  return voice.some((s) => isLowerPosition(s.position))
}

function buildPart(args: XmlGeneratorArguments, voice: EncodedSymbol[], index: number, hasTwoStaves: boolean, inheritedTime?: TimeSignature): XmlElement {
  const part = new XmlElement('part', { id: getPartId(index) })
  for (const measure of buildMeasures(args, voice, index === 0, hasTwoStaves, inheritedTime)) part.append(measure)
  convertTies(part)
  addStems(part)
  convertBeams(part)
  removePositionAttributes(part)
  return part
}

function buildMeasures(
  args: XmlGeneratorArguments,
  voice: EncodedSymbol[],
  isFirstPart: boolean,
  hasTwoStaves = false,
  inheritedTime?: TimeSignature,
): XmlElement[] {
  let clock = new GroupClock()
  let measureNumber = 1
  // Measures a multi-measure rest still covers after the current one
  let restMeasures = 0
  const measures: XmlElement[] = []

  const groups = splitMixedChords(addTupletStartStop(groupIntoChords(voice)))
  const [division, nominators] = findDivisionAndTimeSignatureNominators(groups)
  const state = new ConversionState(division, nominators[0]!)

  const measureRests = (measure: XmlElement) => {
    const positions = hasTwoStaves ? ['upper', 'lower'] : ['upper']
    positions.forEach((position, staffNo) => {
      if (staffNo > 0) measure.append(buildBackup(state.nominator, state))
      measure.append(buildMeasureRest(new EncodedSymbol('measureRest', undefined, undefined, undefined, undefined, position), state))
    })
  }
  const lastMeasure = () => measures[measures.length - 1]
  let currentMeasure = new XmlElement('measure', { number: String(measureNumber) })
  const closeCurrentMeasure = () => {
    rebalanceMeasureVoices(currentMeasure)
    measures.push(currentMeasure)
    clock = new GroupClock()
    // MusicXML writes a multi-measure rest as that many measures
    for (let k = 0; k < restMeasures; k++) {
      measureNumber++
      const measure = new XmlElement('measure', { number: String(measureNumber) })
      measureRests(measure)
      measures.push(measure)
    }
    restMeasures = 0
  }
  const newMeasure = () => {
    closeCurrentMeasure()
    measureNumber++
    currentMeasure = new XmlElement('measure', { number: String(measureNumber) })
  }

  // Without a printed time signature at its start, a page continues in the previous
  // page's one: the model reads only the beat type.
  const inheritedLength = timeSignatureLength(inheritedTime)
  if (inheritedLength !== undefined && !startsWithTimeSignature(groups)) state.nominator = inheritedLength
  else inheritedTime = undefined
  let timeSignatureNo = 0
  const firstAttributes = buildOrGetAttributes(currentMeasure, undefined)
  subElement(firstAttributes, 'divisions', {}, String(Math.floor(division / 4)))
  if (hasTwoStaves) {
    subElement(firstAttributes, 'staves', {}, '2')
    subElement(firstAttributes, 'part-symbol', {}, 'brace')
  }
  if (isFirstPart) {
    const direction = buildAddTimeDirection(args)
    if (direction) currentMeasure.append(direction)
  }
  let attributes: XmlElement | undefined = firstAttributes
  groups.forEach((group, groupNo) => {
    const symbol = group.symbols[0]!
    const rhythm = symbol.rhythm
    const lastAttributes = attributes
    attributes = undefined
    if (isNoteOrRest(rhythm)) {
      if (group.symbols.length === 1 && rhythm.endsWith('m')) {
        attributes = buildOrGetAttributes(currentMeasure, lastAttributes)
        const duration = buildMultiMeasureRest(symbol, attributes)
        if (duration > 0) {
          measureRests(currentMeasure)
          restMeasures = duration - 1
        }
      } else {
        const staffPositions = group.intoPositions()
        const gap = clock.waitForVoices(group)
        if (gap.gt(0)) currentMeasure.append(buildForward(gap, state))
        const advance = clock.advance(group)
        staffPositions.forEach((staffPos, posNo) => {
          const chordDuration = posNo === staffPositions.length - 1 ? advance : ZERO
          for (const noteXml of buildNoteChord(staffPos, state, chordDuration)) currentMeasure.append(noteXml)
        })
      }
      return
    }
    if (rhythm === 'measureRest') {
      // sorted by staff, stable
      const rests = [...group.symbols].sort((a, b) => getStaff(a) - getStaff(b))
      rests.forEach((rest, staffNo) => {
        if (staffNo > 0) currentMeasure.append(buildBackup(state.nominator, state))
        currentMeasure.append(buildMeasureRest(rest, state))
      })
    } else if (rhythm === 'newline') {
      // An octave shift ends with its staff, the next staff repeats it if it continues
      stopOctaveShifts(currentMeasure, state)
      if (groupNo !== groups.length - 1) subElement(currentMeasure, 'print', { 'new-system': 'yes' })
    } else if (rhythm.startsWith('clef')) {
      attributes = buildOrGetAttributes(currentMeasure, lastAttributes, true)
      for (const clef of group.symbols) {
        if (clef.rhythm.startsWith('clef')) {
          buildClef(clef, attributes)
          state.clefOctaves.set(getStaff(clef), octavesOfClef(clef.rhythm))
        }
      }
    } else if (rhythm.startsWith('keySignature')) {
      attributes = buildOrGetAttributes(currentMeasure, lastAttributes)
      buildKey(symbol, attributes)
    } else if (rhythm.startsWith('timeSignature')) {
      attributes = buildOrGetAttributes(currentMeasure, lastAttributes)
      state.nominator = nominators[Math.min(timeSignatureNo, nominators.length - 1)]!
      timeSignatureNo++
      buildTimeSignature(symbol, attributes, state)
    } else if (rhythm.includes('barline')) {
      // A barline right after another one doesn't start a new measure. The first measure
      // of a part is kept even without notes: it's a pickup measure.
      const isEmptyPickup = measures.length === 0 && !hasNotes(currentMeasure)
      const endingMeasure = hasNotes(currentMeasure) || isEmptyPickup ? currentMeasure : lastMeasure()
      if (rhythm !== 'barline' && endingMeasure) buildBarlineStyle(symbol, buildOrGetBarline(endingMeasure, 'right'))
      if (endingMeasure === currentMeasure) newMeasure()
    } else if (rhythm === 'repeatStart') {
      // The repeated section starts with the next measure, or this one if it has no notes yet
      if (hasNotes(currentMeasure)) newMeasure()
      buildRepeat(symbol, buildOrGetBarline(currentMeasure, 'left'))
    } else if (rhythm === 'repeatEnd') {
      const endingMeasure = hasNotes(currentMeasure) ? currentMeasure : lastMeasure()
      if (endingMeasure) buildRepeat(symbol, buildOrGetBarline(endingMeasure, 'right'))
      if (endingMeasure === currentMeasure) newMeasure()
    } else if (rhythm === 'repeatEndStart') {
      const endingMeasure = hasNotes(currentMeasure) ? currentMeasure : lastMeasure()
      if (endingMeasure) buildRepeat(new EncodedSymbol('repeatEnd'), buildOrGetBarline(endingMeasure, 'right'))
      if (endingMeasure === currentMeasure) newMeasure()
      buildRepeat(new EncodedSymbol('repeatStart'), buildOrGetBarline(currentMeasure, 'left'))
    } else if (rhythm.startsWith('voltaStart')) {
      const voltaNumber = state.startVolta(measureNumber)
      buildBarlineEnding(symbol, buildOrGetBarline(currentMeasure, 'left'), voltaNumber)
    } else if (startsWithAny(rhythm, ['voltaStop', 'voltaDiscontinue'])) {
      // Comes after the barline that ended the volta's last measure
      const stoppedMeasure = hasNotes(currentMeasure) ? currentMeasure : lastMeasure()
      if (stoppedMeasure) {
        const voltaNumber = state.stopVolta(toInt(stoppedMeasure.get('number', '0')))
        buildBarlineEnding(symbol, buildOrGetBarline(stoppedMeasure, 'right'), voltaNumber)
      }
    } else if (startsWithAny(rhythm, ['dynamic', 'octaveShift']) || symbol.articulation.startsWith('dynamic')) {
      for (const marking of group.symbols) {
        if (marking.rhythm.startsWith('octaveShift')) buildOctaveShift(marking, currentMeasure, state)
        else buildDynamic(marking, currentMeasure)
      }
    }
    // homr logs other symbols as not supported yet
  })

  if (hasNotes(currentMeasure) || measures.length === 0) {
    stopOctaveShifts(currentMeasure, state)
    closeCurrentMeasure()
  } else {
    stopOctaveShifts(measures[measures.length - 1]!, state)
  }
  // A clef opens a second attributes element, so look at the whole first measure
  if (!measures[0]!.find('attributes/time')) {
    const time = subElement(firstAttributes, 'time')
    const [beatsText, beatType] = inheritedTime ?? [String(Math.max(int(state.nominator.mul(4)), 1)), '4']
    subElement(time, 'beats', {}, beatsText)
    subElement(time, 'beat-type', {}, beatType)
  }
  return measures
}

function timeSignatureLength(time?: TimeSignature): Fraction | undefined {
  if (!time) return undefined
  const beats = Number(time[0])
  const beatType = Number(time[1])
  if (!Number.isInteger(beats) || !Number.isInteger(beatType) || time[0].trim() === '' || time[1].trim() === '' || beatType === 0) {
    return undefined
  }
  const length = new Fraction(beats, beatType)
  return length.gt(0) ? length : undefined
}

/** Whether a time signature comes before the first note, rest or barline. */
function startsWithTimeSignature(groups: SymbolChord[]): boolean {
  for (const group of groups) {
    const rhythm = group.symbols[0]?.rhythm ?? ''
    if (rhythm.startsWith('timeSignature')) return true
    if (startsWithAny(rhythm, ['note', 'rest', 'measureRest']) || group.isBarline()) return false
  }
  return false
}

/**
 * When the groups of a measure start: a group starts when the earliest still-sounding note
 * ends, but not before the earlier notes of its own positions (voices) have ended.
 */
class GroupClock {
  time = ZERO
  sounding: Fraction[] = []
  voiceFree = new Map<string, Fraction>()

  /** Grace notes have no duration and take no time */
  private static timed(group: SymbolChord): EncodedSymbol[] {
    return group.symbols.filter((s) => isNoteOrRest(s.rhythm) && s.getDuration().fraction.gt(0))
  }

  /** Moves the time to when the positions of the group are free, returns the gap. */
  waitForVoices(group: SymbolChord): Fraction {
    const free = GroupClock.timed(group)
      .map((s) => this.voiceFree.get(s.position) ?? ZERO)
      .reduce((a, b) => (b.gt(a) ? b : a), ZERO)
    const gap = Fraction.max(free.sub(this.time), ZERO)
    this.time = this.time.add(gap)
    this.sounding = this.sounding.filter((end) => end.gt(this.time))
    return gap
  }

  /** Moves the time to the start of the next group and returns how far. */
  advance(group: SymbolChord): Fraction {
    // A position can hold notes of different lengths, the shortest one frees it
    const shortest = new Map<string, Fraction>()
    for (const symbol of GroupClock.timed(group)) {
      const duration = symbol.getDuration().fraction
      shortest.set(symbol.position, Fraction.min(duration, shortest.get(symbol.position) ?? duration))
    }
    for (const [position, duration] of shortest) this.voiceFree.set(position, this.time.add(duration))
    const advance = advanceToNextGroup(group, this.time, this.sounding)
    this.time = this.time.add(advance)
    this.sounding = this.sounding.filter((end) => end.gt(this.time))
    return advance
  }
}

/** How far the next group starts after this one, updating the sounding notes in place. */
function advanceToNextGroup(group: SymbolChord, clock: Fraction, sounding: Fraction[]): Fraction {
  const timed = group.symbols
    .filter((s) => isNoteOrRest(s.rhythm))
    .map((s) => s.getDuration().fraction)
    .filter((d) => d.gt(0))
  if (timed.length === 0) return ZERO
  sounding.push(...timed.map((d) => clock.add(d)))
  return Fraction.min(...sounding.filter((end) => end.gt(clock))).sub(clock)
}

function buildWork(titleText: string): XmlElement {
  const work = new XmlElement('work')
  subElement(work, 'work-title', {}, titleText)
  return work
}

function buildDefaults(args: XmlGeneratorArguments): XmlElement {
  const defaults = new XmlElement('defaults')
  if (args.largePage) {
    const pageLayout = subElement(defaults, 'page-layout')
    subElement(pageLayout, 'page-height', {}, '300')
    subElement(pageLayout, 'page-width', {}, '110')
  }
  return defaults
}

const getPartId = (index: number) => `P${index + 1}`

/** Single-staff parts are a voice, two-staff parts a piano. */
function partMetadata(hasTwoStaves: boolean): [string, string, string, number] {
  return hasTwoStaves ? ['Piano', 'Piano', 'keyboard.piano', 1] : ['Voice', 'Voice', 'voice', 54]
}

function buildPartList(hasTwoStavesByPart: boolean[]): XmlElement {
  const partList = new XmlElement('part-list')
  hasTwoStavesByPart.forEach((hasTwoStaves, part) => {
    const partId = getPartId(part)
    const [partName, instrumentName, instrumentSound, midiProgram] = partMetadata(hasTwoStaves)
    const scorePart = subElement(partList, 'score-part', { id: partId })
    subElement(scorePart, 'part-name', {}, partName)
    const scoreInstrument = subElement(scorePart, 'score-instrument', { id: `${partId}-I1` })
    subElement(scoreInstrument, 'instrument-name', {}, instrumentName)
    subElement(scoreInstrument, 'instrument-sound', {}, instrumentSound)
    const midi = subElement(scorePart, 'midi-instrument', { id: `${partId}-I1` })
    subElement(midi, 'midi-channel', {}, String(part + 1))
    subElement(midi, 'midi-program', {}, String(midiProgram))
    subElement(midi, 'volume', {}, '100')
    subElement(midi, 'pan', {}, '0')
  })
  return partList
}

function buildOrGetAttributes(measure: XmlElement, lastAttributes: XmlElement | undefined, forceNew = false): XmlElement {
  if (lastAttributes && !forceNew) return lastAttributes
  return subElement(measure, 'attributes')
}

/** Whether a measure has notes or rests. */
const hasNotes = (measure: XmlElement) => measure.find('note') !== undefined

function buildOrGetBarline(measure: XmlElement, location: string): XmlElement {
  for (const child of measure.children) if (child.tag === 'barline' && child.get('location') === location) return child
  return subElement(measure, 'barline', { location })
}

function buildDynamic(model: EncodedSymbol, measure: XmlElement): void {
  const marks: XmlElement[] = []
  if (model.rhythm.startsWith('dynamic')) {
    const name = model.rhythm.split('_').slice(1).join('_')
    // dynamic_empty is the placeholder for a modifier-only marking (for example, "più")
    if (name !== 'empty') marks.push(new XmlElement(name))
  }
  if (model.articulation.startsWith('dynamic')) {
    const text = new XmlElement('other-dynamics')
    text.text = model.articulation.split('_').slice(1).join('_').replace(/piu/g, 'più')
    marks.push(text)
  }
  if (marks.length === 0) return
  const direction = subElement(measure, 'direction', { placement: 'below' })
  const directionType = subElement(direction, 'direction-type')
  subElement(directionType, 'dynamics').extend(marks)
  subElement(direction, 'staff', {}, String(getStaff(model)))
}

function buildOctaveShift(model: EncodedSymbol, measure: XmlElement, state: ConversionState): void {
  const staff = getStaff(model)
  if ((state.shiftOctaves.get(staff) ?? 0) !== 0) {
    buildOctaveShiftDirection(measure, staff, 'stop', 'above')
    state.shiftOctaves.set(staff, 0)
  }
  if (model.rhythm === OCTAVE_SHIFT_STOP) return
  const octaves = octavesOfShift(model.rhythm)
  if (octaves === 0) return // homr logs an unknown octave shift
  // MusicXML names the direction in which the notes are printed: 8va is down
  const [shiftType, placement] = octaves > 0 ? ['down', 'above'] : ['up', 'below']
  buildOctaveShiftDirection(measure, staff, shiftType!, placement!)
  state.shiftOctaves.set(staff, octaves)
}

function stopOctaveShifts(measure: XmlElement, state: ConversionState): void {
  for (const [staff, octaves] of state.shiftOctaves) if (octaves !== 0) buildOctaveShiftDirection(measure, staff, 'stop', 'above')
  state.shiftOctaves = new Map()
}

function buildOctaveShiftDirection(measure: XmlElement, staff: number, shiftType: string, placement: string): void {
  const direction = new XmlElement('direction', { placement })
  const directionType = subElement(direction, 'direction-type')
  subElement(directionType, 'octave-shift', { type: shiftType, size: '8', number: String(staff) })
  subElement(direction, 'staff', {}, String(staff))
  const children = measure.children
  // Stop after the last note: a trailing backup would move it before that note
  if (shiftType === 'stop' && children.length > 0 && children[children.length - 1]!.tag === 'backup') {
    measure.insert(children.length - 1, direction)
  } else {
    measure.append(direction)
  }
}

function buildKey(model: EncodedSymbol, attributes: XmlElement): void {
  subElement(subElement(attributes, 'key'), 'fifths', {}, model.rhythm.split('_')[1])
}

const getStaff = (symbol: EncodedSymbol) => (isLowerPosition(symbol.position) ? 2 : 1)

/** Voice numbers are part-global: staff 1 has voices 1-4, staff 2 voices 5-8. */
const getXmlVoice = (staffNum: number, rhythmicLayer: number) => (staffNum - 1) * 4 + rhythmicLayer + 1

interface TimedNoteEvent {
  staffNum: number
  start: number
  end: number
  notes: XmlElement[]
}

/** Assigns stable non-overlapping voices per staff for a whole measure. */
function rebalanceMeasureVoices(measure: XmlElement): void {
  const timedEvents: TimedNoteEvent[] = []
  let currentTime = 0
  let lastNoteStart = 0
  for (const child of measure.children) {
    if (child.tag === 'backup') {
      const dur = child.find('duration')
      if (dur) currentTime -= toInt(dur.text)
      continue
    }
    if (child.tag === 'forward') {
      const dur = child.find('duration')
      if (dur) currentTime += toInt(dur.text)
      continue
    }
    if (child.tag !== 'note') continue
    const durEl = child.find('duration')
    const duration = durEl ? toInt(durEl.text) : 0
    const staffEl = child.find('staff')
    const staffNum = staffEl ? toInt(staffEl.text) : 1
    const isChordTone = child.find('chord') !== undefined
    const start = isChordTone ? lastNoteStart : currentTime
    const end = start + duration
    const last = timedEvents[timedEvents.length - 1]
    if (isChordTone && last && last.staffNum === staffNum && last.start === start && last.end === end) {
      last.notes.push(child)
    } else if (isChordTone) {
      timedEvents.push({ staffNum, start, end, notes: [child] })
    } else {
      lastNoteStart = start
      currentTime += duration
      timedEvents.push({ staffNum, start, end, notes: [child] })
    }
  }
  const byStaff = new Map<number, TimedNoteEvent[]>()
  for (const event of timedEvents) {
    if (!byStaff.has(event.staffNum)) byStaff.set(event.staffNum, [])
    byStaff.get(event.staffNum)!.push(event)
  }
  for (const [staffNum, events] of byStaff) {
    const sorted = [...events].sort((a, b) => a.start - b.start || a.end - b.end)
    let active: Array<[number, number]> = []
    for (const event of sorted) {
      active = active.filter(([activeEnd]) => activeEnd > event.start)
      const used = new Set(active.map(([, v]) => v))
      // The second voice of the model (e.g. upper2) prefers the second voice
      let voiceNo = isSecondVoice(event.notes[0]!) ? 2 : 1
      if (used.has(voiceNo)) {
        voiceNo = 1
        while (used.has(voiceNo)) voiceNo++
      }
      active.push([event.end, voiceNo])
      const xmlVoice = String(getXmlVoice(staffNum, voiceNo - 1))
      for (const note of event.notes) {
        const voiceEl = note.find('voice')
        if (voiceEl) voiceEl.text = xmlVoice
      }
    }
  }
}

// The position of the model (e.g. upper2) of a note while the part is built
const POSITION_ATTRIBUTE = 'homr-position'

const isSecondVoice = (note: XmlElement) => (note.get(POSITION_ATTRIBUTE, '') ?? '').endsWith('2')

function removePositionAttributes(part: XmlElement): void {
  for (const note of part.iter('note')) note.attrib.delete(POSITION_ATTRIBUTE)
}

/** Where a staff has two voices in a measure, the first has its stems up and the second down. */
function addStems(part: XmlElement): void {
  for (const measure of part.findall('measure')) {
    const notes = measure.findall('note').filter((n) => !n.find('rest'))
    for (const staff of new Set(notes.map((n) => n.findtext('staff', '1')))) {
      const onStaff = notes.filter((n) => n.findtext('staff', '1') === staff)
      const voices = new Set(onStaff.filter((n) => n.get(POSITION_ATTRIBUTE)).map(isSecondVoice))
      if (voices.size < 2) continue
      for (const note of onStaff) {
        const stem = new XmlElement('stem')
        stem.text = isSecondVoice(note) ? 'down' : 'up'
        const staffEl = note.find('staff')
        note.insert(staffEl ? note.indexOf(staffEl) : note.length, stem)
      }
    }
  }
}

function getNotePitch(note: XmlElement): string | undefined {
  const pitch = note.find('pitch')
  if (!pitch) return undefined
  return ['step', 'alter', 'octave'].map((p) => pitch.findtext(p, '')).join('|')
}

/** The note's slur of this type with the notations holding it, if any. */
function getSlur(note: XmlElement, slurType: string): [XmlElement, XmlElement] | undefined {
  for (const notation of note.findall('notations')) {
    for (const slur of notation.findall('slur')) if (slur.get('type') === slurType) return [slur, notation]
  }
  return undefined
}

/** A tie needs both elements: <tie> for what sounds, <tied> for what is drawn. */
function addTie(note: XmlElement, tieType: string, notation: XmlElement): void {
  const duration = note.find('duration')
  note.insert(duration ? note.indexOf(duration) + 1 : 0, new XmlElement('tie', { type: tieType }))
  notation.insert(0, new XmlElement('tied', { type: tieType }))
}

/** Rewrites slurs which are really ties: a slur to the next note of its voice with the same pitch. */
function convertTies(part: XmlElement): void {
  const previous = new Map<string, XmlElement[]>()
  for (const measure of part.findall('measure')) {
    for (const event of groupIntoEvents(measure)) {
      const first = event[0]!
      const key = `${first.findtext('staff', '1')}|${first.findtext('voice', '1')}`
      const before = previous.get(key)
      previous.set(key, event)
      if (before) tieEvent(before, event)
    }
  }
}

const BEAM_TYPES: Record<string, string> = { beamStart: 'begin', beamContinue: 'continue', beamStop: 'end' }
const BEAMS_PER_TYPE: Record<string, number> = { eighth: 1, '16th': 2, '32nd': 3, '64th': 4, '128th': 5 }

interface BeamEvent {
  notes: XmlElement[]
  position: string
  isGrace: boolean
  state: string | undefined
  /** measure and time within it */
  start: [number, number]
  end: [number, number]
}

const compareTimes = (a: [number, number], b: [number, number]) => a[0] - b[0] || a[1] - b[1]

/** Turns the primary beam states of the model into complete beams, see homr's convert_beams. */
function convertBeams(part: XmlElement): void {
  const openGroups = new Map<string, BeamEvent[]>()
  const groups: BeamEvent[][] = []
  const close = (key: string) => {
    const group = openGroups.get(key) ?? []
    openGroups.delete(key)
    if (group.length >= 2) groups.push(group)
  }
  for (const event of beamEvents(part)) {
    const key = `${event.position}|${event.isGrace}`
    if (event.state === undefined || beamCount(event.notes[0]!) === 0) {
      close(key)
      continue
    }
    if (event.state === 'begin') {
      close(key)
    } else if (!openGroups.has(key)) {
      const other = crossStaffGroup(openGroups, event)
      if (other !== undefined) {
        joinVoice(openGroups.get(other)!, event)
        openGroups.get(other)!.push(event)
        if (event.state === 'end') close(other)
        continue
      }
    }
    if (!openGroups.has(key)) openGroups.set(key, [])
    openGroups.get(key)!.push(event)
    if (event.state === 'end') close(key)
  }
  for (const key of [...openGroups.keys()]) close(key)
  for (const group of groups) writeBeams(group.map((e) => e.notes))
}

/** The chords with notes of a part in the order of time; their beams are removed. */
function beamEvents(part: XmlElement): BeamEvent[] {
  const events: Array<[number, BeamEvent]> = []
  part.findall('measure').forEach((measure, measureNo) => {
    const times = noteTimes(measure)
    for (const event of groupIntoEvents(measure)) {
      const first = event[0]!
      const position = first.get(POSITION_ATTRIBUTE)
      let state: string | undefined
      for (const note of event) {
        for (const beam of note.findall('beam')) {
          if (beam.get('number') === '1' && state === undefined) state = beam.text ?? undefined
          note.remove(beam)
        }
      }
      if (position === undefined || first.find('rest')) continue
      const [start, end] = times.get(first)!
      events.push([
        events.length,
        { notes: event, position, isGrace: first.find('grace') !== undefined, state, start: [measureNo, start], end: [measureNo, end] },
      ])
    }
  })
  events.sort((a, b) => compareTimes(a[1].start, b[1].start) || a[0] - b[0])
  return events.map(([, e]) => e)
}

/** Start and end of each note in a measure, in divisions. */
function noteTimes(measure: XmlElement): Map<XmlElement, [number, number]> {
  const result = new Map<XmlElement, [number, number]>()
  let time = 0
  let lastStart = 0
  for (const child of measure.children) {
    if (child.tag === 'backup' || child.tag === 'forward') {
      const duration = toInt(child.findtext('duration', '0'))
      time += child.tag === 'backup' ? -duration : duration
    } else if (child.tag === 'note') {
      const duration = toInt(child.findtext('duration', '0'))
      if (child.find('chord')) {
        result.set(child, [lastStart, lastStart + duration])
        continue
      }
      lastStart = time
      result.set(child, [time, time + duration])
      time += duration
    }
  }
  return result
}

/** The open group on the other staff which the event can continue, if there is exactly one. */
function crossStaffGroup(openGroups: Map<string, BeamEvent[]>, event: BeamEvent): string | undefined {
  const staff = event.notes[0]!.findtext('staff', '1')
  const candidates = [...openGroups.entries()]
    .filter(([key, group]) => {
      const last = group[group.length - 1]!
      return key.endsWith(`|${event.isGrace}`) && last.notes[0]!.findtext('staff', '1') !== staff && compareTimes(last.end, event.start) <= 0
    })
    .map(([key]) => key)
  return candidates.length === 1 ? candidates[0] : undefined
}

/** A beam is drawn within a voice, so the notes move into the voice of the group. */
function joinVoice(group: BeamEvent[], event: BeamEvent): void {
  const voice = group[0]!.notes[0]!.findtext('voice', '1')
  for (const note of event.notes) {
    const voiceEl = note.find('voice')
    if (voiceEl) voiceEl.text = voice
  }
}

const beamCount = (note: XmlElement) => BEAMS_PER_TYPE[note.findtext('type', '') ?? ''] ?? 0

function writeBeams(group: XmlElement[][]): void {
  const counts = group.map((event) => beamCount(event[0]!))
  group.forEach((event, index) => {
    const note = event[0]!
    const staff = note.find('staff')
    let position = staff ? note.indexOf(staff) + 1 : note.length
    for (let level = 1; level <= counts[index]!; level++) {
      const hasPrevious = index > 0 && counts[index - 1]! >= level
      const hasNext = index < group.length - 1 && counts[index + 1]! >= level
      const type = hasPrevious && hasNext ? 'continue' : hasPrevious ? 'end' : hasNext ? 'begin' : index === 0 ? 'forward hook' : 'backward hook'
      const beam = new XmlElement('beam', { number: String(level) })
      beam.text = type
      note.insert(position, beam)
      position++
    }
  })
}

/** The measure's notes, with each chord kept together as one event. */
function groupIntoEvents(measure: XmlElement): XmlElement[][] {
  const events: XmlElement[][] = []
  for (const note of measure.findall('note')) {
    if (note.find('chord') && events.length > 0) events[events.length - 1]!.push(note)
    else events.push([note])
  }
  return events
}

/** Converts every slur between two adjacent events which is really a tie. */
function tieEvent(before: XmlElement[], after: XmlElement[]): void {
  let isTied = false
  for (const startNote of before) {
    const begins = getSlur(startNote, 'start')
    if (!begins) continue
    const pitch = getNotePitch(startNote)
    if (pitch === undefined) continue
    for (const stopNote of after) {
      if (getNotePitch(stopNote) !== pitch) continue
      const ends = getSlur(stopNote, 'stop')
      if (!ends) continue
      const [beginSlur, beginNotation] = begins
      const [endSlur, endNotation] = ends
      beginNotation.remove(beginSlur)
      endNotation.remove(endSlur)
      addTie(startNote, 'start', beginNotation)
      addTie(stopNote, 'stop', endNotation)
      isTied = true
      break
    }
  }
  if (isTied) tieRestOfChord(before, after)
}

/** Ties the other notes of a chord which continue into the next chord. */
function tieRestOfChord(before: XmlElement[], after: XmlElement[]): void {
  if (before.length < 2 || after.length < 2) return
  const afterByPitch = new Map<string, XmlElement>()
  for (const n of after) {
    const p = getNotePitch(n)
    if (p !== undefined) afterByPitch.set(p, n)
  }
  for (const startNote of before) {
    const pitch = getNotePitch(startNote)
    const stopNote = pitch === undefined ? undefined : afterByPitch.get(pitch)
    if (pitch === undefined || !stopNote) continue
    if (hasTie(startNote, 'start') || hasTie(stopNote, 'stop')) continue
    addTie(startNote, 'start', notationsOf(startNote))
    addTie(stopNote, 'stop', notationsOf(stopNote))
  }
}

const hasTie = (note: XmlElement, type: string) => note.findall('tie').some((t) => t.get('type') === type)

function notationsOf(note: XmlElement): XmlElement {
  return note.find('notations') ?? subElement(note, 'notations')
}

function buildClef(model: EncodedSymbol, attributes: XmlElement): void {
  const signAndLine = model.rhythm.split('_')[1]!
  const clef = subElement(attributes, 'clef', { number: String(getStaff(model)) })
  subElement(clef, 'sign', {}, signAndLine[0])
  subElement(clef, 'line', {}, signAndLine[1])
  const octaves = octavesOfClef(model.rhythm)
  if (octaves !== 0) subElement(clef, 'clef-octave-change', {}, String(octaves))
}

function buildTimeSignature(model: EncodedSymbol, attributes: XmlElement, state: ConversionState): void {
  const time = subElement(attributes, 'time')
  const denominator = model.rhythm.split('/')[1]!
  const beats = Math.max(int(state.nominator.mul(Number(denominator))), 1)
  subElement(time, 'beats', {}, String(beats))
  subElement(time, 'beat-type', {}, denominator)
  state.beats = beats
}

function buildBarlineStyle(barline: EncodedSymbol, xml: XmlElement): void {
  subElement(xml, 'bar-style', {}, barline.rhythm === 'bolddoublebarline' ? 'heavy-heavy' : 'light-light')
}

function buildBarlineEnding(volta: EncodedSymbol, xml: XmlElement, voltaNumber: number): void {
  let type: string
  if (volta.rhythm.startsWith('voltaStart')) type = 'start'
  else if (volta.rhythm.startsWith('voltaStop')) type = 'stop'
  else if (volta.rhythm.startsWith('voltaDiscontinue')) type = 'discontinue'
  else throw new Error(`Unknown ending ${volta}`)
  subElement(xml, 'ending', { type, number: String(voltaNumber) })
}

function buildRepeat(barline: EncodedSymbol, xml: XmlElement): void {
  if (xml.find('repeat')) return // homr logs that the barline already has a repeat
  subElement(xml, 'repeat', { direction: barline.rhythm === 'repeatStart' ? 'forward' : 'backward' })
}

const LIFT_TO_ALTER: Record<string, number> = { N: 0, '#': 1, '##': 2, b: -1, bb: -2 }

const DURATION_NAMES: Record<number, string> = {
  0: 'breve',
  1: 'whole',
  2: 'half',
  4: 'quarter',
  8: 'eighth',
  16: '16th',
  32: '32nd',
  64: '64th',
  128: '128th',
}

function durationName(kern: number): string {
  const name = DURATION_NAMES[kern]
  if (name === undefined) throw new Error(`KeyError: ${kern}`)
  return name
}

function buildArticulations(note: XmlElement, articulations: string, tupletMark: string, state: ConversionState): void {
  const notation = subElement(note, 'notations')
  const xmlArticulations: XmlElement[] = []
  const xmlOrnaments: XmlElement[] = []
  const simple: Record<string, string> = {
    accent: 'accent',
    accentStrong: 'strong-accent',
    mordent: 'mordent',
    staccato: 'staccato',
    staccatissimo: 'staccatissimo',
    tenuto: 'tenuto',
    breathMark: 'breath-mark',
    caesura: 'caesura',
    doit: 'doit',
  }
  if (!articulations.startsWith('dynamic')) {
    for (const articulation of articulations.split('_')) {
      if (articulation === '' || articulation === nonote) continue // homr warns about nonote
      if (articulation === 'fermata') subElement(notation, 'fermata')
      else if (articulation === 'arpeggiate') subElement(notation, 'arpeggiate')
      else if (articulation in simple) xmlArticulations.push(new XmlElement(simple[articulation]!))
      else if (articulation === 'tremolo') {
        const el = new XmlElement('tremolo', { type: state.toggleTremoloState() })
        el.text = '3'
        xmlOrnaments.push(el)
      } else if (articulation === 'trill') xmlOrnaments.push(new XmlElement('trill-mark'))
      else if (articulation === 'turn') xmlOrnaments.push(new XmlElement('inverted-turn'))
      else if (articulation === 'slurStart') subElement(notation, 'slur', { type: 'start' })
      else if (articulation === 'slurStop') subElement(notation, 'slur', { type: 'stop' })
      else if (articulation === 'tieStart') subElement(notation, 'tied', { type: 'start' })
      else if (articulation === 'tieStop') subElement(notation, 'tied', { type: 'stop' })
      else throw new Error(`Unsupported articulation ${articulation}`)
    }
  }
  for (const mark of tupletMark.split('_')) if (mark) subElement(notation, 'tuplet', { type: mark })
  if (xmlArticulations.length > 0) subElement(notation, 'articulations').extend(xmlArticulations)
  if (xmlOrnaments.length > 0) subElement(notation, 'ornaments').extend(xmlOrnaments)
}

function buildSlurs(note: XmlElement, slurs: string, slurNumber: number): void {
  const notation = note.find('notations') ?? subElement(note, 'notations')
  const number = String(slurNumber)
  if (slurs === '_' || slurs === '' || slurs === nonote) return // homr warns about nonote
  if (slurs === 'slurStart') subElement(notation, 'slur', { type: 'start', number })
  else if (slurs === 'slurStop') subElement(notation, 'slur', { type: 'stop', number })
  else if (slurs === 'slurStart_slurStop') {
    subElement(notation, 'slur', { type: 'stop', number })
    subElement(notation, 'slur', { type: 'start', number })
  } else {
    throw new Error(`Unsupported slur ${slurs}`)
  }
}

function buildNoteOrRest(model: EncodedSymbol, rhythmicLayer: number, isChord: boolean, state: ConversionState, tupletMark: string): XmlElement {
  const note = new XmlElement('note')
  if (isChord) subElement(note, 'chord')
  const modelPitch = model.pitch
  const duration = model.getDuration()
  const isGrace = model.rhythm.includes('G')
  if (isGrace) subElement(note, 'grace')
  if (modelPitch === empty) {
    if (duration.fraction.numerator === 0) subElement(note, 'rest', { measure: 'yes' })
    else subElement(note, 'rest')
  } else if (modelPitch === nonote) {
    subElement(note, 'rest') // homr warns about a note without pitch
  } else {
    const sounding = state.soundingPitch(modelPitch, getStaff(model))
    const pitch = subElement(note, 'pitch')
    subElement(pitch, 'step', {}, sounding[0])
    subElement(pitch, 'octave', {}, sounding.slice(1))
    if (model.lift !== nonote && model.lift !== empty) {
      const alter = LIFT_TO_ALTER[model.lift]
      if (alter === undefined) throw new Error(`KeyError: ${model.lift}`)
      subElement(pitch, 'alter', {}, String(alter))
    }
  }
  if (isGrace) {
    subElement(note, 'type', {}, durationName(duration.kern))
  } else if (duration.fraction.numerator > 0) {
    const base = duration.kern === 0 ? 1 : duration.kern
    subElement(note, 'duration', {}, String(Math.max(1, int(duration.fraction.mul(state.division)))))
    subElement(note, 'type', {}, durationName(base))
  } else {
    subElement(note, 'duration', {}, String(state.beats))
    subElement(note, 'type', {}, durationName(0))
  }
  for (let i = 0; i < duration.dots; i++) subElement(note, 'dot')
  const isTuplet = duration.actualNotes !== duration.normalNotes
  if (isTuplet) {
    const timeMod = subElement(note, 'time-modification')
    subElement(timeMod, 'actual-notes', {}, String(duration.actualNotes))
    subElement(timeMod, 'normal-notes', {}, String(duration.normalNotes))
  }
  const staffNum = getStaff(model)
  subElement(note, 'voice', {}, String(getXmlVoice(staffNum, rhythmicLayer)))
  subElement(note, 'staff', {}, String(staffNum))
  const [slurs, beam] = splitSlurAndBeam(model.slur)
  // Used for voices, stems and beams, removed at the end of buildPart
  note.set(POSITION_ATTRIBUTE, model.position)
  if (beam in BEAM_TYPES && modelPitch !== empty && modelPitch !== nonote) {
    subElement(note, 'beam', { number: '1' }, BEAM_TYPES[beam]) // completed by convertBeams
  }
  // The other notes of a group, e.g. in the other staff, aren't part of the tuplet
  buildArticulations(note, model.articulation, isTuplet ? tupletMark : '', state)
  buildSlurs(note, slurs, staffNum)
  buildImagePosition(note, model)
  return note
}

/** The position of the symbol on the input image as a comment, estimated from attention. */
function buildImagePosition(xml: XmlElement, symbol: EncodedSymbol): void {
  if (!symbol.imageCoordinates) return
  const [x, y] = symbol.imageCoordinates
  xml.append(XmlElement.comment(` imgpos: ${pyRound(x)}, ${pyRound(y)} `))
}

/** The number of measures of the rest, 0 if the measure already has one. */
function buildMultiMeasureRest(symbol: EncodedSymbol, attributes: XmlElement): number {
  if (attributes.find('measure-style')) return 0
  const duration = Number.parseInt(symbol.rhythm.split('_')[1]!.replace(/m/g, ''), 10)
  subElement(subElement(attributes, 'measure-style'), 'multiple-rest', {}, String(duration))
  return duration
}

/** A rest which fills the measure, e.g. in a staff which is hidden in a system. */
function buildMeasureRest(symbol: EncodedSymbol, state: ConversionState): XmlElement {
  const note = new XmlElement('note')
  subElement(note, 'rest', { measure: 'yes' })
  subElement(note, 'duration', {}, String(Math.max(1, int(state.nominator.mul(state.division)))))
  subElement(note, 'voice', {}, '1')
  subElement(note, 'staff', {}, String(getStaff(symbol)))
  return note
}

function buildForward(duration: Fraction, state: ConversionState): XmlElement {
  const forward = new XmlElement('forward')
  subElement(forward, 'duration', {}, String(Math.max(1, int(duration.mul(state.division)))))
  return forward
}

function buildBackup(duration: Fraction, state: ConversionState): XmlElement {
  if (!duration.gt(0)) throw new Error('Backup duration must be positive')
  const backup = new XmlElement('backup')
  subElement(backup, 'duration', {}, String(Math.max(1, int(duration.mul(state.division)))))
  return backup
}

function buildNoteChord(chord: SymbolChord, state: ConversionState, chordDuration: Fraction): XmlElement[] {
  const byDuration = groupNotes(chord.symbols)
  const result: XmlElement[] = []
  byDuration.forEach(([groupDuration, groupNotes], i) => {
    const notes = groupNotes.filter((n) => n.pitch !== empty && n.pitch !== nonote)
    const rests = groupNotes.filter((n) => n.pitch === empty || n.pitch === nonote)
    notes.forEach((note, k) => result.push(buildNoteOrRest(note, i, k > 0, state, chord.markFor(note))))
    // A grace note without pitch would be a rest which takes no time
    if (rests.length > 0 && groupDuration.gt(0)) {
      // A backup keeps the rest from being merged into the chord
      if (notes.length > 0) result.push(buildBackup(groupDuration, state))
      // Only the first of several rests
      result.push(buildNoteOrRest(rests[0]!, i, false, state, chord.markFor(rests[0]!)))
    }
    if (i !== byDuration.length - 1 && groupDuration.gt(0)) result.push(buildBackup(groupDuration, state))
  })
  const longest = byDuration[byDuration.length - 1]![0]
  if (chordDuration.lt(longest)) result.push(buildBackup(longest.sub(chordDuration), state))
  return result
}

/** The notes by duration, sorted by duration. */
function groupNotes(notes: EncodedSymbol[]): Array<[Fraction, EncodedSymbol[]]> {
  const groups = new Map<string, [Fraction, EncodedSymbol[]]>()
  const maxDuration = Fraction.max(...notes.map((n) => n.getDuration().fraction))
  for (const note of notes) {
    const duration = note.getDuration()
    const fraction = note.rhythm.includes('G') ? ZERO : duration.fraction.numerator === 0 ? maxDuration : duration.fraction
    if (!groups.has(fraction.key())) groups.set(fraction.key(), [fraction, []])
    groups.get(fraction.key())![1].push(note)
  }
  return [...groups.values()].sort((a, b) => a[0].compare(b[0]))
}

function buildAddTimeDirection(args: XmlGeneratorArguments): XmlElement | undefined {
  if (!args.metronome) return undefined
  const direction = new XmlElement('direction')
  const metronome = subElement(subElement(direction, 'direction-type'), 'metronome')
  subElement(metronome, 'beat-unit', {}, 'quarter')
  subElement(metronome, 'per-minute', {}, String(args.metronome))
  subElement(direction, 'sound', { tempo: String(args.tempo || args.metronome) })
  return direction
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b]
  return Math.abs(a)
}

/** The smallest division in which all durations are whole numbers. */
function findCommonDivision(durations: Fraction[]): number {
  const denominators = durations.filter((d) => d.gt(0)).map((d) => d.denominator)
  if (denominators.length === 0) return 1
  return denominators.slice(1).reduce((common, d) => Math.abs(common * d) / gcd(common, d), denominators[0]!)
}

/** np.median of Fractions, which numpy computes with the Fractions themselves. */
function medianFraction(values: Fraction[]): Fraction {
  const sorted = [...values].sort((a, b) => a.compare(b))
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid]! : sorted[mid - 1]!.add(sorted[mid]!).div(2)
}

/**
 * The division and one measure length per time signature, estimated from the measures up
 * to the next time signature. Measures before the first one count towards it.
 */
function findDivisionAndTimeSignatureNominators(voice: SymbolChord[]): [number, Fraction[]] {
  const durations = [new Fraction(1, 4)]
  let durationInMeasure = ZERO
  const segments: Fraction[][] = [[]]
  let hasTimeSignature = false
  // Measure lengths are taken the way buildMeasures lays the groups out
  let clock = new GroupClock()
  for (const chord of voice) {
    if (chord.symbols.length > 0 && chord.symbols[0]!.rhythm.startsWith('timeSignature')) {
      if (durationInMeasure.gt(0)) {
        segments[segments.length - 1]!.push(durationInMeasure)
        durationInMeasure = ZERO
        clock = new GroupClock()
      }
      if (hasTimeSignature) segments.push([])
      hasTimeSignature = true
    } else if (chord.isBarline() && durationInMeasure.gt(0)) {
      segments[segments.length - 1]!.push(durationInMeasure)
      durationInMeasure = ZERO
      clock = new GroupClock()
    } else {
      const timed: Fraction[] = []
      for (const symbol of chord.symbols) {
        if (isNoteOrRest(symbol.rhythm)) {
          const frac = symbol.getDuration().fraction
          if (frac.gt(0)) {
            durations.push(frac)
            timed.push(frac)
          }
        }
      }
      if (timed.length > 0 && !(chord.symbols.length === 1 && chord.symbols[0]!.rhythm.endsWith('m'))) {
        clock.waitForVoices(chord)
        const end = clock.time.add(Fraction.max(...timed))
        clock.advance(chord)
        durationInMeasure = Fraction.max(durationInMeasure, end)
      }
    }
  }
  if (durationInMeasure.gt(0)) segments[segments.length - 1]!.push(durationInMeasure)
  const allMeasures = segments.flat()
  if (allMeasures.length === 0) return [findCommonDivision(durations), segments.map(() => new Fraction(1))]
  // A time signature without measures after it belongs to the measures of the next one
  const nominators: Fraction[] = []
  let following = medianFraction(allMeasures)
  for (const segment of [...segments].reverse()) {
    if (segment.length > 0) following = medianFraction(segment)
    nominators.push(following)
  }
  nominators.reverse()
  return [findCommonDivision(durations), nominators]
}

const BEFORE_NOTES_ORDER = ['clef', 'keySignature', 'timeSignature']

/**
 * Splits a chord which joins clefs, keys, time signatures or barlines to notes: the signs go
 * before the notes, barlines and repeats after them.
 */
function splitMixedChord(symbols: EncodedSymbol[]): EncodedSymbol[][] {
  const notes = symbols.filter((s) => isNoteOrRest(s.rhythm))
  if (notes.length === 0 || notes.length === symbols.length) return [symbols]
  const others = symbols.filter((s) => !isNoteOrRest(s.rhythm))
  const after = others.filter((s) => s.rhythm.includes('barline') || s.rhythm.includes('repeat'))
  const before = new Map<string, EncodedSymbol[]>()
  for (const s of others) {
    // `s not in after` compares by value
    if (after.some((a) => a.equals(s))) continue
    const kind = s.rhythm.split('_')[0]!.split('/')[0]!
    if (!before.has(kind)) before.set(kind, [])
    before.get(kind)!.push(s)
  }
  const rank = (kind: string) => {
    const i = BEFORE_NOTES_ORDER.indexOf(kind)
    return i < 0 ? BEFORE_NOTES_ORDER.length : i
  }
  const ordered = [...before.keys()].sort((a, b) => rank(a) - rank(b))
  return [...ordered.map((kind) => before.get(kind)!), notes, ...after.map((s) => [s])]
}

/** splitMixedChord on every group, after the tuplet marks are set. */
function splitMixedChords(groups: SymbolChord[]): SymbolChord[] {
  const result: SymbolChord[] = []
  let splitBarline = false
  for (const group of groups) {
    const parts = splitMixedChord(group.symbols)
    if (splitBarline && group.isBarline() && parts.length === 1) {
      // The barline split off the previous chord and this one are the same barline: keep
      // one, preferring a repeat or double barline over a plain barline
      if (group.symbols[0]!.rhythm === 'barline' && result[result.length - 1]!.symbols[0]!.rhythm !== 'barline') {
        splitBarline = false
        continue
      }
      result.pop()
    }
    for (const part of parts) {
      const isNotes = isNoteOrRest(part[0]!.rhythm)
      result.push(new SymbolChord(part, isNotes ? group.tupletMarks : new Map()))
    }
    splitBarline = parts.length > 1 && result[result.length - 1]!.isBarline()
  }
  return result
}

function groupIntoChords(voice: EncodedSymbol[]): SymbolChord[] {
  return sortTokenChords(voice).map((s) => new SymbolChord(s))
}

const isPowerOfTwo = (value: number) => value > 0 && (value & (value - 1)) === 0

function isTupletSymbol(symbol: EncodedSymbol): boolean {
  if (!isNoteOrRest(symbol.rhythm) || symbol.rhythm.includes('G')) return false
  const d = symbol.getDuration()
  return d.normalNotes !== d.actualNotes
}

/** The duration of the first tuplet note or rest at the position, else of the first timed one. */
function durationAt(group: SymbolChord, position: string): SymbolDuration | undefined {
  const timed = group.symbols.filter((s) => s.position === position && isNoteOrRest(s.rhythm) && !s.rhythm.includes('G'))
  const tuplets = timed.filter(isTupletSymbol)
  if (tuplets.length > 0) return tuplets[0]!.getDuration()
  if (timed.length > 0) return timed[0]!.getDuration()
  return undefined
}

function splitIntoMeasures(groups: SymbolChord[]): SymbolChord[][] {
  const measures: SymbolChord[][] = []
  let current: SymbolChord[] = []
  for (const group of groups) {
    current.push(group)
    if (group.isBarline()) {
      measures.push(current)
      current = []
    }
  }
  if (current.length > 0) measures.push(current)
  return measures
}

/** When each group of a measure starts, counted like buildMeasures. */
function startTimes(groups: SymbolChord[]): Fraction[] {
  const clock = new GroupClock()
  return groups.map((group) => {
    if (group.symbols.some((s) => isNoteOrRest(s.rhythm))) {
      clock.waitForVoices(group)
      const start = clock.time
      clock.advance(group)
      return start
    }
    return clock.time
  })
}

type Run = Array<[number, Fraction, Fraction]> // group, start time and duration

/** The complete tuplets as [first, last] group, and the groups left over. */
function splitRun(run: Run, measure: (start: Fraction, total: Fraction, end: Fraction) => Fraction): [Array<[number, number]>, number[]] {
  const tuplets: Array<[number, number]> = []
  let pending: number[] = []
  let total = ZERO
  for (const [index, start, duration] of run) {
    pending.push(index)
    total = total.add(duration)
    if (isPowerOfTwo(measure(start, total, start.add(duration)).denominator)) {
      tuplets.push([pending[0]!, index])
      pending = []
      total = ZERO
    }
  }
  return [tuplets, pending]
}

/** Splits consecutive tuplet notes of one position into tuplets, see homr's _mark_run. */
function markRun(groups: SymbolChord[], position: string, run: Run): void {
  const byLength = splitRun(run, (_start, total) => total)
  const byGrid = splitRun(run, (_start, _total, end) => end)
  const [tuplets, leftOver] = byLength[1].length <= byGrid[1].length ? byLength : byGrid
  // An incomplete tuplet, e.g. one note too many, still has tuplet durations
  if (leftOver.length > 0) tuplets.push([leftOver[0]!, leftOver[leftOver.length - 1]!])
  for (const [first, last] of tuplets) {
    if (first === last) {
      groups[first]!.tupletMarks.set(position, 'start_stop')
    } else {
      groups[first]!.tupletMarks.set(position, 'start')
      groups[last]!.tupletMarks.set(position, 'stop')
    }
  }
}

function addTuplets(groups: SymbolChord[], position: string): void {
  const times = startTimes(groups)
  let run: Run = []
  let format: [number, number] = [1, 1]
  groups.forEach((group, index) => {
    const duration = durationAt(group, position)
    if (!duration) return
    const current: [number, number] = [duration.actualNotes, duration.normalNotes]
    if ((current[0] !== format[0] || current[1] !== format[1]) && run.length > 0) {
      markRun(groups, position, run)
      run = []
    }
    format = current
    if (current[0] !== current[1]) run.push([index, times[index]!, duration.fraction])
  })
  if (run.length > 0) markRun(groups, position, run)
}

/** Marks the start and stop of tuplets, per measure and position. */
function addTupletStartStop(groups: SymbolChord[]): SymbolChord[] {
  for (const measureGroups of splitIntoMeasures(groups)) {
    const positions = new Set(measureGroups.flatMap((g) => g.symbols.filter(isTupletSymbol).map((s) => s.position)))
    for (const position of [...positions].sort()) addTuplets(measureGroups, position)
  }
  return groups
}
