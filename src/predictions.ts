// homr's InputPredictions (model.py) and the steps of main.load_and_preprocess_predictions
// after segmentation: noise filtering and making staff lines stronger.
import { withMats, type CV } from './cv.js'
import type { BgrImage, GrayImage } from './image.js'
import { filterPredictions } from './noise-filtering.js'
import { SegmentationClass, classMask, type ClassMap } from './segmentation.js'

/** A 0/1 mask, row-major. */
export interface Mask {
  width: number
  height: number
  data: Uint8Array
}

export interface InputPredictions {
  original: BgrImage
  preprocessed: GrayImage
  notehead: Mask
  symbols: Mask
  staff: Mask
  clefsKeys: Mask
  stemsRest: Mask
}

/** The predictions as main.get_predictions builds them from segnet's classes. */
export function predictionsFromClasses(
  original: BgrImage,
  preprocessed: GrayImage,
  classes: ClassMap,
): InputPredictions {
  const mask = (cls: number): Mask => ({
    width: classes.width,
    height: classes.height,
    data: classMask(classes, cls),
  })
  return {
    original,
    preprocessed,
    notehead: mask(SegmentationClass.notehead),
    symbols: mask(SegmentationClass.symbols),
    staff: mask(SegmentationClass.staff),
    clefsKeys: mask(SegmentationClass.clefsKeys),
    stemsRest: mask(SegmentationClass.stemsRests),
  }
}

/** Port of staff_detection.make_lines_stronger: dilates with an elliptic kernel. */
export function makeLinesStronger(cv: CV, img: Mask, kernelSize: [number, number]): Mask {
  return withMats(cv, (s) => {
    const kernel = s.track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(...kernelSize)))
    const dilated = s.empty()
    cv.dilate(s.fromU8(img.data, img.width, img.height, 1), dilated, kernel)
    const data = new Uint8Array(dilated.data)
    // cv2.threshold(img, 0.1, 1, THRESH_BINARY)
    for (let i = 0; i < data.length; i++) data[i] = data[i]! > 0 ? 1 : 0
    return { width: img.width, height: img.height, data }
  })
}

/** The rest of main.load_and_preprocess_predictions once segnet has run. */
export function finishPredictions(cv: CV, predictions: InputPredictions): InputPredictions {
  const filtered = filterPredictions(predictions)
  return { ...filtered, staff: makeLinesStronger(cv, filtered.staff, [1, 2]) }
}
