// Adds the cross-origin isolation headers to the site's responses, which GitHub Pages can't
// send itself. With them onnxruntime-web can use several threads: a page takes about 20
// seconds instead of 50. The embedder policy is credentialless, so that the fonts from Google
// Fonts still load.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return
  event.respondWith(
    fetch(request).then((response) => {
      if (response.status === 0) return response
      const headers = new Headers(response.headers)
      headers.set('Cross-Origin-Opener-Policy', 'same-origin')
      headers.set('Cross-Origin-Embedder-Policy', 'credentialless')
      headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
    }),
  )
})
