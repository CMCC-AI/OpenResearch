#!/usr/bin/env node
// One-command multi-user full-stack hot-reload development runner:
// - Vite dev server on :5201 (HMR for ui/src, proxies API/auth to platform)
// - Platform server on :5301 via `node --watch` (auto-restart for packages/platform/src)
// - Provisioner via `node --watch` (manages per-user `orx-managed-*` Docker containers)
// - Rust watcher on src/ + Cargo.toml (auto-rebuilds executor image & recycles containers on change)
// - Reuses hosted-local PostgreSQL on 127.0.0.1:15440

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, watch } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const platformDir = path.join(root, 'packages', 'platform')
const hostedStateDir = path.join(root, '.mobilesci-run', 'hosted-local')
const hostedEnvFile = path.join(hostedStateDir, '.env')
const hostedOverrideFile = path.join(hostedStateDir, 'compose.override.yaml')
const quotaModelsFile = path.join(hostedStateDir, 'quota-models', 'models.json')
const opencodeConfigDir = path.join(hostedStateDir, 'opencode-config')
const executorImage = 'openresearch-managed-executor:hosted-local'

const UI_PORT = Number(process.env.DEV_HOT_UI_PORT || 5201)
const PLATFORM_PORT = Number(process.env.DEV_HOT_PLATFORM_PORT || 5301)
const DB_PORT = Number(process.env.DEV_HOT_DB_PORT || 15440)

function readEnvMap(file) {
  const map = new Map()
  if (!existsSync(file)) return map
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx > 0) map.set(trimmed.slice(0, idx), trimmed.slice(idx + 1))
  }
  return map
}

function isPortOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      socket.destroy()
      resolve(false)
    })
  })
}

async function waitForHttp(url, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
      if (res.ok || res.status < 500) return
    } catch { /* waiting */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`${label} did not become ready at ${url} within ${timeoutMs}ms`)
}

async function ensurePostgres() {
  if (!existsSync(hostedEnvFile)) {
    throw new Error(
      'Missing .mobilesci-run/hosted-local/.env. Run `node scripts/hosted-local.mjs start --no-open` once to initialize PostgreSQL.'
    )
  }
  const envMap = readEnvMap(hostedEnvFile)
  const dbPassword = envMap.get('PLATFORM_DB_PASSWORD')
  if (!dbPassword) {
    throw new Error('PLATFORM_DB_PASSWORD not found in .mobilesci-run/hosted-local/.env')
  }
  if (!(await isPortOpen(DB_PORT))) {
    console.log('[dev-hot] Starting PostgreSQL container...')
    const composeArgs = [
      'compose', '-p', 'openresearch-hosted-local',
      '--env-file', hostedEnvFile,
      '-f', path.join(platformDir, 'compose.yaml'),
      '-f', path.join(platformDir, 'compose.hosted.yaml'),
      ...(existsSync(hostedOverrideFile) ? ['-f', hostedOverrideFile] : []),
      'up', '-d', 'db',
    ]
    const res = spawnSync('docker', composeArgs, { cwd: platformDir, stdio: 'inherit' })
    if (res.status !== 0) throw new Error('Failed to start PostgreSQL container')
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && !(await isPortOpen(DB_PORT))) {
      await new Promise((r) => setTimeout(r, 500))
    }
    if (!(await isPortOpen(DB_PORT))) {
      throw new Error(`PostgreSQL did not listen on 127.0.0.1:${DB_PORT}`)
    }
  }
  return {
    envMap,
    databaseUrl: `postgres://research_platform:${dbPassword}@127.0.0.1:${DB_PORT}/research_platform`,
    ssoSecret: envMap.get('DEEPLIT_SSO_CLIENT_SECRET') || '',
  }
}

function prefixStream(stream, prefix, target) {
  let buf = ''
  stream.on('data', (chunk) => {
    buf += chunk.toString()
    const lines = buf.split(/\r?\n/)
    buf = lines.pop() ?? ''
    for (const line of lines) {
      target.write(`${prefix} ${line}\n`)
    }
  })
  stream.on('end', () => {
    if (buf) target.write(`${prefix} ${buf}\n`)
  })
}

function buildExecutorImageAsync() {
  return new Promise((resolve) => {
    const child = spawn('docker', [
      'build',
      '-f', path.join(platformDir, 'Dockerfile.executor'),
      '-t', executorImage,
      '.',
    ], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    prefixStream(child.stdout, '[executor-build]', process.stdout)
    prefixStream(child.stderr, '[executor-build]', process.stderr)
    child.on('exit', (code) => resolve(code === 0))
  })
}

function recycleManagedContainers() {
  const list = spawnSync('docker', [
    'ps', '-a', '--filter', 'label=openresearch.managed=true', '--format', '{{.Names}}',
  ], { encoding: 'utf8' })
  if (list.status !== 0 || !list.stdout.trim()) return
  const names = list.stdout.split(/\r?\n/).filter(Boolean)
  if (names.length > 0) {
    console.log(`[dev-hot] Recycling ${names.length} managed executor container(s)...`)
    spawnSync('docker', ['rm', '-f', ...names], { stdio: 'inherit' })
  }
}

async function stopChild(child, timeoutMs = 4000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      resolve()
    }, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    try { child.kill('SIGTERM') } catch { resolve() }
  })
}

async function main() {
  for (const [port, name] of [[UI_PORT, 'UI'], [PLATFORM_PORT, 'Platform']]) {
    if (await isPortOpen(port)) {
      throw new Error(`Port ${port} (${name}) is already in use. Stop existing dev services first.`)
    }
  }

  const { envMap, databaseUrl, ssoSecret } = await ensurePostgres()
  const uiOrigin = `http://localhost:${UI_PORT}`
  const containerConnectOrigin = `http://host.docker.internal:${PLATFORM_PORT}`
  const withQuotas = envMap.get('TOKEN_QUOTAS_ENABLED') !== 'false'

  mkdirSync(opencodeConfigDir, { recursive: true, mode: 0o755 })

  const imageCheck = spawnSync('docker', ['image', 'inspect', executorImage], { stdio: 'ignore' })
  if (imageCheck.status !== 0) {
    console.log('[dev-hot] Building managed executor image for first run...')
    const ok = await buildExecutorImageAsync()
    if (!ok) throw new Error('Failed to build managed executor image')
  }

  const platformEnv = {
    ...process.env,
    PORT: String(PLATFORM_PORT),
    BIND_ADDRESS: '0.0.0.0',
    DATABASE_URL: databaseUrl,
    PLATFORM_ORIGIN: uiOrigin,
    OPENRESEARCH_APP_ORIGIN: uiOrigin,
    PRIVATE_USER_SPACES: 'true',
    MANAGED_EXECUTORS: 'true',
    PRIVATE_SPACE_ROUTING: 'shared-origin',
    MANAGED_CAPACITY: envMap.get('MANAGED_CAPACITY') || '2',
    MANAGED_IDLE_SECONDS: envMap.get('MANAGED_IDLE_SECONDS') || '120',
    MANAGED_EXECUTOR_IMAGE: executorImage,
    MANAGED_CONNECT_URL: containerConnectOrigin,
    MANAGED_OPENCODE_LIVE_CONFIG_DIR: opencodeConfigDir,
    TOKEN_QUOTAS_ENABLED: withQuotas ? 'true' : 'false',
    ...(withQuotas ? {
      OPENCODE_ADMIN_URL: '',
      TOKEN_QUOTA_DEFAULT_MONTHLY_TOKENS: '2000000',
      TOKEN_QUOTA_MODELS_FILE: quotaModelsFile,
    } : {}),
    DEEPLIT_ORIGIN: process.env.ORX_DEEP_LITERATURE_WEB_URL || 'http://localhost:3000',
    DEEPLIT_SSO_CLIENT_SECRET: ssoSecret,
    ORX_DEEP_LITERATURE_URL: 'http://host.docker.internal:3000',
    ORX_DEEP_LITERATURE_WEB_URL: 'http://localhost:3000',
  }

  const provisionerEnv = {
    ...platformEnv,
    // Managed containers reach platform via host.docker.internal:<PLATFORM_PORT>.
    PLATFORM_ORIGIN: containerConnectOrigin,
    DOCKER_SOCKET: process.env.DOCKER_SOCKET || '/var/run/docker.sock',
  }

  console.log('[dev-hot] Running platform DB migrations...')
  const mig = spawnSync(process.execPath, ['src/admin.mjs', 'migrate'], {
    cwd: platformDir,
    env: platformEnv,
    stdio: 'inherit',
  })
  if (mig.status !== 0) throw new Error('Platform migration failed')

  let shuttingDown = false
  const watchers = []

  const platformChild = spawn(process.execPath, ['--watch', 'src/server.mjs'], {
    cwd: platformDir,
    env: platformEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  prefixStream(platformChild.stdout, '[platform]', process.stdout)
  prefixStream(platformChild.stderr, '[platform]', process.stderr)

  const provisionerChild = spawn(process.execPath, ['--watch', 'src/provisioner.mjs'], {
    cwd: platformDir,
    env: provisionerEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  prefixStream(provisionerChild.stdout, '[provisioner]', process.stdout)
  prefixStream(provisionerChild.stderr, '[provisioner]', process.stderr)

  const uiChild = spawn(
    process.execPath,
    [path.join(root, 'ui', 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(UI_PORT), '--strictPort', '--force'],
    {
      cwd: path.join(root, 'ui'),
      env: {
        ...process.env,
        ORX_BACKEND: `http://127.0.0.1:${PLATFORM_PORT}`,
        ORX_PLATFORM_PROXY: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )
  prefixStream(uiChild.stdout, '[vite]', process.stdout)
  prefixStream(uiChild.stderr, '[vite]', process.stderr)

  await Promise.all([
    waitForHttp(`http://127.0.0.1:${PLATFORM_PORT}/healthz`, 'Platform'),
    waitForHttp(uiOrigin, 'Vite UI'),
  ])

  console.log('')
  console.log('============================================================')
  console.log(`  OpenResearch 多用户全栈热更新已就绪: ${uiOrigin}/projects`)
  console.log(`  - 前端 (Vite HMR):          ${uiOrigin}`)
  console.log(`  - 平台 (node --watch):      http://127.0.0.1:${PLATFORM_PORT} (多用户私有空间 + 配额网关)`)
  console.log('  - 执行器 (provisioner):     按需拉起容器，修改 src/ 自动重建并更新')
  console.log('  按 Ctrl+C 一键停止所有服务')
  console.log('============================================================')
  console.log('')

  // Watch Rust sources for automatic executor image rebuild + container recycle.
  let building = false
  let pendingRebuild = false
  let debounceTimer = null

  const triggerExecutorRebuild = async () => {
    if (shuttingDown) return
    if (building) {
      pendingRebuild = true
      return
    }
    building = true
    pendingRebuild = false
    console.log('[dev-hot] Rust source changed, rebuilding executor image...')
    const ok = await buildExecutorImageAsync()
    building = false
    if (shuttingDown) return
    if (ok) {
      recycleManagedContainers()
      console.log('[dev-hot] Executor image updated; next request will use the new binary.')
    } else {
      console.error('[dev-hot] Executor image build failed; keeping existing containers.')
    }
    if (pendingRebuild && !shuttingDown) {
      void triggerExecutorRebuild()
    }
  }

  const scheduleRustRebuild = (filename) => {
    if (!filename || !/\.(rs|toml)$/.test(String(filename))) return
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => { void triggerExecutorRebuild() }, 500)
  }

  watchers.push(watch(path.join(root, 'src'), { recursive: true }, (_event, file) => scheduleRustRebuild(file)))
  watchers.push(watch(path.join(root, 'Cargo.toml'), () => scheduleRustRebuild('Cargo.toml')))

  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    console.log('\n[dev-hot] Stopping services...')
    clearTimeout(debounceTimer)
    for (const w of watchers) w.close()
    await Promise.all([
      stopChild(uiChild),
      stopChild(provisionerChild),
      stopChild(platformChild),
    ])
    process.exit(0)
  }

  process.on('SIGINT', () => { void shutdown() })
  process.on('SIGTERM', () => { void shutdown() })
}

main().catch((err) => {
  console.error('[dev-hot] Fatal:', err.message)
  process.exit(1)
})
