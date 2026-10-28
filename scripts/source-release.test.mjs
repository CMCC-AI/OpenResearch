import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { prepareSourceRelease } from './source-release.mjs'

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'mobilesci-source-release-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'repo')
  await mkdir(join(root, 'release-notes'), { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '-q')
  const version = '0.2.22-mobilesci.1'
  await writeFile(join(root, 'Cargo.toml'), `[package]\nname = "openresearch-cli"\nversion = "${version}"\n`)
  await writeFile(join(root, 'Cargo.lock'), `[[package]]\nname = "openresearch-cli"\nversion = "${version}"\n`)
  await writeFile(join(root, 'product-upstream.json'), JSON.stringify({ tag: 'v0.2.19', version: '0.2.19', productVersion: version }))
  await writeFile(join(root, `release-notes/v${version}.md`), '# Release\n材料阅读与可靠投递\n')
  git('add', '.')
  git('-c', 'user.name=Release Test', '-c', 'user.email=release-test@example.invalid', 'commit', '-qm', 'fixture')
  return { base, root, version, revision: git('rev-parse', 'HEAD') }
}

test('source archives and checksums bind the exact clean revision and are reproducible', async t => {
  const { base, root, version, revision } = await fixture(t)
  const first = join(base, 'first'), second = join(base, 'second')
  const manifest = await prepareSourceRelease(root, first, revision)
  await prepareSourceRelease(root, second, revision)
  assert.equal(manifest.revision, revision)
  assert.equal(manifest.tag, `v${version}`)
  for (const name of [...manifest.artifacts, 'source-release.json', 'SHA256SUMS']) {
    assert.deepEqual(await readFile(join(first, name)), await readFile(join(second, name)))
  }
  const tar = gunzipSync(await readFile(join(first, manifest.artifacts[0])))
  assert.ok(tar.includes(Buffer.from(`MobileSci-${version}/Cargo.toml`)))
  assert.ok(tar.includes(Buffer.from('材料阅读与可靠投递')))
  const sums = (await readFile(join(first, 'SHA256SUMS'), 'utf8')).trim().split('\n')
  for (const row of sums) {
    const [hash, name] = row.split('  ')
    assert.equal(createHash('sha256').update(await readFile(join(first, name))).digest('hex'), hash)
  }
})

test('dirty or mismatched candidates and reused output files cannot be released', async t => {
  const { base, root, version, revision } = await fixture(t)
  await assert.rejects(prepareSourceRelease(root, join(base, 'bad'), '0'.repeat(40)), /revision/)
  await writeFile(join(root, 'uncommitted'), 'draft')
  await assert.rejects(prepareSourceRelease(root, join(base, 'dirty'), revision), /clean/)
  await rm(join(root, 'uncommitted'))
  const output = join(base, 'existing')
  await mkdir(output)
  const path = join(output, `MobileSci-${version}.tar`)
  await writeFile(path, 'preserve existing data')
  await assert.rejects(prepareSourceRelease(root, output, revision), /EEXIST/)
  assert.equal(await readFile(path, 'utf8'), 'preserve existing data')
})
