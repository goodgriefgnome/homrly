"""
Makes test/fixtures/photo.png: a rendered page, slightly rotated, on a desk with uneven
light, like a photo of sheet music. Deterministic, so the fixture can be regenerated.

  python -I tools/reference/make_photo_fixture.py test/fixtures/piano.png test/fixtures/photo.png
"""

import sys

import cv2
import numpy as np


def main(page_path: str, out_path: str) -> None:
    page = cv2.imread(page_path)
    # Only the top of the page, where the music is, to keep the fixture small
    page = page[: page.shape[0] // 3]
    page = cv2.resize(page, None, fx=0.8, fy=0.8, interpolation=cv2.INTER_AREA)
    ph, pw = page.shape[:2]
    # Slightly warm paper
    page = np.clip(page.astype(np.float32) * np.array([0.88, 0.95, 1.0]), 0, 255)

    height, width = int(ph * 1.35), int(pw * 1.25)
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
    # A wooden desk: brown with soft stripes
    stripes = 12 * np.sin(yy / 9.0 + 3 * np.sin(xx / 70.0))
    desk = np.stack([60 + stripes, 95 + stripes, 140 + stripes], axis=2)

    center = (width / 2 + 10, height / 2 - 5)
    matrix = cv2.getRotationMatrix2D((pw / 2, ph / 2), 2.5, 1.0)
    matrix[:, 2] += (center[0] - pw / 2, center[1] - ph / 2)
    warped = cv2.warpAffine(page, matrix, (width, height), flags=cv2.INTER_LINEAR)
    mask = cv2.warpAffine(
        np.ones((ph, pw), np.float32), matrix, (width, height), flags=cv2.INTER_LINEAR
    )[:, :, None]
    image = warped * mask + desk * (1 - mask)

    # Light falling off towards the bottom right
    light = 1.0 - 0.25 * (xx / width + yy / height) / 2
    image = np.clip(image * light[:, :, None], 0, 255).astype(np.uint8)
    cv2.imwrite(out_path, image)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
