"""
Writes homr's reference outputs for test images, which the tests compare the port with:

  <name>.autocrop.json     where autocrop cropped the image
  <name>.preprocessed.png  the image segnet sees (autocrop, resize to 1920 wide, CLAHE)
  <name>.segmentation.png  with --segmentation: the class of every pixel (0-5, see
                           SegmentationClass)
  <name>.staff.png         with --segmentation: the staff mask after noise filtering and
                           make_lines_stronger

Run it with homr's checkout and its models on the path, see DEVELOPMENT.md:

  HOMR_DIR=../homr python -I tools/reference/dump_reference.py [--segmentation] IMAGE...
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


def main(image_path: str, segmentation: bool) -> None:
    stem = os.path.splitext(image_path)[0]
    image = cv2.imread(image_path)
    cropped, (x, y) = autocrop_with_offset(image)
    with open(stem + ".autocrop.json", "w") as f:
        json.dump(
            {"x": x, "y": y, "width": cropped.shape[1], "height": cropped.shape[0]}, f
        )
        f.write("\n")
    resized = resize_image(cropped)
    preprocessed = color_adjust.apply_clahe(resized)
    cv2.imwrite(stem + ".preprocessed.png", preprocessed)
    print(f"{stem}: {preprocessed.shape[1]}x{preprocessed.shape[0]}", file=sys.stderr)

    if segmentation:
        from homr.segmentation.inference_segnet import inference  # noqa: PLC0415

        # The arguments homr's main.get_predictions uses, on the CPU
        staff, symbols, stems_rests, notehead, clefs_keys = inference(
            preprocessed, use_gpu_inference=False, batch_size=8, step_size=320, win_size=320
        )
        classes = (
            stems_rests * 1 + notehead * 2 + clefs_keys * 3 + staff * 4 + symbols * 5
        ).astype(np.uint8)
        cv2.imwrite(stem + ".segmentation.png", classes)

        from homr.debug import Debug  # noqa: PLC0415
        from homr.model import InputPredictions  # noqa: PLC0415
        from homr.noise_filtering import filter_predictions  # noqa: PLC0415
        from homr.staff_detection import make_lines_stronger  # noqa: PLC0415

        predictions = InputPredictions(
            resized, preprocessed, notehead, symbols, staff, clefs_keys, stems_rests
        )
        predictions = filter_predictions(predictions, Debug(resized, image_path, False))
        cv2.imwrite(stem + ".staff.png", make_lines_stronger(predictions.staff, (1, 2)))


if __name__ == "__main__":
    args = sys.argv[1:]
    with_segmentation = "--segmentation" in args
    for path in [a for a in args if a != "--segmentation"]:
        main(path, with_segmentation)
