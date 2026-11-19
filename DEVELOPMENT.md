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
HOMR_DIR=../homr .venv/bin/python -I tools/reference/dump_segmentation.py test/fixtures/piano.png
```

homr's `main` module imports `rapidocr` for title detection, which homrly does not port.
The scripts import only the modules they need, so `rapidocr` is not required.

## Fixtures

`test/fixtures/*.ly` are original scores written for these tests, rendered to PNG at 150 DPI
with LilyPond 2.26.0.

## Port status

| Stage | homr source | Port | Checked against homr |
|---|---|---|---|
| Model loading | `onnx_providers.py`, configs | `src/models.ts` | all models load |
| Preprocessing (autocrop, resize, CLAHE) | `autocrop.py`, `resize.py`, `color_adjust.py` | not yet | |
| Segmentation | `segmentation/inference_segnet.py` | `src/segmentation.ts` | exact on `piano` |
| Noise filtering, staff and symbol detection | `noise_filtering.py`, `staff_detection.py`, `bounding_boxes.py`, ... | not yet | |
| Staff dewarping and crops | `staff_dewarping.py`, `staff_parsing.py` | not yet | |
| Transformer (encoder, decoder) | `transformer/` | not yet | |
| Staff relations | `staff_relations.py` | not yet | |
| MusicXML output | `music_xml_generator.py` | not yet | |
| LilyPond output | none (new) | not yet | |
