// Serves dist-site/ for local testing. The page is a fragment, as the host wraps it in a
// document; this server does the same. --isolated sends the cross-origin isolation headers
// which let onnxruntime-web use threads; without it the page runs as on a host without them.
//
//   node scripts/serve-site.mjs [--isolated] [--port 8080]
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, normalize } from 'node:path'

const dir = new URL('../dist-site/', import.meta.url).pathname
const isolated = process.argv.includes('--isolated')
const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 8080
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ly': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream',
}

createServer((req, res) => {
  let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '')
  if (path === '' || path.endsWith('/')) path += 'index.html'
  const file = dir + path
  if (path.includes('..') || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('Not found')
    return
  }
  const headers = { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' }
  if (isolated) {
    headers['Cross-Origin-Opener-Policy'] = 'same-origin'
    headers['Cross-Origin-Embedder-Policy'] = 'require-corp'
    headers['Cross-Origin-Resource-Policy'] = 'same-origin'
  }
  let body = readFileSync(file)
  if (path === 'index.html') {
    body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>body{margin:0}[hidden]{display:none!important}img{max-width:100%}</style></head><body>${body}</body></html>`
  }
  res.writeHead(200, headers).end(body)
}).listen(port, () => console.log(`http://localhost:${port}/${isolated ? ' (cross-origin isolated)' : ''}`))
