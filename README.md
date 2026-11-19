# homrly

An in-browser port of [homr](https://github.com/liebharc/homr): optical music recognition that turns
images of sheet music into MusicXML and LilyPond, entirely client-side.

It runs homr's ONNX models with onnxruntime-web and reimplements homr's image processing and
score building in TypeScript with opencv.js. MusicXML and LilyPond are both written directly
from the recognized score, without a conversion step between them.

Status: early port, not usable yet. See DEVELOPMENT.md for what is ported so far.

## License

AGPL-3.0, as a derivative of homr. The models are homr's, from its `onnx_checkpoints` release.
