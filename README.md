# homrly

An in-browser port of [homr](https://github.com/liebharc/homr): optical music recognition that
turns images of sheet music into MusicXML and LilyPond, entirely client-side.

It runs homr's ONNX models with onnxruntime-web and reimplements homr's image processing and
score building in TypeScript with opencv.js. On the test images it writes the same MusicXML as
homr's command line, and it adds a LilyPond writer.

## Demo

```sh
npm install
npm run fetch-models   # homr's models, about 160 MB, into models/
npm run demo           # http://localhost:5173
```

Choose or drop an image and read the music. The page runs everything in a Web Worker, shows
each staff as it is read, and offers the result as LilyPond and MusicXML. The models are kept
in the browser's cache after the first run.

`npm run demo:build` builds the page into `dist-demo/`. Serve the models next to it at
`models/` (or set `VITE_MODELS_URL` when building), and send the headers
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`
so that onnxruntime-web can use several threads; without them it runs on one, about twice as
slow.

## Library

```ts
import { recognize } from 'homrly'

const result = await recognize(imageData, {
  models: 'https://example.com/homr-models/', // where the .onnx files are, see src/model-files.ts
  onProgress: (p) => console.log(p.stage, p.staff, p.staffs),
})
result.lilypond // the score as LilyPond
result.musicXml // the score as MusicXML, as homr writes it
result.voices   // what the transformer read, per voice
```

`imageData` is RGBA pixels such as a canvas's `ImageData`. `models` can also be a function
which returns a model's bytes, e.g. from a cache. The stages are exported too, from
`preprocess` and `segment` to `parseStaffs`, `generateXml` and `musicXmlToLilyPond`.

Reading a page takes about 20 seconds on four threads.

## How it was checked

Every stage is checked against homr's own Python code on the same input: test images, random
inputs for the parts the images don't reach, and homr's final MusicXML, which homrly matches
byte for byte. The LilyPond output was compiled with
[lilypond-wasm](https://github.com/goodgriefgnome/lilypond-wasm), and for the test score its
MIDI has exactly the notes of the original. See [DEVELOPMENT.md](DEVELOPMENT.md).

## Limitations

- One image at a time; PDFs (which homr reads with pdfium) and homr's title detection (which
  needs another OCR model) are not ported.
- homr's results vary a little between machines, as native OpenCV's warping depends on the
  CPU; homrly's are those of opencv.js.

## License

AGPL-3.0, as a derivative of homr. The models are homr's, from its `onnx_checkpoints`
release. `src/subdiv2d.ts` is ported from OpenCV and keeps OpenCV's license notice.
