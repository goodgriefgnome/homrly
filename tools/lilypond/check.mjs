// Compiles LilyPond files with lilypond-wasm and reports failures and warnings, e.g. to
// check what src/lilypond.ts writes for many inputs. lilypond-wasm is not a dependency of
// homrly; point LILYPOND_WASM at a checkout or an installed copy of it:
//
//   LILYPOND_WASM=../lilypond-wasm node tools/lilypond/check.mjs out/*.ly
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.env.LILYPOND_WASM
if (!root) throw new Error('Set LILYPOND_WASM to a lilypond-wasm checkout')
const { compile } = await import(pathToFileURL(path.resolve(root, 'src/index.mjs')).href)

let failed = 0
let warned = 0
for (const file of process.argv.slice(2)) {
  try {
    const result = await compile(fs.readFileSync(file, 'utf8'), { format: 'png', resolution: 30 })
    const warnings = String(result.logs ?? '')
      .split('\n')
      .filter((line) => /warning/.test(line))
    if (warnings.length > 0) {
      warned++
      console.log(`${file}: ${warnings.join(' | ')}`)
    }
  } catch (e) {
    failed++
    console.log(`${file}: FAILED ${String(e.logs ?? e).split('\n').filter((l) => /error/.test(l)).join(' | ')}`)
  }
}
console.log(`${process.argv.length - 2} files, ${failed} failed, ${warned} with warnings`)
process.exitCode = failed > 0 ? 1 : 0
