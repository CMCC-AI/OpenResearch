#!/usr/bin/env node
// Local full-parity runner for server multi-user private-space mode (compose.yaml + compose.hosted.yaml).
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const platformDir = path.join(root, 'packages', 'platform')
const stateDir = path.join(root, '.mobilesci-run', 'hosted-local')
const envFile = path.join(stateDir, '.env')
const overrideFile = path.join(stateDir, 'compose.override.yaml')
const opencodeConfigDir = path.join(stateDir, 'opencode-config')
const quotaModelsDir = path.join(stateDir, 'quota-models')
const quotaModelsFile = path.join(quotaModelsDir, 'models.json')
const projectName = 'openresearch-hosted-local'
const executorImage = 'openresearch-managed-executor:hosted-local'

function usage() {
  return `Usage:
  node scripts/hosted-local.mjs start [--rebuild] [--no-open] [--with-quotas|--no-quotas] [--port 5400] [--capacity 2] [--idle-seconds 120]
  node scripts/hosted-local.mjs stop [--clean]
  node scripts/hosted-local.mjs status
  node scripts/hosted-local.mjs grant-admin <email>`
}

export function parseArgs(argv) {
  const [command, ...rest] = argv
  if (!['start', 'stop', 'status', 'grant-admin'].includes(command)) {
    throw new Error(usage())
  }
  const options = {
    command,
    rebuild: false,
    open: true,
    withQuotas: false,
    quotasFlag: null,
    clean: false,
    port: 5400,
    dbPort: 15440,
    capacity: 2,
    idleSeconds: 120,
    aptMirror: process.env.APT_MIRROR || '',
    npmRegistry: process.env.NPM_REGISTRY || '',
    email: null,
  }
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    if (arg === '--rebuild') options.rebuild = true
    else if (arg === '--no-open') options.open = false
    else if (arg === '--with-quotas') { options.withQuotas = true; options.quotasFlag = true }
    else if (arg === '--no-quotas') { options.withQuotas = false; options.quotasFlag = false }
    else if (arg === '--clean') options.clean = true
    else if (arg === '--port' && rest[i + 1]) {
      options.port = Number(rest[++i])
      if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) {
        throw new Error(`Invalid --port: ${rest[i]}`)
      }
    } else if (arg === '--capacity' && rest[i + 1]) {
      options.capacity = Number(rest[++i])
      if (!Number.isInteger(options.capacity) || options.capacity < 1) {
        throw new Error(`Invalid --capacity: ${rest[i]}`)
      }
    } else if (arg === '--idle-seconds' && rest[i + 1]) {
      options.idleSeconds = Number(rest[++i])
      if (!Number.isInteger(options.idleSeconds) || options.idleSeconds < 10) {
        throw new Error(`Invalid --idle-seconds: ${rest[i]}`)
      }
    } else if (arg === '--apt-mirror' && rest[i + 1]) {
      options.aptMirror = rest[++i]
    } else if (arg === '--npm-registry' && rest[i + 1]) {
      options.npmRegistry = rest[++i]
    } else if (arg === '--help' || arg === '-h') {
      throw new Error(usage())
    } else if (command === 'grant-admin' && !arg.startsWith('-') && !options.email) {
      options.email = arg
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`)
    }
  }
  if (command === 'grant-admin' && !options.email) {
    throw new Error('grant-admin requires an email address')
  }
  return options
}

function run(command, args, cwd = root, env = process.env) {
  console.log(`$ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error) throw new Error(`Failed to run ${command}: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`)
}

function capture(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return { status: result.status, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim() }
}

function ensureDockerReady() {
  const info = capture('docker', ['info', '--format', '{{.ServerVersion}}'])
  if (info.status !== 0) {
    throw new Error('Docker is not running. Please start Docker Desktop first.')
  }
}

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

function ensureEnvFile(options) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  mkdirSync(opencodeConfigDir, { recursive: true, mode: 0o755 })
  const existing = readEnvMap(envFile)
  const withQuotas = options.quotasFlag !== null
    ? options.quotasFlag
    : existing.get('TOKEN_QUOTAS_ENABLED') === 'true'
  options.withQuotas = withQuotas
  if (withQuotas) {
    mkdirSync(quotaModelsDir, { recursive: true, mode: 0o755 })
    if (!existsSync(quotaModelsFile)) {
      writeFileSync(quotaModelsFile, JSON.stringify({ providers: {}, models: [] }, null, 2) + '\n', { mode: 0o600 })
      chmodSync(quotaModelsFile, 0o600)
    }
  }
  const dbPassword = existing.get('PLATFORM_DB_PASSWORD') || randomBytes(24).toString('hex')
  const ssoSecret = existing.get('DEEPLIT_SSO_CLIENT_SECRET') || randomBytes(32).toString('hex')
  const origin = `http://localhost:${options.port}`
  const content = [
    `PLATFORM_ORIGIN=${origin}`,
    `OPENRESEARCH_APP_ORIGIN=${origin}`,
    `PLATFORM_DB_PASSWORD=${dbPassword}`,
    `DEEPLIT_ORIGIN=http://localhost:3000`,
    `DEEPLIT_SSO_CLIENT_SECRET=${ssoSecret}`,
    `MANAGED_OPENCODE_CONFIG_DIRECTORY=${opencodeConfigDir}`,
    `MANAGED_EXECUTOR_IMAGE=${executorImage}`,
    `MANAGED_CAPACITY=${options.capacity}`,
    `MANAGED_IDLE_SECONDS=${options.idleSeconds}`,
    `TOKEN_QUOTAS_ENABLED=${withQuotas ? 'true' : 'false'}`,
  ].join('\n') + '\n'
  writeFileSync(envFile, content, { mode: 0o600 })
  chmodSync(envFile, 0o600)
  return origin
}

function writeOverrideFile(options, origin) {
  const quotaValue = options.withQuotas ? 'true' : 'false'
  const quotaPlatformEnv = options.withQuotas
    ? `
      OPENCODE_ADMIN_URL: ""
      TOKEN_QUOTA_DEFAULT_MONTHLY_TOKENS: "2000000"
      TOKEN_QUOTA_MODELS_FILE: "/run/quota-models/models.json"`
    : ''
  const quotaPlatformVolumes = options.withQuotas
    ? `
    volumes:
      - "${quotaModelsDir}:/run/quota-models"`
    : ''
  const yaml = `# Auto-generated by scripts/hosted-local.mjs; do not edit manually.
services:
  db:
    ports: !override
      - "127.0.0.1:${options.dbPort}:5432"
  platform:
    ports: !override
      - "127.0.0.1:${options.port}:5300"
    environment:
      PRIVATE_SPACE_ROUTING: "shared-origin"
      PLATFORM_ORIGIN: "${origin}"
      OPENRESEARCH_APP_ORIGIN: "${origin}"
      TOKEN_QUOTAS_ENABLED: "${quotaValue}"${quotaPlatformEnv}${quotaPlatformVolumes}
  provisioner:
    environment:
      PLATFORM_ORIGIN: "${origin}"
      MANAGED_CONNECT_URL: "http://host.docker.internal:${options.port}"
      MANAGED_EXECUTOR_IMAGE: "${executorImage}"
      MANAGED_CAPACITY: "${options.capacity}"
      MANAGED_IDLE_SECONDS: "${options.idleSeconds}"
      MANAGED_OPENCODE_LIVE_CONFIG_DIR: "${opencodeConfigDir}"
      ORX_DEEP_LITERATURE_URL: "http://host.docker.internal:3000"
      ORX_DEEP_LITERATURE_WEB_URL: "http://localhost:3000"
      TOKEN_QUOTAS_ENABLED: "${quotaValue}"
`
  writeFileSync(overrideFile, yaml, { mode: 0o600 })
}

function composeArgs(extra = []) {
  return [
    'compose',
    '-p', projectName,
    '--env-file', envFile,
    '-f', path.join(platformDir, 'compose.yaml'),
    '-f', path.join(platformDir, 'compose.hosted.yaml'),
    '-f', overrideFile,
    ...extra,
  ]
}

function findHostedManagedContainers(targetOrigin = null) {
  const list = capture('docker', ['ps', '-a', '--filter', 'label=openresearch.managed=true', '--format', '{{.Names}}'])
  if (list.status !== 0 || !list.stdout) return []
  const names = list.stdout.split(/\r?\n/).filter(Boolean)
  if (!targetOrigin) return names
  return names.filter((name) => {
    const inspected = capture('docker', ['inspect', name, '--format', '{{json .Config.Env}}'])
    if (inspected.status !== 0) return false
    try {
      const envs = JSON.parse(inspected.stdout)
      return Array.isArray(envs) && envs.includes(`PLATFORM_ORIGIN=${targetOrigin}`)
    } catch {
      return false
    }
  })
}

async function waitForHealth(origin, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return
    } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`Hosted platform did not become healthy at ${origin}/healthz`)
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]]
  const child = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' })
  child.unref()
}

async function start(options) {
  ensureDockerReady()
  const origin = ensureEnvFile(options)
  writeOverrideFile(options, origin)

  if (!existsSync(path.join(root, 'ui', 'node_modules'))) {
    run('pnpm', ['--dir', 'ui', 'install', '--frozen-lockfile'])
  }
  const imageExists = capture('docker', ['image', 'inspect', executorImage]).status === 0
  if (options.rebuild || !existsSync(path.join(root, 'ui', 'dist'))) {
    run('pnpm', ['--dir', 'ui', 'build'])
  }
  if (options.rebuild || !imageExists) {
    const opencodeVersion = process.env.OPENCODE_VERSION || '1.18.33'
    const aptMirror = options.aptMirror
    const npmRegistry = options.npmRegistry
    const buildArgs = [
      'build',
      '-f', path.join(platformDir, 'Dockerfile.executor'),
      '--build-arg', `OPENCODE_VERSION=${opencodeVersion}`,
      ...(aptMirror ? ['--build-arg', `APT_MIRROR=${aptMirror}`] : []),
      ...(npmRegistry ? ['--build-arg', `NPM_REGISTRY=${npmRegistry}`] : []),
      '-t', executorImage,
      '.',
    ]
    run('docker', buildArgs)
  }

  const upArgs = options.rebuild ? ['up', '-d', '--build'] : ['up', '-d', '--build']
  run('docker', composeArgs(upArgs), platformDir)
  await waitForHealth(origin)

  if (options.open) openBrowser(`${origin}/projects`)

  console.log(`\n本地服务器多用户托管模式已就绪：`)
  console.log(`  浏览器入口:   ${origin}/projects`)
  console.log(`  登录/注册页:  ${origin}/_account/login`)
  console.log(`  系统管理后台: ${origin}/admin/users`)
  console.log(`  PostgreSQL:   127.0.0.1:${options.dbPort} (Compose 项目: ${projectName})`)
  console.log(`  执行器镜像:   ${executorImage}`)
  console.log(`  并发容量上限: ${options.capacity}，闲置休眠: ${options.idleSeconds}s`)
  console.log(`\n常用操作：`)
  console.log(`  授予管理员权限: node scripts/hosted-local.mjs grant-admin <你的邮箱>`)
  console.log(`  查看运行状态:   node scripts/hosted-local.mjs status`)
  console.log(`  停止全部服务:   ./stop-hosted-local.command`)
}

function stop(options) {
  ensureDockerReady()
  const existing = readEnvMap(envFile)
  const targetOrigin = existing.get('PLATFORM_ORIGIN') || null

  if (existsSync(overrideFile) && existsSync(envFile)) {
    // Stop provisioner first so it doesn't respawn executor containers during teardown.
    capture('docker', composeArgs(['stop', 'provisioner']), platformDir)
  }

  const managed = findHostedManagedContainers(targetOrigin)
  if (managed.length > 0) {
    console.log(`Stopping ${managed.length} managed executor container(s): ${managed.join(', ')}`)
    run('docker', ['rm', '-f', ...managed])
  }

  if (existsSync(overrideFile) && existsSync(envFile)) {
    const downArgs = options.clean ? ['down', '-v', '--remove-orphans'] : ['down', '--remove-orphans']
    run('docker', composeArgs(downArgs), platformDir)
  } else {
    console.log('No hosted-local compose state found; skipping compose down.')
  }

  if (options.clean) {
    if (managed.length > 0) {
      for (const name of managed) {
        capture('docker', ['volume', 'rm', name])
      }
    }
    rmSync(stateDir, { recursive: true, force: true })
    console.log('Cleaned hosted-local volumes and state directory.')
  } else {
    console.log('已停止托管服务与执行器容器（用户数据库与研究数据卷已保留；如需清空请加 --clean）。')
  }
}

function status() {
  ensureDockerReady()
  const existing = readEnvMap(envFile)
  const targetOrigin = existing.get('PLATFORM_ORIGIN') || null
  if (!existsSync(overrideFile) || !existsSync(envFile)) {
    console.log('hosted-local 尚未初始化。运行 ./start-hosted-local.command 启动。')
    return
  }
  console.log(`Compose 项目: ${projectName} (${targetOrigin || 'unknown origin'})`)
  run('docker', composeArgs(['ps']), platformDir)
  const managed = findHostedManagedContainers(targetOrigin)
  console.log(`\n托管执行器容器 (${managed.length}):`)
  if (managed.length === 0) {
    console.log('  (无运行中或已创建的托管执行器容器)')
  } else {
    run('docker', ['ps', '-a', '--filter', 'label=openresearch.managed=true', '--format', 'table {{.Names}}\t{{.Status}}\t{{.Image}}'])
  }
}

function grantAdmin(options) {
  ensureDockerReady()
  if (!existsSync(overrideFile) || !existsSync(envFile)) {
    throw new Error('hosted-local 尚未启动，请先运行 ./start-hosted-local.command')
  }
  run('docker', composeArgs(['exec', '-T', 'platform', 'node', 'src/admin.mjs', 'grant-admin', options.email]), platformDir)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.command === 'start') await start(options)
  else if (options.command === 'stop') stop(options)
  else if (options.command === 'status') status()
  else if (options.command === 'grant-admin') grantAdmin(options)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((error) => {
    console.error(`hosted-local: ${error.message}`)
    process.exitCode = 1
  })
}
