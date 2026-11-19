import type { WorkerMessage, WorkerRequest } from './worker.js'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const drop = $('drop')
const fileInput = $<HTMLInputElement>('file')
const sampleButton = $<HTMLButtonElement>('sample')
const preview = $<HTMLImageElement>('preview')
const previewCaption = $('preview-caption')
const status = $('status')
const statusLine = $('status-line')
const bar = $('bar')
const barFill = bar.firstElementChild as HTMLElement
const error = $('error')
const ly = $('ly')
const outCaption = $('out-caption')
const copy = $<HTMLButtonElement>('copy')

const base = new URL('./', import.meta.url).href
let busy = false

/**
 * Threads need cross-origin isolation, whose headers static hosts like GitHub Pages can't send:
 * coi-sw.js adds them. The page reloads once, so that the service worker serves it.
 */
async function isolate(): Promise<void> {
  if (crossOriginIsolated || !('serviceWorker' in navigator) || !isSecureContext) return
  try {
    const registration = await navigator.serviceWorker.register(new URL('coi-sw.js', base), { scope: base })
    if (navigator.serviceWorker.controller) return // serves the page, but the browser doesn't isolate it
    let reloaded = false
    try {
      reloaded = sessionStorage.getItem('homrly-isolation') === 'tried'
      sessionStorage.setItem('homrly-isolation', 'tried')
    } catch {
      return // without storage a reload could repeat
    }
    if (reloaded) return
    const worker = registration.installing ?? registration.waiting ?? registration.active
    if (worker?.state === 'activated') location.reload()
    else worker?.addEventListener('statechange', () => worker.state === 'activated' && location.reload())
  } catch {
    // Without a service worker the page runs on one thread
  }
}
void isolate()

// The example output of the sample page, shown until something is read
fetch(new URL('sample.ly', base))
  .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
  .then((text) => {
    if (!busy && ly.textContent === 'Loading the example…') ly.textContent = text
  })
  .catch(() => {
    ly.textContent = ''
  })

const stageText: Record<string, string> = {
  loading: 'Loading the models',
  preprocessing: 'Preparing the image',
  segmentation: 'Finding staff lines, notes and symbols',
  staffs: 'Finding the staffs',
  transcription: 'Reading the notes',
  writing: 'Writing LilyPond',
}
const order = Object.keys(stageText)

function showStage(stage: string) {
  const index = order.indexOf(stage)
  document.querySelectorAll<HTMLLIElement>('#steps li').forEach((li, i) => {
    li.classList.toggle('now', i === index)
    li.classList.toggle('done', i < index)
  })
}

/** The image as RGBA pixels, transparent parts white like paper. */
async function pixels(blob: Blob): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, bitmap.width, bitmap.height)
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  return ctx.getImageData(0, 0, canvas.width, canvas.height)
}

async function read(blob: Blob, name: string) {
  if (busy) return
  busy = true
  sampleButton.disabled = true
  preview.src = URL.createObjectURL(blob)
  previewCaption.textContent = name.charAt(0).toUpperCase() + name.slice(1)
  status.hidden = false
  error.hidden = true
  bar.hidden = true
  statusLine.textContent = 'Starting'
  showStage('loading')
  ly.textContent = ''
  outCaption.textContent = 'Appears here once the page is read.'

  let image: ImageData
  try {
    image = await pixels(blob)
  } catch {
    fail('This file could not be opened as an image. Try a PNG or JPEG.')
    return
  }
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
  const finish = () => {
    worker.terminate()
    busy = false
    sampleButton.disabled = false
  }
  worker.onerror = (e) => {
    finish()
    fail(`Reading failed: ${e.message || 'the worker stopped'}.`)
  }
  worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
    const m = event.data
    if (m.type === 'download') {
      bar.hidden = false
      barFill.style.width = `${(100 * m.loaded) / m.total}%`
      statusLine.textContent = `Downloading the models: ${(m.loaded / 1e6).toFixed(0)} of ${(m.total / 1e6).toFixed(0)} MB`
    } else if (m.type === 'stage') {
      if (m.stage !== 'loading') bar.hidden = true
      showStage(m.stage)
      statusLine.textContent =
        m.stage === 'transcription' && m.staffs ? `Reading the notes of staff ${(m.staff ?? 0) + 1} of ${m.staffs}` : (stageText[m.stage] ?? m.stage)
    } else if (m.type === 'result') {
      finish()
      showStage('done')
      document.querySelectorAll('#steps li').forEach((li) => li.classList.add('done'))
      statusLine.textContent = `Read in ${Math.round(m.seconds)} seconds`
      ly.textContent = m.lilypond
      outCaption.textContent = `For ${name}. Check it against the image: the recognition makes mistakes.`
    } else {
      finish()
      fail(friendly(m.message))
    }
  }
  const request: WorkerRequest = { image: { width: image.width, height: image.height, data: image.data }, base }
  worker.postMessage(request, [image.data.buffer])
}

function friendly(message: string): string {
  if (/No staffs found|No noteheads or clefs/.test(message)) {
    return 'No music was found in this image. Use a page with staff lines, upright and in focus.'
  }
  return `Reading failed: ${message}`
}

function fail(message: string) {
  error.textContent = message
  error.hidden = false
  statusLine.textContent = 'Stopped'
  busy = false
  sampleButton.disabled = false
}

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0]
  if (f) void read(f, f.name)
  fileInput.value = ''
})

sampleButton.addEventListener('click', async () => {
  const blob = await (await fetch(new URL('sample.png', base))).blob()
  void read(blob, 'the sample page')
})

document.addEventListener('paste', (event) => {
  const item = [...(event.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'))
  const f = item?.getAsFile()
  if (!f) return
  event.preventDefault()
  void read(f, 'the pasted image')
})

drop.addEventListener('dragover', (e) => {
  e.preventDefault()
  drop.classList.add('over')
})
drop.addEventListener('dragleave', () => drop.classList.remove('over'))
drop.addEventListener('drop', (e) => {
  e.preventDefault()
  drop.classList.remove('over')
  const f = [...(e.dataTransfer?.files ?? [])].find((file) => file.type.startsWith('image/'))
  if (f) void read(f, f.name)
})

copy.addEventListener('click', async () => {
  const text = ly.textContent ?? ''
  try {
    await navigator.clipboard.writeText(text)
    copy.textContent = 'Copied'
  } catch {
    // Some views refuse the clipboard: select the text for Ctrl+C instead
    const range = document.createRange()
    range.selectNodeContents(ly)
    const selection = getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    copy.textContent = 'Selected, press Ctrl+C'
  }
  setTimeout(() => (copy.textContent = 'Copy'), 2000)
})
