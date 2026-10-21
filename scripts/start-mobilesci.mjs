#!/usr/bin/env node
// Start the personal MobileSci workspace without replacing its data or credentials.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appOrigin = 'http://localhost:4791'
const platformOrigin = 'http://localhost:5300'
const literatureOrigin = 'http://localhost:3000'
const runtimeDir = path.join(root, '.mobilesci-run')

export function optionsFrom(args) {
  const result = { literatureDir: path.resolve(root, '../DeepLiterature'), rebuild: false }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--rebuild') result.rebuild = true
    else if (args[i] === '--deeplit-dir' && args[i + 1]) result.literatureDir = path.resolve(args[++i])
    else throw new Error(`未知参数：${args[i]}。支持 --rebuild、--deeplit-dir PATH。`)
  }
  return result
}

export function workspaceIsHealthy(body) {
  return body?.ok === true && typeof body.version === 'string' && typeof body.dashboardProtocol === 'number'
}

export function composeFiles(label, directory) {
  if (!label) return ['compose.yaml', 'compose.dev.yaml'].map(file => path.join(directory, file))
  return label.trim().split(',').map(file => {
    const resolved = path.resolve(file)
    if (path.dirname(resolved) !== directory || !existsSync(resolved)) throw new Error('现有账号服务使用其他目录的 Compose 配置，请在原部署目录启动。')
    return resolved
  })
}

export function sourceIsNewer(binary, sources) {
  if (!existsSync(binary)) return true
  const compiled = statSync(binary).mtimeMs
  const changed = file => {
    if (!existsSync(file)) return false
    const info = statSync(file)
    if (info.isDirectory()) return readdirSync(file).some(child => changed(path.join(file, child)))
    return info.mtimeMs > compiled
  }
  return sources.some(changed)
}

function run(command, args, directory = root, env = process.env) {
  console.log(`执行：${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { cwd: directory, env, stdio: 'inherit' })
  if (result.error) throw new Error(`无法运行 ${command}：${result.error.message}`)
  if (result.status !== 0) throw new Error(`${command} 执行失败（退出码 ${result.status}）。`)
}

async function ready(url, workspace = false) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) })
    return response.ok && (!workspace || workspaceIsHealthy(await response.json()))
  } catch { return false }
}

async function waitFor(url, name, workspace = false, timeout = 180000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await ready(url, workspace)) return
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error(`${name} 未就绪，请检查 .mobilesci-run/workspace.log 或对应 Docker 日志。`)
}

function lockStartup() {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  const lockDir = path.join(runtimeDir, 'start.lock')
  if (existsSync(lockDir)) {
    let active = true
    try {
      const pid = Number(readFileSync(path.join(lockDir, 'pid'), 'utf8'))
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('invalid pid')
      process.kill(pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') active = false
    }
    if (active) throw new Error('另一个启动脚本正在运行，请等待其完成。')
    rmSync(lockDir, { recursive: true })
  }
  mkdirSync(lockDir, { mode: 0o700 })
  writeFileSync(path.join(lockDir, 'pid'), String(process.pid), { mode: 0o600 })
  return () => rmSync(lockDir, { recursive: true, force: true })
}

async function ensureCompanions(options) {
  const [platformReady, literatureReady] = await Promise.all([
    ready(`${platformOrigin}/healthz`), ready(`${literatureOrigin}/api/papers?limit=1`),
  ])
  if (platformReady && literatureReady) { console.log('账号服务和 DeepXiv 已运行，复用现有服务。'); return }
  const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore' })
  if (docker.status !== 0) throw new Error('请先启动 Docker Desktop，再双击 start-mobilesci.command。')
  if (!platformReady) {
    const directory = path.join(root, 'packages/platform')
    if (!existsSync(path.join(directory, '.env'))) throw new Error('账号服务尚未配置 packages/platform/.env；脚本不会自动生成或覆盖凭据。')
    const previous = spawnSync('docker', ['inspect', 'openresearch-platform-platform-1', '--format', '{{ index .Config.Labels "com.docker.compose.project.config_files" }}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const files = composeFiles(previous.status === 0 ? previous.stdout.trim() : '', directory)
    run('docker', ['compose', ...files.flatMap(file => ['-f', file]), 'up', '-d'], directory)
    await waitFor(`${platformOrigin}/healthz`, '账号服务')
  }
  if (!literatureReady) {
    if (!existsSync(path.join(options.literatureDir, '.env.local'))) throw new Error('DeepXiv 尚未配置 .env.local；请完成既有服务配置后再启动。')
    run('docker', ['compose', '--env-file', '.env.local', 'up', '-d', 'db', 'migrate', 'web'], options.literatureDir)
    await waitFor(`${literatureOrigin}/api/papers?limit=1`, 'DeepXiv')
  }
}

async function main() {
  const options = optionsFrom(process.argv.slice(2))
  const unlock = lockStartup()
  try {
    await ensureCompanions(options)
    if (await ready(`${appOrigin}/api/health`, true)) {
      console.log(`MobileSci 已运行，保留当前研究会话：${appOrigin}/projects`)
      if (options.rebuild) console.log('当前服务正在运行；未重建或重启。请停止服务后使用 --rebuild。')
      return
    }
    // A response from an unrelated process is not a workspace we may replace.
    try {
      await fetch(appOrigin, { signal: AbortSignal.timeout(2000) })
      throw new Error('4791 端口被其他服务占用，请确认后再启动。')
    } catch (error) { if (error.message.includes('4791')) throw error }
    if (!existsSync(path.join(root, 'ui/node_modules'))) run('pnpm', ['--dir', 'ui', 'install', '--frozen-lockfile'])
    run('pnpm', ['--dir', 'ui', 'build'])
    const target = path.join(os.homedir(), '.local/share/openresearch-dev/cargo-target')
    const binary = path.join(target, 'debug/orx')
    if (options.rebuild || sourceIsNewer(binary, ['src', 'agent-skills', 'ui/dist', 'ui/src/researchWorkflows.json', 'Cargo.toml', 'Cargo.lock', 'build.rs'].map(file => path.join(root, file)))) {
      run('cargo', ['build', '--locked', '-j', '2'], root, { ...process.env, CARGO_TARGET_DIR: target })
    }
    const logFile = path.join(runtimeDir, 'workspace.log')
    const log = openSync(logFile, 'a', 0o600)
    let child
    try {
      child = spawn(binary, ['up', '--no-browser', '--port', '4791'], {
        cwd: root, detached: true, stdio: ['ignore', log, log],
        env: { ...process.env, ORX_ACCOUNT_URL: platformOrigin, ORX_DEEP_LITERATURE_URL: 'http://127.0.0.1:3000', ORX_DEEP_LITERATURE_WEB_URL: literatureOrigin },
      })
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
      writeFileSync(path.join(runtimeDir, 'workspace.json'), JSON.stringify({ pid: child.pid, url: appOrigin, binary, startedAt: new Date().toISOString() }, null, 2), { mode: 0o600 })
      child.unref()
    } finally { closeSync(log) }
    await waitFor(`${appOrigin}/api/health`, 'MobileSci 工作区', true)
    console.log(`\nMobileSci 已启动：${appOrigin}/projects\n账号服务：${platformOrigin}\nDeepXiv：${literatureOrigin}\n后台 PID：${child.pid}\n日志：${logFile}\n关闭启动窗口不会停止 MobileSci；再次运行脚本会复用现有服务。`)
  } finally { unlock() }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`启动失败：${error.message}`); process.exitCode = 1 })
}
