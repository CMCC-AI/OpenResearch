import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { prepareSourceRelease, canonicalGzipHeader } from './source-release.mjs'
import { Readable } from 'node:stream'

async function fixture(t, version = '0.2.22-mobilesci.1') {
  const base = await mkdtemp(join(tmpdir(), 'mobilesci-source-release-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'repo')
  await mkdir(join(root, 'release-notes'), { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '-q')
  await writeFile(join(root, 'Cargo.toml'), `[package]\nname = "openresearch-cli"\nversion = "${version}"\n`)
  await writeFile(join(root, 'Cargo.lock'), `[[package]]\nname = "openresearch-cli"\nversion = "${version}"\n`)
  await writeFile(join(root, 'product-upstream.json'), JSON.stringify({
    repository: 'https://github.com/alphaXiv/OpenResearch', tag: 'v0.2.19', commit: '1'.repeat(40), version: '0.2.19', productVersion: version,
    backportTarget: { tag: 'v0.2.22', commit: '2'.repeat(40), status: 'partial' },
    backportLedger: 'docs/backports.md',
  }))
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
  assert.deepEqual(manifest.upstreamBase, { repository: 'https://github.com/alphaXiv/OpenResearch', tag: 'v0.2.19', commit: '1'.repeat(40) })
  assert.deepEqual(manifest.backportTarget, { tag: 'v0.2.22', commit: '2'.repeat(40), status: 'partial' })
  assert.equal(manifest.backportLedger, 'docs/backports.md')
  for (const name of [...manifest.artifacts, 'source-release.json', 'SHA256SUMS']) {
    assert.deepEqual(await readFile(join(first, name)), await readFile(join(second, name)))
  }
  const gzip = await readFile(join(first, manifest.artifacts[0]))
  assert.equal(gzip[9], 255, 'gzip must not encode the producer OS')
  const tar = gunzipSync(gzip)
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


test('source archives are byte-identical across caller timezones', async t => {
  const { base, root, revision } = await fixture(t)
  const script = new URL('./source-release.mjs', import.meta.url).href
  for (const [name, timezone] of [['utc', 'UTC'], ['shanghai', 'Asia/Shanghai']]) {
    execFileSync(process.execPath, ['--input-type=module', '-e', 'const {prepareSourceRelease}=await import(process.argv[1]); await prepareSourceRelease(...process.argv.slice(2))', script, root, join(base, name), revision], { env: { ...process.env, TZ: timezone } })
  }
  const manifest = JSON.parse(await readFile(join(base, 'utc', 'source-release.json'), 'utf8'))
  for (const name of [...manifest.artifacts, 'source-release.json', 'SHA256SUMS']) {
    assert.deepEqual(await readFile(join(base, 'utc', name)), await readFile(join(base, 'shanghai', name)), name)
  }
})


test('gzip producer OS metadata is normalized even across split headers', async () => {
  const fixture = Buffer.from('1f8b080000000000021300', 'hex')
  const normalize = async bytes => {
    const chunks = []
    for await (const chunk of Readable.from([bytes.subarray(0, 9), bytes.subarray(9, 10), bytes.subarray(10)]).pipe(canonicalGzipHeader())) chunks.push(chunk)
    return Buffer.concat(chunks)
  }
  const mac = await normalize(fixture)
  const linux = Buffer.from(fixture); linux[9] = 3
  assert.deepEqual(mac, await normalize(linux))
  assert.equal(mac[9], 255)
  assert.deepEqual(mac.subarray(10), fixture.subarray(10))
  await assert.rejects(async () => { for await (const _ of Readable.from([Buffer.from('short')]).pipe(canonicalGzipHeader())) {} }, /Truncated/)
})


test('numeric product hotfix versions produce archives while unsupported suffixes stay rejected', async t => {
  const { base, root, version, revision } = await fixture(t, '0.2.22-mobilesci.1.1')
  const manifest = await prepareSourceRelease(root, join(base, 'hotfix'), revision)
  assert.equal(manifest.version, version)
  assert.equal(manifest.tag, `v${version}`)
  const tar = gunzipSync(await readFile(join(base, 'hotfix', manifest.artifacts[0])))
  assert.ok(tar.includes(Buffer.from(`MobileSci-${version}/Cargo.toml`)))
  for (const invalid of ['0.2.22-mobilesci.1.fix', '0.2.22-mobilesci.1.1.1']) {
    const fixtureInvalid = await fixture(t, invalid)
    await assert.rejects(prepareSourceRelease(fixtureInvalid.root, join(fixtureInvalid.base, 'invalid'), fixtureInvalid.revision), /Expected a MobileSci product version/)
  }
})
