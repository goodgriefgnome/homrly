import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { recognize } from '../src/recognize.js'
import { fixture, haveModels, localModels, readBgr } from './helpers.js'

describe.skipIf(!haveModels)('recognize', () => {
  it.each(['piano', 'photo'])(
    'writes what homr writes for %s',
    { timeout: 600_000 },
    async (name) => {
      const models = localModels()
      try {
        const stages: string[] = []
        const result = await recognize(readBgr(fixture(`${name}.png`)), {
          models,
          onProgress: (p) => stages.push(p.stage),
        })
        expect(new Set(stages)).toEqual(new Set(['loading', 'preprocessing', 'segmentation', 'staffs', 'transcription', 'writing']))
        const expected = readFileSync(fixture(`${name}.musicxml`), 'utf8')
        // The image positions come from the decoder's attention mapped back through the
        // dewarping, so they can differ by a pixel
        const withoutPositions = (xml: string) => xml.replace(/<!-- imgpos: -?\d+, -?\d+ -->/g, '')
        expect(withoutPositions(result.musicXml)).toBe(withoutPositions(expected))
        const positions = (xml: string) => [...xml.matchAll(/imgpos: (-?\d+), (-?\d+)/g)].map((m) => [Number(m[1]), Number(m[2])])
        const ours = positions(result.musicXml)
        const theirs = positions(expected)
        expect(ours.length).toBe(theirs.length)
        const distances = ours.map(([x, y], i) => Math.max(Math.abs(x! - theirs[i]![0]!), Math.abs(y! - theirs[i]![1]!)))
        console.log(`${name}: image positions differ by up to ${Math.max(...distances)} px, ${distances.filter((d) => d > 0).length} of ${distances.length}`)
        expect(Math.max(...distances)).toBeLessThanOrEqual(3)
        expect(result.lilypond).toBe(readFileSync(fixture('piano.expected.ly'), 'utf8'))
      } finally {
        await models.release()
      }
    },
  )
})
