#!/usr/bin/env bash
# Builds vendor/opencv/opencv.mjs: OpenCV 5.0.0 with only what homrly uses (see whitelist.json),
# with the same settings as the full opencv.js build homrly used before (@techstark/opencv-js
# 5.0.0): WebAssembly in a single file, without SIMD and threads, so the results are the same.
#
#   EMSDK=/path/to/emsdk tools/opencv/build.sh [work directory]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="${1:-$here/../../.opencv-build}"
: "${EMSDK:?Set EMSDK to an emsdk checkout}"
source "$EMSDK/emsdk_env.sh" >/dev/null
mkdir -p "$work"
if [ ! -d "$work/opencv" ]; then
  git clone --depth 1 --branch 5.0.0 https://github.com/opencv/opencv.git "$work/opencv"
fi
cd "$work/opencv"
# The bindings use cv::segmentation unconditionally, which only exists in the bindings when
# something of it is exported
sed -i 's|^using namespace cv::segmentation;  // FIXIT$|// homrly: cv::segmentation is not exported|' modules/js/src/core_bindings.cpp
emcmake python3 platforms/js/build_js.py "$work/build" --build_wasm \
  --config "$here/whitelist.json" \
  -DBUILD_LIST=core,imgproc,geometry,js \
  -DBUILD_TESTS=OFF -DBUILD_PERF_TESTS=OFF -DBUILD_EXAMPLES=OFF
mkdir -p "$here/../../vendor/opencv"
node "$here/to-esm.mjs" "$work/build/bin/opencv.js" "$here/../../vendor/opencv/opencv.mjs"
echo "Wrote vendor/opencv/opencv.mjs"
