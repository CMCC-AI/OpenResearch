import assert from 'node:assert/strict'
import test from 'node:test'
import { parseArgs } from './hosted-local.mjs'

test('hosted-local parseArgs parses start, stop, status, and grant-admin options', () => {
  const start = parseArgs(['start', '--rebuild', '--no-open', '--with-quotas', '--port', '5405', '--capacity', '4', '--idle-seconds', '60'])
  assert.equal(start.command, 'start')
  assert.equal(start.rebuild, true)
  assert.equal(start.open, false)
  assert.equal(start.withQuotas, true)
  assert.equal(start.port, 5405)
  assert.equal(start.capacity, 4)
  assert.equal(start.idleSeconds, 60)

  const noQuotas = parseArgs(['start', '--no-quotas'])
  assert.equal(noQuotas.withQuotas, false)
  assert.equal(noQuotas.quotasFlag, false)

  const stop = parseArgs(['stop', '--clean'])
  assert.equal(stop.command, 'stop')
  assert.equal(stop.clean, true)

  const status = parseArgs(['status'])
  assert.equal(status.command, 'status')

  const grant = parseArgs(['grant-admin', 'admin@example.com'])
  assert.equal(grant.command, 'grant-admin')
  assert.equal(grant.email, 'admin@example.com')

  assert.throws(() => parseArgs(['unknown']))
  assert.throws(() => parseArgs(['grant-admin']))
  assert.throws(() => parseArgs(['start', '--port', '80']))
})
