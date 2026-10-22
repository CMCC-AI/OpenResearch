import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { optionsFrom, setValues, valueOf } from './start-local.mjs'

test('local startup options resolve a companion checkout and reject unknown flags', () => {
  const options = optionsFrom(['--deeplit-dir', '/tmp/deeplit', '--no-open', '--with-workers'])
  assert.equal(options.deeplitDir, path.resolve('/tmp/deeplit'))
  assert.equal(options.open, false)
  assert.equal(options.withWorkers, true)
  assert.throws(() => optionsFrom(['--wrong']), /Unknown option/)
})

test('local env updates preserve unrelated values and replace a key once', () => {
  const updated = setValues('PLATFORM_DB_PASSWORD=kept\nOPENRESEARCH_APP_ORIGIN=http://localhost:5202\n', {
    OPENRESEARCH_APP_ORIGIN: 'http://localhost:4791',
    DEEPLIT_ORIGIN: 'http://localhost:3000',
  })
  assert.equal(valueOf(updated, 'PLATFORM_DB_PASSWORD'), 'kept')
  assert.equal(valueOf(updated, 'OPENRESEARCH_APP_ORIGIN'), 'http://localhost:4791')
  assert.equal(valueOf(updated, 'DEEPLIT_ORIGIN'), 'http://localhost:3000')
  assert.equal(updated.match(/OPENRESEARCH_APP_ORIGIN=/g)?.length, 1)
})
