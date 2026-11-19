// Port of homr/transformer/staff2score.py, encoder_inference.py and decoder_inference.py:
// reads the symbols of one staff image with the encoder and a greedy decoder loop.
import * as ort from 'onnxruntime-web'
import type { GrayImage } from './image.js'
import type { Models } from './models.js'
import { EncodedSymbol } from './vocabulary.js'
import {
  articulationTokens,
  liftTokens,
  pitchTokens,
  positionTokens,
  rhythmTokens,
  slurTokens,
} from './vocabulary-data.js'

export const maxHeight = 256
export const maxWidth = 1280
const maxSeqLen = 608
const eosToken = 2
const decoderDepth = 8
const decoderHeads = 8
const decoderDim = 512
const contextLength = 1280

/** ConvertToArray: scales to [0, 1] and normalizes, in float64 like numpy, then to float32. */
function toInput(image: GrayImage): Float32Array {
  const mean = 0.7931
  const std = 0.1738
  return Float32Array.from(image.data, (v) => (v / 255 - mean) / std)
}

function argmax(data: Float32Array): number {
  let best = 0
  for (let i = 1; i < data.length; i++) if (data[i]! > data[best]!) best = i
  return best
}

const int64 = (value: number, dims: number[]) => new ort.Tensor('int64', BigInt64Array.of(BigInt(value)), dims)

/**
 * Reads a staff image of maxHeight x maxWidth pixels. Each symbol carries the decoder's
 * attention as its coordinates.
 */
export async function readStaff(models: Models, image: GrayImage): Promise<EncodedSymbol[]> {
  if (image.width !== maxWidth || image.height !== maxHeight) {
    throw new Error(`The staff image must be ${maxWidth}x${maxHeight}, got ${image.width}x${image.height}`)
  }
  const encoder = await models.session('encoder')
  const decoder = await models.session('decoder')
  const encoded = await encoder.run({ input: new ort.Tensor('float32', toInput(image), [1, 1, maxHeight, maxWidth]) })
  const contextData = encoded.output!.data as Float32Array
  const context = new ort.Tensor('float32', contextData, [1, contextLength, decoderDim])
  // After the first step the decoder only needs the first row of the context
  const contextReduced = new ort.Tensor('float32', contextData.slice(0, decoderDim), [1, 1, decoderDim])

  const headDim = decoderDim / decoderHeads
  let cache: ort.Tensor[] = Array.from(
    { length: decoderDepth * 4 },
    () => new ort.Tensor('float32', new Float32Array(0), [1, decoderHeads, 0, headDim]),
  )
  let rhythm = 1 // the start token
  let pitch = 0 // the "no note" token
  let lift = 0
  let articulation = 0
  let slur = 0
  const symbols: EncodedSymbol[] = []
  try {
    for (let step = 0; step < maxSeqLen; step++) {
      const feeds: Record<string, ort.Tensor> = {
        rhythms: int64(rhythm, [1, 1]),
        pitchs: int64(pitch, [1, 1]),
        lifts: int64(lift, [1, 1]),
        articulations: int64(articulation, [1, 1]),
        slurs: int64(slur, [1, 1]),
        context: step === 0 ? context : contextReduced,
        cache_len: int64(step, [1]),
      }
      cache.forEach((tensor, i) => (feeds[`cache_in${i}`] = tensor))
      const out = await decoder.run(feeds)
      for (const tensor of cache) tensor.dispose()
      cache = cache.map((_, i) => out[`cache_out${i}`]!)

      // Greedy decoding: the highest logit of each branch
      rhythm = argmax(out.out_rhythms!.data as Float32Array)
      pitch = argmax(out.out_pitchs!.data as Float32Array)
      lift = argmax(out.out_lifts!.data as Float32Array)
      articulation = argmax(out.out_articulations!.data as Float32Array)
      slur = argmax(out.out_slurs!.data as Float32Array)
      const position = argmax(out.out_positions!.data as Float32Array)
      const attention = Float32Array.from(out.attention!.data as Float32Array)
      for (const name of ['out_rhythms', 'out_pitchs', 'out_lifts', 'out_articulations', 'out_slurs', 'out_positions', 'attention']) {
        out[name]!.dispose()
      }
      if (rhythm === eosToken) break
      // homr's detokenize drops "[BOS]", "[EOS]" and "[PAD]", which aren't in its vocabularies
      const token = (tokens: readonly string[], index: number) => tokens[index]!
      symbols.push(
        new EncodedSymbol(
          token(rhythmTokens, rhythm),
          token(pitchTokens, pitch),
          token(liftTokens, lift),
          token(articulationTokens, articulation),
          token(slurTokens, slur),
          token(positionTokens, position),
          attention,
        ),
      )
    }
  } finally {
    for (const tensor of cache) tensor.dispose()
  }
  return symbols
}
