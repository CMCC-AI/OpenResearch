import assert from 'node:assert/strict'
import test from 'node:test'
import { validateProductVersion } from './product-version.mjs'

const base = { tag: 'v0.2.19', version: '0.2.19' }
const product = { ...base, productVersion: '0.2.21-mobilesci.1', backportTarget: {
  tag: 'v0.2.21', commit: '5af82bb531a731698afc6e8e46f3e5157e20210b', status: 'partial',
} }

test('legacy versions and partial product versions retain their actual upstream base', () => {
  assert.equal(validateProductVersion(base, '0.2.19'), '0.2.19')
  assert.equal(validateProductVersion(product, '0.2.21-mobilesci.1'), '0.2.21-mobilesci.1')
  assert.equal(product.tag, 'v0.2.19')
})

test('reject inconsistent versions and claims of complete upstream adoption', () => {
  for (const [metadata, cargo] of [
    [product, '0.2.19'],
    [{ ...product, tag: 'v0.2.21' }, product.productVersion],
    [{ ...product, productVersion: '0.2.21' }, '0.2.21'],
    [{ ...product, backportTarget: { ...product.backportTarget, commit: 'main' } }, product.productVersion],
    [{ ...product, backportTarget: { ...product.backportTarget, status: 'complete' } }, product.productVersion],
  ]) assert.throws(() => validateProductVersion(metadata, cargo))
})
