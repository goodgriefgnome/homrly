// Builds the website into dist-site/: the page (a fragment, which the host wraps in a document),
// its scripts, onnxruntime-web's CPU build, a sample, and the models split into parts small
// enough for hosts with a file size limit.
//
//   npm run fetch-models && npm run site:build
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'
import { MODELS } from '../src/model-files.ts'

const out = new URL('../dist-site/', import.meta.url)
const at = (path) => new URL(path, out)
const root = (path) => new URL(`../${path}`, import.meta.url)
const partSize = 14 * 1000 * 1000

rmSync(out, { recursive: true, force: true })
mkdirSync(at('ort/'), { recursive: true })
mkdirSync(at('models/'), { recursive: true })

/** opencv.js has code paths for Node which the browser never takes. */
const nodeBuiltins = {
  name: 'node-builtins',
  setup(b) {
    b.onResolve({ filter: /^(fs|path|crypto|worker_threads|perf_hooks)$/ }, (args) => ({ path: args.path, namespace: 'empty' }))
    b.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({ contents: 'export default {}', loader: 'js' }))
  },
}

const common = {
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
  plugins: [nodeBuiltins],
  // The CPU build of onnxruntime-web, which loads its WebAssembly from ort.env.wasm.wasmPaths
  alias: { 'onnxruntime-web': 'onnxruntime-web/wasm' },
  conditions: ['onnxruntime-web-use-extern-wasm'],
}
await build({ ...common, entryPoints: [root('site/app.ts').pathname], outfile: at('app.js').pathname })
await build({ ...common, entryPoints: [root('site/worker.ts').pathname], outfile: at('worker.js').pathname })

copyFileSync(root('site/page.html'), at('index.html'))
copyFileSync(root('test/fixtures/piano.png'), at('sample.png'))
copyFileSync(root('site/sample-preview.png'), at('sample-preview.png'))
copyFileSync(root('test/fixtures/piano.expected.ly'), at('sample.ly'))
for (const name of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  copyFileSync(root(`node_modules/onnxruntime-web/dist/${name}`), at(`ort/${name}`))
}

const manifest = {}
for (const [name, model] of Object.entries(MODELS)) {
  const source = root(`models/${model.file}`)
  if (!existsSync(source)) throw new Error(`${model.file} is missing, run npm run fetch-models`)
  const bytes = readFileSync(source)
  const parts = []
  for (let offset = 0, i = 0; offset < bytes.length; offset += partSize, i++) {
    // Served as application/wasm, the binary type every static host knows; it is a part of an
    // ONNX model, not WebAssembly
    const part = `${name}-${i}.wasm`
    writeFileSync(at(`models/${part}`), bytes.subarray(offset, offset + partSize))
    parts.push(part)
  }
  manifest[model.file] = { size: bytes.length, parts }
}
writeFileSync(at('models/manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log('Built dist-site/')
