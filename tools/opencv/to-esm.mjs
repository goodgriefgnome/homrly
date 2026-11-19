// Turns OpenCV's UMD opencv.js into an ES module: its default export is the promise of the
// initialized module. ES modules are strict, so the UMD wrapper's assignment to an undeclared
// `Module` is replaced.
//
//   node tools/opencv/to-esm.mjs path/to/opencv.js vendor/opencv/opencv.mjs
import { readFileSync, writeFileSync } from 'node:fs'

const [input, output] = process.argv.slice(2)
let code = readFileSync(input, 'utf8')
const sloppy = /  if \(typeof Module === 'undefined'\)\n    Module = \{\};\n  return cv\(Module\);/
if (!sloppy.test(code)) throw new Error('The UMD wrapper of opencv.js is not as expected')
code = code.replace(sloppy, "  return cv(typeof Module === 'undefined' ? {} : Module);")
writeFileSync(
  output,
  `// OpenCV 5.0.0 for homrly, built by tools/opencv/build.sh. OpenCV is under the Apache 2 license.\n` +
    `const module = { exports: {} };\nconst exports = module.exports;\nconst define = undefined;\n` +
    // In Node, Emscripten's start-up code reaches for CommonJS names. The WebAssembly is in this
    // file, so it never reads a file: these stand-ins are enough.
    `const require = () => ({});\nconst __dirname = '.';\nconst __filename = undefined;\n` +
    `${code}\nexport default module.exports;\n`,
)
