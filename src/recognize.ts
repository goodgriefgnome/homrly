// The whole pipeline, as homr's main.process_image runs it for one image.
import { loadCv } from './cv.js'
import { rgbaToBgr, type BgrImage, type GrayImage, type RgbaPixels } from './image.js'
import { musicXmlToLilyPond, type LilyPondOptions } from './lilypond.js'
import { generateXml, type XmlGeneratorArguments } from './music-xml.js'
import type { MultiStaff } from './model.js'
import { Models, type ModelSource } from './models.js'
import { detectSystems } from './pipeline.js'
import { finishPredictions, predictionsFromClasses } from './predictions.js'
import { preprocess } from './preprocess.js'
import { segment } from './segmentation.js'
import { parseStaffs } from './staff-parsing.js'
import type { EncodedSymbol } from './vocabulary.js'
import { toXmlString, type XmlElement } from './xml.js'

export type Stage = 'loading' | 'preprocessing' | 'segmentation' | 'staffs' | 'transcription' | 'writing'

export interface Progress {
  stage: Stage
  /** For the transcription: the staff being read and how many there are. */
  staff?: number
  staffs?: number
  /** The image of the staff the transformer reads. */
  staffImage?: GrayImage
}

export interface RecognizeOptions {
  /** The models, or where to load them from (a URL prefix or a loader function). */
  models: Models | ModelSource
  title?: string
  xml?: XmlGeneratorArguments
  lilypond?: LilyPondOptions
  onProgress?: (progress: Progress) => void
}

export interface Recognition {
  /** The voices of the page, as the transformer read them. */
  voices: EncodedSymbol[][]
  /** The systems (staffs which belong together) on the page. */
  systems: MultiStaff[]
  musicXml: string
  xml: XmlElement
  lilypond: string
}

function isBgr(image: RgbaPixels | BgrImage): image is BgrImage {
  return image.data.length === image.width * image.height * 3
}

/**
 * Reads the music on an image: RGBA pixels (e.g. browser ImageData) or BGR pixels like
 * OpenCV's. Returns the voices and the score as MusicXML and LilyPond.
 */
export async function recognize(image: RgbaPixels | BgrImage, options: RecognizeOptions): Promise<Recognition> {
  const report = options.onProgress ?? (() => {})
  const models = options.models instanceof Models ? options.models : new Models(options.models)
  report({ stage: 'loading' })
  const cv = await loadCv()
  const segnet = await models.session('segnet')

  report({ stage: 'preprocessing' })
  const bgr = isBgr(image) ? image : rgbaToBgr(image)
  const { original, preprocessed, toInputImage } = preprocess(cv, bgr)

  report({ stage: 'segmentation' })
  const classes = await segment(segnet, preprocessed)
  const predictions = finishPredictions(cv, predictionsFromClasses(original, preprocessed, classes))

  report({ stage: 'staffs' })
  const systems = await detectSystems(models, predictions)

  const staffs = systems.reduce((n, row) => n + row.staffs.length, 0)
  report({ stage: 'transcription', staff: 0, staffs })
  const voices = await parseStaffs(models, systems, predictions.preprocessed, {
    pageToInputImage: toInputImage,
    onStaffImage: (staffImage, index) => report({ stage: 'transcription', staff: index, staffs, staffImage }),
  })

  report({ stage: 'writing' })
  const xml = generateXml(options.xml ?? {}, voices, options.title ?? '')
  return {
    voices,
    systems,
    xml,
    musicXml: toXmlString(xml),
    lilypond: musicXmlToLilyPond(xml, options.lilypond),
  }
}
