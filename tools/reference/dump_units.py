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


if __name__ == "__main__":
    noise()
    overlaps()
