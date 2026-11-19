"""
Writes reference outputs of single homr functions on synthetic inputs to
test/fixtures/units/, for cases the test pages do not reach (e.g. noise filtering).

  HOMR_DIR=../homr python -I tools/reference/dump_units.py
"""

import json
import os
import sys

sys.path.insert(0, os.environ["HOMR_DIR"])

import cv2  # noqa: E402
import numpy as np  # noqa: E402

from homr.debug import Debug  # noqa: E402
from homr.bounding_boxes import do_polygons_overlap  # noqa: E402
from homr.noise_filtering import create_noise_grid  # noqa: E402

out = os.path.join(os.path.dirname(__file__), "..", "..", "test", "fixtures", "units")


def noise() -> None:
    rng = np.random.default_rng(7)
    staff = np.zeros((400, 600), np.uint8)
    for y in range(40, 400, 60):
        for line in range(5):
            staff[y + line * 8, 20:580] = 1
    # A patch of speckles, like a textured background predicted as staff
    staff[230:330, 350:520] = rng.random((100, 170)) < 0.4
    debug = Debug(np.zeros((400, 600, 3), np.uint8), "unused.png", False)
    mask = create_noise_grid(255 * staff, debug)
    cv2.imwrite(os.path.join(out, "noise.input.png"), staff)
    cv2.imwrite(os.path.join(out, "noise.mask.png"), mask if mask is not None else np.zeros(0))


def overlaps() -> None:
    """Pairs of nearby polygons as homr builds them, and whether homr sees them overlap."""
    rng = np.random.default_rng(11)
    cases = []
    for _ in range(3000):
        polygons = []
        for _ in range(2):
            center = (float(rng.uniform(0, 40)), float(rng.uniform(0, 40)))
            size = (float(rng.uniform(0.5, 30)), float(rng.uniform(0.5, 30)))
            if rng.random() < 0.3:
                # Thin like stems and staff lines
                size = (size[0], float(rng.uniform(0.2, 2)))
            angle = float(rng.uniform(-90, 90))
            if rng.random() < 0.5:
                poly = cv2.boxPoints((center, size, angle)).astype(np.int64)
            else:
                poly = cv2.ellipse2Poly(
                    (int(center[0]), int(center[1])),
                    (int(size[0] / 2), int(size[1] / 2)),
                    int(angle),
                    0,
                    360,
                    1,
                )
            polygons.append(poly)
        cases.append(
            [
                polygons[0].flatten().tolist(),
                polygons[1].flatten().tolist(),
                bool(do_polygons_overlap(polygons[0], polygons[1])),
            ]
        )
    with open(os.path.join(out, "overlaps.json"), "w") as f:
        json.dump(cases, f)
        f.write("\n")


def _staff(y0: float, unit: float, grand: bool, x0: int, x1: int):  # noqa: ANN202
    from homr.model import Staff, StaffPoint  # noqa: PLC0415

    gap = 9 * unit
    ys = [y0 + k * unit for k in range(5)]
    if grand:
        ys += [y0 + 4 * unit + gap + k * unit for k in range(5)]
    staff = Staff([StaffPoint(float(x), list(ys), 0.0) for x in range(x0, x1, 10)])
    staff.is_grandstaff = grand
    return staff


def _staff_json(staff) -> dict:  # noqa: ANN001
    """The synthetic staffs have the same lines at every x, so x range and lines suffice."""
    assert all(p.y == staff.grid[0].y for p in staff.grid)
    return {
        "is_grandstaff": staff.is_grandstaff,
        "x": [staff.grid[0].x, staff.grid[-1].x, len(staff.grid)],
        "y": list(staff.grid[0].y),
    }


def systems() -> None:
    """Random pages of single and grand staffs, grouped into systems, and homr's repair."""
    from homr.model import MultiStaff  # noqa: PLC0415
    from homr.system_repair import repair_systems  # noqa: PLC0415

    rng = np.random.default_rng(5)
    cases = []
    for _ in range(300):
        unit = float(rng.choice([12.0, 15.0, 16.5]))
        period = [bool(g) for g in rng.random(int(rng.integers(1, 4))) < 0.5]
        count = int(rng.integers(2, 9))
        layout = [period[i % len(period)] for i in range(count)]
        # Occasionally a brace is missed or a staff doesn't fit the pattern
        layout = [(not g) if rng.random() < 0.1 else g for g in layout]
        staffs = []
        y = 100.0
        for grand in layout:
            # Grand staffs which lost their brace are two single staffs close together
            if grand and rng.random() < 0.2:
                staffs.append(_staff(y, unit, False, 100, 1500))
                y += 13 * unit
                staffs.append(_staff(y, unit, False, 100, 1500))
                y += 4 * unit + float(rng.uniform(6, 12)) * unit
            else:
                staffs.append(_staff(y, unit, grand, 100, 1500))
                y += (18 if grand else 4) * unit + float(rng.uniform(6, 12)) * unit
        systems = []
        i = 0
        while i < len(staffs):
            size = int(rng.integers(1, 4))
            group = staffs[i : i + size]
            systems.append(MultiStaff(group, [], certain=bool(rng.random() < 0.3) and len(group) > 1))
            i += size
        before = [
            {"certain": m.certain, "staffs": [_staff_json(s) for s in m.staffs]} for m in systems
        ]
        debug = Debug(np.zeros((10, 10, 3), np.uint8), "unused.png", False)
        try:
            after = [[_staff_json(s) for s in m.staffs] for m in repair_systems(debug, systems)]
        except Exception as e:  # noqa: BLE001
            after = {"error": type(e).__name__}
        cases.append({"systems": before, "repaired": after})
    with open(os.path.join(out, "systems.json"), "w") as f:
        json.dump(cases, f)
        f.write("\n")


def staff_pieces() -> None:
    """
    The staffs of the piano page cut in two with a gap, and homr's horizontal relations
    model on them: does it join the pieces again?
    """
    from homr import staff_relations  # noqa: PLC0415
    from homr.model import InputPredictions, Staff, StaffPoint  # noqa: PLC0415

    fixtures = os.path.join(out, "..")
    pre = cv2.imread(os.path.join(fixtures, "piano.preprocessed.png"), 0)
    classes = cv2.imread(os.path.join(fixtures, "piano.segmentation.png"), 0)
    staff_mask = cv2.imread(os.path.join(fixtures, "piano.staff.png"), 0)

    def mask(k: int) -> np.ndarray:
        return (classes == k).astype(np.uint8)

    predictions = InputPredictions(None, pre, mask(2), mask(5), staff_mask, mask(3), mask(1))
    with open(os.path.join(fixtures, "piano.staffs.json")) as f:
        reference = json.load(f)
    pieces = []
    for staff in reference:
        grid = [StaffPoint(x, ys, angle) for x, ys, angle in staff["grid"]]
        middle = len(grid) // 2
        pieces.append(Staff(grid[: middle - 3]))
        pieces.append(Staff(grid[middle + 3 :]))
    pairs = staff_relations.horizontal_pairs(pieces)
    unit = float(np.median([s.average_unit_size for s in pieces]))
    page, scale = staff_relations.page_channels(predictions, unit)
    crops, feats = staff_relations.horizontal_inputs(page, scale, pieces, pairs)
    probabilities = staff_relations.get_model(staff_relations.horizontal_model_path).predict(
        crops, feats
    )
    joined = staff_relations.join_staff_pieces(pieces, pairs, probabilities)
    with open(os.path.join(out, "staff_pieces.json"), "w") as f:
        json.dump(
            {
                "pieces": [
                    [[p.x, list(p.y), p.angle] for p in s.grid] for s in pieces
                ],
                "pairs": [list(p) for p in pairs],
                "features": feats.tolist(),
                "crop_sums": [float(c.astype(np.float64).sum()) for c in crops],
                "probabilities": probabilities.tolist(),
                "joined": [[p.x for p in s.grid] for s in joined],
            },
            f,
        )
        f.write("\n")


def subdivisions() -> None:
    """Point sets like the dewarping's, and the triangles of OpenCV's Subdiv2D for them."""
    rng = np.random.default_rng(2)
    cases = []
    for k in range(200):
        kind = k % 4
        if kind == 0:  # random points
            pts = rng.uniform(0, 500, (int(rng.integers(3, 40)), 2)).round(1)
        elif kind == 1:  # a grid of lines like the dewarping's, many cocircular points
            xs = np.arange(0, 1200, 80)
            ys = np.arange(2, 200, 40)
            pts = np.array(
                [[x, y + int(rng.integers(-3, 4))] for y in ys for x in xs], dtype=float
            )
        elif kind == 2:  # an exact grid, every point twice  # noqa: PLR2004
            pts = np.array(
                [[x, y] for y in range(0, 100, 20) for x in range(0, 100, 25)] * 2, dtype=float
            )
        else:  # a row of points between corners
            pts = np.array(
                [[x, 50] for x in range(0, 300, 30)] + [[0, 0], [300, 0], [0, 100], [300, 100]],
                dtype=float,
            )
        p32 = pts.astype(np.float32)
        rect = cv2.boundingRect(p32.reshape(-1, 1, 2))
        rect = (rect[0] - 10, rect[1] - 10, rect[2] + 20, rect[3] + 20)
        subdiv = cv2.Subdiv2D(rect)
        for p in p32:
            subdiv.insert((float(p[0]), float(p[1])))
        cases.append(
            {
                "rect": list(rect),
                "points": p32.tolist(),
                "triangles": subdiv.getTriangleList().tolist(),
            }
        )
    with open(os.path.join(out, "subdiv.json"), "w") as f:
        json.dump(cases, f)
        f.write("\n")


def voices() -> None:
    """
    Random token streams of a voice, and homr's clean-up of them: remove_duplicated_symbols
    and restore_unmarked_triplets.
    """
    from homr.transformer.vocabulary import EncodedSymbol, remove_duplicated_symbols  # noqa: PLC0415
    from homr.triplet_restoration import restore_unmarked_triplets  # noqa: PLC0415

    rng = np.random.default_rng(9)
    pitches = ["C4", "D4", "E4", "F4", "G4", "A4", "B4", "C5", "D5", "E5"]

    def note(rhythm: str, position: str) -> EncodedSymbol:
        pitch = str(rng.choice(pitches)) if rhythm.startswith("note") else "_"
        return EncodedSymbol(rhythm, pitch, "_", "_", "_", position)

    cases = []
    for _ in range(300):
        tokens = []
        if rng.random() < 0.8:
            tokens += [EncodedSymbol("clef_G2", "_", "_", "_", "_", "upper")]
        if rng.random() < 0.5:
            tokens += [EncodedSymbol("chord"), EncodedSymbol("clef_F4", "_", "_", "_", "_", "lower")]
        tokens += [EncodedSymbol("keySignature_1"), EncodedSymbol("timeSignature/4")]
        for _measure in range(int(rng.integers(1, 7))):
            kind = rng.random()
            if kind < 0.35:
                # Triplet eighths read as plain eighths against quarters in the lower voice
                for _beat in range(3):
                    tokens += [note("note_8", "upper"), EncodedSymbol("chord"), note("note_4", "lower")]
                    tokens += [note("note_8", "upper"), note("note_8", "upper")]
            elif kind < 0.6:
                for _beat in range(3):
                    tokens += [note(str(rng.choice(["note_4", "rest_4", "note_12"])), "upper")]
                    if rng.random() < 0.5:
                        tokens += [EncodedSymbol("chord"), note("note_4", "upper")]
            elif kind < 0.8:
                # A chord with a repeated pitch, and repeated clefs and keys
                tokens += [EncodedSymbol("clef_G2", "_", "_", "_", "_", "upper")]
                tokens += [EncodedSymbol("keySignature_1")]
                tokens += [note("note_2.", "upper"), EncodedSymbol("chord"), note("note_2.", "lower")]
            else:
                tokens += [note(str(rng.choice(["note_8", "note_16", "note_4", "note_24"])), "upper")
                           for _ in range(int(rng.integers(2, 8)))]
            tokens += [EncodedSymbol(str(rng.choice(["barline", "barline", "repeatEnd"])))]
            if rng.random() < 0.15:
                tokens += [EncodedSymbol("newline")]
        cleaned = remove_duplicated_symbols(tokens)
        cases.append(
            {
                "tokens": [str(t) for t in tokens],
                "cleaned": [str(t) for t in cleaned],
                "restored": [str(t) for t in restore_unmarked_triplets(cleaned)],
            }
        )
    with open(os.path.join(out, "voices.json"), "w") as f:
        json.dump(cases, f)
        f.write("\n")


if __name__ == "__main__":
    voices()
    subdivisions()
    noise()
    overlaps()
    systems()
    staff_pieces()
