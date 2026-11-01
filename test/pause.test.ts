/**
 * 暂停 / 继续（1.8.0）的端到端测试。
 *
 * 暂停与取消是同一个物理动作（终止子进程），差别只在终态语义与后续路径。
 * 因此正向契约是：
 * - 暂停后两条轨道的终态是 **paused**（不是 cancelled / failed）；
 * - 半包与旁车指纹保留 → startRetry 对 paused 行放行 → 从断点续传到完成；
 * - rpc `op:'pause'` 对 running / not-running / unknown 如实回告；
 * - 批量里一条被暂停 → 该条 `paused: true`，其余条目照常。
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
import { pauseRunningTask, resetTaskRegistry } from '../src/tasks.js'
import { pauseManagedTask } from '../src/rpc.js'
import { downloadGate } from '../src/gate.js'

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
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pause-test-'))
  process.env.DSH_PROGRESS_DIR = path.join(tmpRoot, 'progress')
  process.env.DSH_DOWNLOAD_PROGRESS_DIR = path.join(tmpRoot, 'downloads')
  mkdirSync(path.join(tmpRoot, 'downloads'), { recursive: true })
  tool = loadToolNamed('smart_download')
  downloadGate.reset()
  resetTaskRegistry()
})

after(async () => {
  delete process.env.DSH_PROGRESS_DIR
  delete process.env.DSH_DOWNLOAD_PROGRESS_DIR
  downloadGate.reset()
  resetTaskRegistry()
  rmSync(tmpRoot, { recursive: true, force: true })
})

/** 慢速源：发一小段后按间隔续传，给暂停留窗口 */
function slowHandler(res: ServerResponse): void {
  res.writeHead(200, { 'content-length': String(4 * 1024 * 1024) })
  res.write(Buffer.alloc(64 * 1024, 0x42))
  const timer = setInterval(() => res.write(Buffer.alloc(64 * 1024, 0x42)), 200)
  res.on('close', () => clearInterval(timer))
}

async function waitForStatus(
  taskId: string,
  expected: Array<'running' | 'completed' | 'failed' | 'cancelled' | 'paused'>,
  timeoutMs = 15000,
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

test('暂停：后台下载 → pauseRunningTask → 终态 paused → retry 续传到完成', async () => {
  const s = await startServer((_req, res) => slowHandler(res))
  try {
    const out = path.join(tmpRoot, 'pause-resume.bin')
    const started = await tool.execute(
      { url: `${s.base}/pause.bin`, output: out, background: true },
      { signal: new AbortController().signal },
    ) as Record<string, unknown>
    const taskId = started.taskId as string
    assert.equal(started.background, true)

    // 等下载真正开跑且已有进度（pct > 0 时暂停，续传才跨得过断点）
    await waitForStatus(taskId, ['running'], 20000)
    const pctDeadline = Date.now() + 15000
    for (;;) {
      const snap = readDownloadStatus(50, taskId).tasks[0]
      if (snap && snap.pct > 0) break
      if (Date.now() > pctDeadline) throw new Error('下载未在时限内产生进度')
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(pauseRunningTask(taskId), 'paused', '暂停请求必须被注册表接受')

    const final = await waitForStatus(taskId, ['paused'])
    assert.equal(final.status, 'paused', '终态必须是 paused（不是 cancelled / failed）')
    assert.equal(pctClamp(final.pct) > 0, true, '暂停时应有进度')

    // 继续 = 对 paused 行的重试（同 taskId、同代码路径）
    assert.equal(startRetry(taskId, { id: 'pause-test-session', cwd: tmpRoot }).started, true, 'paused 行的重试必须放行')

    const done = await waitForStatus(taskId, ['completed'], 30000)
    assert.equal(done.status, 'completed')
    assert.ok(existsSync(out), '文件应完整落盘')
    assert.equal(statSync(out).size, 4 * 1024 * 1024, '1MiB×4 的内容应完整（断点续传拼接正确）')
  } finally {
    await s.close()
  }
})

function pctClamp(pct: number): number {
  return Math.max(0, Math.min(100, pct))
}

test('rpc op:pause：running 之外如实回告（not-running / unknown）', async () => {
  // 先做一次真实前台下载产生记录
  const s = await startServer((_req, res) => {
    res.writeHead(200, { 'content-length': '128' })
    res.end(Buffer.alloc(128, 0x41))
  })
  try {
    const out = path.join(tmpRoot, 'pause-rpc-done.bin')
    await tool.execute(
      { url: `${s.base}/done.bin`, output: out },
      { signal: new AbortController().signal },
    )
    const doneTask = readDownloadStatus(50).tasks.find((t) => t.outPath === path.resolve(out))
    assert.ok(doneTask, '应有已完成的任务记录')

    // 已完成的任务：不在跑 → not-running，并带回记录状态
    const notRunning = pauseManagedTask(doneTask.id)
    assert.equal(notRunning.paused, false)
    assert.equal(notRunning.reason, 'not-running')
    assert.equal(notRunning.state, 'completed')

    // 从未见过的 id → unknown
    const unknown = pauseManagedTask('dl-no-such-task')
    assert.equal(unknown.paused, false)
    assert.equal(unknown.reason, 'unknown')
  } finally {
    await s.close()
  }
})

test('批量里一条被暂停：该条 paused:true，其余条目照常成功', async () => {
  const body = Buffer.alloc(64 * 1024, 0x43)
  const s = await startServer((_req, res) => {
    // 慢速源：给暂停留窗口
    res.writeHead(200, { 'content-length': String(body.length) })
    res.write(body.subarray(0, 1024))
    const timer = setInterval(() => res.write(body.subarray(1024)), 150)
    res.on('close', () => clearInterval(timer))
  })
  try {
    const outSlow = path.join(tmpRoot, 'batch-pause-slow.bin')
    const outFast = path.join(tmpRoot, 'batch-fast.bin')
    const execPromise = tool.execute(
      {
        targets: [
          { url: `${s.base}/slow.bin`, output: outSlow },
          { url: `${s.base}/fast.bin`, output: outFast },
        ],
      },
      { signal: new AbortController().signal },
    ) as Promise<Record<string, unknown>>

    // 等慢速条目开跑（有 running 记录）后暂停它
    let slowId = ''
    const deadline = Date.now() + 10000
    for (;;) {
      const running = readDownloadStatus(50).tasks.filter((t) => t.status === 'running')
      const hit = running.find((t) => t.outPath === path.resolve(outSlow))
      if (hit) {
        slowId = hit.id
        break
      }
      if (Date.now() > deadline) throw new Error('慢速条目未在时限内开始')
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(pauseRunningTask(slowId), 'paused')

    const batch = (await execPromise) as {
      results: Array<{ url: string; success: boolean; paused?: boolean; cancelled?: boolean }>
    }
    const slow = batch.results.find((r) => r.url === `${s.base}/slow.bin`)
    const fast = batch.results.find((r) => r.url === `${s.base}/fast.bin`)
    assert.ok(slow, '慢速条目应有逐条结果')
    assert.equal(slow.paused, true, '被暂停的条目必须标 paused（不是 cancelled / failed）')
    assert.equal(slow.success, false)
    assert.ok(fast, '另一条照常成功')
    assert.equal(fast.success, true)
    assert.equal(fast.paused, undefined, '成功条目不带 paused')
  } finally {
    await s.close()
  }
})
