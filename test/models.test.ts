import { describe, expect, it } from 'vitest'
import { MODELS, type ModelName } from '../src/models.js'
import { haveModels, localModels } from './helpers.js'

describe.skipIf(!haveModels)('models', () => {
  it('loads every model in onnxruntime-web', { timeout: 120_000 }, async () => {
    const models = localModels()
    try {
      for (const name of Object.keys(MODELS) as ModelName[]) {
        const session = await models.session(name)
        expect(session.inputNames.length).toBeGreaterThan(0)
      }
    } finally {
      await models.release()
    }
  })
})
