// Serves dist-site/ for local testing, like GitHub Pages: without the cross-origin isolation
// headers, which the page's service worker adds. --isolated sends them from the server.
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
  res.writeHead(200, headers).end(readFileSync(file))
}).listen(port, () => console.log(`http://localhost:${port}/${isolated ? ' (cross-origin isolated)' : ''}`))
