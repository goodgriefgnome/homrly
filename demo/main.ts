import type { Request, Response } from './worker.js'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const file = $<HTMLInputElement>('file')
const drop = $<HTMLLabelElement>('drop')
const preview = $<HTMLImageElement>('preview')
const run = $<HTMLButtonElement>('run')
const progressSection = $('progress-section')
const resultSection = $('result-section')
const bar = $<HTMLProgressElement>('bar')
const detail = $('detail')
const staffCanvas = $<HTMLCanvasElement>('staff')
const error = $('error')
const output = $('output')
const time = $('time')

const modelsUrl: string = import.meta.env.VITE_MODELS_URL ?? new URL('models/', location.href).href
let image: ImageData | undefined
let name = 'score'
let result: { lilypond: string; musicXml: string } | undefined
let tab: 'lilypond' | 'musicxml' = 'lilypond'

async function choose(f: File) {
  name = f.name.replace(/\.[^.]+$/, '') || 'score'
  const bitmap = await createImageBitmap(f)
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d')!
  // Transparent pixels become white, like paper
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, bitmap.width, bitmap.height)
  ctx.drawImage(bitmap, 0, 0)
  image = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
  preview.src = URL.createObjectURL(f)
  preview.hidden = false
  run.disabled = false
}

file.addEventListener('change', () => file.files?.[0] && choose(file.files[0]))
drop.addEventListener('dragover', (e) => {
  e.preventDefault()
  drop.classList.add('over')
})
drop.addEventListener('dragleave', () => drop.classList.remove('over'))
drop.addEventListener('drop', (e) => {
  e.preventDefault()
  drop.classList.remove('over')
  const f = e.dataTransfer?.files[0]
  if (f) void choose(f)
})

function setStage(stage: string) {
  let reached = false
  for (const li of document.querySelectorAll<HTMLLIElement>('#stages li')) {
    const isCurrent = li.dataset.stage === stage
    li.classList.toggle('active', isCurrent)
    li.classList.toggle('done', !isCurrent && !reached)
    if (isCurrent) reached = true
  }
}

function show() {
  if (!result) return
  output.textContent = tab === 'lilypond' ? result.lilypond : result.musicXml
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab))
}

for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button')) {
  b.addEventListener('click', () => {
    tab = b.dataset.tab as typeof tab
    show()
  })
}

$('copy').addEventListener('click', () => void navigator.clipboard.writeText(output.textContent ?? ''))
$('download').addEventListener('click', () => {
  if (!result) return
  const [text, ext, type] =
    tab === 'lilypond' ? [result.lilypond, 'ly', 'text/x-lilypond'] : [result.musicXml, 'musicxml', 'application/vnd.recordare.musicxml+xml']
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type }))
  a.download = `${name}.${ext}`
  a.click()
})

run.addEventListener('click', () => {
  if (!image) return
  run.disabled = true
  progressSection.hidden = false
  resultSection.hidden = true
  error.hidden = true
  staffCanvas.hidden = true
  detail.textContent = ''
  setStage('loading')
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  worker.onerror = (event) => {
    error.textContent = `Reading failed: ${event.message}`
    error.hidden = false
    run.disabled = false
  }
  worker.onmessage = (event: MessageEvent<Response>) => {
    const message = event.data
    if (message.type === 'download') {
      bar.hidden = false
      bar.max = message.total || 1
      bar.value = message.loaded
      detail.textContent = `Downloading ${message.file.split('_')[0]}: ${(message.loaded / 1e6).toFixed(0)} of ${(message.total / 1e6).toFixed(0)} MB`
    } else if (message.type === 'progress') {
      bar.hidden = true
      setStage(message.progress.stage)
      const { staff, staffs } = message.progress
      detail.textContent = message.progress.stage === 'transcription' && staffs ? `Staff ${(staff ?? 0) + 1} of ${staffs}` : ''
      if (message.staffImage) {
        staffCanvas.width = message.staffImage.width
        staffCanvas.height = message.staffImage.height
        staffCanvas.getContext('2d')!.putImageData(message.staffImage, 0, 0)
        staffCanvas.hidden = false
      }
    } else if (message.type === 'result') {
      setStage('')
      for (const li of document.querySelectorAll('#stages li')) li.classList.add('done')
      detail.textContent = ''
      staffCanvas.hidden = true
      result = message
      resultSection.hidden = false
      time.textContent = `Read in ${message.seconds.toFixed(0)} s`
      show()
      worker.terminate()
      run.disabled = false
    } else {
      error.textContent = `Reading failed: ${message.message}`
      error.hidden = false
      worker.terminate()
      run.disabled = false
    }
  }
  const request: Request = {
    image: { width: image.width, height: image.height, data: image.data },
    modelsUrl,
    ortUrl: new URL('ort/', location.href).href,
    title: '',
  }
  worker.postMessage(request)
})
