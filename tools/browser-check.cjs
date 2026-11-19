// Runs the demo in Chromium with Playwright: chooses an image, reads the music and compares
// the LilyPond with an expected file. Start the demo first (npm run demo, or npm run
// demo:build and vite preview), then:
//
//   node tools/browser-check.cjs http://localhost:5173/ test/fixtures/photo.png test/fixtures/piano.expected.ly
const fs = require('node:fs')
const { chromium } = require('playwright')

const [url, image, expected] = process.argv.slice(2)
if (!url || !image) throw new Error('Usage: browser-check.cjs URL IMAGE [EXPECTED.ly]')

;(async () => {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    page.on('pageerror', (e) => console.log('page error:', e.message))
    await page.goto(url)
    console.log('cross-origin isolated:', await page.evaluate(() => crossOriginIsolated))
    await page.setInputFiles('#file', image)
    await page.waitForSelector('#run:not([disabled])')
    await page.click('#run')
    await page.waitForSelector('#result-section:not([hidden]), #error:not([hidden])', { timeout: 600_000 })
    const error = await page.$eval('#error', (e) => (e.hidden ? '' : e.textContent))
    if (error) throw new Error(error)
    console.log(await page.$eval('#time', (e) => e.textContent))
    const lilypond = await page.$eval('#output', (e) => e.textContent)
    if (expected) {
      const same = lilypond === fs.readFileSync(expected, 'utf8')
      console.log(same ? 'The LilyPond is as expected' : 'The LilyPond differs from the expected file')
      process.exitCode = same ? 0 : 1
    } else {
      console.log(lilypond)
    }
  } finally {
    await browser.close()
  }
})()
