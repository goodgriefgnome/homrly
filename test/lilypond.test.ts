import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { musicXmlToLilyPond } from '../src/lilypond.js'
import { generateXml } from '../src/music-xml.js'
import { EncodedSymbol } from '../src/vocabulary.js'
import { fixture } from './helpers.js'

const parse = (token: string) => {
  const [rhythm, pitch, lift, articulation, slur, position] = token.split(' ')
  return new EncodedSymbol(rhythm!, pitch, lift, articulation, slur, position)
}

const lilypondFor = (tokens: string[][]) => musicXmlToLilyPond(generateXml({}, tokens.map((v) => v.map(parse)), ''))

describe('LilyPond', () => {
  // piano.expected.ly compiles without warnings, and its MIDI has exactly the notes of
  // piano.ly, the score the test image was rendered from (see DEVELOPMENT.md)
  it.each(['piano', 'photo'])('writes the checked score for %s', (name) => {
    const { voices } = JSON.parse(readFileSync(fixture(`${name}.tokens.json`), 'utf8'))
    expect(lilypondFor(voices)).toBe(readFileSync(fixture('piano.expected.ly'), 'utf8'))
  })

  it('writes a pickup, triplets, a second voice and a repeat', () => {
    const ly = lilypondFor([
      [
        'clef_G2 _ _ _ _ upper',
        'keySignature_-2 . . . . .',
        'timeSignature/4 . . . . .',
        'note_4 F4 _ _ _ upper',
        'barline . . . . .',
        'note_12 B4 b _ _ upper',
        'note_12 C5 _ _ _ upper',
        'note_12 D5 _ _ _ upper',
        'chord . . . . .',
        'note_4 B3 b _ _ upper2',
        'note_2 F5 _ _ _ upper',
        'chord . . . . .',
        'note_2. D4 _ _ _ upper2',
        'note_4 B4 b _ _ upper',
        'repeatEnd . . . . .',
      ],
    ])
    expect(ly).toContain('\\partial 4')
    expect(ly).toContain('\\tuplet 3/2 {')
    expect(ly).toContain('\\voiceTwo')
    expect(ly).toContain('\\bar ":|."')
    expect(ly).toContain('\\key bes \\major')
  })
})
