import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    server: {
      deps: {
        // opencv.js exports a `then` (Emscripten's), so Node's dynamic import of it, which
        // vitest uses for external packages, would await it as a promise and fail
        inline: ['@techstark/opencv-js'],
      },
    },
  },
})
