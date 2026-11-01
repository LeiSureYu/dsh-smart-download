/**
 * SPIKE 1.9：aria2 常驻 RPC 模式的三问实测（Windows 真机）。
 *
 * Q1 生命周期：宿主进程死亡后，daemon 会孤儿化吗？Windows 上 --stop-with-pid
 *    不存在（实测 unknown option），stdin-EOF watchdog 能否作为可行替代？
 * Q2 延迟：RPC pause/unpause 的原地继续，比 1.8 的「杀进程 + -c 重启」快多少？
 * Q3 控制文件：aria2 的 <output>.aria2 与本插件自建的 <output>.part.json 能否共存？
 *
 * 全程本机回环。结论写入 docs/SPIKE-1.9-RPC.md。
 *
 * 用法：node scripts/spike-1.9-rpc.mjs
 */
import { spawn, execSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const A2C = require('../dist/downloader.js').getAria2Path()
const WATCHDOG = path.join(here, 'spike-1.9-rpc-watchdog.mjs')
const BODY = Buffer.alloc(8 * 1024 * 1024, 0x41) // 8MiB

if (!A2C) {
  console.error('SPIKE: 找不到 aria2c')
  process.exit(1)
}

const WORK = mkdtempSync(path.join(tmpdir(), 'spike-rpc-'))
const BASE_PORT = 16800 + Math.floor(Math.random() * 500)
const SECRET = 'spike-secret-' + Date.now()
const results = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function startOrigin() {
  const server = createServer((req, res) => {
    const range = req.headers.range
    if (range) {
      const m = /bytes=(\d+)-(\d+)?/.exec(range)
      const start = m ? Number(m[1]) : 0
      const end = m && m[2] ? Math.min(Number(m[2]), BODY.length - 1) : BODY.length - 1
      res.writeHead(206, {
        'content-type': 'application/octet-stream',
        'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${BODY.length}`,
        'accept-ranges': 'bytes',
      })
      res.end(BODY.subarray(start, end + 1))
      return
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(BODY.length),
      'accept-ranges': 'bytes',
    })
    res.end(BODY)
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({ port, close: () => server.close() })
    }),
  )
}

function killTree(pid) {
  try {
    execSync('taskkill /PID ' + pid + ' /F /T', { stdio: 'ignore' })
  } catch {
    /* already dead */
  }
}

/** SPIKE 专用清理：杀掉本机所有 aria2c，避免上一阶段的孤儿占住端口 */
function killAllAria2() {
  try {
    execSync('taskkill /IM aria2c.exe /F', { stdio: 'ignore' })
  } catch {
    /* none running */
  }
}

function aria2Alive(pid) {
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: 'utf8' })
    return out.includes('aria2c.exe')
  } catch {
    return false
  }
}

async function rpcCall(port, method, params) {
  const res = await fetch(`http://127.0.0.1:${port}/jsonrpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'spike', method, params: ['token:' + SECRET, ...params] }),
  })
  const json = await res.json()
  if (json.error) throw new Error('RPC ' + method + ': ' + json.error.message)
  return json.result
}

async function rpcReady(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const v = await rpcCall(port, 'aria2.getVersion', [])
      if (v && v.version) return v.version
    } catch {
      /* not ready */
    }
    if (Date.now() > deadline) throw new Error('RPC 未在时限内就绪 (port ' + port + ')')
    await sleep(200)
  }
}

/**
 * 宿主子进程：spawn watchdog（或直接 daemon），上报 daemon pid，然后常驻等待被杀。
 * useWatchdog=true → 宿主持有 watchdog 的 stdin 管道；false → 直接 spawn daemon（对照组）。
 */
function spawnHost({ port, useWatchdog }) {
  const host = spawn(
    process.execPath,
    [
      '-e',
      [
        "const { spawn } = require('node:child_process')",
        "const [a2c, watchdog, port, secret, dir, useWatchdog] = process.argv.slice(1)",
        "let child",
        "if (useWatchdog === '1') {",
        "  child = spawn(process.execPath, [watchdog, a2c, port, secret, dir], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })",
        "  // 中继 watchdog 的 stdout：daemon pid 与 DAEMON_EXIT 诊断都在那里",
        "  child.stdout.on('data', (c) => process.stdout.write(c))",
        "} else {",
        "  child = spawn(a2c, ['--enable-rpc=true', '--rpc-listen-port=' + port, '--rpc-secret=' + secret, '--dir=' + dir, '--file-allocation=none', '--console-log-level=warn'], { stdio: 'ignore', windowsHide: true })",
        "  process.stdout.write(String(child.pid))",
        "}",
        "setInterval(() => {}, 1000)",
      ].join('\n'),

      A2C,
      WATCHDOG,
      String(port),
      SECRET,
      WORK,
      useWatchdog ? '1' : '0',
    ],
    { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true },
  )
  return host
}
async function waitDaemonAndRpc(host, port, timeoutMs = 15000) {
  let daemonPid = 0
  let out = ''
  host.stdout.on('data', (c) => {
    out += c
    const m = /(\d+)/.exec(out)
    if (m && !daemonPid) daemonPid = Number(m[1])
  })
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (daemonPid && aria2Alive(daemonPid)) break
    if (Date.now() > deadline) throw new Error('daemon 未就绪 (host stdout: ' + JSON.stringify(out.slice(0, 80)) + ')')
    await sleep(150)
  }
  await rpcReady(port)
  return daemonPid
}

/* ---------------- Q1：孤儿测试 ---------------- */

async function orphanExperiment({ port, useWatchdog }) {
  killAllAria2()
  const host = spawnHost({ port, useWatchdog })
  let daemonPid = 0
  try {
    daemonPid = await waitDaemonAndRpc(host, port)
  } catch (err) {
    killTree(host.pid)
    throw err
  }
  // 杀宿主：只杀宿主进程本身（不带 /T，否则树杀会连 daemon 一起带走）
  try {
    execSync('taskkill /PID ' + host.pid + ' /F', { stdio: 'ignore' })
  } catch {
    /* */
  }
  await sleep(300)
  const samples = []
  for (let i = 0; i < 16; i++) {
    samples.push(aria2Alive(daemonPid))
    if (!samples[samples.length - 1]) break
    await sleep(500)
  }
  const orphaned = samples[samples.length - 1] === true
  killTree(daemonPid)
  return { orphaned, diedAfterMs: samples.lastIndexOf(false) * 500 }
}

/* ---------------- Q2：延迟对比 ---------------- */

async function latencyExperiment(originPort, rpcPort) {
  killAllAria2()
  const outRpc = path.join(WORK, 'rpc.bin')
  const url = `http://127.0.0.1:${originPort}/big.bin`

  const daemon = spawn(
    A2C,
    [
      '--enable-rpc=true',
      '--rpc-listen-port=' + rpcPort,
      '--rpc-secret=' + SECRET,
      '--dir=' + WORK,
      '--file-allocation=none',
      '--allow-overwrite=true',
      '--auto-file-renaming=false',
      '--max-connection-per-server=8',
      '--console-log-level=warn',
    ],
    { stdio: 'ignore', windowsHide: true },
  )
  try {
    await rpcReady(rpcPort)
    const gid = await rpcCall(rpcPort, 'aria2.addUri', [[url], { dir: WORK, out: 'rpc.bin' }])
    // 等到有进度（>1MiB）再暂停，保证续传跨得过断点
    for (;;) {
      const st = await rpcCall(rpcPort, 'aria2.tellStatus', [gid, ['completedLength']])
      if (Number(st.completedLength) >= 1024 * 1024) break
      await sleep(30)
    }

    const tPause0 = Date.now()
    await rpcCall(rpcPort, 'aria2.pause', [gid])
    let pauseLatency = -1
    for (;;) {
      const st = await rpcCall(rpcPort, 'aria2.tellStatus', [gid, ['status']])
      if (st.status === 'paused') {
        pauseLatency = Date.now() - tPause0
        break
      }
      if (Date.now() - tPause0 > 5000) throw new Error('pause 未生效')
      await sleep(15)
    }
    const ctrl = path.join(WORK, 'rpc.bin.aria2')
    const ctrlAfterPause = existsSync(ctrl)

    const tResume0 = Date.now()
    await rpcCall(rpcPort, 'aria2.unpause', [gid])
    let resumeLatency = -1
    let last = Number((await rpcCall(rpcPort, 'aria2.tellStatus', [gid, ['completedLength']])).completedLength)
    for (;;) {
      const st = await rpcCall(rpcPort, 'aria2.tellStatus', [gid, ['completedLength', 'status']])
      const done = Number(st.completedLength)
      if (done > last + 256 * 1024 || st.status === 'complete') {
        resumeLatency = Date.now() - tResume0
        break
      }
      if (Date.now() - tResume0 > 20000) throw new Error('unpause 后未恢复传输')
      last = done
      await sleep(20)
    }

    for (;;) {
      const st = await rpcCall(rpcPort, 'aria2.tellStatus', [gid, ['status']])
      if (st.status === 'complete') break
      if (st.status === 'error') throw new Error('RPC 下载失败')
      await sleep(100)
    }

    results.push({ what: 'Q2 RPC pause 延迟（调用 → 状态 paused）', ms: pauseLatency })
    results.push({ what: 'Q2 RPC unpause 恢复传输延迟（unpause → 字节再增 ≥256KiB）', ms: resumeLatency })
    results.push({
      what: 'Q3 .aria2 控制文件：暂停后存在 / 完成后清理',
      ms: ctrlAfterPause && !existsSync(ctrl) ? 1 : 0,
      note: ctrlAfterPause && !existsSync(ctrl) ? '存在 → 清理 ✓' : '暂停后存在: ' + ctrlAfterPause,
    })
    results.push({ what: 'Q3 RPC 产物 8MiB 完整落盘', ms: statSync(outRpc).size, note: '字节' })
  } finally {
    killTree(daemon.pid)
  }

  // ---- 1.8 spawn 路径对照：直启 → 进度 → 杀进程 → -c 重启 ----
  killAllAria2()
  const outSpawn = path.join(WORK, 'spawn.bin')
  const urlSpawn = `http://127.0.0.1:${originPort}/big.bin`
  const spawnOnce = () =>
    spawn(
      A2C,
      [
        urlSpawn,
        '-d', WORK,
        '-o', 'spawn.bin',
        '-c',
        '--file-allocation=none',
        '--allow-overwrite=true',
        '--auto-file-renaming=false',
        '--summary-interval=0',
        '--console-log-level=error',
      ],
      { stdio: 'ignore', windowsHide: true },
    )
  const fileSize = () => (existsSync(outSpawn) ? statSync(outSpawn).size : 0)

  let child = spawnOnce()
  for (;;) {
    if (fileSize() >= 1024 * 1024) break
    await sleep(20)
  }
  child.kill()
  await sleep(300)
  try {
    child.kill('SIGKILL')
  } catch {
    /* */
  }
  const beforeRestart = fileSize()

  const t0 = Date.now()
  child = spawnOnce()
  let resumed = 0
  for (;;) {
    resumed = fileSize()
    if (resumed >= BODY.length || resumed > beforeRestart + 256 * 1024) break
    if (Date.now() - t0 > 20000) throw new Error('-c 重启后未恢复传输')
    await sleep(20)
  }
  const restartLatency = Date.now() - t0
  killTree(child.pid)
  results.push({ what: 'Q2 1.8 spawn -c 重启恢复延迟（重启 → 字节再增 ≥256KiB，不含探测/指纹）', ms: restartLatency })
  results.push({ what: 'Q2 1.8 重启前/恢复后落盘字节', ms: beforeRestart, note: '→ ' + resumed + '（字节）' })
}

/* ---------------- 主流程 ---------------- */

console.log('=== SPIKE 1.9：aria2 常驻 RPC（Windows 真机） ===')
console.log('aria2c:', A2C)

const origin = await startOrigin()
console.log('origin: http://127.0.0.1:' + origin.port + '（8MiB，支持 Range）')

console.log('\n--- Q1a 无 stop-with-pid（问题演示） ---')
const a1 = await orphanExperiment({ port: BASE_PORT, useWatchdog: false })
results.push({
  what: 'Q1a 宿主死亡后 daemon（无绑定机制）',
  ms: a1.orphaned ? 1 : 0,
  note: a1.orphaned ? '存活 → 孤儿（问题确认）' : '已退出',
})

console.log('\n--- Q1b --stop-with-pid（选项存在性） ---')
results.push({
  what: 'Q1b --stop-with-pid 在 Windows 构建',
  ms: 0,
  note: '实测 unknown option —— POSIX-only，1.37.0 Windows 构建没有它',
})

console.log('\n--- Q1c stdin-EOF watchdog（Windows 可行的绑定方案） ---')
const a3 = await orphanExperiment({ port: BASE_PORT + 1, useWatchdog: true })
results.push({
  what: 'Q1c 宿主死亡后 stdin-EOF watchdog 的 daemon',
  ms: a3.orphaned ? 1 : 0,
  note: a3.orphaned ? '存活 → 方案无效' : '已退出 → 无孤儿（方案实测有效）',
})

console.log('\n--- Q2/Q3 延迟与控制文件 ---')
await latencyExperiment(origin.port, BASE_PORT + 2)

console.log('\n=== 实测汇总 ===')
for (const r of results) {
  console.log(r.note ? `${r.what} — ${r.note}` : `${r.what}: ${r.ms}`)
}

origin.close()
rmSync(WORK, { recursive: true, force: true })
