// Port of homr/system_repair.py: repairs the grouping of staffs into systems.
import { MultiStaff, Staff, numberOfLinesOnAStaff } from './model.js'
import { median, pyRound } from './np.js'

/** A layout, the is_grandstaff of each staff, as a string of 0 and 1. Strings of 0 and 1
 * sort like Python's tuples of bools. */
type Layout = string

export const layoutOf = (row: MultiStaff): Layout => row.staffs.map((s) => (s.isGrandstaff ? '1' : '0')).join('')
const repeat = (layout: Layout, n: number) => layout.repeat(n)

/** Python's id(): a number per object. */
const ids = new WeakMap<object, number>()
let nextId = 1
function id(o: object): number {
  let v = ids.get(o)
  if (v === undefined) {
    v = nextId++
    ids.set(o, v)
  }
  return v
}

/** collections.Counter, keeping insertion order like a dict. */
class Counter extends Map<Layout, number> {
  add(key: Layout): void {
    this.set(key, (this.get(key) ?? 0) + 1)
  }
  count(key: Layout): number {
    return this.get(key) ?? 0
  }
  /** most_common(): by count, ties in insertion order. */
  mostCommon(): Array<[Layout, number]> {
    return [...this.entries()].sort((a, b) => b[1] - a[1])
  }
}

function pairwise<T>(items: T[]): Array<[T, T]> {
  return items.slice(1).map((b, i) => [items[i]!, b])
}

const flattenStaffs = (staffs: MultiStaff[]) => staffs.flatMap((row) => row.staffs)
const isUniform = (staffs: MultiStaff[]) => new Set(staffs.map(layoutOf)).size === 1

/** The most common layout, undefined if there is none or two are equally common. */
function mostCommon(layouts: Counter): Layout | undefined {
  if (layouts.size === 0) return undefined
  const [first, second] = layouts.mostCommon()
  if (second && second[1] === first![1]) return undefined
  return first![0]
}

/** The gap between two staffs where both have points, undefined if there is no such x. */
function verticalGap(upper: Staff, lower: Staff): number | undefined {
  const upperPoints = new Map<number, (typeof upper.grid)[number]>()
  for (const p of upper.grid) upperPoints.set(pyRound(p.x), p)
  const gaps = lower.grid
    .filter((p) => upperPoints.has(pyRound(p.x)))
    .map((p) => p.y[0]! - upperPoints.get(pyRound(p.x))!.y.at(-1)!)
  return gaps.length > 0 ? median(gaps) : undefined
}

/**
 * Pairs of neighboring single staffs (by id) which can form a grand staff, see homr's
 * _possible_grandstaffs.
 */
function possibleGrandstaffs(staffs: MultiStaff[], strict: boolean, guessLoneStaffs = true): Set<string> {
  const flat = flattenStaffs(staffs)
  const systemOf = new Map<number, number>()
  staffs.forEach((row, i) => row.staffs.forEach((s) => systemOf.set(id(s), i)))
  const lines = numberOfLinesOnAStaff
  const grandstaffGaps = flat
    .filter((s) => s.isGrandstaff)
    .flatMap((s) => s.grid.filter((p) => p.y.length === 2 * lines))
    .map((p) => ((p.y[lines]! - p.y[lines - 1]!) * (lines - 1)) / (p.y[lines - 1]! - p.y[0]!))
  const maxGap = grandstaffGaps.length > 0 ? 1.5 * median(grandstaffGaps) : Infinity
  const pairs = pairwise(flat)
  const measured = pairs.map(([upper, lower]) => verticalGap(upper, lower))
  // Without overlap, the distance of the bounding boxes is good enough for a comparison
  const gaps = measured.map((gap, i) => gap ?? pairs[i]![1].minY - pairs[i]![0].maxY)
  const result = new Set<string>()
  pairs.forEach(([upper, lower], i) => {
    const gap = measured[i]
    const unitSize = Math.min(upper.averageUnitSize, lower.averageUnitSize)
    if (upper.isGrandstaff || lower.isGrandstaff || gap === undefined || gap > maxGap * unitSize) return
    const neighbors = [i - 1, i + 1]
      .filter((j) => j >= 0 && j < gaps.length && !flat[j]!.isGrandstaff && !flat[j + 1]!.isGrandstaff)
      .map((j) => gaps[j]!)
    const connected = systemOf.get(id(upper)) === systemOf.get(id(lower))
    const lone = [upper, lower].every((s) => staffs[systemOf.get(id(s))!]!.staffs.length === 1)
    const guess = !strict && (guessLoneStaffs || !lone)
    if (guess || connected || neighbors.every((n) => gap < 0.8 * n)) result.add(`${id(upper)},${id(lower)}`)
  })
  return result
}

/** Fits the staffs to the layout, joining pairs of single staffs into grand staffs. */
function fitToLayout(staffs: Staff[], layout: Layout, grandstaffs: Set<string>): Staff[] | undefined {
  const result: Staff[] = []
  let i = 0
  for (const c of layout) {
    const isGrandstaff = c === '1'
    if (i < staffs.length && staffs[i]!.isGrandstaff === isGrandstaff) {
      result.push(staffs[i]!)
      i++
    } else if (
      isGrandstaff &&
      i + 1 < staffs.length &&
      !staffs[i]!.isGrandstaff &&
      !staffs[i + 1]!.isGrandstaff &&
      grandstaffs.has(`${id(staffs[i]!)},${id(staffs[i + 1]!)}`)
    ) {
      result.push(staffs[i]!.merge(staffs[i + 1]!))
      i += 2
    } else {
      return undefined
    }
  }
  return i === staffs.length ? result : undefined
}

function fitNeighbors(
  staffs: MultiStaff[],
  start: number,
  layout: Layout,
  grandstaffs: Set<string>,
): [Staff[], number] | undefined {
  for (let end = start + 1; end <= staffs.length; end++) {
    const group = flattenStaffs(staffs.slice(start, end))
    if (group.length > 2 * layout.length) return undefined
    if (!layout.includes('1') && group.length === end - start && end - start > 1) continue
    const fitted = fitToLayout(group, layout, grandstaffs)
    if (fitted) return [fitted, end]
  }
  return undefined
}

function repairSystemsTo(staffs: MultiStaff[], layout: Layout, strict = false, guessLoneStaffs = true): MultiStaff[] {
  const grandstaffs = possibleGrandstaffs(staffs, strict, guessLoneStaffs)
  const result: MultiStaff[] = []
  let i = 0
  while (i < staffs.length) {
    const current = staffs[i]!
    if (layoutOf(current) === layout) {
      result.push(current)
      i++
      continue
    }
    const row = current.staffs
    const repeats = Math.floor(row.length / layout.length)
    if (repeats > 1 && layoutOf(current) === repeat(layout, repeats) && !current.certain) {
      for (let k = 0; k < row.length; k += layout.length) result.push(new MultiStaff(row.slice(k, k + layout.length), []))
      i++
      continue
    }
    const fit = fitNeighbors(staffs, i, layout, grandstaffs)
    if (!fit) {
      result.push(current)
      i++
    } else {
      result.push(new MultiStaff(fit[0], []))
      i = fit[1]
    }
  }
  return result
}

function repairScore(staffs: MultiStaff[], layout: Layout): number {
  const systemOf = new Map<number, MultiStaff>()
  for (const row of staffs) for (const s of row.staffs) systemOf.set(id(s), row)
  let score = 0
  for (const row of repairSystemsTo(staffs, layout, true)) {
    if (layoutOf(row) !== layout) continue
    const rowIds = new Set(row.staffs.map(id))
    const contradicts = row.staffs.some((s) => {
      const source = systemOf.get(id(s))
      return !source || !source.staffs.every((x) => rowIds.has(id(x)))
    })
    const grandstaffs = [...layout].filter((c) => c === '1').length
    score += (row.staffs.length + grandstaffs) * (contradicts ? 0.5 : 1)
  }
  return score
}

/** Layouts of systems and neighbor systems which mix single and grand staffs. */
function mixedLayouts(staffs: MultiStaff[]): Counter {
  const mixed = new Counter()
  for (const row of staffs) if (new Set(layoutOf(row)).size > 1) mixed.add(layoutOf(row))
  for (const [upper, lower] of pairwise(staffs)) {
    const pair = layoutOf(upper) + layoutOf(lower)
    if (pair === '01' || pair === '10') mixed.add(pair)
  }
  return mixed
}

function isShownByMixedSystems(staffs: MultiStaff[], layout: Layout): boolean {
  const mixed = mixedLayouts(staffs)
  return mostCommon(mixed) === layout && mixed.count(layout) > 1
}

/** The layout most systems share, see homr's _common_layout. */
function commonLayout(staffs: MultiStaff[]): Layout | undefined {
  const mixed = mixedLayouts(staffs)
  const fromMixed = mostCommon(mixed)
  if (fromMixed !== undefined && mixed.count(fromMixed) > 1) return fromMixed
  const counts = new Counter()
  for (const row of staffs) counts.add(layoutOf(row))
  const candidates = [...new Set([...counts.keys(), ...mixed.keys()])]
    .sort()
    .filter((l) => !(l.length > 1 && !l.includes('0') && counts.count(l) < 2))
  if (candidates.length === 0) return undefined
  // max() keeps the first of equal keys
  let best = candidates[0]!
  let bestKey = [repairScore(staffs, best), counts.count(best)]
  for (const l of candidates.slice(1)) {
    const key = [repairScore(staffs, l), counts.count(l)]
    if (key[0]! > bestKey[0]! || (key[0] === bestKey[0] && key[1]! > bestKey[1]!)) {
      best = l
      bestKey = key
    }
  }
  return best
}

/** On a page of grand staffs, drops a single staff below the last system. */
function dropSingleStaffAtEnd(staffs: MultiStaff[], layout: Layout): MultiStaff[] {
  const single = staffs.filter((row) => layoutOf(row) === '0')
  const onlyGrandstaffs = !layout.includes('0')
  if (!onlyGrandstaffs || single.length !== 1 || single[0] !== staffs.at(-1) || staffs.length < 3) return staffs
  return staffs.slice(0, -1)
}

/** The shortest repeating layout of single and grand staffs: [period, frontTrim, backTrim]. */
function findPeriodicCore(flat: Staff[]): [number, number, number] | undefined {
  const layout = flat.map((s) => (s.isGrandstaff ? '1' : '0'))
  const n = layout.length
  let best: [number, number, number, number] | undefined
  for (let period = 1; period <= Math.floor(n / 2); period++) {
    for (let front = 0; front <= period; front++) {
      for (let back = 0; back <= period; back++) {
        const core = layout.slice(front, n - back)
        if (core.length < 2 * period || core.length % period !== 0) continue
        const first = core.slice(0, period).join('')
        let same = true
        for (let i = 0; i < core.length; i += period) if (core.slice(i, i + period).join('') !== first) same = false
        if (!same) continue
        const candidate: [number, number, number, number] = [front + back, period, front, back]
        if (!best || candidate[0] < best[0] || (candidate[0] === best[0] && candidate[1] < best[1])) best = candidate
      }
    }
  }
  return best && [best[1], best[2], best[3]]
}

function regroupByPattern(staffs: MultiStaff[]): MultiStaff[] | undefined {
  const flat = flattenStaffs(staffs)
  const core = findPeriodicCore(flat)
  if (!core) return undefined
  const [period, front, back] = core
  const end = flat.length - back
  const pattern = new Set(flat.slice(front, front + period).map((s) => s.isGrandstaff))
  const mixes = pattern.size === 2
  const trimmed = front > 0 || back > 0
  const nothingGrouped = staffs.every((row) => row.staffs.length === 1)
  if (!mixes || (trimmed && !nothingGrouped)) return undefined
  const result = flat.slice(0, front).map((s) => new MultiStaff([s], []))
  for (let i = front; i < end; i += period) result.push(new MultiStaff(flat.slice(i, i + period), []))
  result.push(...flat.slice(end).map((s) => new MultiStaff([s], [])))
  return result
}

function convertToLayout(row: MultiStaff, layout: Layout): MultiStaff | undefined {
  if (layoutOf(row) === layout) return row
  const singles: Staff[] = []
  for (const staff of row.staffs) {
    const parts = staff.isGrandstaff ? staff.split() : [staff]
    if (!parts) return undefined
    singles.push(...parts)
  }
  let next = 0
  const take = () => {
    if (next >= singles.length) throw new Error('StopIteration')
    return singles[next++]!
  }
  const staffs: Staff[] = []
  for (const c of layout) {
    let staff = take()
    if (c === '1') {
      const lower = take()
      if (verticalGap(staff, lower) === undefined) return undefined
      staff = staff.merge(lower)
    }
    staffs.push(staff)
  }
  return new MultiStaff(staffs, row.connections, row.certain)
}

function unifyGrandStaffs(staffs: MultiStaff[]): MultiStaff[] {
  const perSystem = new Set(staffs.map((row) => row.staffs.reduce((n, s) => n + (s.isGrandstaff ? 2 : 1), 0)))
  if (perSystem.size !== 1) return staffs
  const counts = new Counter()
  for (const row of staffs) counts.add(layoutOf(row))
  const layout = mostCommon(counts)
  if (layout === undefined) return staffs
  const result: MultiStaff[] = []
  for (const row of staffs) {
    const converted = convertToLayout(row, layout)
    if (!converted) return staffs
    result.push(converted)
  }
  return result
}

/** Repairs the grouping of staffs into systems towards the layout most systems share. */
export function repairSystems(staffs: MultiStaff[]): MultiStaff[] {
  staffs = unifyGrandStaffs(staffs)
  if (isUniform(staffs) && staffs[0]!.staffs.length > 1) return staffs
  const layout = commonLayout(staffs)
  let repaired: MultiStaff[]
  if (layout === undefined) {
    repaired = staffs
  } else {
    // Single staffs only pair up by a guess if systems show how the page is built
    repaired = repairSystemsTo(staffs, layout, false, isShownByMixedSystems(staffs, layout))
  }
  if (!isUniform(repaired) && !staffs.some((row) => row.certain)) {
    // Nothing grouped, or e.g. a crease connected staffs of different systems
    const regrouped = regroupByPattern(staffs)
    if (regrouped) return regrouped
  }
  return layout === undefined ? repaired : dropSingleStaffAtEnd(repaired, layout)
}
