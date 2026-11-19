"""
Writes homr's segmentation reference for a test image, for test/segmentation.test.ts:

  <name>.preprocessed.png  the image segnet sees (autocrop, resize to 1920 wide, CLAHE)
  <name>.segmentation.png  the class of every pixel (0-5, see SegmentationClass)

Run it with homr's checkout and its models on the path, see DEVELOPMENT.md:

  HOMR_DIR=../homr python -I tools/reference/dump_segmentation.py test/fixtures/piano.png
"""

import os
import sys

sys.path.insert(0, os.environ["HOMR_DIR"])

import cv2  # noqa: E402
import numpy as np  # noqa: E402

from homr import color_adjust  # noqa: E402
from homr.autocrop import autocrop_with_offset  # noqa: E402
from homr.resize import resize_image  # noqa: E402
from homr.segmentation.inference_segnet import inference  # noqa: E402


def main(image_path: str) -> None:
    image = cv2.imread(image_path)
    image, _ = autocrop_with_offset(image)
    image = resize_image(image)
    preprocessed = color_adjust.apply_clahe(image)
    # The arguments homr's main.get_predictions uses, on the CPU
    staff, symbols, stems_rests, notehead, clefs_keys = inference(
        preprocessed, use_gpu_inference=False, batch_size=8, step_size=320, win_size=320
    )
    classes = (
        stems_rests * 1 + notehead * 2 + clefs_keys * 3 + staff * 4 + symbols * 5
    ).astype(np.uint8)
    stem = os.path.splitext(image_path)[0]
    cv2.imwrite(stem + ".preprocessed.png", preprocessed)
    cv2.imwrite(stem + ".segmentation.png", classes)
    print(f"{stem}: {preprocessed.shape[1]}x{preprocessed.shape[0]}", file=sys.stderr)


if __name__ == "__main__":
    for path in sys.argv[1:]:
        main(path)
