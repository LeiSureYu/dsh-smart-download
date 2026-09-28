/**
 * `smart_download.execute()` 的端到端测试。
 *
 * 为什么必须有这一层：0.4.1 的缺陷「探测拿不到文件大小时返回 `size: undefined`」
 * 逃过了全部既有测试 —— 因为校验发生在 `ToolRuntime.createSuccessResult()`
 * （`snapshotJsonValue` 判定含 `undefined` 的对象不是 lossless JSON），
 * 而此前没有任何测试真正调用过 `execute()`。
 *
 * 这里不依赖 aria2 / 真实网络：用本地 http server 构造响应，用真实的
 * `@deepseek-ai/dsh-tools` 对返回值跑一次它自己的校验，等价于宿主行为。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply } from '../src/index.js'
import type { SmartDownloadResult } from '../src/types.js'

/**
 * 取宿主真正用来判定「结果是否是 lossless JSON」的函数。
 *
 * 它是 `@deepseek-ai/dsh-tools` 的传递依赖（pnpm 下不提升到顶层，故用
 * createRequire 从 dsh-tools 出发解析）。直接复用宿主实现而不是在测试里
 * 重写一份判定，避免测试与真实行为漂移。
 */
async function loadSnapshotJsonValue(): Promise<(value: unknown) => unknown> {
  const require = createRequire(import.meta.url)
  const toolsEntry = require.resolve('@deepseek-ai/dsh-tools')
  const fromTools = createRequire(toolsEntry)
  const resolved = fromTools.resolve('@deepseek-ai/dsh-util-values')
  const mod = (await import(pathToFileURL(resolved).href)) as {
    snapshotJsonValue: (value: unknown) => unknown
  }
  assert.equal(typeof mod.snapshotJsonValue, 'function', '应能取到 snapshotJsonValue')
  return mod.snapshotJsonValue
}

/* ------------------------------ 桩 ctx ------------------------------ */

interface RegisteredTool {
  name: string
  execute: (args: unknown, exec: unknown) => Promise<unknown>
  output: { schema: unknown }
}

/** 用桩 ctx 取出插件注册的 smart_download 工具定义。 */
function loadTool(): RegisteredTool {
  let tool: RegisteredTool | undefined
  const ctx = {
    tools: {
      register: (t: RegisteredTool) => {
        if (t.name === 'smart_download') tool = t
      },
    },
    inject: () => {},
  }
  apply(ctx as never)
  assert.ok(tool, '应注册 smart_download')
  return tool
}

/* ------------------------------ 本地 server ------------------------------ */

function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ base: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer(handler)
    // 跟踪连接：被 abort 的下载会留下挂起的 socket，close() 必须主动断开，
    // 否则 node:test 会一直等这个 server 关闭。
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
let tool: RegisteredTool
let snapshotJsonValue: (value: unknown) => unknown

before(async () => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'execute-test-'))
  // 进度目录指向临时目录，避免污染真实 home
  process.env.DSH_PROGRESS_DIR = path.join(tmpRoot, 'progress')
  process.env.DSH_DOWNLOAD_PROGRESS_DIR = path.join(tmpRoot, 'downloads')
  tool = loadTool()
  snapshotJsonValue = await loadSnapshotJsonValue()
})

after(async () => {
  delete process.env.DSH_PROGRESS_DIR
  delete process.env.DSH_DOWNLOAD_PROGRESS_DIR
  rmSync(tmpRoot, { recursive: true, force: true })
})

/**
 * 每个用例自建 server 并在用例结束前关闭。
 * 必须逐个关闭：只要有一个 server 还开着，node:test 就会等事件循环排空而挂住。
 */
async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const s = await startServer(handler)
  try {
    await fn(s.base)
  } finally {
    await s.close()
  }
}

/** 跑一次 execute，返回结果 */
async function run(args: Record<string, unknown>): Promise<SmartDownloadResult> {
  return (await tool.execute(args, {
    signal: new AbortController().signal,
  })) as SmartDownloadResult
}

/* ------------------------------ 用例 ------------------------------ */

test('chunked 无 Content-Length：结果不含 undefined 的 size，且通过 dsh-tools 校验', async () => {
  // 探测会走 HEAD -> 无 content-length -> Range GET -> 仍无 length，
  // 于是 contentLength 为 undefined；curl 回退后必须仍返回合法 JSON。
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' }) // 无 content-length
    res.end(Buffer.alloc(4096, 0x41))
  }, async (base) => {
    const out = path.join(tmpRoot, 'chunked.bin')
    const result = await run({ url: `${base}/chunked.bin`, output: out })

    assert.equal(result.success, true)
    assert.equal(result.method, 'curl')
    // 关键断言：不能出现值为 undefined 的 size 键
    assert.equal(Object.hasOwn(result, 'size'), false, 'size 键不应出现')
    assert.equal(snapshotJsonValue(result) === undefined, false, '结果必须是 lossless JSON')
    assert.ok(existsSync(out), '文件应落盘')
  })
})

test('已知 Content-Length 且支持 Range：返回 size 且走 curl（无 aria2 时）', async () => {
  const body = Buffer.alloc(8192, 0x42)
  await withServer((_req, res) => {
    res.writeHead(200, {
      'content-length': String(body.length),
      'accept-ranges': 'bytes',
      'content-type': 'application/octet-stream',
    })
    res.end(body)
  }, async (base) => {
    const out = path.join(tmpRoot, 'sized.bin')
    const result = await run({ url: `${base}/sized.bin`, output: out })

    assert.equal(result.success, true)
    assert.equal(result.size, body.length)
    assert.equal(snapshotJsonValue(result) === undefined, false)
    assert.equal(readFileSync(out).length, body.length)
  })
})

test('拒绝 file:// 协议（0.4.1 实测会被 curl 复制本地文件）', async () => {
  await assert.rejects(
    () => run({ url: 'file:///C:/Windows/win.ini' }),
    /拒绝下载.*file:/,
  )
})

test('拒绝 ftp:// 协议', async () => {
  await assert.rejects(() => run({ url: 'ftp://example.com/a.zip' }), /拒绝下载/)
})

test('URL 路径穿越不会写到输出目录之外', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-length': '5', 'accept-ranges': 'bytes' })
    res.end(Buffer.from('PWNED'))
  }, async (base) => {
    // 未传 output：文件名完全由 URL 推导，正是穿越的入口
    const cwdBefore = process.cwd()
    process.chdir(tmpRoot)
    try {
      const result = await run({ url: `${base}/..%2F..%2F..%2Fescaped.txt` })
      assert.equal(result.success, true)
      assert.equal(result.path, 'escaped.txt', '推导结果必须是单段文件名')
      // 文件应落在 tmpRoot 内，而不是上层目录
      assert.ok(existsSync(path.join(tmpRoot, 'escaped.txt')), '应写在当前目录内')
      assert.equal(existsSync(path.join(cwdBefore, 'escaped.txt')), false, '不得写到 cwd 之外')
    } finally {
      process.chdir(cwdBefore)
    }
  })
})

test('取消信号：下载被中止时以错误结束', async () => {
  await withServer((_req, res) => {
    // 永不结束的响应体，等待 abort
    res.writeHead(200, { 'content-length': '999999' })
    res.write(Buffer.alloc(16, 0x43))
  }, async (base) => {
    const controller = new AbortController()
    const pending = tool.execute(
      { url: `${base}/slow.bin`, output: path.join(tmpRoot, 'slow.bin') },
      { signal: controller.signal },
    )
    setTimeout(() => controller.abort(), 300)
    await assert.rejects(() => pending, /取消|abort/i)
  })
})
