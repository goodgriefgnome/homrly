# Developing homrly

homrly ports [homr](https://github.com/liebharc/homr) stage by stage and checks each ported
stage against homr's own output on the same input.

The port follows homr at commit `83130ba` (2026-11-17). Its models are pinned with SHA-256
hashes in `src/model-files.ts`.

## Setup

```sh
npm install
npm run fetch-models   # downloads homr's ONNX models (~160 MB) into models/
npm test
```

Tests that need the models are skipped when `models/` is missing.

## Reference outputs

`tools/reference/` holds Python scripts that run homr's own code on the files in
`test/fixtures/` and write what a stage produces next to them. `<name>.musicxml` is what
homr's command line writes for the image, byte for byte. The tests compare the port
with those files. To regenerate them you need a homr checkout at the pinned commit, its
models in place (homr downloads them on first run, or link the ones from `models/` into
`homr/segmentation/`, `homr/transformer/` and `homr/staff_relations/`) and the packages in
`tools/reference/requirements.txt`:

```sh
python -m venv .venv
.venv/bin/pip install -r tools/reference/requirements.txt
HOMR_DIR=../homr .venv/bin/python -I tools/reference/dump_reference.py --full test/fixtures/piano.png test/fixtures/photo.png
HOMR_DIR=../homr .venv/bin/python -I tools/reference/dump_units.py
HOMR_DIR=../homr .venv/bin/python -I tools/reference/dump_vocabulary.py
```

homr's `main` module imports `rapidocr` for title detection, which homrly does not port.
The scripts import only the modules they need, so `rapidocr` is not required.

## Fixtures

`test/fixtures/*.ly` are original scores written for these tests, rendered to PNG at 150 DPI
with LilyPond 2.26.0. `photo.png` is made from `piano.png` by
`tools/reference/make_photo_fixture.py`: rotated, on a desk, in uneven light, to exercise
autocrop.

## OpenCV

homrly uses opencv.js (`@techstark/opencv-js`) for the OpenCV calls homr makes. Where homr
uses another library, homrly ports its algorithm instead: `src/pil-resize.ts` is Pillow's
bicubic resampling, which OpenCV's resize does not reproduce, and `src/np.ts` reproduces
numpy's medians and float32 rounding. The aim is identical results, not approximations.

Some OpenCV calls stay in OpenCV even where plain TypeScript would be simpler or faster,
because homr's results depend on OpenCV's exact behaviour: `intersectConvexConvex` is given
polygons that are not strictly convex, and an exact convex intersection disagrees with it on
about 0.4% of such pairs. `pointPolygonTest` on integer contours is ported (it is exact).

`src/np.ts` reproduces numpy's pairwise summation, so means and standard deviations match
to the last bit. One known gap: homr's `find_peaks` orders peaks with `np.argsort`, whose
order for equal values is not specified for longer arrays; the port uses a stable order.
Extrapolating a staff beyond its end fits a line in closed form where homr uses
`np.polyfit`, which can differ in the last bits.

The staff images the transformer reads can differ from homr's by one gray level in a few
pixels: native OpenCV's `warpAffine` interpolates with float32 SIMD code (fused
multiply-adds, a lane width and a scalar tail that depend on the CPU), opencv.js does not.
homr itself gives slightly different staff images on different machines for this reason.
The tests allow this for the staff images; what the transformer reads must match exactly.

`Subdiv2D`, which opencv.js lacks, is ported in `src/subdiv2d.ts` (under OpenCV's license,
see the file) and gives OpenCV's triangles in OpenCV's order.

## Port status

| Stage | homr source | Port | Checked against homr |
|---|---|---|---|
| Model loading | `onnx_providers.py`, configs | `src/models.ts` | all models load |
| Preprocessing (autocrop, resize, CLAHE) | `autocrop.py`, `resize.py`, `color_adjust.py` | `src/preprocess.ts`, `src/autocrop.ts`, `src/pil-resize.ts` | exact on `piano` and `photo` |
| Segmentation | `segmentation/inference_segnet.py` | `src/segmentation.ts` | exact on `piano` and `photo` |
| Noise filtering, stronger staff lines | `noise_filtering.py`, `make_lines_stronger` | `src/noise-filtering.ts`, `src/predictions.ts` | exact on `piano` and a synthetic noisy mask |
| Symbols: boxes, noteheads with stems, bar lines | `bounding_boxes.py`, `bar_line_detection.py`, `note_detection.py`, `main.predict_symbols` | `src/bounding-boxes.ts`, `src/geometry.ts`, `src/symbols.ts` | exact on `piano` and `photo`; polygon overlap on 3000 random pairs |
| Staff detection, notes on staffs | `staff_detection.py`, `find_peaks.py`, `model.py`, `note_detection.py`, `main.detect_single_staffs` | `src/staff-detection.ts`, `src/find-peaks.ts`, `src/model.ts`, `src/note-detection.ts`, `src/pipeline.ts` | exact on `piano` and `photo` |
| Staff relations, system repair | `staff_relations.py`, `system_repair.py`, `main.group_staffs` | `src/staff-relations.ts`, `src/system-repair.ts` | exact on `piano` and `photo` (model outputs to 1e-4); staffs cut in pieces; 300 random pages for the repair |
| Staff images, dewarping, transformer, voices | `staff_parsing.py`, `staff_dewarping.py`, `transformer/`, `triplet_restoration.py` | `src/staff-parsing.ts`, `src/dewarping.ts`, `src/subdiv2d.ts`, `src/transformer.ts`, `src/vocabulary.ts`, `src/triplet-restoration.ts` | tokens and voices exact on `piano` and `photo`; staff images within one gray level; Subdiv2D on 200 point sets; clean-up and triplets on 300 random voices |
| MusicXML output | `music_xml_generator.py` | `src/music-xml.ts`, `src/xml.ts` | byte-identical to homr on `piano` and `photo` (without image positions), 300 random voices and 400 random token streams from the whole vocabulary |
| LilyPond output | none (new) | `src/lilypond.ts` | see below |

## LilyPond output

`src/lilypond.ts` is not a port: homr writes only MusicXML. It reads the MusicXML document
that `src/music-xml.ts` builds, so the timing, voices, ties, beams and tuplets which homr's
generator works out carry over. Parts become staves or piano staves, MusicXML voices become
LilyPond voices on their staff (with `\change Staff` for beams across staves), gaps are filled
with spacer rests, a short or long first measure gets `\partial` and later irregular measures
`Timing.measureLength`, so that barlines stay where homr put them. Slurs, beams and tuplets are
written only where they start and stop properly, which keeps the output compilable whatever
the transformer reads.

How it was checked, with [lilypond-wasm](https://github.com/goodgriefgnome/lilypond-wasm):

- `test/fixtures/piano.expected.ly`, what homrly writes for both test images, compiles
  without warnings, and its MIDI has exactly the 67 notes, at the same times, of `piano.ly`,
  the score the test image was rendered from.
- The LilyPond for the 300 random voices of `test/fixtures/units/voices.json` compiles
  without warnings, and for 100 random token streams of `units/musicxml.json` (which are far
  from music: clefs and time signatures in the middle of measures and so on) it compiles,
  with warnings like failed bar checks where the input is nonsense.

`tools/lilypond/check.mjs` compiles a set of `.ly` files and reports failures and warnings:

```sh
LILYPOND_WASM=../lilypond-wasm node tools/lilypond/check.mjs out/*.ly
```

## Demo

`demo/` is a Vite page which runs `recognize()` in a Web Worker. In development the Vite
server serves `models/` and onnxruntime-web's loader and WebAssembly (the CPU build), which
onnxruntime-web loads by URL so that it can start its threads; both need the cross-origin
isolation headers. `tools/browser-check.cjs` runs the page in Chromium with Playwright and
compares its LilyPond with an expected file; on the test images the page gives exactly
`test/fixtures/piano.expected.ly`, in about 20 seconds on four threads.

```sh
npm run demo &
node tools/browser-check.cjs http://localhost:5173/ test/fixtures/photo.png test/fixtures/piano.expected.ly
```
