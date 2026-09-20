// Read-only smoke checks against an isolated running OpenResearch + Deep Literature.
// No project creation, model calls, ingestion, or experiment execution.
import assert from 'node:assert/strict'

const base = new URL(process.env.ORX_TEST_URL || 'http://127.0.0.1:4901')
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
  throw new Error('Use an isolated loopback development instance')
}
async function request(path, expected = 200) {
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(15_000) })
  assert.equal(response.status, expected, `${path}: unexpected HTTP status`)
  return response.json()
}

const status = await request('/api/deep-literature/status')
assert.equal(status.connected, true, 'Start the development literature web service first')
const pages = []
for (const offset of [0, 18]) {
  const page = await request(`/api/deep-literature/papers?limit=18&offset=${offset}`)
  assert.equal(page.offset, offset)
  assert.equal(typeof page.hasMore, 'boolean')
  assert.equal(typeof page.total, 'number')
  assert.ok(page.papers.length <= 18)
  for (const paper of page.papers) {
    assert.equal(typeof paper.id, 'string')
    assert.equal(typeof paper.title, 'string')
    assert.ok(!('isLiked' in paper) && !('isBookmarked' in paper))
  }
  pages.push(page)
}
// Totals may change during ingestion; do not assume a static corpus between requests.
assert.ok(pages[0].total >= pages[0].papers.length)
await request(`/api/deep-literature/papers?q=${encodeURIComponent('脑')}`)
await request('/api/deep-literature/papers?offset=10001', 400)
await request('/api/deep-literature/papers?tab=invalid', 400)
await request(`/api/deep-literature/papers?q=${'x'.repeat(501)}`, 400)
await request('/api/papers/discover?q=x', 400)
console.log('Literature integration passed: connection, pagination, single-character search, privacy fields and input boundaries')
