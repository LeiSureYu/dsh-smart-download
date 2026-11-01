/**
 * background:true 的 execute 层端到端测试（1.7.0）。
 *
 * 静默失败形态：后台任务的失败只进进度轨道，调用方拿不到任何异常 —— 如果
 * preflight 没有前移，「非法参数 + background」会变成「看似提交成功、实际哪也
 * 没去」。正向契约：
 * - 返回值立即携带 taskId / batch，且**首条进度记录已落盘**（download_status
 *   立即可查，而不是「查了个寂寞」）；
 * - 非法入参在 background:true 下仍然**同步抛错**，且不留下任何任务痕迹；
 * - 后台任务可被进程内注册表取消，终态是 cancelled（不是 failed）；
 * - 后台批量返回批次 ID，download_status(batchId) 能把整批归组并等到全终态。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../src/index.js'
import { readDownloadStatus } from '../src/status.js'
import { cancelRunningTask, resetTaskRegistry } from '../src/tasks.js'
import { downloadGate } from '../src/gate.js'

interface ToolDef {
  name: string
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
  output?: { render?: (args: unknown, value: unknown) => Array<{ type: string; text: string }> }
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
let statusTool: ToolDef

before(async () => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'background-test-'))
  process.env.DSH_PROGRESS_DIR = path.join(tmpRoot, 'progress')
  process.env.DSH_DOWNLOAD_PROGRESS_DIR = path.join(tmpRoot, 'downloads')
  mkdirSync(path.join(tmpRoot, 'downloads'), { recursive: true })
  tool = loadToolNamed('smart_download')
  statusTool = loadToolNamed('download_status')
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

async function run(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const exec = { signal: new AbortController().signal }
  return (await tool.execute(args, exec)) as Record<string, unknown>
}

/** 轮询直到任务达到期望状态（终态判定来自与 download_status 同一份读取端）。 */
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
      throw new Error(
        `任务 ${taskId} 在 ${timeoutMs}ms 内未达到 ${expected.join('/')}，实际：${task?.status ?? '无记录'}`,
      )
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
  }
}

test('后台单条目：立即返回 taskId，首条记录立即可查，最终 completed 且文件落盘', async () => {
  const body = Buffer.alloc(64 * 1024, 0x41)
  const s = await startServer((_req, res) => {
    res.writeHead(200, { 'content-length': String(body.length) })
    res.end(body)
  })
  try {
    const out = path.join(tmpRoot, 'bg-single.bin')
    const started = Date.now()
    const result = await run({ url: `${s.base}/bg-single.bin`, output: out, background: true })
    const elapsed = Date.now() - started

    assert.equal(result.background, true)
    assert.equal(result.success, true)
    assert.equal(typeof result.taskId, 'string')
    assert.equal(result.url, `${s.base}/bg-single.bin`)
    assert.equal(result.output, path.resolve(out))
    // 「立即」的断言：整次调用必须在秒级以内（真实下载还要等 curl/aria2 跑完）
    assert.ok(elapsed < 5000, `后台提交不应等待下载完成（实际 ${elapsed}ms）`)

    // 首条进度记录在返回前就已落盘：download_status 立即可查
    const snap = readDownloadStatus(50, result.taskId as string)
    assert.ok(snap.tasks[0], '返回后 download_status 必须立即能查到该任务')

    const final = await waitForStatus(result.taskId as string, ['completed'])
    assert.equal(final.status, 'completed')
    assert.ok(existsSync(out), '文件应落盘')
    assert.equal((await import('node:fs')).statSync(out).size, body.length)
  } finally {
    await s.close()
  }
})

test('background 传非布尔值：同步拒绝，而不是静默落回前台', async () => {
  // "yes" 是 truthy，调用方要的是后台；静默当成前台等于把「立即返回」变成
  // 「同步等 30 分钟」。显式拒绝，与 maxBandwidth / timeoutMs 同一套纪律。
  const err = await run({ url: 'https://example.com/a.zip', background: 'yes' }).then(
    () => null,
    (e: unknown) => e as Error,
  )
  assert.ok(err, 'background: "yes" 必须被拒绝')
  // 双层防线都要能拦：宿主的 schema 校验（dsh-tools）先拦；若调用方绕过
  // schema 直达 execute，插件自己的守卫（index.ts 0a-2）拦第二道。
  assert.match(
    err!.message,
    /must be a boolean|background 必须是布尔值/,
    'schema 校验或插件守卫至少一道必须拒绝',
  )
})

test('后台 + 非法 URL：同步抛错，且不留任务痕迹（preflight 前移的意义）', async () => {
  const result = await run({ url: 'file:///C:/Windows/win.ini', background: true }).then(
    () => ({ threw: false as const }),
    (err: unknown) => ({ threw: true as const, message: err instanceof Error ? err.message : String(err) }),
  )
  assert.equal(result.threw, true, '非法 URL 必须在调用处同步抛错')
  const snap = readDownloadStatus(50)
  assert.equal(
    snap.tasks.filter((t) => t.msg.includes('win.ini')).length,
    0,
    '不得留下「看似提交、实际没跑」的任务记录',
  )
})

test('后台任务可被进程内注册表取消，终态 cancelled（不是 failed）', async () => {
  const s = await startServer((_req, res) => {
    // 慢速源：发一小段后长时间挂起，给取消留窗口
    res.writeHead(200, { 'content-length': String(4 * 1024 * 1024) })
    res.write(Buffer.alloc(64 * 1024, 0x42))
    const timer = setInterval(() => res.write(Buffer.alloc(64 * 1024, 0x42)), 200)
    res.on('close', () => clearInterval(timer))
  })
  try {
    const out = path.join(tmpRoot, 'bg-cancel.bin')
    const result = await run({ url: `${s.base}/bg-cancel.bin`, output: out, background: true })
    const taskId = result.taskId as string
    // 等下载真正开跑（有进度记录）
    await new Promise<void>((resolve) => setTimeout(resolve, 500))
    assert.equal(cancelRunningTask(taskId), 'cancelled', '取消必须被注册表接受')
    const final = await waitForStatus(taskId, ['cancelled'])
    assert.equal(final.status, 'cancelled')
  } finally {
    await s.close()
  }
})

test('后台批量：返回批次 ID 与条目数，batchId 过滤可归组，全部到终态', async () => {
  const body = Buffer.alloc(32 * 1024, 0x43)
  const s = await startServer((req, res) => {
    res.writeHead(200, { 'content-length': String(body.length) })
    res.end(req.url?.includes('b') ? body : Buffer.alloc(16 * 1024, 0x44))
  })
  try {
    const result = await run({
      targets: [
        { url: `${s.base}/a.bin`, output: path.join(tmpRoot, 'bg-a.bin') },
        { url: `${s.base}/b.bin`, output: path.join(tmpRoot, 'bg-b.bin') },
        { url: `${s.base}/c.bin`, output: path.join(tmpRoot, 'bg-c.bin') },
      ],
      background: true,
    })
    assert.equal(result.background, true)
    assert.equal(result.success, true)
    assert.equal(typeof result.batch, 'string')
    assert.equal(result.count, 3)

    // download_status 的 batchId 过滤必须能查出整批（1.7.0 配套）
    const deadline = Date.now() + 15000
    for (;;) {
      const snap = readDownloadStatus(50, undefined, undefined, result.batch as string)
      if (snap.tasks.length === 3 && snap.tasks.every((t) => t.status === 'completed')) break
      if (Date.now() > deadline) {
        throw new Error(`批次未在时限内全部完成：${JSON.stringify(snap.tasks.map((t) => [t.id, t.status, t.batch]))}`)
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
    const snap = readDownloadStatus(50, undefined, undefined, result.batch as string)
    assert.equal(snap.total, 3)
    for (const task of snap.tasks) {
      assert.equal(task.batch, result.batch, '进度记录的 batch 必须等于返回的批次 ID')
      assert.ok(existsSync(task.outPath), '每个条目都应落盘')
    }
  } finally {
    await s.close()
  }
})

test('后台批量里 preflight 不合格的条目：不影响其余条目，且自己留下 failed 记录', async () => {
  const body = Buffer.alloc(8 * 1024, 0x45)
  const s = await startServer((_req, res) => {
    res.writeHead(200, { 'content-length': String(body.length) })
    res.end(body)
  })
  try {
    const result = await run({
      targets: [
        { url: `${s.base}/ok.bin`, output: path.join(tmpRoot, 'bg-ok.bin') },
        { url: 'ftp://nope/x', output: path.join(tmpRoot, 'bg-nope.bin') },
      ],
      background: true,
    })
    // 合法条目照常完成
    await waitForStatusFile(path.join(tmpRoot, 'bg-ok.bin'))
    // 不合格条目在轨道上留了 failed 记录（不是凭空消失）
    const snap = readDownloadStatus(50)
    const nope = snap.tasks.find((t) => t.status === 'failed' && t.outPath === path.resolve(path.join(tmpRoot, 'bg-nope.bin')))
    assert.ok(nope, '不合格条目必须留下 failed 记录')
    assert.match(nope.msg, /拒绝下载/, '记录里要写明拒绝原因')
    // render 文案按批次给出下一步
    assert.equal(result.count, 2, 'count 是入参条目数（含不合格条目）')
  } finally {
    await s.close()
  }
})

/** 等待某个文件对应任务的终态（辅助断言用） */
async function waitForStatusFile(outPath: string): Promise<void> {
  const deadline = Date.now() + 15000
  for (;;) {
    const snap = readDownloadStatus(50)
    const task = snap.tasks.find((t) => t.outPath === path.resolve(outPath))
    if (task && task.status === 'completed') return
    if (Date.now() > deadline) throw new Error(`等待 ${outPath} 完成超时`)
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
  }
}

test('后台 render 文案：单条给 taskId 下一步，批量给 batchId 下一步', () => {
  const render = tool.output?.render
  assert.ok(render, 'smart_download 必须有 render')
  const text = (value: unknown): string => render!({} as never, value).map((p) => p.text).join('')
  const single = text({
    success: true,
    background: true,
    taskId: 'dl-abc',
    url: 'https://e/a.zip',
  })
  assert.match(single, /background/)
  assert.match(single, /dl-abc/)
  assert.match(single, /download_status/)
  const batch = text({ success: true, background: true, batch: 'b-xyz', count: 3 })
  assert.match(batch, /b-xyz/)
  assert.match(batch, /batchId/)
})

test('download_status 工具的 execute 接受 batchId 并过滤', async () => {
  // 直接走 download_status 工具的 execute，确认参数从 schema 层一路接到底
  const exec = { signal: new AbortController().signal }
  const snap = (await statusTool.execute({ batchId: 'b-none' }, exec)) as {
    tasks: unknown[]
    total: number
    ok: boolean
  }
  assert.equal(snap.ok, true)
  assert.deepEqual(snap.tasks, [])
  assert.equal(snap.total, 0)
})
