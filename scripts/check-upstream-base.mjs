#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const release = JSON.parse(readFileSync(path.join(root, 'product-upstream.json'), 'utf8'))
const cargo = readFileSync(path.join(root, 'Cargo.toml'), 'utf8')
const updates = readFileSync(path.join(root, 'src/updates.rs'), 'utf8')
const version = /^version = "([^"]+)"/m.exec(cargo)?.[1]

assert.match(release.tag, /^v\d+\.\d+\.\d+$/)
assert.match(release.commit, /^[0-9a-f]{40}$/)
assert.equal(version, release.version, 'Cargo.toml and product-upstream.json versions differ')
assert.equal(release.tag, `v${version}`)
assert.equal(release.updateChannel, 'product-disabled')
assert.match(updates, /pub const OFFICIAL_UPDATE_CHANNEL_ENABLED: bool = false;/)

const exists = spawnSync('git', ['cat-file', '-e', `${release.commit}^{commit}`], { cwd: root })
assert.equal(exists.status, 0, 'Upstream base commit is missing; checkout the full Git history')
const mergedHead = spawnSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: root, encoding: 'utf8' })
const candidates = ['HEAD', ...(mergedHead.status === 0 ? [mergedHead.stdout.trim()] : [])]
const included = candidates.some((candidate) =>
  spawnSync('git', ['merge-base', '--is-ancestor', release.commit, candidate], { cwd: root }).status === 0)
assert.ok(included, 'Upstream base commit is not part of this product branch')

console.log(`Upstream base verified: ${release.tag} (${release.commit.slice(0, 7)}); official updater disabled`)
