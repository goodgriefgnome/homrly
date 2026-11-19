/**
 * homr's ONNX models, as published in its `onnx_checkpoints` release, unzipped.
 * The hashes are SHA-256 of the `.onnx` files.
 */
export const MODELS = {
  segnet: {
    file: 'segnet_308-3296ccd40960f90ca6ab9c035cca945675d30a0f.onnx',
    sha256: '6ed36640db4ef5d223098b6d5efe4eda97c66b24a2c72faab8a018c749003a8d',
  },
  encoder: {
    file: 'encoder_pytorch_model_566-ccd1cb311c368b5711dd238d2464c615397a3f2b.onnx',
    sha256: 'ab4135c1ad65883bf9a63f19cb600911d69f3ef5e8cb9deaccfa562b326db38c',
  },
  decoder: {
    file: 'decoder_pytorch_model_566-ccd1cb311c368b5711dd238d2464c615397a3f2b.onnx',
    sha256: 'c6075364b02bd2cc7b47e428d518fa5c5e84412ae62bf38542ea4e567afbed47',
  },
  staffRelations: {
    file: 'staff_relations_pdmx2-cc40992a36690003f7ed2bebe197016f19242fa6.onnx',
    sha256: '893336b40287303b335b3c9ff9c678316e6f00d95e87973fe12cd0e4d0b2a582',
  },
  staffPieces: {
    file: 'staff_pieces_h1-165e413e0edb2d8d2486e2bface8f345e6641ec9.onnx',
    sha256: '24c77f647cb0f8f01480089c2f43648c7aead76e75d0ab26667445f3e2fd3f65',
  },
} as const
