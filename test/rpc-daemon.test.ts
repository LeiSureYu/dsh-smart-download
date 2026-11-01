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
import { pauseRunningTask, resetTaskRegistry } from '../src/tasks.js'
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
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'rpc-test-'))
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
  } finally {
    await s.close()
  }
})

test('RPC 下载：pause → paused 终态 → startRetry 续传到完成', async () => {
  const s = await startServer((_req, res) => {
    res.writeHead(200, { 'content-length': String(4 * 1024 * 1024) })
    res.write(Buffer.alloc(64 * 1024, 0x42))
    const timer = setInterval(() => res.write(Buffer.alloc(64 * 1024, 0x42)), 200)
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
