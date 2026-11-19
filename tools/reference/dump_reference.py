"""
Writes homr's reference outputs for test images, which the tests compare the port with:

  <name>.autocrop.json     where autocrop cropped the image
  <name>.preprocessed.png  the image segnet sees (autocrop, resize to 1920 wide, CLAHE)

and with --full, which also runs segnet and the following stages:

  <name>.segmentation.png  the class of every pixel (0-5, see SegmentationClass)
  <name>.staff.png         the staff mask after noise filtering and make_lines_stronger
  <name>.symbols.json      the symbols found on the page, see test/symbols.test.ts
  <name>.staffs.json       the staffs and the notes on them, see test/staffs.test.ts
  <name>.systems.json      the staff relations and the systems, see test/systems.test.ts
  <name>.staff-<i>.png     the image of each staff the transformer reads
  <name>.tokens.json       what the transformer reads on each staff, and the voices

Run it with homr's checkout and its models on the path, see DEVELOPMENT.md:

  HOMR_DIR=../homr python -I tools/reference/dump_reference.py [--full] IMAGE...
"""

import json
import os
import sys

sys.path.insert(0, os.environ["HOMR_DIR"])

import cv2  # noqa: E402
import numpy as np  # noqa: E402

from homr import color_adjust  # noqa: E402
from homr.autocrop import autocrop_with_offset  # noqa: E402
from homr.resize import resize_image  # noqa: E402


def rect(box) -> list:  # noqa: ANN001
    """A RotatedRect as JSON: [[cx, cy], [w, h], angle]."""
    return [[float(box[0][0]), float(box[0][1])], [float(box[1][0]), float(box[1][1])], float(box[2])]


def write_json(path: str, data: object) -> None:
    with open(path, "w") as f:
        json.dump(data, f)
        f.write("\n")


def preprocess(image_path: str, stem: str) -> tuple[np.ndarray, np.ndarray]:
    image = cv2.imread(image_path)
    cropped, (x, y) = autocrop_with_offset(image)
    write_json(
        stem + ".autocrop.json",
        {"x": x, "y": y, "width": cropped.shape[1], "height": cropped.shape[0]},
    )
    resized = resize_image(cropped)
    preprocessed = color_adjust.apply_clahe(resized)
    cv2.imwrite(stem + ".preprocessed.png", preprocessed)
    print(f"{stem}: {preprocessed.shape[1]}x{preprocessed.shape[0]}", file=sys.stderr)
    return resized, preprocessed


def full(image_path: str, stem: str, resized: np.ndarray, preprocessed: np.ndarray) -> None:
    from homr.bar_line_detection import detect_bar_lines  # noqa: PLC0415
    from homr.debug import Debug  # noqa: PLC0415
    from homr.bar_line_detection import prepare_bar_line_image  # noqa: PLC0415
    from homr.bounding_boxes import (  # noqa: PLC0415
        create_bounding_ellipses,
        create_rotated_bounding_boxes,
    )
    from homr.model import InputPredictions  # noqa: PLC0415
    from homr.noise_filtering import filter_predictions  # noqa: PLC0415
    from homr.note_detection import combine_noteheads_with_stems  # noqa: PLC0415
    from homr.segmentation.inference_segnet import inference  # noqa: PLC0415
    from homr.staff_detection import break_wide_fragments, make_lines_stronger  # noqa: PLC0415

    # The arguments homr's main.get_predictions uses, on the CPU
    staff, symbols, stems_rests, notehead, clefs_keys = inference(
        preprocessed, use_gpu_inference=False, batch_size=8, step_size=320, win_size=320
    )
    classes = (stems_rests * 1 + notehead * 2 + clefs_keys * 3 + staff * 4 + symbols * 5).astype(
        np.uint8
    )
    cv2.imwrite(stem + ".segmentation.png", classes)

    debug = Debug(resized, image_path, False)
    predictions = InputPredictions(
        resized, preprocessed, notehead, symbols, staff, clefs_keys, stems_rests
    )
    predictions = filter_predictions(predictions, debug)
    predictions.staff = make_lines_stronger(predictions.staff, (1, 2))
    cv2.imwrite(stem + ".staff.png", predictions.staff)

    # As main.predict_symbols, which can't be imported without homr's OCR dependency
    noteheads = create_bounding_ellipses(predictions.notehead, min_size=(4, 4))
    found_staff_fragments = create_rotated_bounding_boxes(
        predictions.staff, skip_merging=True, min_size=(5, 1), max_size=(10000, 100)
    )
    found_clefs_keys = create_rotated_bounding_boxes(
        predictions.clefs_keys, min_size=(20, 40), max_size=(1000, 1000)
    )
    stems_rest = create_rotated_bounding_boxes(predictions.stems_rest)
    bar_line_img = prepare_bar_line_image(predictions.stems_rest)
    found_bar_lines = create_rotated_bounding_boxes(bar_line_img, skip_merging=True, min_size=(1, 5))

    # As in main.detect_single_staffs
    staff_fragments = break_wide_fragments(found_staff_fragments)
    noteheads_with_stems = combine_noteheads_with_stems(noteheads, stems_rest)
    average_note_head_height = float(
        np.median([n.notehead.size[1] for n in noteheads_with_stems])
    )
    all_noteheads = [n.notehead for n in noteheads_with_stems]
    all_stems = [n.stem for n in noteheads_with_stems if n.stem is not None]
    bar_lines_or_rests = [
        line
        for line in found_bar_lines
        if not line.is_overlapping_with_any(all_noteheads)
        and not line.is_overlapping_with_any(all_stems)
    ]
    bar_line_boxes = detect_bar_lines(bar_lines_or_rests, average_note_head_height)
    write_json(
        stem + ".symbols.json",
        {
            "noteheads": [rect(b.box) for b in noteheads],
            "staff_fragments": [rect(b.box) for b in found_staff_fragments],
            "clefs_keys": [rect(b.box) for b in found_clefs_keys],
            "stems_rest": [rect(b.box) for b in stems_rest],
            "bar_lines": [rect(b.box) for b in found_bar_lines],
            "broken_staff_fragments": [rect(b.box) for b in staff_fragments],
            "noteheads_with_stems": [
                [
                    rect(n.notehead.box),
                    rect(n.stem.box) if n.stem is not None else None,
                    n.stem_direction.value if n.stem_direction is not None else None,
                ]
                for n in noteheads_with_stems
            ],
            "average_note_head_height": average_note_head_height,
            "bar_line_boxes": [rect(b.box) for b in bar_line_boxes],
        },
    )

    from homr.note_detection import add_notes_to_staffs  # noqa: PLC0415
    from homr.staff_detection import detect_staff  # noqa: PLC0415

    staffs = detect_staff(
        debug, predictions.staff, staff_fragments, found_clefs_keys, bar_line_boxes,
        predictions.symbols,
    )
    add_notes_to_staffs(staffs, noteheads_with_stems, predictions.symbols, predictions.notehead)
    write_json(stem + ".staffs.json", [staff_json(s) for s in staffs])

    # As main.group_staffs and the start of process_image
    from homr import staff_relations  # noqa: PLC0415
    from homr.system_repair import repair_systems  # noqa: PLC0415

    h_pairs = staff_relations.horizontal_pairs(staffs)
    joined = staff_relations.join_pieces_with_model(predictions, staffs)
    v_pairs, crops = staff_relations.page_inputs(predictions, joined)
    probabilities = staff_relations.get_model().predict(crops)
    systems = staff_relations.group_staffs(joined, v_pairs, probabilities)
    repaired = repair_systems(debug, systems)
    write_json(
        stem + ".systems.json",
        {
            "horizontal_pairs": [list(p) for p in h_pairs],
            "joined": [staff_json(s) for s in joined],
            "vertical_pairs": [list(p) for p in v_pairs],
            "probabilities": probabilities.tolist(),
            "systems": [system_json(m) for m in systems],
            "repaired": [system_json(m) for m in repaired],
        },
    )

    # As main.process_image: the staff images and what the transformer reads on them
    from homr.staff_parsing import parse_staffs, prepare_staff_image  # noqa: PLC0415
    from homr.staff_regions import StaffRegions  # noqa: PLC0415
    from homr.transformer.configs import Config  # noqa: PLC0415
    from homr.transformer.staff2score import Staff2Score  # noqa: PLC0415

    config = Config()
    config.use_gpu_inference = False
    image = predictions.preprocessed
    regions = StaffRegions(repaired)
    staff2score = Staff2Score(config)
    staff_tokens = []
    for i, staff in enumerate(s for row in repaired for s in row.staffs):
        staff_image, _, _ = prepare_staff_image(debug, i, staff, image, regions)
        cv2.imwrite(f"{stem}.staff-{i}.png", staff_image)
        staff_tokens.append([str(symbol) for symbol in staff2score.predict(staff_image)])
    voices = parse_staffs(debug, repaired, image, config)
    write_json(
        stem + ".tokens.json",
        {"staffs": staff_tokens, "voices": [[str(s) for s in voice] for voice in voices]},
    )


def system_json(multi_staff) -> dict:  # noqa: ANN001
    return {
        "certain": multi_staff.certain,
        "staffs": [
            {
                "is_grandstaff": s.is_grandstaff,
                "grid": [[float(p.x), [float(y) for y in p.y], float(p.angle)] for p in s.grid],
                "notes": len(s.get_notes()),
            }
            for s in multi_staff.staffs
        ],
    }


def staff_json(staff) -> dict:  # noqa: ANN001
    return {
        "grid": [[float(p.x), [float(y) for y in p.y], float(p.angle)] for p in staff.grid],
        "average_unit_size": float(staff.average_unit_size),
        "notes": [
            [
                rect(n.box.box),
                int(n.position),
                rect(n.stem.box) if n.stem is not None else None,
                n.stem_direction.value if n.stem_direction is not None else None,
            ]
            for n in staff.get_notes()
        ],
    }


if __name__ == "__main__":
    args = sys.argv[1:]
    with_full = "--full" in args
    for path in [a for a in args if a != "--full"]:
        stem = os.path.splitext(path)[0]
        resized, preprocessed = preprocess(path, stem)
        if with_full:
            full(path, stem, resized, preprocessed)
