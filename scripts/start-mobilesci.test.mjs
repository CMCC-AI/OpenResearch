import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { optionsFrom, workspaceIsHealthy, sourceIsNewer, composeFiles } from './start-mobilesci.mjs'

test('startup options reject unknown arguments and resolve companion paths', () => {
  assert.equal(optionsFrom(['--rebuild', '--deeplit-dir', '/tmp/literature']).rebuild, true)
  assert.equal(optionsFrom(['--deeplit-dir', '/tmp/literature']).literatureDir, path.resolve('/tmp/literature'))
  assert.throws(() => optionsFrom(['--deeplit-dir']), /未知参数/)
})

test('existing service must expose the actual workspace health protocol', () => {
  assert.equal(workspaceIsHealthy({ok:true,version:'0.2.17',dashboardProtocol:1}), true)
  for (const body of [null, {}, {ok:true}, {ok:true,version:'0.2.17',dashboardProtocol:'wrong'}]) assert.equal(workspaceIsHealthy(body), false)
})

test('managed compose configuration is retained and foreign paths are refused', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mobilesci-compose-'))
  try {
    const files = ['compose.yaml', 'compose.dev.yaml', 'compose.managed.yaml'].map(file => path.join(dir,file))
    files.forEach(file => writeFileSync(file,''))
    assert.deepEqual(composeFiles(files.join(','), dir), files)
    assert.throws(() => composeFiles('/other/compose.yaml', dir), /其他目录/)
  } finally { rmSync(dir,{recursive:true}) }
})

test('source changes rebuild a cached executable while an unchanged checkout reuses it', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(),'mobilesci-binary-'))
  try {
    const binary = path.join(dir,'orx'), sources = path.join(dir,'src')
    mkdirSync(sources); writeFileSync(path.join(sources,'main.rs'),'source')
    assert.equal(sourceIsNewer(binary,[sources]), true)
    writeFileSync(binary,'binary'); utimesSync(binary,new Date(200000),new Date(200000))
    utimesSync(path.join(sources,'main.rs'),new Date(100000),new Date(100000))
    assert.equal(sourceIsNewer(binary,[sources]), false)
    utimesSync(path.join(sources,'main.rs'),new Date(300000),new Date(300000))
    assert.equal(sourceIsNewer(binary,[sources]), true)
  } finally { rmSync(dir,{recursive:true}) }
})
