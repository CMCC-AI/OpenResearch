import assert from 'node:assert/strict'

export function validateProductVersion(release, cargoVersion) {
  const productVersion = release.productVersion ?? release.version
  assert.equal(cargoVersion, productVersion, 'Cargo.toml and product-upstream.json product versions differ')
  assert.match(productVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  assert.equal(release.tag, `v${release.version}`)
  if (release.backportTarget) {
    assert.match(release.backportTarget.tag, /^v\d+\.\d+\.\d+$/)
    assert.match(release.backportTarget.commit, /^[0-9a-f]{40}$/)
    assert.equal(release.backportTarget.status, 'partial')
    assert.ok(productVersion.startsWith(`${release.backportTarget.tag.slice(1)}-`), 'Partial backports must use a product prerelease version')
  }
  return productVersion
}
