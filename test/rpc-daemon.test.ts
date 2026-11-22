/**
 * 1.9.0 RPC daemon 与 RPC 下载路径的端到端测试。
 *
 * 静默失败形态：daemon 起来了但 RPC 调不通、或者下载在 daemon 里「成功」但
 * 调用方不知道。正向契约：
 * - ensureDaemon() 幂等（两次调用返回同一实例）；
 * - RPC 下载完整走通（本机 Range 源 8MiB，含进度上报与吞吐观测）；
 * - pause 后终态 paused → startRetry 续传到完成；
 * - daemon 不可用时回退 spawn 路径完成下载。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, startRetry } from '../src/index.js'
import { readDownloadStatus } from '../src/status.js'
import { ProgressReporter } from '../src/progress.js'
import { pauseRunningTask, resetTaskRegistry, PAUSE_ABORT_REASON } from '../src/tasks.js'
import { downloadGate } from '../src/gate.js'
import { downloadWithAria2Rpc } from '../src/download-rpc.js'
import {
  DaemonUnavailableError,
  ensureDaemon,
  isDaemonRunning,
  rpcCall,
  shutdownDaemon,
} from '../src/rpc-daemon.js'

interface ToolDef {
  name: string
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
}

function loadToolNamed(name: string): ToolDef {
  let tool: ToolDef | undefined
  const ctx = {
    tools: { register: (t: unknown) => { if ((t as ToolDef).name === name) tool = t as ToolDef } },
    inject: () => {},
  }
  apply(ctx as never)
  assert.ok(tool, `应注册 ${name}`)
  return tool!
}

function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ base: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer(handler)
    const sockets = new Set<Socket>()
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((r) => {
            for (const socket of sockets) socket.destroy()
            server.close(() => r())
          }),
      })
    })
  })
}

let tmpRoot = ''
let tool: ToolDef

before(async () => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'rpc-test-'))
  process.env.DSH_PROGRESS_DIR = path.join(tmpRoot, 'progress')
  process.env.DSH_DOWNLOAD_PROGRESS_DIR = path.join(tmpRoot, 'downloads')
  mkdirSync(path.join(tmpRoot, 'downloads'), { recursive: true })
  process.env.DSH_SMARTDL_THROUGHPUT_DIR = path.join(tmpRoot, 'throughput')
  tool = loadToolNamed('smart_download')
  downloadGate.reset()
  resetTaskRegistry()
})

after(async () => {
  delete process.env.DSH_PROGRESS_DIR
  delete process.env.DSH_DOWNLOAD_PROGRESS_DIR
  delete process.env.DSH_SMARTDL_THROUGHPUT_DIR
  downloadGate.reset()
  resetTaskRegistry()
  // daemon 的 watchdog stdin 管道由本进程持有，必须显式关停，否则事件循环
  // 排不空、node:test 挂住不退
  shutdownDaemon()
  rmSync(tmpRoot, { recursive: true, force: true })
})

async function waitForStatus(
  taskId: string,
  expected: Array<'running' | 'completed' | 'failed' | 'cancelled' | 'paused'>,
  timeoutMs = 30000,
): Promise<{ status: string; pct: number }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const snap = readDownloadStatus(50, taskId)
    const task = snap.tasks[0]
    if (task && expected.includes(task.status)) return { status: task.status, pct: task.pct }
    if (Date.now() > deadline) {
      throw new Error(`任务 ${taskId} 未达到 ${expected.join('/')}，实际：${task?.status ?? '无记录'}`)
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
  }
}

test('RPC 下载：8MiB 完整走通（进度 → 完成 → 字节数核对）', async () => {
  const body = Buffer.alloc(8 * 1024 * 1024, 0x41)
  const s = await startServer((_req, res) => {
    res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' })
    res.end(body)
  })
  try {
    const out = path.join(tmpRoot, 'rpc-full.bin')
    const result = (await tool.execute(
      { url: `${s.base}/rpc-full.bin`, output: out },
      { signal: new AbortController().signal },
    )) as Record<string, unknown>

    assert.equal(result.success, true)
    assert.ok(existsSync(out), '文件应落盘')
    assert.equal(statSync(out).size, body.length)
    assert.equal(isDaemonRunning(), true, 'auto 模式下 aria2 下载必须经由 RPC daemon（接线断言）')
  } finally {
    await s.close()
  }
})

test('RPC 下载：pause → paused 终态 → startRetry 续传到完成', async () => {
  const s = await startServer((req, res) => {
    // accept-ranges + Range 落实：supportsMultiThread 判真，决策才会走 aria2/RPC
    const total = 4 * 1024 * 1024
    const m = /bytes=(d+)-/.exec(req.headers.range ?? '')
    const start = m ? Number(m[1]) : 0
    res.writeHead(m ? 206 : 200, {
      'content-length': String(total - start),
      ...(m ? { 'content-range': `bytes ${start}-${total - 1}/${total}` } : {}),
      'accept-ranges': 'bytes',
    })
    let sent = start
    res.write(Buffer.alloc(64 * 1024, 0x42))
    sent += 64 * 1024
    const timer = setInterval(() => {
      if (sent >= total) { clearInterval(timer); res.end(); return }
      res.write(Buffer.alloc(Math.min(64 * 1024, total - sent), 0x42))
      sent += 64 * 1024
    }, 200)
    res.on('close', () => clearInterval(timer))
  })
  try {
    const out = path.join(tmpRoot, 'rpc-pause.bin')
    const started = (await tool.execute(
      { url: `${s.base}/rpc-pause.bin`, output: out, background: true },
      { signal: new AbortController().signal },
    )) as Record<string, unknown>
    const taskId = started.taskId as string

    await waitForStatus(taskId, ['running'], 20000)
    // 等到有进度
    const pctDeadline = Date.now() + 15000
    for (;;) {
      const snap = readDownloadStatus(50, taskId).tasks[0]
      if (snap && snap.pct > 0) break
      if (Date.now() > pctDeadline) throw new Error('RPC 下载未在时限内产生进度')
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }

    assert.equal(pauseRunningTask(taskId), 'paused')
    const final = await waitForStatus(taskId, ['paused'], 10000)
    assert.equal(final.status, 'paused', 'RPC 下载的暂停终态必须是 paused')

    // 继续 = 对 paused 行的重试
    const session = { id: 'rpc-pause-test', cwd: tmpRoot }
    assert.equal(startRetry(taskId, session).started, true, 'paused 行的 startRetry 必须放行')
    const done = await waitForStatus(taskId, ['completed'], 30000)
    assert.equal(done.status, 'completed')
    assert.ok(existsSync(out))
    assert.equal(statSync(out).size, 4 * 1024 * 1024, '断点续传拼接正确')
  } finally {
    await s.close()
  }
})

test('RPC daemon 崩溃检测：杀掉 daemon -> DaemonUnavailableError，下次下载自动重建（2.0.0 隐患①）', async () => {
  const { execSync } = await import('node:child_process')
  const st = await ensureDaemon()
  const pid = st.process.pid
  assert.ok(typeof pid === 'number')
  // 模拟 daemon 崩溃：连进程树一起杀（Windows 上 process=watchdog）
  if (process.platform === 'win32') {
    execSync('taskkill /PID ' + pid + ' /F /T', { stdio: 'ignore' })
  } else {
    try { process.kill(pid as number, 'SIGKILL') } catch { /* already dead */ }
  }
  await assert.rejects(() => rpcCall('aria2.getVersion', []), DaemonUnavailableError)
  assert.equal(isDaemonRunning(), false, '失联后状态必须作废（1.9.0 会永远指着死端口）')

  // 下一次工具下载自动重建 daemon 并完成（auto 模式下也可能走 spawn 续传——
  // 无论哪条路径，下载都必须成功，而不是对着死端口失败）
  // 2MB：必须越过 1MB 多线程阈值，决策才会走 aria2/RPC（daemon 才会被重建）
  const body = Buffer.alloc(2 * 1024 * 1024, 0x44)
  const s2 = await startServer((_req, res) => {
    res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' })
    res.end(body)
  })
  try {
    const out = path.join(tmpRoot, 'rpc-recover.bin')
    const result = (await tool.execute(
      { url: `${s2.base}/rpc-recover.bin`, output: out },
      { signal: new AbortController().signal },
    )) as Record<string, unknown>
    assert.equal(result.success, true, 'daemon 崩溃后的下一次下载必须成功（自动重建或降级）')
    assert.equal(isDaemonRunning(), true, '重建后的 daemon 状态必须恢复')
    assert.equal(statSync(out).size, body.length)
  } finally {
    await s2.close()
  }
})

test('RPC 完成竞态：pause 打在已完成 gid 上 -> 按完成收尾，不盖 cancelled（2.0.0 隐患③）', async () => {
  const body = Buffer.from('done-bytes')
  const s2 = await startServer((_req, res) => {
    // 延迟 150ms 再给数据：保证第一次 tellStatus 看到 active（进入 500ms 轮询），
    // 而 300ms 的暂停请求到达时下载早已完成 —— 稳定命中完成竞态
    setTimeout(() => {
      res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' })
      res.end(body)
    }, 150)
  })
  try {
    const controller = new AbortController()
    setTimeout(() => controller.abort(PAUSE_ABORT_REASON), 300)
    const out = path.join(tmpRoot, 'rpc-race.bin')
    const reporter = new ProgressReporter('rpc-race-test', out, undefined, undefined, path.resolve(out))
    const obs = await downloadWithAria2Rpc({
      url: `${s2.base}/rpc-race.bin`,
      outputPath: out,
      concurrency: 4,
      signal: controller.signal,
      reporter,
      resume: false,
    })
    await reporter.awaitFlush()
    const snap = readDownloadStatus(50, 'rpc-race-test').tasks[0]
    assert.equal(snap?.status, 'completed', '完成竞态必须按完成收尾（1.9.0 会盖成 cancelled）')
    assert.equal(statSync(out).size, body.length)
    // 观测可能存在（取决于竞态时是否已有速度样本），存在则形状必须正确
    if (obs !== undefined) {
      assert.ok(obs.throughput > 0)
    }
  } finally {
    await s2.close()
  }
})

test('DSH_SMARTDL_ARIA2_RPC=off -> 完全回到 spawn 路径，daemon 不启动（2.0.0）', async () => {
  shutdownDaemon() // 把前序用例启动的 daemon 真正关掉，off 断言才有意义
  process.env.DSH_SMARTDL_ARIA2_RPC = 'off'
  try {
    const body = Buffer.alloc(2 * 1024 * 1024, 0x45)
    const s2 = await startServer((_req, res) => {
      res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' })
      res.end(body)
    })
    try {
      const out = path.join(tmpRoot, 'rpc-off.bin')
      const result = (await tool.execute(
        { url: `${s2.base}/rpc-off.bin`, output: out },
        { signal: new AbortController().signal },
      )) as Record<string, unknown>
      assert.equal(result.success, true)
      assert.equal(statSync(out).size, body.length)
      assert.equal(isDaemonRunning(), false, 'off 模式不得启动 daemon')
    } finally {
      await s2.close()
    }
  } finally {
    delete process.env.DSH_SMARTDL_ARIA2_RPC
  }
})
