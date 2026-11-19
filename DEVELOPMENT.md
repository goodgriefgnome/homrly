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
`test/fixtures/` and write what a stage produces next to them. The tests compare the port
with those files. To regenerate them you need a homr checkout at the pinned commit, its
models in place (homr downloads them on first run, or link the ones from `models/` into
`homr/segmentation/`, `homr/transformer/` and `homr/staff_relations/`) and the packages in
`tools/reference/requirements.txt`:

```sh
python -m venv .venv
.venv/bin/pip install -r tools/reference/requirements.txt
HOMR_DIR=../homr .venv/bin/python -I tools/reference/dump_reference.py test/fixtures/photo.png
HOMR_DIR=../homr .venv/bin/python -I tools/reference/dump_reference.py --full test/fixtures/piano.png
HOMR_DIR=../homr .venv/bin/python -I tools/reference/dump_units.py
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

## Port status

| Stage | homr source | Port | Checked against homr |
|---|---|---|---|
| Model loading | `onnx_providers.py`, configs | `src/models.ts` | all models load |
| Preprocessing (autocrop, resize, CLAHE) | `autocrop.py`, `resize.py`, `color_adjust.py` | `src/preprocess.ts`, `src/autocrop.ts`, `src/pil-resize.ts` | exact on `piano` and `photo` |
| Segmentation | `segmentation/inference_segnet.py` | `src/segmentation.ts` | exact on `piano` |
| Noise filtering, stronger staff lines | `noise_filtering.py`, `make_lines_stronger` | `src/noise-filtering.ts`, `src/predictions.ts` | exact on `piano` and a synthetic noisy mask |
| Symbols: boxes, noteheads with stems, bar lines | `bounding_boxes.py`, `bar_line_detection.py`, `note_detection.py`, `main.predict_symbols` | `src/bounding-boxes.ts`, `src/geometry.ts`, `src/symbols.ts` | exact on `piano`; polygon overlap on 3000 random pairs |
| Staff detection | `staff_detection.py` | `breakWideFragments` only | exact on `piano` |
| Staff dewarping and crops | `staff_dewarping.py`, `staff_parsing.py` | not yet | |
| Transformer (encoder, decoder) | `transformer/` | not yet | |
| Staff relations | `staff_relations.py` | not yet | |
| MusicXML output | `music_xml_generator.py` | not yet | |
| LilyPond output | none (new) | not yet | |
