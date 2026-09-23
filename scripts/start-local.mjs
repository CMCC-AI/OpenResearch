#!/usr/bin/env node

// Starts the personal, local OpenResearch product and its two companion services.
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appOrigin = 'http://localhost:4791'
const platformOrigin = 'http://localhost:5300'
const literatureOrigin = 'http://localhost:3000'

function usage() {
  return `Usage: node scripts/start-local.mjs [--deeplit-dir PATH] [--no-open] [--with-workers]

Starts the local release on ${appOrigin}. Deep Literature defaults to ../DeepLiterature.
Existing secrets and database passwords are preserved. Changed .env files are backed up.`
}

function optionsFrom(argv) {
  const options = { deeplitDir: path.resolve(root, '../DeepLiterature'), open: true, withWorkers: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--deeplit-dir' && argv[i + 1]) options.deeplitDir = path.resolve(argv[++i])
    else if (argv[i] === '--no-open') options.open = false
    else if (argv[i] === '--with-workers') options.withWorkers = true
    else if (argv[i] === '-h' || argv[i] === '--help') { console.log(usage()); process.exit(0) }
    else throw new Error(`Unknown option: ${argv[i]}\n${usage()}`)
  }
  return options
}

function valueOf(content, key) {
  const line = content.split(/\r?\n/).find((item) => item.startsWith(`${key}=`))
  return line?.slice(key.length + 1).trim().replace(/^(['"])(.*)\1$/, '$2') || ''
}

function setValues(content, values) {
  const lines = content.trimEnd() ? content.trimEnd().split(/\r?\n/) : []
  for (const [key, value] of Object.entries(values)) {
    const index = lines.findIndex((item) => item.startsWith(`${key}=`))
    if (index < 0) lines.push(`${key}=${value}`)
    else lines[index] = `${key}=${value}`
  }
  return `${lines.join('\n')}\n`
}

function saveEnv(file, content) {
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : null
  if (previous === content) {
    chmodSync(file, 0o600)
    return
  }
  if (previous !== null) {
    const backup = `${file}.bak-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${process.pid}`
    copyFileSync(file, backup)
    chmodSync(backup, 0o600)
    console.log(`配置备份：${backup}`)
  }
  const temporary = `${file}.tmp-${process.pid}`
  writeFileSync(temporary, content, { mode: 0o600 })
  renameSync(temporary, file)
  console.log(`已配置：${file}`)
}

function secret(content, key) {
  const value = valueOf(content, key)
  return value && !value.startsWith('replace-with-') && !value.startsWith('<') ? value : ''
}

function configure(deeplitDir, withWorkers) {
  const platformEnv = path.join(root, 'packages/platform/.env')
  const literatureEnv = path.join(deeplitDir, '.env.local')
  const platformOld = existsSync(platformEnv) ? readFileSync(platformEnv, 'utf8') : ''
  const literatureOld = existsSync(literatureEnv)
    ? readFileSync(literatureEnv, 'utf8')
    : readFileSync(path.join(deeplitDir, '.env.production.example'), 'utf8')
  const literatureExisted = existsSync(literatureEnv)
  const platformSso = secret(platformOld, 'DEEPLIT_SSO_CLIENT_SECRET')
  const literatureSso = secret(literatureOld, 'DEEPLIT_SSO_CLIENT_SECRET')
  if (platformSso && literatureSso && platformSso !== literatureSso) {
    throw new Error('两端 DEEPLIT_SSO_CLIENT_SECRET 不一致；请先核对现有配置，脚本不会覆盖密钥。')
  }
  const sharedSecret = platformSso || literatureSso || randomBytes(32).toString('hex')
  const modelKey = secret(literatureOld, 'QWEN_API_KEY')
  if (withWorkers && !modelKey) {
    throw new Error('--with-workers 需要在 Deep Literature .env.local 配置 QWEN_API_KEY。')
  }
  // Older local Compose stacks used this fallback when .env.local had no password.
  const literaturePassword = secret(literatureOld, 'POSTGRES_PASSWORD')
    || (literatureExisted && !valueOf(literatureOld, 'POSTGRES_PASSWORD')
      ? 'deeplit-local-password'
      : randomBytes(32).toString('hex'))
  const platformNext = setValues(platformOld, {
    PLATFORM_ORIGIN: platformOrigin,
    OPENRESEARCH_APP_ORIGIN: appOrigin,
    PLATFORM_DB_PASSWORD: secret(platformOld, 'PLATFORM_DB_PASSWORD') || randomBytes(32).toString('hex'),
    DEEPLIT_ORIGIN: literatureOrigin,
    DEEPLIT_SSO_CLIENT_SECRET: sharedSecret,
  })
  const literatureNext = setValues(literatureOld, {
    APP_PORT: '3000',
    POSTGRES_PORT: '127.0.0.1:5433',
    POSTGRES_PASSWORD: literaturePassword,
    DEEPLIT_AUTH_MODE: 'openresearch',
    DEEPLIT_OPENRESEARCH_URL: 'http://host.docker.internal:5300',
    DEEPLIT_OPENRESEARCH_PUBLIC_ORIGIN: platformOrigin,
    DEEPLIT_OPENRESEARCH_APP_ORIGIN: appOrigin,
    DEEPLIT_PUBLIC_ORIGIN: literatureOrigin,
    DEEPLIT_SSO_CLIENT_SECRET: sharedSecret,
    DEEPLIT_COOKIE_MODE: 'same-site',
    DEEPLIT_SECURE_COOKIES: 'false',
    DEEPLIT_PASSWORD_PEPPER: secret(literatureOld, 'DEEPLIT_PASSWORD_PEPPER') || randomBytes(32).toString('hex'),
    CRON_SECRET: secret(literatureOld, 'CRON_SECRET') || randomBytes(32).toString('hex'),
    QWEN_API_KEY: modelKey,
  })
  saveEnv(platformEnv, platformNext)
  saveEnv(literatureEnv, literatureNext)
  if (literaturePassword === 'deeplit-local-password') {
    console.warn('沿用现有 Deep Literature 数据库的本地默认密码；请在迁移数据库密码后更新 .env.local。')
  }
  return { hasModelKey: Boolean(modelKey) }
}

function requireCommand(command, args = ['--version']) {
  const result = spawnSync(command, args, { stdio: 'ignore' })
  if (result.error || result.status !== 0) throw new Error(`缺少可用的 ${command}；请先安装并确认它在 PATH 中。`)
}

function run(command, args, cwd, env = process.env) {
  console.log(`\n$ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} 退出码 ${result.status ?? 'unknown'}`)
}

async function waitFor(url, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
      if (response.ok) return
    } catch { /* Service is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  throw new Error(`${label} 未就绪：${url}。请查看对应 docker compose logs。`)
}

async function main() {
  const options = optionsFrom(process.argv.slice(2))
  if (!existsSync(path.join(options.deeplitDir, 'compose.yaml'))) {
    throw new Error(`未找到 Deep Literature 仓库：${options.deeplitDir}。可用 --deeplit-dir 指定。`)
  }
  requireCommand('docker', ['compose', 'version'])
  requireCommand('pnpm')
  requireCommand('cargo')
  run('docker', ['info', '--format', '{{.ServerVersion}}'], root)
  const { hasModelKey } = configure(options.deeplitDir, options.withWorkers)

  run('pnpm', ['install', '--frozen-lockfile'], path.join(root, 'ui'))
  run('pnpm', ['build'], path.join(root, 'ui'))
  run('cargo', ['build', '--release', '--locked'], root)

  const platformDir = path.join(root, 'packages/platform')
  run('docker', ['compose', '-f', 'compose.yaml', '-f', 'compose.dev.yaml', 'up', '-d', '--build'], platformDir)
  await waitFor(`${platformOrigin}/healthz`, '统一账号服务')

  const startWorkers = options.withWorkers || hasModelKey
  const services = startWorkers
    ? []
    : ['db', 'migrate', 'web']
  run('docker', ['compose', '--env-file', '.env.local', 'up', '-d', '--build', ...services], options.deeplitDir)
  await waitFor(`${literatureOrigin}/api/papers?limit=1`, 'Deep Literature', 180_000)

  console.log(`\n服务就绪：${appOrigin}  |  ${platformOrigin}  |  ${literatureOrigin}`)
  if (!startWorkers) console.log('后台 Worker 未启动；需要自动采集和 Blog 时，在 .env.local 配置 QWEN_API_KEY 后重跑脚本。')
  console.log('本地 OpenResearch 在当前终端运行；按 Ctrl+C 停止它，Docker 服务继续运行。')
  const child = spawn(path.join(root, 'target/release/orx'), ['up', ...(options.open ? [] : ['--no-browser'])], {
    cwd: root,
    env: {
      ...process.env,
      ORX_ACCOUNT_URL: platformOrigin,
      ORX_DEEP_LITERATURE_URL: 'http://127.0.0.1:3000',
      ORX_DEEP_LITERATURE_WEB_URL: literatureOrigin,
    },
    stdio: 'inherit',
  })
  child.on('error', (error) => { console.error(error); process.exitCode = 1 })
  child.on('exit', (code) => { process.exitCode = code || 0 })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main().catch((error) => { console.error(`启动失败：${error.message}`); process.exitCode = 1 })

export { optionsFrom, setValues, valueOf }
