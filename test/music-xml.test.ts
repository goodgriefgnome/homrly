import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { generateMusicXml, generateXml } from '../src/music-xml.js'
import { EncodedSymbol } from '../src/vocabulary.js'
import { toXmlString } from '../src/xml.js'
import { fixture } from './helpers.js'

const parse = (token: string) => {
  const [rhythm, pitch, lift, articulation, slur, position] = token.split(' ')
  return new EncodedSymbol(rhythm!, pitch, lift, articulation, slur, position)
}

describe('MusicXML', () => {
  it('is what homr writes for random voices', () => {
    const cases: Array<{ restored: string[]; musicxml: string }> = JSON.parse(readFileSync(fixture('units/voices.json'), 'utf8'))
    const wrong = cases.flatMap((c, i) =>
      toXmlString(generateXml({}, [c.restored.map(parse)], ''), false) === c.musicxml ? [] : [i],
    )
    expect(wrong).toEqual([])
  })

  it.each(['piano', 'photo'])("is what homr writes for the voices of %s, without the image positions", (name) => {
    const { voices }: { voices: string[][] } = JSON.parse(readFileSync(fixture(`${name}.tokens.json`), 'utf8'))
    const expected = readFileSync(fixture(`${name}.musicxml`), 'utf8').replace(/<!-- imgpos: -?\d+, -?\d+ -->/g, '')
    expect(generateMusicXml(voices.map((v) => v.map(parse)))).toBe(expected)
  })
})

describe('MusicXML of random tokens', () => {
  it('is what homr writes, or fails where homr fails', () => {
    const cases: Array<{ tokens: string[]; musicxml: string }> = JSON.parse(readFileSync(fixture('units/musicxml.json'), 'utf8'))
    const results = cases.map((c) => {
      try {
        return toXmlString(generateXml({}, [c.tokens.map(parse)], ''), false)
      } catch (e) {
        return `error: ${String(e)}`
      }
    })
    const wrong = cases.flatMap((c, i) => {
      const r = results[i]!
      const ok = c.musicxml.startsWith('error') ? r.startsWith('error') : r === c.musicxml
      return ok ? [] : [i]
    })
    if (wrong.length > 0) console.log('first wrong', wrong[0], results[wrong[0]!]!.slice(0, 300))
    expect(wrong).toEqual([])
  })
})
