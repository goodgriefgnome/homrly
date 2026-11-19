// Writes LilyPond from the MusicXML that music-xml.ts generates. This is not part of homr:
// it reads the generated document, so the timing, voices, ties, beams and tuplets which the
// MusicXML generator works out carry over.
import { Fraction } from './fraction.js'
import type { XmlElement } from './xml.js'

export interface LilyPondOptions {
  /** The \version statement. */
  version?: string
  /** Keep the line breaks of the image (homr's new-system marks). Default true. */
  lineBreaks?: boolean
}

const ZERO = new Fraction(0)

/** A note value LilyPond can write without scaling: 1, 2., 8.. and so on. */
function plainDuration(length: Fraction): string | undefined {
  for (let base = 0; base <= 7; base++) {
    const value = new Fraction(1, 2 ** base)
    let total = value
    let add = value
    for (let dots = 0; dots <= 3; dots++) {
      if (total.eq(length)) return `${2 ** base}${'.'.repeat(dots)}`
      add = add.div(2)
      total = total.add(add)
    }
  }
  if (length.eq(2)) return '\\breve'
  if (length.eq(3)) return '\\breve.'
  return undefined
}

/** Any length, scaled if needed, e.g. 1*5/8. */
function scaledDuration(length: Fraction): string {
  return plainDuration(length) ?? `1*${length.numerator}/${length.denominator}`
}

/**
 * A length as plain durations for spacers, longest first, e.g. 5/8 as 2 and 8. A length
 * which isn't a sum of powers of two (e.g. in triplets) is one scaled duration.
 */
function splitIntoPlainDurations(length: Fraction): Array<[string, Fraction]> {
  if (!isPowerOfTwo(length.denominator)) return [[scaledDuration(length), length]]
  const result: Array<[string, Fraction]> = []
  let rest = length
  for (let base = -1; rest.gt(0); base++) {
    const value = base < 0 ? new Fraction(2) : new Fraction(1, 2 ** base)
    while (rest.ge(value)) {
      result.push([base < 0 ? '\\breve' : String(2 ** base), value])
      rest = rest.sub(value)
    }
  }
  return result
}

const isPowerOfTwo = (n: number) => n > 0 && (n & (n - 1)) === 0

const TYPE_LENGTHS: Record<string, Fraction> = {
  breve: new Fraction(2),
  whole: new Fraction(1),
  half: new Fraction(1, 2),
  quarter: new Fraction(1, 4),
  eighth: new Fraction(1, 8),
  '16th': new Fraction(1, 16),
  '32nd': new Fraction(1, 32),
  '64th': new Fraction(1, 64),
  '128th': new Fraction(1, 128),
}

const TYPE_NAMES: Record<string, string> = {
  breve: '\\breve',
  whole: '1',
  half: '2',
  quarter: '4',
  eighth: '8',
  '16th': '16',
  '32nd': '32',
  '64th': '64',
  '128th': '128',
}

const KEYS: Record<number, string> = {
  [-7]: 'ces',
  [-6]: 'ges',
  [-5]: 'des',
  [-4]: 'aes',
  [-3]: 'ees',
  [-2]: 'bes',
  [-1]: 'f',
  0: 'c',
  1: 'g',
  2: 'd',
  3: 'a',
  4: 'e',
  5: 'b',
  6: 'fis',
  7: 'cis',
}

function clefName(clef: XmlElement): string {
  const sign = clef.findtext('sign', 'G')
  const line = clef.findtext('line', '')
  const octave = Number(clef.findtext('clef-octave-change', '0'))
  const names: Record<string, string> = {
    G2: 'treble',
    G1: 'french',
    F4: 'bass',
    F3: 'varbaritone',
    F5: 'subbass',
    C1: 'soprano',
    C2: 'mezzosoprano',
    C3: 'alto',
    C4: 'tenor',
    C5: 'baritone',
  }
  const name = sign === 'T' ? 'tab' : (names[`${sign}${line}`] ?? 'treble')
  if (octave === 0) return name
  return `"${name}${octave < 0 ? '_' : '^'}${8 * Math.abs(octave) - (Math.abs(octave) - 1)}"`
}

function pitchName(pitch: XmlElement): string {
  const step = (pitch.findtext('step', 'C') ?? 'C').toLowerCase()
  const alter = Number(pitch.findtext('alter', '0') || '0')
  const octave = Number(pitch.findtext('octave', '4'))
  const accidental = alter > 0 ? 'is'.repeat(alter) : 'es'.repeat(-alter)
  const marks = octave - 3
  return step + accidental + (marks > 0 ? "'".repeat(marks) : ','.repeat(-marks))
}

const ARTICULATIONS: Record<string, string> = {
  accent: '->',
  'strong-accent': '-^',
  staccato: '-.',
  staccatissimo: '-!',
  tenuto: '--',
  doit: '\\bendAfter #4',
}
/** Marks which LilyPond writes as music after the note rather than attached to it. */
const AFTER_NOTE: Record<string, string> = {
  'breath-mark': '\\breathe',
  caesura: '\\caesura',
}
const ORNAMENTS: Record<string, string> = {
  'trill-mark': '\\trill',
  mordent: '\\mordent',
  'inverted-turn': '\\reverseturn',
}

/** A chord (or single note or rest) of one voice, as MusicXML has it. */
interface NoteEvent {
  start: Fraction
  length: Fraction
  notes: XmlElement[]
  staff: number
  grace: boolean
}

/** Something which happens at a time on a staff: clefs, keys, times, dynamics, ... */
interface StaffMark {
  time: Fraction
  /** Written before the event, e.g. \clef bass */
  prefix?: string
  /** Attached to the event, e.g. \p */
  post?: string
}

interface MeasureInfo {
  /** The length of the measure as its notes take it. */
  length: Fraction
  /** The length the time signature gives. */
  nominal: Fraction
  /** Barline before and after, and whether a new system starts here. */
  leftBar?: string
  rightBar?: string
  newSystem: boolean
  /** Volta commands at the start and end of the measure. */
  voltaStart?: string
  voltaEnd?: boolean
}

interface PartModel {
  staves: number
  /** Events by voice number, per measure. */
  voices: Map<number, NoteEvent[][]>
  /** Marks by staff, per measure. */
  marks: Map<number, StaffMark[][]>
  /** Key and time marks, which go to every staff. */
  partMarks: StaffMark[][]
  measureLengths: Fraction[]
  nominalLengths: Fraction[]
  bars: Array<Pick<MeasureInfo, 'leftBar' | 'rightBar' | 'newSystem' | 'voltaStart' | 'voltaEnd'>>
  tempo?: string
}

function readPart(part: XmlElement): PartModel {
  const measures = part.findall('measure')
  const divisions = Number(part.findtext('measure/attributes/divisions', '1')) || 1
  const toLength = (d: number) => new Fraction(d, divisions * 4)
  let staves = 1
  let nominal = new Fraction(1)
  const voices = new Map<number, NoteEvent[][]>()
  const marks = new Map<number, StaffMark[][]>()
  const partMarks: StaffMark[][] = []
  const measureLengths: Fraction[] = []
  const nominalLengths: Fraction[] = []
  const bars: PartModel['bars'] = []
  let tempo: string | undefined

  const marksOf = (staff: number, m: number) => {
    if (!marks.has(staff)) marks.set(staff, [])
    const list = marks.get(staff)!
    while (list.length <= m) list.push([])
    return list[m]!
  }

  measures.forEach((measure, m) => {
    partMarks.push([])
    let time = ZERO
    let end = ZERO
    let lastEvent: NoteEvent | undefined
    const bar: PartModel['bars'][number] = { newSystem: false }
    for (const child of measure.children) {
      const tag = child.tag
      if (tag === 'attributes') {
        const st = child.findtext('staves')
        if (st) staves = Number(st)
        for (const clef of child.findall('clef')) {
          marksOf(Number(clef.get('number', '1')), m).push({ time, prefix: `\\clef ${clefName(clef)}` })
        }
        const fifths = child.findtext('key/fifths')
        if (fifths !== undefined) partMarks[m]!.push({ time, prefix: `\\key ${KEYS[Number(fifths)] ?? 'c'} \\major` })
        const beats = child.findtext('time/beats')
        const beatType = child.findtext('time/beat-type')
        if (beats && beatType) {
          nominal = new Fraction(Number(beats), Number(beatType))
          partMarks[m]!.push({ time, prefix: `\\time ${beats}/${beatType}` })
        }
      } else if (tag === 'backup') {
        time = time.sub(toLength(Number(child.findtext('duration', '0'))))
        if (time.lt(0)) time = ZERO
      } else if (tag === 'forward') {
        time = time.add(toLength(Number(child.findtext('duration', '0'))))
        end = Fraction.max(end, time)
      } else if (tag === 'print') {
        if (child.get('new-system') === 'yes') bar.newSystem = true
      } else if (tag === 'barline') {
        const location = child.get('location', 'right')
        const repeat = child.find('repeat')?.get('direction')
        const style = child.findtext('bar-style')
        const ending = child.find('ending')
        if (location === 'left') {
          if (repeat === 'forward') bar.leftBar = '.|:'
          if (ending?.get('type') === 'start') bar.voltaStart = `${ending.get('number', '1')}.`
        } else {
          if (repeat === 'backward') bar.rightBar = ':|.'
          else if (style === 'heavy-heavy') bar.rightBar = '|.'
          else if (style === 'light-light') bar.rightBar = '||'
          if (ending && (ending.get('type') === 'stop' || ending.get('type') === 'discontinue')) bar.voltaEnd = true
        }
      } else if (tag === 'direction') {
        const staff = Number(child.findtext('staff', '1'))
        const dynamics = child.find('direction-type/dynamics')
        if (dynamics) {
          for (const d of dynamics.children) {
            if (d.tag === 'other-dynamics') marksOf(staff, m).push({ time, post: `_\\markup { \\dynamic "${(d.text ?? '').replace(/"/g, '')}" }` })
            else if (d.tag) marksOf(staff, m).push({ time, post: `\\${d.tag}` })
          }
        }
        const shift = child.find('direction-type/octave-shift')
        if (shift) {
          const type = shift.get('type')
          const value = type === 'down' ? 1 : type === 'up' ? -1 : 0
          marksOf(Number(shift.get('number', String(staff))), m).push({ time, prefix: `\\ottava #${value}` })
        }
        const perMinute = child.findtext('direction-type/metronome/per-minute')
        if (perMinute && m === 0) tempo = `\\tempo 4 = ${perMinute}`
      } else if (tag === 'note') {
        const isChord = child.find('chord') !== undefined
        const grace = child.find('grace') !== undefined
        const length = grace ? ZERO : toLength(Number(child.findtext('duration', '0')))
        const voice = Number(child.findtext('voice', '1'))
        const staff = Number(child.findtext('staff', '1'))
        if (isChord && lastEvent && lastEvent.grace === grace) {
          lastEvent.notes.push(child)
          continue
        }
        const event: NoteEvent = { start: time, length, notes: [child], staff, grace }
        if (!voices.has(voice)) voices.set(voice, [])
        const list = voices.get(voice)!
        while (list.length <= m) list.push([])
        list[m]!.push(event)
        lastEvent = event
        time = time.add(length)
        end = Fraction.max(end, time)
      }
    }
    measureLengths.push(end)
    nominalLengths.push(nominal)
    bars.push(bar)
  })
  for (const list of voices.values()) while (list.length < measures.length) list.push([])
  return { staves, voices, marks, partMarks, measureLengths, nominalLengths, bars, tempo }
}

/** Keeps the starts and stops of slurs, beams or tuplets that match, per voice. */
class Balancer {
  private open = false

  /** Returns whether the start is written. */
  start(): boolean {
    if (this.open) return false
    this.open = true
    return true
  }

  stop(): boolean {
    if (!this.open) return false
    this.open = false
    return true
  }

  get isOpen(): boolean {
    return this.open
  }
}

/** The text of a chord, single note or rest, without its duration. */
function eventBody(event: NoteEvent): { body: string; measureRest: boolean } {
  const first = event.notes[0]!
  const rest = first.find('rest')
  if (rest) {
    if (rest.get('measure') === 'yes') return { body: 'R', measureRest: true }
    return { body: 'r', measureRest: false }
  }
  const pitches = event.notes
    .filter((n) => n.find('pitch'))
    .map((n) => pitchName(n.find('pitch')!) + (n.findall('tie').some((t) => t.get('type') === 'start') && event.notes.length > 1 ? '~' : ''))
  if (pitches.length === 0) return { body: 'r', measureRest: false }
  return { body: pitches.length === 1 ? pitches[0]! : `<${pitches.join(' ')}>`, measureRest: false }
}

/** The note value of an event as MusicXML gives it (type and dots), unscaled. */
function noteValue(note: XmlElement): Fraction | undefined {
  const base = TYPE_LENGTHS[note.findtext('type', '') ?? '']
  if (!base) return undefined
  let total = base
  let add = base
  for (let i = 0; i < note.findall('dot').length; i++) {
    add = add.div(2)
    total = total.add(add)
  }
  return total
}

function writtenDuration(note: XmlElement): string | undefined {
  const name = TYPE_NAMES[note.findtext('type', '') ?? '']
  if (!name) return undefined
  return name + '.'.repeat(note.findall('dot').length)
}

interface VoiceState {
  slurs: Balancer
  beams: Balancer
  tuplet: { actual: number; normal: number } | undefined
}

/** What follows a chord as music of its own, e.g. a breath mark. */
function afterEvent(event: NoteEvent): string[] {
  const tags = new Set(
    event.notes.flatMap((n) => n.findall('notations/articulations').flatMap((a) => a.children.map((c) => c.tag ?? ''))),
  )
  return Object.entries(AFTER_NOTE).flatMap(([tag, text]) => (tags.has(tag) ? [text] : []))
}

/** The post-events of a chord: ties, articulations, slurs, beams. */
function postEvents(event: NoteEvent, state: VoiceState): string {
  const out: string[] = []
  const notes = event.notes
  const single = notes.length === 1
  if (single && notes[0]!.findall('tie').some((t) => t.get('type') === 'start')) out.push('~')
  const notations = notes.flatMap((n) => n.findall('notations'))
  const has = (path: string) => notations.some((n) => n.find(path) !== undefined)
  if (has('fermata')) out.push('\\fermata')
  if (has('arpeggiate')) out.push('\\arpeggio')
  const seen = new Set<string>()
  for (const n of notations) {
    for (const a of [...n.findall('articulations'), ...n.findall('ornaments')].flatMap((x) => x.children)) {
      const text = (a.tag && (ARTICULATIONS[a.tag] ?? ORNAMENTS[a.tag])) || undefined
      if (text && !seen.has(text)) {
        seen.add(text)
        out.push(text)
      }
    }
  }
  const slurStops = notations.some((n) => n.findall('slur').some((s) => s.get('type') === 'stop'))
  const slurStarts = notations.some((n) => n.findall('slur').some((s) => s.get('type') === 'start'))
  if (slurStops && state.slurs.stop()) out.push(')')
  if (slurStarts && state.slurs.start()) out.push('(')
  const beam = notes[0]!.findall('beam').find((b) => b.get('number') === '1')?.text
  if (!event.grace) {
    if (beam === 'begin' && state.beams.start()) out.push('[')
    else if (beam === 'end' && state.beams.stop()) out.push(']')
  }
  return out.join('')
}

/** Splits a measure rest's length into a LilyPond duration. */
function measureRestDuration(length: Fraction): string {
  return plainDuration(length) ?? `1*${length.numerator}/${length.denominator}`
}

/** The music of one voice, measure by measure, with spacers in its gaps. */
function voiceMusic(
  model: PartModel,
  voice: number,
  homeStaff: number,
  isFirstOfStaff: boolean,
  isFirstVoiceOfPart: boolean,
  options: Required<LilyPondOptions>,
  layout: MeasureInfo[],
): string {
  const events = model.voices.get(voice)!
  const state: VoiceState = { slurs: new Balancer(), beams: new Balancer(), tuplet: undefined }
  const out: string[] = []
  let currentStaff = homeStaff
  let items: string[] = []
  const closeTuplet = () => {
    if (state.tuplet) {
      items.push('}')
      state.tuplet = undefined
    }
  }
  // The measure length LilyPond counts with, which \time resets
  let timingLength = layout[0]?.nominal ?? new Fraction(1)
  layout.forEach((info, m) => {
    items = []
    if (m === 0 && isFirstVoiceOfPart && model.tempo) items.push(model.tempo)
    // Marks of this voice's staff (clefs, dynamics, ...) and of the part (key, time); the
    // sort below is stable, so commands added later at the same time come after them
    const marks: StaffMark[] = []
    if (isFirstOfStaff) {
      marks.push(...(model.partMarks[m] ?? []))
      marks.push(...(model.marks.get(homeStaff)?.[m] ?? []))
    }
    if (isFirstVoiceOfPart) {
      const timeChange = (model.partMarks[m] ?? []).some((mark) => mark.prefix?.startsWith('\\time'))
      if (timeChange) timingLength = info.nominal
      const commands: string[] = []
      if (info.newSystem && options.lineBreaks && m > 0) commands.push('\\break')
      if (m === 0 && !info.length.eq(info.nominal)) {
        // A pickup, or a first measure longer than the time signature: \\partial takes both
        commands.push(`\\partial ${scaledDuration(info.length)}`)
      } else if (!info.length.eq(timingLength)) {
        // A measure which is longer or shorter than the time signature says
        // The skip keeps a \\time at the same moment from resetting the length again
        commands.push(`s1*0 \\set Timing.measureLength = #${info.length.numerator}/${info.length.denominator}`)
        timingLength = info.length
      }
      if (info.leftBar) commands.push(`\\bar "${info.leftBar}"`)
      if (info.voltaStart) commands.push(`\\set Score.repeatCommands = #'((volta "${info.voltaStart}"))`)
      for (const prefix of commands) marks.push({ time: ZERO, prefix })
    }
    marks.sort((a, b) => a.time.compare(b.time))
    let markIndex = 0
    const takeMarks = (until: Fraction, inclusive: boolean) => {
      const prefix: string[] = []
      const post: string[] = []
      while (markIndex < marks.length && (inclusive ? marks[markIndex]!.time.le(until) : marks[markIndex]!.time.lt(until))) {
        const mark = marks[markIndex]!
        if (mark.prefix) prefix.push(mark.prefix)
        if (mark.post) post.push(mark.post)
        markIndex++
      }
      return { prefix, post }
    }
    let cursor = ZERO
    const spacer = (until: Fraction) => {
      if (!until.gt(cursor)) return
      closeTuplet()
      for (const [d, length] of splitIntoPlainDurations(until.sub(cursor))) {
        const { prefix, post } = takeMarks(cursor, true)
        items.push(...prefix, `s${d}${post.join('')}`)
        cursor = cursor.add(length)
      }
    }
    for (const event of events[m] ?? []) {
      if (event.start.gt(cursor)) spacer(event.start)
      const { prefix, post } = takeMarks(event.start, true)
      const first = event.notes[0]!
      const { body, measureRest } = eventBody(event)
      // Tuplets
      const actual = Number(first.findtext('time-modification/actual-notes', '0'))
      const normal = Number(first.findtext('time-modification/normal-notes', '0'))
      const tupletMarks = first.findall('notations/tuplet').map((t) => t.get('type'))
      if (state.tuplet && (actual !== state.tuplet.actual || normal !== state.tuplet.normal)) closeTuplet()
      // Clefs, keys, time signatures and measure commands come before a tuplet starts
      items.push(...prefix)
      if (!state.tuplet && actual > 0 && normal > 0 && actual !== normal && tupletMarks.includes('start') && !event.grace) {
        items.push(`\\tuplet ${actual}/${normal} {`)
        state.tuplet = { actual, normal }
      }
      let duration: string
      if (event.grace) {
        duration = writtenDuration(first) ?? '8'
      } else if (measureRest) {
        duration = measureRestDuration(event.length)
      } else if (state.tuplet || !(actual > 0 && normal > 0 && actual !== normal)) {
        const value = noteValue(first)
        const expected = state.tuplet ? event.length.mul(new Fraction(state.tuplet.actual, state.tuplet.normal)) : event.length
        duration = value && value.eq(expected) ? writtenDuration(first)! : scaledDuration(expected)
      } else {
        // A tuplet note outside of a tuplet bracket
        const value = noteValue(first)
        duration = value ? `${writtenDuration(first)}*${normal}/${actual}` : scaledDuration(event.length)
      }
      // Cross-staff notes
      if (event.staff !== currentStaff && !measureRest) {
        items.push(`\\change Staff = "${event.staff}"`)
        currentStaff = event.staff
      } else if (event.staff === homeStaff && currentStaff !== homeStaff) {
        items.push(`\\change Staff = "${homeStaff}"`)
        currentStaff = homeStaff
      }
      const text = `${body}${duration}${measureRest ? '' : postEvents(event, state)}${post.join('')}`
      items.push(event.grace ? `\\grace ${text}` : text)
      if (!measureRest && !event.grace) items.push(...afterEvent(event))
      if (state.tuplet && tupletMarks.some((t) => t === 'stop')) closeTuplet()
      cursor = Fraction.max(cursor, event.start.add(event.length))
    }
    spacer(info.length)
    closeTuplet()
    // Marks at the very end of the measure
    const rest = takeMarks(info.length, true)
    items.push(...rest.prefix)
    if (rest.post.length > 0) items.push(`<>${rest.post.join('')}`)
    if (isFirstVoiceOfPart) {
      if (info.voltaEnd) items.push(`\\set Score.repeatCommands = #'((volta #f))`)
      if (info.rightBar) items.push(`\\bar "${info.rightBar}"`)
    }
    if (currentStaff !== homeStaff) {
      items.push(`\\change Staff = "${homeStaff}"`)
      currentStaff = homeStaff
    }
    out.push(`${items.join(' ')} |`)
  })
  return out.join('\n')
}

const VOICE_COMMANDS = ['\\voiceOne', '\\voiceTwo', '\\voiceThree', '\\voiceFour']

/** The dynamics LilyPond predefines; others are defined with make-dynamic-script. */
const BUILTIN_DYNAMICS = new Set(['ppppp', 'pppp', 'ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'ffff', 'fffff', 'fp', 'sf', 'sff', 'sp', 'spp', 'sfz', 'rfz', 'n'])

/** The MusicXML document as a LilyPond score. */
export function musicXmlToLilyPond(root: XmlElement, options: LilyPondOptions = {}): string {
  const opts: Required<LilyPondOptions> = { version: '2.24.0', lineBreaks: true, ...options }
  const parts = root.findall('part').map(readPart)
  const measureCount = Math.max(0, ...parts.map((p) => p.measureLengths.length))
  // One measure layout for all parts: the longest content of each measure
  const layout: MeasureInfo[] = []
  for (let m = 0; m < measureCount; m++) {
    const lengths = parts.map((p) => p.measureLengths[m] ?? ZERO)
    const nominal = parts.find((p) => p.nominalLengths[m])?.nominalLengths[m] ?? new Fraction(1)
    const bar = parts.find((p) => p.bars[m])?.bars[m] ?? { newSystem: false }
    const length = Fraction.max(...lengths)
    layout.push({ ...bar, length: length.gt(0) ? length : nominal, nominal })
  }
  const title = root.findtext('work/work-title', '')
  const lines = [`\\version "${opts.version}"`, '']
  const customDynamics = new Set<string>()
  for (const dynamics of root.iter('dynamics')) {
    for (const d of dynamics.children) if (d.tag && d.tag !== 'other-dynamics' && !BUILTIN_DYNAMICS.has(d.tag)) customDynamics.add(d.tag)
  }
  for (const name of [...customDynamics].sort()) lines.push(`${name} = #(make-dynamic-script "${name}")`)
  if (customDynamics.size > 0) lines.push('')
  lines.push('\\header {')
  if (title) lines.push(`  title = "${title.replace(/"/g, '\\"')}"`)
  lines.push('  tagline = ##f', '}', '')
  const indent = (text: string, n: number) => text.replace(/^(?=.)/gm, ' '.repeat(n))
  const blocks: string[] = []
  parts.forEach((part, p) => {
    const staffBlocks: string[] = []
    let firstVoiceOfPart = true
    for (let staff = 1; staff <= part.staves; staff++) {
      const voices = [...part.voices.keys()].filter((v) => Math.floor((v - 1) / 4) + 1 === staff).sort((a, b) => a - b)
      const staffName = part.staves > 1 ? `${staff}` : `${p + 1}`
      if (voices.length === 0) {
        // A staff without notes still shows its clef and the measures
        part.voices.set(1000 + staff, layout.map(() => []))
        voices.push(1000 + staff)
      }
      const voiceBlocks = voices.map((voice, i) => {
        const music = voiceMusic(part, voice, staff, i === 0, firstVoiceOfPart && p === 0, opts, layout)
        firstVoiceOfPart = false
        const command = voices.length > 1 ? `${VOICE_COMMANDS[i] ?? ''}\n` : ''
        return `\\new Voice = "${staffName}-${i + 1}" {\n${indent(command + music, 2)}\n}`
      })
      staffBlocks.push(`\\new Staff = "${staffName}" <<\n${indent(voiceBlocks.join('\n'), 2)}\n>>`)
    }
    blocks.push(part.staves > 1 ? `\\new PianoStaff <<\n${indent(staffBlocks.join('\n'), 2)}\n>>` : staffBlocks.join('\n'))
  })
  lines.push('\\score {', '  <<', indent(blocks.join('\n'), 4))
  lines.push('  >>', '  \\layout { }', '}', '')
  return lines.join('\n')
}
