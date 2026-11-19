"""
Writes reference outputs of single homr functions on synthetic inputs to
test/fixtures/units/, for cases the test pages do not reach (e.g. noise filtering).

  HOMR_DIR=../homr python -I tools/reference/dump_units.py
"""

import os
import sys

sys.path.insert(0, os.environ["HOMR_DIR"])

import cv2  # noqa: E402
import numpy as np  # noqa: E402

from homr.debug import Debug  # noqa: E402
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


if __name__ == "__main__":
    noise()
