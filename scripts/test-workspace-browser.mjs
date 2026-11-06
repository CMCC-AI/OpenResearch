#!/usr/bin/env node
// Real Chromium acceptance runs in CI; all projects/account responses are synthetic.
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync, copyFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { worktreeInfo } from './dev-slot.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ui = path.join(root, 'ui')
const cli = path.join(ui, 'node_modules/@playwright/test/cli.js')
const artifacts = path.join(ui, 'test-results/workspace-server')
mkdirSync(artifacts, { recursive: true })
const log = path.join(artifacts, 'driver.log')
const run = (program, args, env = process.env) => new Promise((resolve, reject) => {
  const child = spawn(program, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', bytes => { process.stdout.write(bytes); writeFileSync(log, bytes, { flag: 'a' }) })
  child.stderr.on('data', bytes => { process.stderr.write(bytes); writeFileSync(log, bytes, { flag: 'a' }) })
  child.once('error', reject)
  child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${path.basename(program)} failed: ${code ?? signal}`)))
})
if (process.argv.includes('--list')) {
  await run(process.execPath, [cli, 'test', '--config', path.join(ui, 'playwright.config.mjs'), '--list'])
  process.exit(0)
}
const info = worktreeInfo(root)
const registry = path.join(os.homedir(), '.local/share/openresearch-dev')
// CI has a fresh HOME. Reuse this job's already-built cache without changing the
// helper's data/port/process isolation; never replace a developer's existing cache.
if (process.env.CI && !existsSync(path.join(registry, 'cargo-target'))) {
  mkdirSync(registry, { recursive: true })
  symlinkSync(path.join(root, 'target'), path.join(registry, 'cargo-target'), 'dir')
}
const projects = ['a', 'b', 'c', 'd'].map(letter => ({ id: `browser-${letter}`, main: `browser-${letter}-main`, title: `Browser conversation ${letter.toUpperCase()}`, name: `Browser fixture ${letter.toUpperCase()}` }))
const readingProject = { id: 'browser-reading', main: 'browser-reading-main', title: 'Browser reading conversation', name: 'Browser reading fixture' }
const seededProjects = [...projects, readingProject]
let origin = null
let detail = null
let readingDetail = null
let assets = []
let readingAssets = []
const unexpected = []
const account = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture.invalid')
  if (request.headers.origin && request.headers.origin !== origin) { response.writeHead(403).end(); return }
  if (request.headers.origin) {
    response.setHeader('access-control-allow-origin', origin)
    response.setHeader('access-control-allow-credentials', 'true')
    response.setHeader('vary', 'Origin')
  }
  if (request.method === 'OPTIONS') { response.writeHead(204, { 'access-control-allow-methods': 'GET', 'access-control-allow-headers': 'content-type' }).end(); return }
  const json = value => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)) }
  if (request.method === 'GET' && url.pathname === '/api/platform/catalog-session') {
    json({ user: { id: 'browser-fixture-user', name: 'Synthetic browser fixture', email: 'browser@example.invalid', isAdmin: false }, canAccessResearch: true, privateResearch: false, deepLiteratureUrl: null }); return
  }
  if (request.method === 'GET' && url.pathname === '/api/platform/cases') { json({ cases: detail ? [detail, ...(readingDetail ? [readingDetail] : [])] : [] }); return }
  if (request.method === 'GET' && url.pathname === '/api/platform/cases/browser-case' && detail) { json(detail); return }
  if (request.method === 'GET' && url.pathname === '/api/platform/cases/browser-reading-case' && readingDetail) { json(readingDetail); return }
  if (request.method === 'GET' && url.pathname === '/api/platform/cases/browser-reading-case/assets') {
    const asset = readingAssets.find(item => item.name === url.searchParams.get('name'))
    if (asset) { response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(Buffer.from(asset.content, 'base64')); return }
  }
  if (request.method === 'GET' && url.pathname === '/api/platform/cases/browser-case/assets') {
    const asset = assets.find(item => item.name === url.searchParams.get('name'))
    if (asset) { response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(Buffer.from(asset.content, 'base64')); return }
  }
  unexpected.push(`${request.method} ${url.pathname}`)
  response.writeHead(404).end('Unknown synthetic account endpoint')
})
await new Promise(resolve => account.listen(0, '127.0.0.1', resolve))
const accountOrigin = `http://127.0.0.1:${account.address().port}`
const environment = { ...process.env, ORX_ACCOUNT_URL: accountOrigin, CARGO_INCREMENTAL: '0' }
let state
let attempted = false
try {
  const existing = (existsSync(registry) ? readdirSync(registry) : []).filter(name => /^slot-[1-9]-state\.json$/.test(name)).map(name => JSON.parse(readFileSync(path.join(registry, name), 'utf8'))).filter(item => item.worktreePath === info.worktreePath)
  if (existing.length) throw new Error('Browser acceptance requires a dedicated worktree without an existing dev slot; preserve and manage that slot explicitly')
  writeFileSync(path.join(artifacts, 'owned-slot.json'), JSON.stringify({ worktreePath: info.worktreePath }))
  attempted = true
  await run(process.execPath, [path.join(root, 'scripts/dev-slot.mjs'), 'start', '--db', 'empty'], environment)
  const matches = readdirSync(registry).filter(name => /^slot-[1-9]-state\.json$/.test(name)).map(name => JSON.parse(readFileSync(path.join(registry, name), 'utf8'))).filter(item => item.worktreePath === info.worktreePath)
  if (matches.length !== 1 || matches[0].dbMode !== 'empty') throw new Error('A unique managed empty slot is required')
  state = matches[0]
  if (!/^slot-[1-9]$/.test(state.slotKey)) throw new Error('Unexpected slot key')
  origin = `http://localhost:${state.uiPort}`
  const backend = `http://127.0.0.1:${state.backendPort}`
  const data = path.join(registry, state.slotKey)
  // An existing-file connection can participate in the live WAL's shared
  // memory; query_only forbids SQL writes during the emptiness/audit checks.
  execFileSync('python3', ['-c', "import sqlite3,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=rw',uri=True); c.execute('PRAGMA query_only=ON'); assert c.execute('SELECT count(*) FROM local_projects').fetchone()[0]==0 and c.execute('SELECT count(*) FROM chat_sessions').fetchone()[0]==0, 'Refuse a nonempty database'", path.join(data, 'orx.db')])
  const repos = mkdtempSync(path.join(data, 'browser-fixture-'))
  for (const project of seededProjects) {
    project.repo = path.join(repos, project.id)
    mkdirSync(project.repo, { recursive: true })
    writeFileSync(path.join(project.repo, 'README.md'), `Synthetic browser file for ${project.id}\n`)
    execFileSync('git', ['init', '--initial-branch=main', project.repo], { stdio: 'ignore' })
    execFileSync('git', ['-C', project.repo, 'add', 'README.md'])
    execFileSync('git', ['-C', project.repo, '-c', 'user.name=Browser fixture', '-c', 'user.email=browser@example.invalid', 'commit', '-m', 'Synthetic browser fixture'], { stdio: 'ignore' })
  }
  const seed = `import json,sys,sqlite3,time
rows=json.loads(sys.argv[2])
with sqlite3.connect(sys.argv[1]) as c:
 c.execute('BEGIN IMMEDIATE')
 assert c.execute('SELECT count(*) FROM local_projects').fetchone()[0]==0, 'Refuse to seed a nonempty slot'
 assert c.execute('SELECT count(*) FROM chat_sessions').fetchone()[0]==0, 'Refuse to seed existing chats'
 for p in rows:
  c.execute("INSERT INTO local_projects(id,name,slug,github_owner,github_repo,github_sync_enabled,baseline_branch,repo_path,created_at,updated_at) VALUES(?,?,?,'','',0,'main',?,1,1)",(p['id'],p['name'],p['id'],p['repo']))
  c.execute("INSERT INTO chat_sessions(id,project_id,harness,title,created_at,updated_at) VALUES(?,?,'opencode',?,1,1)",(p['main'],p['id'],p['title']))
 c.execute("INSERT INTO chat_sessions(id,project_id,harness,title,side_parent_session_id,created_at,updated_at) VALUES('browser-a-side','browser-a','opencode','Browser side A','browser-a-main',2,2)")`
  execFileSync('python3', ['-c', seed, path.join(data, 'orx.db'), JSON.stringify(seededProjects)])
  const read = async (url, init) => {
    const response = await fetch(new URL(url, backend), init)
    if (!response.ok) throw new Error(`Fixture API ${url}: ${response.status} ${await response.text()}`)
    return response
  }
  const post = (url, value) => read(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
  const panes = [{ kind: 'side', sessionId: 'browser-a-side' }, { kind: 'home', view: 'materials' }, null, { kind: 'home', view: 'research' }]
  for (const [index, project] of projects.entries()) {
    const pane = panes[index]
    const task = { tabs: [pane ?? { kind: 'home', view: 'materials' }], active: pane, previewKey: null, history: [], expanded: {}, scroll: {}, sourceModes: {}, filesView: 'files', scope: 'project', panelMax: false }
    await post(`/api/projects/${project.id}/ui-state`, { version: 1, lastTaskId: project.main, lastLocation: `/projects/${project.id}/tasks/${project.main}`, tasks: { [project.main]: task } })
  }
  await post('/api/settings/ui-state', { tourCompleted: true, preferredAgent: { harness: 'opencode', model: null }, workspace: { lastLocation: '/projects', railOpen: true, panelWidth: 480, experimentsView: 'tree' } })
  // Generate the case through the production capture implementation and real
  // APIs. Only its hash primitive is supplied by Node instead of browser crypto.
  // Actual upload/CLI receipts, isolated from the four navigation fixtures.
  // The two read events below are synthetic test observations, never model calls.
  const readingMaterial = await (await post(`/api/projects/${readingProject.id}/materials`, {})).json()
  await read(`/api/projects/${readingProject.id}/materials/${readingMaterial.id}/files?path=notes.txt`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: 'one\ntwo\nthree\nfour\n' })
  const readingManifest = await (await post(`/api/projects/${readingProject.id}/materials/${readingMaterial.id}/finalize`, {})).json()
  const cliEnv = { ...environment, ORX_DATA_DIR: data, ORX_CACHE_DIR: path.join(data, 'cache'), XDG_CONFIG_HOME: path.join(registry, `${state.slotKey}-config`), ORX_CHAT_SESSION_ID: readingProject.main, ORX_NO_UPDATE_CHECK: '1' }
  for (const offset of ['1', '2']) await run(path.join(registry, 'cargo-target/debug/orx'), ['--no-telemetry', 'materials', '--project', readingProject.id, 'read', readingMaterial.id, readingManifest.files[0].id, '--offset', offset, '--limit', '2'], cliEnv)
  execFileSync('python3', ['-c', `import sqlite3,sys,json
with sqlite3.connect(sys.argv[1]) as c:
 c.execute("INSERT INTO chat_messages(id,session_id,role,parts_json,created_at) VALUES('browser-reading-upload',?,'user',?,3)",(sys.argv[2],json.dumps([{'type':'material','text':sys.argv[3]}])))
 c.execute("UPDATE chat_sessions SET active_leaf_id='browser-reading-upload' WHERE id=?",(sys.argv[2],))`, path.join(data, 'orx.db'), readingProject.main, readingMaterial.id])
  const readingPane = { kind: 'home', view: 'materials' }
  await post(`/api/projects/${readingProject.id}/ui-state`, { version: 1, lastTaskId: readingProject.main, lastLocation: `/projects/${readingProject.id}/tasks/${readingProject.main}`, tasks: { [readingProject.main]: { tabs: [readingPane], active: readingPane, previewKey: null, history: [], expanded: {}, scroll: {}, sourceModes: {}, filesView: 'files', scope: 'project', panelMax: false } } })
  const require = createRequire(path.join(ui, 'package.json'))
  const ts = require('typescript')
  const { canonicalRequest } = await import(pathToFileURL(path.join(ui, 'src/readOnlyApi.ts')).href)
  const source = readFileSync(path.join(ui, 'src/product/captureNativeProject.ts'), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = {}
  new Function('require', 'exports', 'fetch', code)(name => {
    if (name === '../readOnlyApi') return { canonicalRequest }
    if (name === './sha256') return { sha256Hex: async bytes => createHash('sha256').update(bytes).digest('hex') }
    throw new Error(`Unexpected capture dependency ${name}`)
  }, module, read)
  const captured = await module.captureNativeProject(projects[0].id)
  assets = captured.assets
  const caseState = captured.workspace.responses['/api/projects/browser-a/ui-state']
  caseState.tasks[projects[0].main].active = { kind: 'home', view: 'research' }
  caseState.tasks[projects[0].main].tabs = [{ kind: 'home', view: 'research' }]
  detail = { id: 'browser-case', title: 'Synthetic browser case', summary: 'Isolated acceptance fixture', category: 'test', status: 'published', revision: 1, sort_order: 0, created_at: '2026-11-07T00:00:00Z', updated_at: '2026-11-07T00:00:00Z', published_at: '2026-11-07T00:00:00Z', source_project_id: projects[0].id, files: [], snapshot: { sessions: [], workspace: captured.workspace } }
  const readingCapture = await module.captureNativeProject(readingProject.id)
  readingAssets = readingCapture.assets
  readingDetail = { ...detail, id: 'browser-reading-case', title: 'Synthetic reading case', source_project_id: readingProject.id, snapshot: { sessions: [], workspace: readingCapture.workspace } }
  const fixtureFile = path.join(artifacts, 'fixture.json')
  writeFileSync(fixtureFile, JSON.stringify({ origin, backend, accountOrigin, projects, readingProject, readingManifest }))
  await run(process.execPath, [cli, 'test', '--config', path.join(ui, 'playwright.config.mjs')], { ...environment, ORX_BROWSER_BASE_URL: origin, ORX_BROWSER_FIXTURE_FILE: fixtureFile })
  if (unexpected.length) throw new Error(`Unexpected fixture account requests: ${unexpected.join(', ')}`)
  const audit = JSON.parse(execFileSync('python3', ['-c', `import sqlite3,sys,json
with sqlite3.connect('file:'+sys.argv[1]+'?mode=rw',uri=True) as c:
 c.execute('PRAGMA query_only=ON')
 print(json.dumps({t:c.execute('SELECT count(*) FROM '+t).fetchone()[0] for t in ['runs','chat_messages','chat_queued_messages','chat_spawns','material_read_events']}))`, path.join(data, 'orx.db')], { encoding: 'utf8' }))
  if (JSON.stringify(audit) !== JSON.stringify({ runs: 0, chat_messages: 1, chat_queued_messages: 0, chat_spawns: 0, material_read_events: 2 })) throw new Error(`Unexpected agent/run/material mutations: ${JSON.stringify(audit)}`)
  writeFileSync(path.join(artifacts, 'acceptance.json'), JSON.stringify({ revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), mode: 'synthetic account/upload/two CLI reads; actual app and isolated native backend', slot: state.slotKey, audit, productionDeployed: false }, null, 2))
} finally {
  try {
    if (attempted) await run(process.execPath, [path.join(root, 'scripts/dev-slot.mjs'), 'stop'])
  } finally {
    try {
      for (const key of ['backendLog', 'uiLog']) if (state?.[key] && existsSync(state[key])) copyFileSync(state[key], path.join(artifacts, path.basename(state[key])))
    } finally {
      account.closeAllConnections()
      await new Promise(resolve => account.close(resolve))
    }
  }
}
