import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { restoreUnmarkedTriplets } from '../src/triplet-restoration.js'
import { EncodedSymbol, removeDuplicatedSymbols } from '../src/vocabulary.js'
import { fixture } from './helpers.js'

const parse = (token: string) => {
  const [rhythm, pitch, lift, articulation, slur, position] = token.split(' ')
  return new EncodedSymbol(rhythm!, pitch, lift, articulation, slur, position)
}

describe('voice clean-up', () => {
  const cases: Array<{ tokens: string[]; cleaned: string[]; restored: string[] }> = JSON.parse(
    readFileSync(fixture('units/voices.json'), 'utf8'),
  )

  it('removes duplicated symbols like homr', () => {
    const wrong = cases.flatMap((c, i) =>
      JSON.stringify(removeDuplicatedSymbols(c.tokens.map(parse)).map(String)) === JSON.stringify(c.cleaned) ? [] : [i],
    )
    expect(wrong).toEqual([])
  })

  it('restores unmarked triplets like homr', () => {
    const wrong = cases.flatMap((c, i) =>
      JSON.stringify(restoreUnmarkedTriplets(c.cleaned.map(parse)).map(String)) === JSON.stringify(c.restored) ? [] : [i],
    )
    expect(wrong).toEqual([])
  })
})
