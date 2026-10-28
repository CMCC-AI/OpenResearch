import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createGzip } from 'node:zlib'
import { validateProductVersion } from './product-version.mjs'

export async function prepareSourceRelease(root, output, revision) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  if (!/^[0-9a-f]{40}$/.test(revision) || git('rev-parse', 'HEAD') !== revision) throw Error('Release revision must equal HEAD')
  if (git('status', '--porcelain')) throw Error('Source release requires a clean checkout')
  const metadata = JSON.parse(await readFile(resolve(root, 'product-upstream.json'), 'utf8'))
  const cargo = await readFile(resolve(root, 'Cargo.toml'), 'utf8')
  const version = validateProductVersion(metadata, /^version = "([^"]+)"/m.exec(cargo)?.[1])
  if (!/^\d+\.\d+\.\d+-mobilesci\.\d+$/.test(version)) throw Error('Expected a MobileSci product version')
  const lock = await readFile(resolve(root, 'Cargo.lock'), 'utf8')
  if (!lock.includes(`name = "openresearch-cli"\nversion = "${version}"`)) throw Error('Cargo.lock version differs')
  const notes = await readFile(resolve(root, `release-notes/v${version}.md`), 'utf8')
  if (!notes.trim()) throw Error('Release notes are required')
  await mkdir(output, { recursive: true })
  const prefix = `MobileSci-${version}`
  const tar = resolve(output, `${prefix}.tar`)
  const tgz = `${prefix}.tar.gz`
  const zip = `${prefix}.zip`
  async function archive(format, path) {
    const file = await open(path, 'wx')
    let complete = false
    try {
      execFileSync('git', ['archive', `--format=${format}`, `--prefix=${prefix}/`, revision], { cwd: root, stdio: ['ignore', file.fd, 'pipe'] })
      complete = true
    } finally {
      await file.close()
      if (!complete) await rm(path, { force: true })
    }
  }
  let ownedTar = false
  try {
    await archive('tar', tar)
    ownedTar = true
    await pipeline(createReadStream(tar), createGzip({ level: 9 }), createWriteStream(resolve(output, tgz), { flags: 'wx' }))
  } finally { if (ownedTar) await rm(tar, { force: true }) }
  await archive('zip', resolve(output, zip))
  const manifest = { version, tag: `v${version}`, revision, format: 'source', artifacts: [tgz, zip] }
  await writeFile(resolve(output, 'source-release.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
  const sums = []
  for (const name of [tgz, zip, 'source-release.json']) {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(resolve(output, name))) hash.update(chunk)
    sums.push(`${hash.digest('hex')}  ${name}`)
  }
  await writeFile(resolve(output, 'SHA256SUMS'), `${sums.join('\n')}\n`, { flag: 'wx' })
  return manifest
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [output, revision] = process.argv.slice(2)
  if (!output || !revision) throw Error('Usage: node scripts/source-release.mjs <output-directory> <revision>')
  console.log(JSON.stringify(await prepareSourceRelease(resolve(dirname(fileURLToPath(import.meta.url)), '..'), resolve(output), revision)))
}
