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
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply } from '../src/index.js'
import { getAria2Path } from '../src/downloader.js'
import { readThroughput, throughputKey } from '../src/throughput-cache.js'
import { AUTO_MIRROR_SKIP_NOT_GITHUB } from '../src/auto-mirror.js'
import {
  HISTORY_RAISE_REASON,
  MAX_CONCURRENCY,
  RAISE_MIN_EFFECTIVE_CONNECTIONS,
  decide,
  decideConcurrency,
  LARGE_FILE,
} from '../src/decision.js'
import { MAX_STATUS_LIMIT } from '../src/status.js'

import type {
  BatchDownloadResult,
  BatchItemResult,
  SmartDownloadResult,
} from '../src/types.js'

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

/**
 * 取宿主自己的 JSON Schema 校验器。
 *
 * 为什么必须用它而不是「看着像就行」：`smart_download` 的 output schema 在 1.3.0
 * 变成了 oneOf（单条目 / 批量两种形态），而 oneOf 是**恰好匹配一支**才算通过 ——
 * 批量分支里少声明一个字段，真实调用就会因为多出来的键被 additionalProperties
 * 拒掉，而单测如果只断言「字段值对不对」是发现不了的。
 *
 * `lib/types/json-schema.js` 不在包的 exports 里，因此按文件位置解析（与
 * snapshotJsonValue 同一套 createRequire + 文件 URL 的做法）。
 */
async function loadSchemaValidator(): Promise<
  (schema: unknown, value: unknown) => string[]
> {
  const require = createRequire(import.meta.url)
  const toolsEntry = require.resolve('@deepseek-ai/dsh-tools')
  const resolved = path.join(path.dirname(toolsEntry), 'types', 'json-schema.js')
  const mod = (await import(pathToFileURL(resolved).href)) as {
    validateJsonSchemaValue: (schema: unknown, value: unknown, path?: string) => string[]
  }
  assert.equal(typeof mod.validateJsonSchemaValue, 'function', '应能取到 validateJsonSchemaValue')
  return mod.validateJsonSchemaValue
}

/* ------------------------------ 桩 ctx ------------------------------ */

interface RegisteredTool {
  name: string
  execute: (args: unknown, exec: unknown) => Promise<unknown>
  output: { schema: unknown }
}

/** 用桩 ctx 取出插件注册的指定工具定义。 */
function loadToolNamed(name: string): RegisteredTool {
  let tool: RegisteredTool | undefined
  const ctx = {
    tools: {
      register: (t: RegisteredTool) => {
        if (t.name === name) tool = t
      },
    },
    inject: () => {},
  }
  apply(ctx as never)
  assert.ok(tool, `应注册 ${name}`)
  return tool
}

/** 用桩 ctx 取出插件注册的 smart_download 工具定义。 */
function loadTool(): RegisteredTool {
  return loadToolNamed('smart_download')
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
let validateSchema: (schema: unknown, value: unknown) => string[]

before(async () => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'execute-test-'))
  // 进度目录指向临时目录，避免污染真实 home
  process.env.DSH_PROGRESS_DIR = path.join(tmpRoot, 'progress')
  process.env.DSH_DOWNLOAD_PROGRESS_DIR = path.join(tmpRoot, 'downloads')
  // 吞吐缓存同样要隔离：1.3.0 起成功的 aria2 下载会写它，不隔离就会往真实 `~/.dsh` 里拉屎
  const cacheDir = path.join(tmpRoot, 'throughput')
  mkdirSync(cacheDir, { recursive: true })
  process.env.DSH_SMARTDL_THROUGHPUT_DIR = cacheDir
  tool = loadTool()
  snapshotJsonValue = await loadSnapshotJsonValue()
  validateSchema = await loadSchemaValidator()
})

after(async () => {
  delete process.env.DSH_PROGRESS_DIR
  delete process.env.DSH_DOWNLOAD_PROGRESS_DIR
  delete process.env.DSH_SMARTDL_THROUGHPUT_DIR
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

/** 跑一次 execute，返回结果（可选传入 agent 以获得会话上下文） */
async function run(
  args: Record<string, unknown>,
  agent?: unknown,
): Promise<SmartDownloadResult> {
  const exec: Record<string, unknown> = { signal: new AbortController().signal }
  if (agent !== undefined) exec.agent = agent
  return (await tool.execute(args, exec)) as SmartDownloadResult
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
    // 跳过校验必须是**显式**告知：远端没声明长度，本次没有做字节数比对。
    // 0.9.0 之前这种情况与「校验通过」在返回值里长得一模一样。
    assert.equal(
      result.verifySkipped,
      '未做字节数校验：远端未声明文件长度',
      '拿不到远端长度时必须显式说明未做校验',
    )
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
    // 字节数真的比过且一致：不得出现 verifySkipped
    assert.equal(result.verifySkipped, undefined, '校验通过时不应有 verifySkipped')
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
      // 1.4.0：结果里的路径改为**绝对路径**（下载管理器要拿它删除/打开文件，
      // 所以全链路共用同一个绝对值；相对路径的含义取决于 cwd，不能外传给 UI）。
      // 原断言「必须是单段文件名」的意图在这里拆成更强的两条：文件名仍是单段，
      // 而且必须正好解析在**当前目录**下 —— 一旦穿越到上层，第二条立刻变红。
      assert.equal(path.basename(result.path), 'escaped.txt', '推导结果必须是单段文件名')
      assert.equal(path.dirname(result.path), process.cwd(), '必须正好落在当前目录，而非上层')
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

/* ---------------- 0.5.0：会话上下文决定轨道一的落点 ---------------- */

/** 跑一次带 agent 会话上下文的下载，并返回会话进度目录 */
async function runInSession(base: string, cwd: string, sessionId: string): Promise<string> {
  const saved = process.env.DSH_PROGRESS_DIR
  delete process.env.DSH_PROGRESS_DIR
  try {
    const result = await run(
      { url: `${base}/sess.bin`, output: path.join(tmpRoot, `${sessionId}.bin`) },
      { session: { header: { id: sessionId, cwd } } },
    )
    assert.equal(result.success, true)
    return path.join(cwd, '.dsh-progress', sessionId)
  } finally {
    if (saved !== undefined) process.env.DSH_PROGRESS_DIR = saved
  }
}

test('有 agent 会话时轨道一写进 <cwd>/.dsh-progress/<id>/', async () => {
  const body = Buffer.alloc(2048, 0x44)
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' })
    res.end(body)
  }, async (base) => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'exec-sess-'))
    try {
      const sessionDir = await runInSession(base, cwd, 'sess-exec')
      const files = readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl'))
      assert.equal(files.length, 1, '应恰好有一个任务 JSONL')
      const lines = readFileSync(path.join(sessionDir, files[0]!), 'utf-8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { state?: string })
      assert.equal(lines[lines.length - 1]?.state, 'done', '末条记录必须带终态 state')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

test('无 agent 时不写轨道一（只有轨道二文件）', async () => {
  const body = Buffer.alloc(1024, 0x45)
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' })
    res.end(body)
  }, async (base) => {
    const saved = process.env.DSH_PROGRESS_DIR
    delete process.env.DSH_PROGRESS_DIR
    try {
      const result = await run({ url: `${base}/nosess.bin`, output: path.join(tmpRoot, 'nosess.bin') })
      assert.equal(result.success, true)
      // 轨道二（DSH_DOWNLOAD_PROGRESS_DIR 仍指向临时目录）里应有本次任务
      const dlDir = process.env.DSH_DOWNLOAD_PROGRESS_DIR!
      const files = readdirSync(dlDir).filter((f) => f.endsWith('.json'))
      assert.ok(files.length >= 1, '轨道二应写入任务文件')
    } finally {
      if (saved !== undefined) process.env.DSH_PROGRESS_DIR = saved
    }
  })
})

/* ---------------- 0.5.0：download_status 的会话定位 ---------------- */

test('download_status：带会话上下文时能读到本次会话的轨道一', async () => {
  const body = Buffer.alloc(1536, 0x46)
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' })
    res.end(body)
  }, async (base) => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'exec-status-'))
    const saved = process.env.DSH_PROGRESS_DIR
    delete process.env.DSH_PROGRESS_DIR
    try {
      const agent = { session: { header: { id: 'sess-status', cwd } } }
      const dl = await run({ url: `${base}/st.bin`, output: path.join(tmpRoot, 'st.bin') }, agent)
      assert.equal(dl.success, true)

      // 轨道二目录是跨用例共享的，因此这里按 taskId 精确查本次任务
      const sessionDir = path.join(cwd, '.dsh-progress', 'sess-status')
      const taskId = readdirSync(sessionDir).find((f) => f.endsWith('.jsonl'))!.slice(0, -6)

      const statusTool = loadToolNamed('download_status')
      const snap = (await statusTool.execute(
        { taskId },
        { signal: new AbortController().signal, agent },
      )) as {
        total: number
        taskDir: string
        tasks: Array<{ status: string; pct: number }>
      }
      assert.equal(snap.taskDir, sessionDir)
      assert.equal(snap.total, 1)
      assert.equal(snap.tasks[0]?.status, 'completed', '终态应被 state 正确映射')
      assert.equal(snap.tasks[0]?.pct, 100)
      // 1.3.0：快照里多了 batch 字段，而 download_status 的 tasks 项是
      // additionalProperties:false —— 少了那条 schema 声明，任何带批次 ID 的
      // 任务都会让工具输出校验失败。这里用宿主校验器把活数据真的跑一遍。
      assert.deepEqual(
        validateSchema(loadToolNamed('download_status').output.schema, snapshotJsonValue(snap)),
        [],
        'download_status 的快照（含 batch 字段）必须通过它自己的 output schema',
      )
    } finally {
      if (saved !== undefined) process.env.DSH_PROGRESS_DIR = saved
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

test('download_status：不带会话时只扫轨道二，不抛错', async () => {
  const saved = process.env.DSH_PROGRESS_DIR
  delete process.env.DSH_PROGRESS_DIR
  try {
    const statusTool = loadToolNamed('download_status')
    const snap = (await statusTool.execute({}, { signal: new AbortController().signal })) as {
      ok: boolean
      taskDir: string
      tasks: unknown[]
    }
    assert.equal(snap.ok, true)
    assert.equal(snap.taskDir, '', '无 DSH_PROGRESS_DIR 且无会话 -> 空串')
    assert.ok(Array.isArray(snap.tasks))
  } finally {
    if (saved !== undefined) process.env.DSH_PROGRESS_DIR = saved
  }
})

/* ---------------- 0.6.0：续传安全（静默损坏回归） ---------------- */

/**
 * 远端「等长但内容变了」时，curl -C - 与 aria2 -c 实测都是退出码 0 且保留旧内容。
 * 这里预置一个等长旧半包 + 旧指纹，断言最终落盘的是新内容。
 */
test('续传安全：远端等长但内容变了 -> 删掉旧文件重下，落盘为新内容', async () => {
  // 512KB < 1MB 阈值，决策固定走 curl，避免依赖本机是否装了 aria2 子包
  const SIZE = 512 * 1024
  const NEW_BYTE = 0x47
  const OLD_BYTE = 0x41
  // 长度与本次远端完全一致、内容不同的旧文件：只比长度看不出问题
  const stale = Buffer.alloc(SIZE, OLD_BYTE)
  const body = Buffer.alloc(SIZE, NEW_BYTE) // 本次的真实内容

  await withServer((_req, res) => {
    res.writeHead(200, {
      'content-length': String(body.length),
      'accept-ranges': 'bytes',
      etag: '"v-new"',
      'content-type': 'application/octet-stream',
    })
    res.end(body)
  }, async (base) => {
    const out = path.join(tmpRoot, 'stale-resume.bin')
    // 旧文件 + 旧指纹：长度与本次一致、内容不同 —— 只有指纹能识破
    writeFileSync(out, stale)
    writeFileSync(
      `${out}.part.json`,
      JSON.stringify({ v: 1, length: SIZE, etag: '"v-old"' }),
      'utf-8',
    )

    const result = await run({ url: `${base}/stale-resume.bin`, output: out })

    assert.equal(result.success, true)
    const written = readFileSync(out)
    assert.equal(written.length, SIZE, '应完整重下')
    assert.equal(written[0], NEW_BYTE, '落盘必须是本次的新内容')
    assert.equal(written.includes(OLD_BYTE), false, '不得残留旧内容字节')
    // 成功完成后旁车指纹应被清除，避免下次误比对
    assert.equal(existsSync(`${out}.part.json`), false, '成功后应清掉旁车')
  })
})

/** 下载失败/中断时保留旁车指纹，供下次续传比对 */
test('续传安全：中断后保留 .part.json 指纹', async () => {
  await withServer((req, res) => {
    // 探测走 HEAD：必须正常结束，否则探测会在超时前就被 abort 打断，
    // 拿不到 contentLength 也就不会写旁车。
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': '999999', 'accept-ranges': 'bytes' })
      res.end()
      return
    }
    // 真正的下载永不结束，等待 abort
    res.writeHead(200, { 'content-length': '999999', 'accept-ranges': 'bytes' })
    res.write(Buffer.alloc(16, 0x48))
  }, async (base) => {
    const out = path.join(tmpRoot, 'interrupted.bin')
    const controller = new AbortController()
    const pending = tool.execute(
      { url: `${base}/interrupted.bin`, output: out },
      { signal: controller.signal },
    )
    // 500ms：确保探测（HEAD）已完成、curl 真正进入下载后再中止，
    // 否则会在拿到 contentLength 之前就中断，旁车自然还没写。
    setTimeout(() => controller.abort(), 500)
    await assert.rejects(() => pending, /取消|abort/i)
    // 失败时刻意保留指纹：下次续传时才有得比
    assert.equal(existsSync(`${out}.part.json`), true, '中断后应保留旁车指纹')
  })
})

/* ---------------- 0.7.0：落盘完整性校验（静默损坏回归） ---------------- */

/**
 * 服务器谎报 Content-Length 少发字节：curl 会 exit 0（实测），
 * 而落盘文件是坏的。必须被判为失败，绝不能返回 success。
 */
test('完整性校验：服务器少发字节 -> 抛错，不返回 success', async () => {
  const DECLARED = 4096
  const ACTUAL = 1024
  await withServer((req, res) => {
    if (req.method === 'HEAD') {
      // 探测阶段如实声明 4096
      res.writeHead(200, { 'content-length': String(DECLARED), 'accept-ranges': 'bytes' })
      res.end()
      return
    }
    // 真正下载时改用 chunked（不声明 content-length）并只发 1024 字节。
    // 这是**只有字节数校验能识破**的场景：带 Content-Length 时 curl 会自己
    // 报 exit 18（实测），但 chunked 响应被中途截断时 curl 退出码是 0 ——
    // 真实的静默损坏，正是 0.7.0 要堵的那一类。
    res.writeHead(200, { 'accept-ranges': 'bytes' })
    res.end(Buffer.alloc(ACTUAL, 0x49))
  }, async (base) => {
    const out = path.join(tmpRoot, 'short.bin')
    let err: unknown
    try {
      await run({ url: `${base}/short.bin`, output: out })
    } catch (e) {
      err = e
    }
    // 先确认前置条件成立：curl 自己没报错（否则这条用例没测到校验层）
    const message = err instanceof Error ? err.message : String(err)
    assert.match(
      message,
      /完整性校验失败/,
      `chunked 截断时 curl 退出码应为 0，必须由校验层拦下；实际错误: ${message}`,
    )
    // 正向断言：坏文件留在原地，便于排查；且旁车保留（失败不清）
    assert.equal(readFileSync(out).length, ACTUAL)
    assert.equal(existsSync(`${out}.part.json`), true, '校验失败时应保留旁车指纹')
  })
})

/**
 * 服务器多发字节（声明 1024 实际 2048）：同样应被判为失败。
 * 这类场景出现在续传起点算错、或镜像把两段内容拼在一起时。
 */
test('完整性校验：服务器多发字节 -> 抛错', async () => {
  const DECLARED = 1024
  const ACTUAL = 2048
  await withServer((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': String(DECLARED), 'accept-ranges': 'bytes' })
      res.end()
      return
    }
    // 声明 1024，但 body 写 2048 后立刻销毁 socket：模拟「发了不该发的字节」
    res.writeHead(200, { 'content-length': String(DECLARED), 'accept-ranges': 'bytes' })
    res.write(Buffer.alloc(ACTUAL, 0x4a))
    res.socket?.destroy()
  }, async (base) => {
    const out = path.join(tmpRoot, 'long.bin')
    await assert.rejects(
      () => run({ url: `${base}/long.bin`, output: out }),
      /完整性校验失败|curl|失败/i,
    )
  })
})

/**
 * 正向用例：字节数对得上时必须照常成功 —— 校验不能变成「永远失败」。
 */
test('完整性校验：字节数一致 -> 正常成功并清掉旁车', async () => {
  const body = Buffer.alloc(3000, 0x4b)
  await withServer((_req, res) => {
    res.writeHead(200, {
      'content-length': String(body.length),
      'accept-ranges': 'bytes',
      'content-type': 'application/octet-stream',
    })
    res.end(body)
  }, async (base) => {
    const out = path.join(tmpRoot, 'exact.bin')
    const result = await run({ url: `${base}/exact.bin`, output: out })
    assert.equal(result.success, true)
    assert.equal(result.size, body.length)
    assert.equal(readFileSync(out).length, body.length)
    assert.equal(existsSync(`${out}.part.json`), false, '成功后应清掉旁车')
  })
})

/**
 * 服务器无视 identity 直接返回 gzip：探测长度（压缩后）与落盘字节数
 * 本就不可比，此时必须**跳过**校验而不是误判（0.7.0 实测的误报陷阱）。
 */
test('完整性校验：服务器无视 identity 返回 gzip -> 跳过校验，正常成功', async () => {
  const body = Buffer.alloc(3000, 0x4c)
  const COMPRESSED_LEN = 41
  await withServer((req, res) => {
    if (req.method === 'HEAD') {
      // 无视客户端的 accept-encoding: identity，依然声明压缩后的长度
      res.writeHead(200, {
        'content-length': String(COMPRESSED_LEN),
        'content-encoding': 'gzip',
        'accept-ranges': 'bytes',
      })
      res.end()
      return
    }
    // GET 用 chunked（不声明长度），把未压缩的 3000 字节全发过去 ——
    // 等价于 curl / aria2 实际拿到的未压缩字节流。
    res.writeHead(200, { 'content-encoding': 'gzip', 'accept-ranges': 'bytes' })
    res.end(body)
  }, async (base) => {
    const out = path.join(tmpRoot, 'gz-lie.bin')
    const result = await run({ url: `${base}/gz-lie.bin`, output: out })
    // 关键断言：期望值 41 ≠ 落盘 3000，若没跳过校验就会误报失败
    assert.equal(result.success, true, '压缩编码不可比时应跳过校验而不是误报')
    assert.equal(readFileSync(out).length, body.length, '未压缩的 3000 字节应完整落盘')
    // 跳过必须显式可见，否则用户看到的就是一次「成功」而不知道没验完整性
    assert.equal(
      result.verifySkipped,
      '未做字节数校验：远端声明了压缩编码',
      '压缩编码不可比时必须显式说明未做校验',
    )
  })
})

/**
 * aria2 路径的同一类静默失败（0.7.0 实测坐实）：
 * 服务器用 chunked 只发 1MB 就干净地关掉连接，而 HEAD 声明 4MB 时，
 * 随包 aria2 1.37.0 的退出码是 **0**、「Download Results」里写着 `OK`，
 * 落盘文件却只有 1MB。没有任何非零退出码可供判断 —— 只有字节数校验能拦下。
 *
 * 本机没装 aria2 子包时这条用例会跳过（决策走 curl），这是可接受的：
 * 校验逻辑本身已由前面的 curl 用例与 verify.test.ts 覆盖。
 */
/**
 * aria2 **成功**路径（1.0.0 补测）。
 *
 * 此前全量用例只走到 aria2 的失败分支：被 chunked 截断那条最终在 assertIntegrity
 * 抛错，aria2 自己的 \`return { ... method: 'aria2' }\` 从未被执行过 —— 也就是说
 * 「aria2 下好了一个完整文件、返回 method: 'aria2'」这条主路径没有任何用例。
 * 这里用本地 http server 发一个 2MB、支持 Range 的资源，真实拉起随包 aria2。
 *
 * 本机没装 aria2 子包时跳过（与上一条同样的理由）。
 */
test('aria2 成功路径：完整文件 -> method=aria2、fellback=false、字节数与 size 一致', async (t) => {
  const aria2Available = (() => {
    try {
      return getAria2Path() !== null
    } catch {
      return false
    }
  })()
  if (!aria2Available) {
    t.skip('本机无 aria2 子包，跳过 aria2 专属成功路径用例')
    return
  }

  // 2MB > 1MB 阈值，确保决策走 aria2
  const SIZE = 2 * 1024 * 1024
  const body = Buffer.alloc(SIZE, 0x50)
  await withServer((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': String(SIZE), 'accept-ranges': 'bytes' })
      res.end()
      return
    }
    const range = req.headers.range
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(String(range))
      if (m) {
        const start = Number(m[1])
        const end = m[2] ? Number(m[2]) : SIZE - 1
        res.writeHead(206, {
          'content-length': String(end - start + 1),
          'content-range': `bytes ${start}-${end}/${SIZE}`,
          'accept-ranges': 'bytes',
        })
        res.end(body.subarray(start, end + 1))
        return
      }
    }
    res.writeHead(200, { 'content-length': String(SIZE), 'accept-ranges': 'bytes' })
    res.end(body)
  }, async (base) => {
    const out = path.join(tmpRoot, 'aria2-ok.bin')
    const result = await run({ url: `${base}/aria2-ok.bin`, output: out })

    // 正向断言到具体值：真的走了 aria2，且没有回退
    assert.equal(result.success, true)
    assert.equal(result.method, 'aria2', '完整大文件且 aria2 可用时应走 aria2 主路径')
    assert.equal(result.fellback, false)
    assert.equal(result.size, SIZE)
    // 字节数比过且一致：不得出现 verifySkipped
    assert.equal(result.verifySkipped, undefined, '校验通过时不应有 verifySkipped')
    assert.equal(readFileSync(out).length, SIZE, '落盘字节数必须与远端声明一致')
    assert.equal(existsSync(`${out}.part.json`), false, '成功后应清掉旁车')
  })
})

/**
 * aria2 失败 → 回退 curl → **成功**（1.0.0 补测）。
 *
 * 决策层判定「支持 Range、文件够大、aria2 可用」时走 aria2；但 aria2 本身
 * 可能失败（服务器对它返回错误）。此时必须回退 curl 且把 fellback 标为 true、
 * reason 写成 aria2 的失败原因 —— 这条回退成功路径此前也没有用例。
 *
 * 用 User-Agent 分流：aria2 会带 \`aria2/1.37.0\`，被 500 拒掉；curl 正常拿到文件。
 */
test('aria2 失败回退 curl 成功：method=curl、fellback=true、reason 带 aria2 原因', async (t) => {
  const aria2Available = (() => {
    try {
      return getAria2Path() !== null
    } catch {
      return false
    }
  })()
  if (!aria2Available) {
    t.skip('本机无 aria2 子包，跳过 aria2 回退用例')
    return
  }

  const SIZE = 2 * 1024 * 1024
  const body = Buffer.alloc(SIZE, 0x51)
  await withServer((req, res) => {
    // 只针对 aria2 的请求返回 500，逼它失败；curl 走正常路径
    const ua = String(req.headers['user-agent'] ?? '')
    if (/aria2/i.test(ua)) {
      res.writeHead(500, { 'content-length': '4' })
      res.end('nope')
      return
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': String(SIZE), 'accept-ranges': 'bytes' })
      res.end()
      return
    }
    const range = req.headers.range
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(String(range))
      if (m) {
        const start = Number(m[1])
        const end = m[2] ? Number(m[2]) : SIZE - 1
        res.writeHead(206, {
          'content-length': String(end - start + 1),
          'content-range': `bytes ${start}-${end}/${SIZE}`,
          'accept-ranges': 'bytes',
        })
        res.end(body.subarray(start, end + 1))
        return
      }
    }
    res.writeHead(200, { 'content-length': String(SIZE), 'accept-ranges': 'bytes' })
    res.end(body)
  }, async (base) => {
    const out = path.join(tmpRoot, 'aria2-fb.bin')
    const result = await run({ url: `${base}/aria2-fb.bin`, output: out })

    assert.equal(result.success, true)
    assert.equal(result.method, 'curl', 'aria2 失败后必须回退 curl')
    assert.equal(result.fellback, true, '回退路径必须显式标记 fellback')
    assert.match(String(result.reason), /aria2 失败/, 'reason 必须写明是 aria2 失败导致回退')
    assert.equal(readFileSync(out).length, SIZE, '回退后仍应落盘完整文件')
    // 关掉服务器的错误响应后不残留旁车
    assert.equal(existsSync(`${out}.part.json`), false, '成功后应清掉旁车')
  })
})

test('完整性校验：aria2 被 chunked 截断 -> 退出码 0 但必须判为失败', async (t) => {
  const aria2Available = (() => {
    try {
      return getAria2Path() !== null
    } catch {
      return false
    }
  })()
  if (!aria2Available) {
    t.skip('本机无 aria2 子包，跳过 aria2 专属校验用例')
    return
  }

  const DECLARED = 4 * 1024 * 1024 // > 1MB 阈值，确保决策走 aria2
  const ACTUAL = 1024 * 1024
  await withServer((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': String(DECLARED), 'accept-ranges': 'bytes' })
      res.end()
      return
    }
    // chunked 且不声明长度：aria2 无从判断「还剩多少」，截断后判定为 OK
    res.writeHead(200, { 'accept-ranges': 'bytes' })
    res.end(Buffer.alloc(ACTUAL, 0x4d))
  }, async (base) => {
    const out = path.join(tmpRoot, 'aria2-trunc.bin')
    let err: unknown
    try {
      await run({ url: `${base}/aria2-trunc.bin`, output: out })
    } catch (e) {
      err = e
    }
    const message = err instanceof Error ? err.message : String(err)
    assert.match(
      message,
      /完整性校验失败/,
      `aria2 在这类截断下退出码为 0，必须由校验层拦下；实际: ${message}`,
    )
    // 正向断言：确实只落盘了 1MB（证实这条用例真的构造出了静默损坏）
    assert.equal(readFileSync(out).length, ACTUAL)
  })
})

/* ---------------- 1.2.0：SHA-256 校验 / 自定义请求头 / 自动镜像 ---------------- */

/** 一段固定内容与它的 SHA-256，供下面几条用例复用 */
const SHA_BODY = Buffer.from('dsh-smart-dl sha256 end-to-end\n')
const SHA_DIGEST = createHash('sha256').update(SHA_BODY).digest('hex')

/** 声明长度、支持 Range、内容固定的响应；探测走 HEAD 分支 */
function serveBody(body: Buffer): (req: IncomingMessage, res: ServerResponse) => void {
  return (_req, res) => {
    res.writeHead(200, {
      'content-length': String(body.length),
      'accept-ranges': 'bytes',
      'content-type': 'application/octet-stream',
    })
    res.end(body)
  }
}

test('sha256：摘要一致 -> 返回实际摘要，且不再报「未做字节数校验」', async () => {
  await withServer(serveBody(SHA_BODY), async (base) => {
    const out = path.join(tmpRoot, 'sha-ok.bin')
    const result = await run({ url: `${base}/sha-ok.bin`, output: out, sha256: SHA_DIGEST })

    assert.equal(result.success, true)
    assert.equal(result.sha256, SHA_DIGEST, '校验通过时必须带回实际算出的摘要')
    assert.equal(
      result.verifySkipped,
      undefined,
      '内容已逐字节核对，不该再报「未做字节数校验」',
    )
    assert.equal(snapshotJsonValue(result) === undefined, false, '结果必须是 lossless JSON')
    assert.equal(readFileSync(out).toString(), SHA_BODY.toString())
  })
})

test('sha256：接受官方文档里的各种写法（sha256: 前缀 / 大写 / SRI）', async () => {
  const forms = [
    SHA_DIGEST,
    SHA_DIGEST.toUpperCase(),
    `sha256:${SHA_DIGEST}`,
    `SHA256(${SHA_DIGEST})`,
    `sha256-${Buffer.from(SHA_DIGEST, 'hex').toString('base64')}`,
  ]
  await withServer(serveBody(SHA_BODY), async (base) => {
    for (const [index, form] of forms.entries()) {
      const out = path.join(tmpRoot, `sha-form-${index}.bin`)
      const result = await run({ url: `${base}/sha-form.bin`, output: out, sha256: form })
      assert.equal(result.sha256, SHA_DIGEST, `${form} 应被归一化成同一个小写十六进制`)
    }
  })
})

test('sha256：远端不声明长度时依然给出确定结论（长度校验跳过，内容哈希照常）', async () => {
  const body = Buffer.alloc(4096, 0x51)
  const digest = createHash('sha256').update(body).digest('hex')
  await withServer((_req, res) => {
    // chunked：HEAD 与 Range GET 都拿不到长度，字节数校验必然「跳过」
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(body)
  }, async (base) => {
    const out = path.join(tmpRoot, 'sha-chunked.bin')
    const result = await run({ url: `${base}/sha-chunked.bin`, output: out, sha256: digest })

    assert.equal(result.success, true)
    assert.equal(result.sha256, digest, '哈希不依赖远端长度，跳过长度校验也要能给出结论')
    assert.equal(
      result.verifySkipped,
      undefined,
      '长度那层跳过了，但内容已经核对过，再报「未做校验」只会误导',
    )
  })
})

test('sha256：摘要不符 -> 抛错、不返回 success，且保留旁车指纹', async () => {
  const wrong = 'f'.repeat(64)
  await withServer(serveBody(SHA_BODY), async (base) => {
    const out = path.join(tmpRoot, 'sha-bad.bin')
    await assert.rejects(
      () => run({ url: `${base}/sha-bad.bin`, output: out, sha256: wrong }),
      /完整性校验失败.*SHA-256 不匹配/,
    )
    // 正向断言：文件确实落盘了（证明确实是「内容不对」而不是「没下下来」）
    assert.equal(readFileSync(out).toString(), SHA_BODY.toString())
    assert.equal(existsSync(`${out}.part.json`), true, '校验失败时必须保留旁车指纹')
  })
})

test('sha256：摘要不合法 -> 在发起任何请求之前就拒绝', async () => {
  let requests = 0
  await withServer((_req, res) => {
    requests++
    res.writeHead(200, { 'content-length': '1' })
    res.end('x')
  }, async (base) => {
    await assert.rejects(
      () =>
        run({
          url: `${base}/never.bin`,
          output: path.join(tmpRoot, 'never.bin'),
          sha256: 'not-a-hash',
        }),
      /拒绝下载.*sha256 不是合法/,
    )
    assert.equal(requests, 0, '参数不合法必须在下载前拒绝，不能白下一遍')
  })
})

test('自定义请求头：探测与下载使用同一套（UA / Referer / 自定义头都到达服务器）', async () => {
  const seen: Array<IncomingMessage['headers']> = []
  const body = Buffer.alloc(2048, 0x53)
  await withServer((req, res) => {
    seen.push(req.headers)
    res.writeHead(200, {
      'content-length': String(body.length),
      'accept-ranges': 'bytes',
      'content-type': 'application/octet-stream',
    })
    res.end(body)
  }, async (base) => {
    const out = path.join(tmpRoot, 'headers.bin')
    const result = await run({
      url: `${base}/headers.bin`,
      output: out,
      userAgent: 'dsh-smart-dl-test/1.0',
      referer: 'https://docs.example.com/install',
      headers: { 'X-Trace-Id': 'trace-42' },
    })

    assert.equal(result.success, true)
    assert.ok(seen.length >= 2, `应至少被探测与下载各访问一次，实际 ${seen.length} 次`)
    for (const headers of seen) {
      // 每个请求都必须带同一套头：站点按 UA 分流时，两边不一致会让探测结论
      // 与真实下载错位（见 src/headers.ts 文件头）
      assert.equal(headers['user-agent'], 'dsh-smart-dl-test/1.0')
      assert.equal(headers.referer, 'https://docs.example.com/install')
      assert.equal(headers['x-trace-id'], 'trace-42')
    }
  })
})

test('自定义请求头：值含换行 -> 下载前拒绝（请求头注入）', async () => {
  let requests = 0
  await withServer((_req, res) => {
    requests++
    res.writeHead(200, { 'content-length': '1' })
    res.end('x')
  }, async (base) => {
    await assert.rejects(
      () =>
        run({
          url: `${base}/never.bin`,
          output: path.join(tmpRoot, 'never.bin'),
          headers: { 'X-Test': 'a\r\nX-Evil: 1' },
        }),
      /拒绝下载.*注入/,
    )
    assert.equal(requests, 0)
  })
})

test("mirror: 'auto' 对非 GitHub 地址 -> 明确说明未启用，并照常从原始地址下载", async () => {
  const body = Buffer.alloc(1024, 0x54)
  await withServer(serveBody(body), async (base) => {
    const out = path.join(tmpRoot, 'auto-mirror-local.bin')
    const result = await run({ url: `${base}/auto-mirror-local.bin`, output: out, mirror: 'auto' })

    assert.equal(result.success, true)
    assert.equal(result.mirrored, false)
    assert.equal(result.mirror, undefined, '未启用时不得报出一个镜像前缀')
    assert.equal(
      result.mirrorSkipped,
      AUTO_MIRROR_SKIP_NOT_GITHUB,
      '自动镜像没生效时必须说明原因，不得静默',
    )
    assert.equal(result.requestedUrl, `${base}/auto-mirror-local.bin`, '请求地址必须是原始地址')
    assert.equal(readFileSync(out).length, body.length)
  })
})

test("mirror: 'auto' 对 GitHub 地址但探测失败 -> 不会把下载本身带崩", async () => {
  // 用已取消的信号让探测立即失败：此时拿不到原始长度，自动镜像无从证实同源，
  // 必须原样退回原始地址继续走下载流程（随后被取消），而不是抛镜像相关的错。
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () =>
      tool.execute(
        {
          url: 'https://github.com/owner/repo/releases/download/v1/a.zip',
          output: path.join(tmpRoot, 'never.bin'),
          mirror: 'auto',
        },
        { signal: controller.signal },
      ),
    /取消/,
  )
})

test("mirror: 'auto' 命中镜像 -> 请求地址换成镜像地址，结果带回 mirror 字段", async () => {
  const GITHUB = 'https://github.com/owner/repo/releases/download/v1/a.zip'
  const body = Buffer.alloc(2048, 0x55)
  const etag = '"auto-mirror-etag"'
  const realFetch = globalThis.fetch

  // 本地 server 扮演「镜像」。候选地址是 <前缀> + 完整原始 URL，所以它收到的
  // 路径会长成 `/https://github.com/...`；这里不关心路径，只回同一份内容。
  await withServer((_req, res) => {
    res.writeHead(200, {
      'content-length': String(body.length),
      'accept-ranges': 'bytes',
      'content-type': 'application/octet-stream',
      etag,
    })
    res.end(body)
  }, async (base) => {
    const mirrorPrefix = `${base}/`
    // 用环境变量把候选表指向本地 server —— 内置候选是公开第三方服务，
    // 单测不能也不该去联网。
    process.env.DSH_SMARTDL_MIRRORS = mirrorPrefix
    // 只对原始 GitHub 地址打桩（真实 github.com 不可达）；候选镜像地址照常
    // 走真实 fetch，打到上面的本地 server。
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      if (String(input).startsWith(GITHUB)) {
        return new Response(null, {
          status: 200,
          headers: {
            'content-length': String(body.length),
            'accept-ranges': 'bytes',
            etag,
          },
        })
      }
      return realFetch(input as never, init as never)
    }) as typeof fetch

    try {
      const out = path.join(tmpRoot, 'auto-mirror-hit.bin')
      const result = await run({ url: GITHUB, output: out, mirror: 'auto' })

      assert.equal(result.success, true)
      assert.equal(result.mirrored, true, '被证实同源的候选必须被采用')
      assert.equal(result.mirror, mirrorPrefix, '结果必须带回实际使用的镜像前缀')
      assert.equal(
        result.requestedUrl,
        `${mirrorPrefix}${GITHUB}`,
        '请求地址应为「镜像前缀 + 完整原始 URL」',
      )
      assert.equal(result.mirrorSkipped, undefined, '启用镜像时不得同时给出去启用说明')
      assert.equal(readFileSync(out).length, body.length)
      assert.equal(snapshotJsonValue(result) === undefined, false, '结果必须是 lossless JSON')
    } finally {
      globalThis.fetch = realFetch
      delete process.env.DSH_SMARTDL_MIRRORS
    }
  })
})

/* ============== P0-6：单次调用内批量下载（路线 A，用户决策 D1=A） ============== */

/** 批量结果里的一行（断言用别名，避免每处都写一遍类型断言）。 */
type Item = BatchItemResult

/** 跑一次批量下载；exec 可注入自定义 signal（取消用例用）。 */
async function runBatch(
  targets: Array<{
    url: string
    output?: string
    sha256?: string
    checksum?: string
    ifExists?: 'overwrite' | 'skip' | 'rename'
  }>,
  extra: Record<string, unknown> = {},
  exec?: Record<string, unknown>,
): Promise<BatchDownloadResult> {
  const execCtx = exec ?? { signal: new AbortController().signal }
  const value = (await tool.execute({ targets, ...extra }, execCtx)) as BatchDownloadResult
  assert.ok(Array.isArray(value.results), '批量结果必须带 results 数组')
  return value
}

/** 某目录下指定后缀的文件名集合（用于「本次新写了哪些文件」）。 */
function filesIn(dir: string, ext: string): Set<string> {
  return new Set(readdirSync(dir).filter((f) => f.endsWith(ext)))
}

/** 集合差：after 里新出现的文件。 */
function newFiles(before: Set<string>, after: Set<string>): string[] {
  return [...after].filter((f) => !before.has(f))
}

test('批量：url 与 targets 同时给出 -> 拒绝（行为确定，不发任何请求）', async () => {
  await assert.rejects(
    () => run({ url: 'http://127.0.0.1:9/one', targets: [{ url: 'http://127.0.0.1:9/two' }] }),
    /二选一/,
  )
})

test('批量：url 与 targets 都不给 -> 拒绝', async () => {
  await assert.rejects(() => run({}), /必须提供 url/)
})

test('批量：targets 为空数组 -> 拒绝', async () => {
  await assert.rejects(() => run({ targets: [] }), /空数组/)
})

test('批量：超过 MAX_STATUS_LIMIT 条 -> 显式拒绝并说明上限（不静默丢弃进度记录）', async () => {
  // 51 条（超出 1 条）就足以触发：进度读取端一次只读 50 条，多出来的任务会
  // 「下过了但查不到」，因此必须在发请求之前拒绝。
  const tooMany = Array.from({ length: MAX_STATUS_LIMIT + 1 }, (_, i) => ({
    url: `http://127.0.0.1:9/x${i}`,
  }))
  await assert.rejects(
    () => run({ targets: tooMany }),
    (err: Error) => {
      assert.match(err.message, new RegExp(String(MAX_STATUS_LIMIT)), '必须说明上限是多少')
      assert.match(err.message, new RegExp(String(MAX_STATUS_LIMIT + 1)), '必须说明这次给了多少条')
      return true
    },
  )
})

test('带宽上限：非法值在发起任何请求之前抛错（不是先下几百 MB 再报参数错）', async () => {
  let hits = 0
  const body = Buffer.alloc(2048, 0x51)
  await withServer((_req, res) => {
    hits += 1
    res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' })
    res.end(body)
  }, async (base) => {
    for (const bad of ['2X', '0', '-1', '2 M', '', '1.5M']) {
      await assert.rejects(
        () => run({ url: `${base}/bw.bin`, output: path.join(tmpRoot, 'bw.bin'), maxBandwidth: bad }),
        /maxBandwidth/,
        `maxBandwidth=${JSON.stringify(bad)} 必须在发请求前拒绝`,
      )
    }
    assert.equal(hits, 0, '参数非法时一个请求都不该发出')

    // 正向：合法值必须被接受并且照常下载（否则「只校验、不生效」也能骗过上面那批断言）
    const ok = await run({
      url: `${base}/bw-ok.bin`,
      output: path.join(tmpRoot, 'bw-ok.bin'),
      maxBandwidth: '1M',
    })
    assert.equal(ok.success, true)
    assert.ok(hits > 0, '合法带宽值必须真的发起下载')

    // 正向（批量）：带总带宽上限时整批照常完成 —— 上限按批内并发位均分后
    // 传给每个条目，任何一条都不该因为「分到的份额」而出错。
    const before = hits
    const batched = await tool.execute(
      {
        maxBandwidth: '2M',
        targets: [
          { url: `${base}/bw-b1.bin`, output: path.join(tmpRoot, 'bw-b1.bin') },
          { url: `${base}/bw-b2.bin`, output: path.join(tmpRoot, 'bw-b2.bin') },
        ],
      },
      { signal: new AbortController().signal },
    )
    const batchValue = batched as BatchDownloadResult
    assert.equal(batchValue.succeeded, 2, '带总带宽上限的批量必须照常成功')
    assert.equal(batchValue.failed, 0)
    assert.ok(hits > before, '批量也得真的发请求')
  })
})

test('批量：3 条全部成功，逐条给出结果，且两条轨道都带同一个批次 ID', async () => {
  const body = Buffer.alloc(1024, 0x52)
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' })
    res.end(body)
  }, async (base) => {
    const dlDir = process.env.DSH_DOWNLOAD_PROGRESS_DIR!
    const taskDir = process.env.DSH_PROGRESS_DIR!
    const beforeJson = filesIn(dlDir, '.json')
    const beforeJsonl = filesIn(taskDir, '.jsonl')

    const targets = [0, 1, 2].map((i) => ({
      url: `${base}/f${i}.bin`,
      output: path.join(tmpRoot, `batch-${i}.bin`),
    }))
    const result = await runBatch(targets)

    assert.match(result.batch, /^b-/, '批次 ID 必须有可辨认的前缀')
    assert.equal(result.succeeded, 3)
    assert.equal(result.failed, 0)
    assert.equal(result.cancelled, 0)
    assert.equal(result.results.length, 3)
    assert.deepEqual(
      result.results.map((r) => r.url),
      targets.map((t) => t.url),
      '逐条结果的顺序必须与入参一致，否则调用方对不上',
    )
    for (const [i, item] of result.results.entries()) {
      assert.equal(item.success, true, `第 ${i} 条应成功`)
      assert.equal(item.output, targets[i]!.output)
      assert.equal(item.path, targets[i]!.output)
      assert.ok(item.method === 'aria2' || item.method === 'curl')
      assert.equal(existsSync(targets[i]!.output!), true, '成功条目必须真的落盘')
    }
    assert.equal(snapshotJsonValue(result) === undefined, false, '批量结果必须是 lossless JSON')
    // 关键：批量形态必须真的通过工具自己的 output schema（oneOf 的批量分支）。
    // 少声明一个字段，真实调用就会因 additionalProperties 被拒。
    assert.deepEqual(
      validateSchema(tool.output.schema, snapshotJsonValue(result)),
      [],
      '批量结果必须通过 output schema 校验',
    )

    // 轨道二：本次新增 3 个任务文件，且都带同一个批次 ID
    const newJson = newFiles(beforeJson, filesIn(dlDir, '.json'))
    assert.equal(newJson.length, 3, `轨道二应新增 3 个任务文件，实际 ${newJson.length}`)
    const taskIds = new Set<string>()
    for (const file of newJson) {
      const rec = JSON.parse(readFileSync(path.join(dlDir, file), 'utf-8')) as {
        id: string
        batch?: string
        status: string
      }
      assert.equal(rec.batch, result.batch, '轨道二的每条记录都必须带上批次 ID')
      assert.equal(rec.status, 'completed')
      taskIds.add(rec.id)
    }
    assert.equal(taskIds.size, 3, '每条目一个 taskId（同一条目不得共用）')
    assert.equal(taskIds.has(result.batch), false, '批次 ID 不是任务 ID：两者必须能分辨')

    // 轨道一：同理，末尾记录的 state 必须是 done，且带同一个批次 ID
    const newJsonl = newFiles(beforeJsonl, filesIn(taskDir, '.jsonl'))
    assert.equal(newJsonl.length, 3, `轨道一应新增 3 个任务文件，实际 ${newJsonl.length}`)
    for (const file of newJsonl) {
      const lines = readFileSync(path.join(taskDir, file), 'utf-8').trim().split('\n')
      const last = JSON.parse(lines[lines.length - 1]!) as { batch?: string; state?: string }
      assert.equal(last.batch, result.batch, '轨道一的每条记录都必须带上批次 ID')
      assert.equal(last.state, 'done')
    }
  })
})

test('批量：单条目路径的返回值与 1.2.0 逐字段相同（没有 batch/results）', async () => {
  const body = Buffer.alloc(1536, 0x53)
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' })
    res.end(body)
  }, async (base) => {
    const dlDir = process.env.DSH_DOWNLOAD_PROGRESS_DIR!
    const beforeJson = filesIn(dlDir, '.json')
    const result = await run({ url: `${base}/single.bin`, output: path.join(tmpRoot, 'single.bin') })

    assert.equal(result.success, true)
    // 硬回归项：单条目返回值不得多出任何批量字段
    assert.equal(Object.hasOwn(result, 'batch'), false, '单条目返回值不得带 batch')
    assert.equal(Object.hasOwn(result, 'results'), false, '单条目返回值不得带 results')
    assert.deepEqual(
      Object.keys(result).sort(),
      ['fellback', 'method', 'mirrored', 'path', 'reason', 'requestedUrl', 'size', 'success'],
      '字段集合必须与 1.2.0 一致',
    )

    // 但进度记录里仍然要有批次 ID（P0-5：单条目调用的批次 id 存在且唯一）
    const newJson = newFiles(beforeJson, filesIn(dlDir, '.json'))
    assert.equal(newJson.length, 1)
    const rec = JSON.parse(readFileSync(path.join(dlDir, newJson[0]!), 'utf-8')) as {
      batch?: string
    }
    assert.match(rec.batch ?? '', /^b-/, '单条目调用也必须写入批次 ID')

    // 单条目形态同样要过 output schema（oneOf 的另一支，回归项：
    // 加了批量分支之后，老形态不得因为 oneOf 变成「两支都不匹配」）
    assert.deepEqual(
      validateSchema(tool.output.schema, snapshotJsonValue(result)),
      [],
      '单条目结果必须仍通过 output schema 校验',
    )
  })
})

test('批量：一条失败不影响另一条成功（D4=② 逐条给出原因，成功结果不丢）', async () => {
  const body = Buffer.alloc(2048, 0x54)
  await withServer((req, res) => {
    if (req.url?.includes('missing')) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('nope')
      return
    }
    res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' })
    res.end(body)
  }, async (base) => {
    const okOut = path.join(tmpRoot, 'partial-ok.bin')
    const badOut = path.join(tmpRoot, 'partial-bad.bin')
    const result = await runBatch([
      { url: `${base}/ok.bin`, output: okOut },
      { url: `${base}/missing.bin`, output: badOut },
    ])

    assert.equal(result.succeeded, 1)
    assert.equal(result.failed, 1)
    assert.equal(result.cancelled, 0)

    const ok = result.results[0] as Item
    const bad = result.results[1] as Item
    // 成功条目的结果必须完整保留（失败条目不得把它一起吞掉）
    assert.equal(ok.success, true)
    assert.equal(ok.path, okOut)
    assert.equal(existsSync(okOut), true, '成功条目必须真的落盘')
    // 失败条目必须逐条给出原因
    assert.equal(bad.success, false)
    assert.equal(bad.cancelled, undefined, '失败不是取消')
    assert.equal(typeof bad.error, 'string')
    assert.ok((bad.error ?? '').length > 0, '失败条目必须带原因')
    assert.match(bad.error ?? '', /404|HTTP|22|失败/, '原因必须是可读的下载器报错')
    assert.equal(snapshotJsonValue(result) === undefined, false)
  })
})

test('批量：整批在开工前已取消 -> 逐条标为取消（不是失败），并各写一条取消记录', async () => {
  const dlDir = process.env.DSH_DOWNLOAD_PROGRESS_DIR!
  const taskDir = process.env.DSH_PROGRESS_DIR!
  const beforeJson = filesIn(dlDir, '.json')
  const beforeJsonl = filesIn(taskDir, '.jsonl')

  const controller = new AbortController()
  controller.abort()
  const targets = [0, 1, 2].map((i) => ({
    url: `http://127.0.0.1:9/cancel${i}`,
    output: path.join(tmpRoot, `cancel-${i}.bin`),
  }))
  const result = await runBatch(targets, {}, { signal: controller.signal })

  // 取消必须**正常返回**（不抛错）：已完成条目的结果不能被一个异常吞掉
  assert.equal(result.succeeded, 0)
  assert.equal(result.failed, 0, '取消不是失败：failed 计数必须为 0')
  assert.equal(result.cancelled, 3)
  const outputByUrl = new Map(targets.map((t) => [t.url, t.output]))
  for (const item of result.results) {
    assert.equal(item.success, false)
    assert.equal(item.cancelled, true)
    assert.match(item.error ?? '', /已取消/)
    // 未开工的条目也要报出「本该落到哪」，否则用户无从判断它有没有留下半包
    assert.equal(item.output, outputByUrl.get(item.url), 'output 必须与入参该条目的 output 一致')
  }
  assert.equal(snapshotJsonValue(result) === undefined, false)

  // 未开工的条目也要各留下一条「已取消」记录（否则面板上它们凭空消失）
  const newJson = newFiles(beforeJson, filesIn(dlDir, '.json'))
  assert.equal(newJson.length, 3, '每条被取消的条目都要写轨道二')
  for (const file of newJson) {
    const rec = JSON.parse(readFileSync(path.join(dlDir, file), 'utf-8')) as {
      status: string
      batch?: string
    }
    assert.equal(rec.status, 'cancelled')
    assert.equal(rec.batch, result.batch)
  }
  const newJsonl = newFiles(beforeJsonl, filesIn(taskDir, '.jsonl'))
  assert.equal(newJsonl.length, 3, '每条被取消的条目都要写轨道一')
  for (const file of newJsonl) {
    const lines = readFileSync(path.join(taskDir, file), 'utf-8').trim().split('\n')
    const last = JSON.parse(lines[lines.length - 1]!) as { state?: string; batch?: string }
    assert.equal(last.state, 'cancelled')
    assert.equal(last.batch, result.batch)
  }
})

test('批量：中途取消时，没有任何条目被改判成失败（已完成照旧成功）', async () => {
  const body = Buffer.alloc(1024, 0x55)
  await withServer((req, res) => {
    if (req.url?.includes('slow')) {
      // 永不结束：等待测试中途 abort
      res.writeHead(200, { 'content-length': '9999999' })
      res.write(body)
      return
    }
    res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' })
    res.end(body)
  }, async (base) => {
    const controller = new AbortController()
    const pending = tool.execute(
      {
        targets: [
          { url: `${base}/fast.bin`, output: path.join(tmpRoot, 'mid-fast.bin') },
          { url: `${base}/slow.bin`, output: path.join(tmpRoot, 'mid-slow.bin') },
        ],
      },
      { signal: controller.signal },
    ) as Promise<BatchDownloadResult>
    // 给 fast 条目足够时间完成；slow 会一直挂着
    await new Promise((r) => setTimeout(r, 400))
    controller.abort()
    const result = await pending

    // 关键不变量（与竞态无关）：取消归取消，**没有任何条目被标成失败**；
    // fast 要么成功（它的结果必须还在），要么也被取消 —— 二者都不能变成 failed。
    assert.equal(result.failed, 0, '取消不得把任何条目改判为失败')
    assert.equal(result.cancelled >= 1, true, '至少有一条未完成的条目被标为取消')
    for (const item of result.results) {
      assert.equal(item.success || item.cancelled === true, true, '每条只能是成功或取消')
    }
    const fast = result.results.find((r) => r.url.includes('fast')) as Item
    if (fast.success) {
      assert.equal(existsSync(path.join(tmpRoot, 'mid-fast.bin')), true, '成功条目的文件必须还在')
    }
  })
})

/* ============== 1.5.0：通用摘要 / 同名策略 / 文件名 / 磁盘预检 ============== */

const CHECKSUM_BODY = Buffer.from('dsh-smart-download checksum fixture\n', 'utf-8')

function digestOf(algorithm: 'md5' | 'sha1' | 'sha256' | 'sha512'): string {
  return createHash(algorithm).update(CHECKSUM_BODY).digest('hex')
}

test('checksum：MD5 / SHA-1 / SHA-512 成功时返回实际摘要与算法，且不返回 sha256', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, {
      'content-length': String(CHECKSUM_BODY.length),
      'accept-ranges': 'bytes',
    })
    res.end(CHECKSUM_BODY)
  }, async (base) => {
    const cases = [
      { algorithm: 'md5', expected: digestOf('md5') },
      { algorithm: 'sha1', expected: `sha1:${digestOf('sha1')}` },
      { algorithm: 'sha512', expected: digestOf('sha512').toUpperCase() },
    ] as const

    for (const { algorithm, expected } of cases) {
      const out = path.join(tmpRoot, `checksum-${algorithm}.bin`)
      const result = await run({
        url: `${base}/checksum-${algorithm}.bin`,
        output: out,
        checksum: expected,
      })

      assert.equal(result.success, true)
      assert.equal(result.checksumAlgorithm, algorithm)
      assert.equal(result.checksum, digestOf(algorithm))
      assert.equal(Object.hasOwn(result, 'sha256'), false, '通用 checksum 不得冒充 sha256')
      assert.equal(readFileSync(out).equals(CHECKSUM_BODY), true)
      assert.equal(snapshotJsonValue(result) === undefined, false, '结果必须是 lossless JSON')
      assert.deepEqual(validateSchema(tool.output.schema, snapshotJsonValue(result)), [])
    }
  })
})

test('checksum 不匹配：抛错、保留产物与旁车指纹，不报告成功', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, {
      'content-length': String(CHECKSUM_BODY.length),
      'accept-ranges': 'bytes',
    })
    res.end(CHECKSUM_BODY)
  }, async (base) => {
    const out = path.join(tmpRoot, 'checksum-mismatch.bin')
    await assert.rejects(
      () =>
        run({
          url: `${base}/checksum-mismatch.bin`,
          output: out,
          checksum: `md5:${'0'.repeat(32)}`,
        }),
      /完整性校验失败.*MD5 不匹配/s,
    )

    assert.equal(existsSync(out), true, '产物必须保留，供用户核对')
    assert.equal(existsSync(`${out}.part.json`), true, '旁车指纹必须保留')
    assert.equal(readFileSync(out).equals(CHECKSUM_BODY), true)
  })
})

test('sha256 与 checksum 同时给：请求前拒绝（一个请求都不发）', async () => {
  let hits = 0
  await withServer((_req, res) => {
    hits += 1
    res.writeHead(200, { 'content-length': '1' })
    res.end('x')
  }, async (base) => {
    await assert.rejects(
      () =>
        run({
          url: `${base}/both.bin`,
          output: path.join(tmpRoot, 'both.bin'),
          sha256: digestOf('sha256'),
          checksum: digestOf('md5'),
        }),
      /sha256 与 checksum 只能二选一/,
    )
    assert.equal(hits, 0, '参数互斥必须在探测前拒绝')
  })
})

test('ifExists=skip：已有文件时不发下载 GET，返回 skipped 且不带 method', async () => {
  let getHits = 0
  await withServer((req, res) => {
    if (req.method === 'GET') getHits += 1
    res.writeHead(200, {
      'content-length': String(CHECKSUM_BODY.length),
      'accept-ranges': 'bytes',
    })
    res.end(CHECKSUM_BODY)
  }, async (base) => {
    const out = path.join(tmpRoot, 'skip-existing.bin')
    writeFileSync(out, 'already here')

    const result = await run({
      url: `${base}/skip-existing.bin`,
      output: out,
      ifExists: 'skip',
    })

    assert.equal(result.success, true)
    assert.equal(result.skipped, true)
    assert.equal(Object.hasOwn(result, 'method'), false, 'skip 不得带 method')
    assert.equal(readFileSync(out, 'utf-8'), 'already here', '已有文件不得被改动')
    assert.equal(getHits, 0, 'skip 不得发出下载 GET')
    assert.equal(snapshotJsonValue(result) === undefined, false)
    assert.deepEqual(validateSchema(tool.output.schema, snapshotJsonValue(result)), [])
  })
})

test('ifExists=skip + 摘要：匹配则成功，不匹配则抛错并保留原文件', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, {
      'content-length': String(CHECKSUM_BODY.length),
      'accept-ranges': 'bytes',
    })
    res.end(CHECKSUM_BODY)
  }, async (base) => {
    const good = path.join(tmpRoot, 'skip-checksum-good.bin')
    writeFileSync(good, CHECKSUM_BODY)
    const ok = await run({
      url: `${base}/skip-checksum-good.bin`,
      output: good,
      ifExists: 'skip',
      checksum: `md5:${digestOf('md5')}`,
    })
    assert.equal(ok.skipped, true)
    assert.equal(ok.checksum, digestOf('md5'))
    assert.equal(ok.checksumAlgorithm, 'md5')
    assert.equal(Object.hasOwn(ok, 'method'), false)

    const bad = path.join(tmpRoot, 'skip-checksum-bad.bin')
    const wrong = Buffer.from(CHECKSUM_BODY)
    wrong[0] = wrong[0]! ^ 0xff
    writeFileSync(bad, wrong)
    await assert.rejects(
      () =>
        run({
          url: `${base}/skip-checksum-bad.bin`,
          output: bad,
          ifExists: 'skip',
          checksum: `md5:${digestOf('md5')}`,
        }),
      /完整性校验失败.*MD5 不匹配/s,
    )
    assert.equal(readFileSync(bad).equals(wrong), true, '校验失败时原文件必须原样保留')
  })
})

test('ifExists=rename：绝不覆盖已有文件，依次得到 name (1) / name (2)', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, {
      'content-length': String(CHECKSUM_BODY.length),
      'accept-ranges': 'bytes',
    })
    res.end(CHECKSUM_BODY)
  }, async (base) => {
    const out = path.join(tmpRoot, 'rename-me.zip')
    writeFileSync(out, 'original')

    const first = await run({
      url: `${base}/rename-me.zip`,
      output: out,
      ifExists: 'rename',
    })
    assert.equal(first.path, path.join(tmpRoot, 'rename-me (1).zip'))
    assert.equal(readFileSync(out, 'utf-8'), 'original', '原文件不得被覆盖')
    assert.equal(readFileSync(first.path).equals(CHECKSUM_BODY), true)

    const second = await run({
      url: `${base}/rename-me.zip`,
      output: out,
      ifExists: 'rename',
    })
    assert.equal(second.path, path.join(tmpRoot, 'rename-me (2).zip'))
    assert.equal(readFileSync(out, 'utf-8'), 'original')
    assert.equal(readFileSync(second.path).equals(CHECKSUM_BODY), true)
  })
})

test('ifExists=overwrite：默认覆盖已有文件', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, {
      'content-length': String(CHECKSUM_BODY.length),
      'accept-ranges': 'bytes',
    })
    res.end(CHECKSUM_BODY)
  }, async (base) => {
    const out = path.join(tmpRoot, 'overwrite.bin')
    writeFileSync(out, 'stale')
    const result = await run({ url: `${base}/overwrite.bin`, output: out })
    assert.equal(result.path, out)
    assert.equal(readFileSync(out).equals(CHECKSUM_BODY), true)
  })
})

test('Content-Disposition：未传 output 时采用真实文件名，路径穿越被压成单段名', async () => {
  await withServer((req, res) => {
    const header =
      req.url?.includes('evil')
        ? 'attachment; filename="../../evil.zip"'
        : 'attachment; filename="real-name.zip"'
    res.writeHead(200, {
      'content-length': String(CHECKSUM_BODY.length),
      'accept-ranges': 'bytes',
      'content-disposition': header,
    })
    res.end(CHECKSUM_BODY)
  }, async (base) => {
    const cwdBefore = process.cwd()
    const workDir = mkdtempSync(path.join(tmpRoot, 'cd-name-'))
    process.chdir(workDir)
    try {
      const named = await run({ url: `${base}/download` })
      assert.equal(path.basename(named.path), 'real-name.zip')
      assert.equal(path.dirname(named.path), workDir)
      assert.equal(existsSync(path.join(workDir, 'real-name.zip')), true)

      const evil = await run({ url: `${base}/evil` })
      assert.equal(path.basename(evil.path), 'evil.zip')
      assert.equal(path.dirname(evil.path), workDir, '不得写到当前目录之外')
      assert.equal(existsSync(path.join(workDir, 'evil.zip')), true)
    } finally {
      process.chdir(cwdBefore)
    }
  })
})

test('磁盘空间预检：远端声明的大小超出可用空间时，下载前拒绝', async () => {
  let getHits = 0
  await withServer((req, res) => {
    if (req.method === 'GET') getHits += 1
    res.writeHead(200, {
      'content-length': String(1e15),
      'accept-ranges': 'bytes',
    })
    res.end()
  }, async (base) => {
    const out = path.join(tmpRoot, 'too-big.bin')
    await assert.rejects(
      () => run({ url: `${base}/too-big.bin`, output: out }),
      /磁盘可用空间不足/,
    )
    assert.equal(getHits, 0, '预检失败不得继续下载')
    assert.equal(existsSync(out), false)
  })
})

test('批量：逐条 checksum / ifExists 各自生效，skip 计成功且失败条目可辨认', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, {
      'content-length': String(CHECKSUM_BODY.length),
      'accept-ranges': 'bytes',
    })
    res.end(CHECKSUM_BODY)
  }, async (base) => {
    const skipOut = path.join(tmpRoot, 'batch-skip.bin')
    writeFileSync(skipOut, CHECKSUM_BODY)
    const failOut = path.join(tmpRoot, 'batch-fail.bin')

    const result = await runBatch([
      {
        url: `${base}/batch-md5.bin`,
        output: path.join(tmpRoot, 'batch-md5.bin'),
        checksum: `md5:${digestOf('md5')}`,
      },
      {
        url: `${base}/batch-skip.bin`,
        output: skipOut,
        ifExists: 'skip',
        checksum: `md5:${digestOf('md5')}`,
      },
      {
        url: `${base}/batch-fail.bin`,
        output: failOut,
        checksum: `sha1:${'0'.repeat(40)}`,
      },
    ])

    assert.equal(result.succeeded, 2, 'skip 是成功，不是失败')
    assert.equal(result.failed, 1)
    assert.equal(result.cancelled, 0)

    const [md5, skipped, failed] = result.results
    assert.equal(md5!.success, true)
    assert.equal(md5!.checksumAlgorithm, 'md5')
    assert.equal(md5!.checksum, digestOf('md5'))
    assert.equal(Object.hasOwn(md5!, 'sha256'), false)

    assert.equal(skipped!.success, true)
    assert.equal(skipped!.skipped, true)
    assert.equal(Object.hasOwn(skipped!, 'method'), false, 'skip 条目不得带 method')
    assert.equal(skipped!.output, skipOut, '批量 output 必须是真实落盘路径')

    assert.equal(failed!.success, false)
    assert.match(failed!.error ?? '', /完整性校验失败.*SHA-1 不匹配/s)
    assert.equal(existsSync(failOut), true, '失败条目的产物保留，供核对')

    assert.equal(snapshotJsonValue(result) === undefined, false)
    assert.deepEqual(
      validateSchema(tool.output.schema, snapshotJsonValue(result)),
      [],
      '新增字段必须能通过批量 output schema',
    )
  })
})

test('批量：未传 output 时逐条 output 指向 Content-Disposition 的真实文件名', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, {
      'content-length': String(CHECKSUM_BODY.length),
      'accept-ranges': 'bytes',
      'content-disposition': 'attachment; filename="batch-real-name.zip"',
    })
    res.end(CHECKSUM_BODY)
  }, async (base) => {
    const cwdBefore = process.cwd()
    const workDir = mkdtempSync(path.join(tmpRoot, 'batch-cd-'))
    process.chdir(workDir)
    try {
      const result = await runBatch([{ url: `${base}/download` }])
      assert.equal(result.succeeded, 1)
      assert.equal(result.results[0]!.output, path.join(workDir, 'batch-real-name.zip'))
      assert.equal(result.results[0]!.path, result.results[0]!.output)
      assert.equal(existsSync(result.results[0]!.output), true)
    } finally {
      process.chdir(cwdBefore)
    }
  })
})

test('批量：没有会话也没有 DSH_PROGRESS_DIR 时只写轨道二（缺轨道一不报错）', async () => {
  const body = Buffer.alloc(768, 0x57)
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' })
    res.end(body)
  }, async (base) => {
    const savedTask = process.env.DSH_PROGRESS_DIR
    const dlDir = process.env.DSH_DOWNLOAD_PROGRESS_DIR!
    const beforeJson = filesIn(dlDir, '.json')
    delete process.env.DSH_PROGRESS_DIR
    try {
      const result = await runBatch([
        { url: `${base}/n1.bin`, output: path.join(tmpRoot, 'n1.bin') },
        { url: `${base}/n2.bin`, output: path.join(tmpRoot, 'n2.bin') },
      ])
      assert.equal(result.succeeded, 2, '缺轨道一时批量必须照常成功（不是报错）')
      const newJson = newFiles(beforeJson, filesIn(dlDir, '.json'))
      assert.equal(newJson.length, 2, '轨道二照写')
      for (const file of newJson) {
        const rec = JSON.parse(readFileSync(path.join(dlDir, file), 'utf-8')) as { batch?: string }
        assert.equal(rec.batch, result.batch, '轨道二仍带批次 ID')
      }
    } finally {
      if (savedTask !== undefined) process.env.DSH_PROGRESS_DIR = savedTask
    }
  })
})

test('1.4.0：下载完成后两条轨道都记下绝对 outPath 与 size（下载管理器的数据源）', async () => {
  // 本文件共享一个 tmpRoot（见 before()），进度目录要等第一条下载才被创建 ——
  // 单独跑这条用例时目录还不存在。用 filesInOrEmpty 而不是 filesIn，是为了让
  // 「单独跑」时的失败落在真正的断言上，而不是一个 filesIn 的 ENOENT。
  const filesInOrEmpty = (dir: string, ext: string): Set<string> =>
    existsSync(dir) ? filesIn(dir, ext) : new Set<string>()
  const body = Buffer.alloc(2048, 0x5a)
  await withServer((_req, res) => {
    res.writeHead(200, {
      'content-length': String(body.length),
      'accept-ranges': 'bytes',
      'content-type': 'application/octet-stream',
    })
    res.end(body)
  }, async (base) => {
    const out = path.join(tmpRoot, 'managed.bin')
    const dlDir = process.env.DSH_DOWNLOAD_PROGRESS_DIR!
    const progressDir = process.env.DSH_PROGRESS_DIR!
    const beforeJson = filesInOrEmpty(dlDir, '.json')
    const beforeJsonl = filesInOrEmpty(progressDir, '.jsonl')
    const result = await run({ url: `${base}/managed.bin`, output: out })
    assert.equal(result.success, true)

    // 轨道二：产物路径与尺寸都要落盘
    const newJson = newFiles(beforeJson, filesIn(dlDir, '.json'))
    assert.equal(newJson.length, 1, '本次任务应在轨道二留下一条记录')
    const task = JSON.parse(readFileSync(path.join(dlDir, newJson[0]!), 'utf-8')) as {
      outPath?: string
      size?: number
      status?: string
    }
    assert.equal(task.outPath, out, '记录的必须是产物绝对路径')
    assert.equal(task.size, body.length, '终态必须记下真实字节数')
    assert.equal(task.status, 'completed')

    // 轨道一：最后一条（终态）同样带路径与尺寸
    const newJsonl = newFiles(beforeJsonl, filesIn(progressDir, '.jsonl'))
    assert.equal(newJsonl.length, 1)
    const lines = readFileSync(path.join(progressDir, newJsonl[0]!), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { state?: string; outPath?: string; size?: number })
    const terminal = lines[lines.length - 1]!
    assert.equal(terminal.state, 'done')
    assert.equal(terminal.outPath, out, '轨道一也要能定位到产物')
    assert.equal(terminal.size, body.length)
  })
})

test('1.4.0：调用方给相对 output 时，记录里仍是绝对路径（spawn 没有 cwd 的那个坑）', async () => {
  const body = Buffer.alloc(512, 0x6b)
  await withServer((_req, res) => {
    res.writeHead(200, {
      'content-length': String(body.length),
      'accept-ranges': 'bytes',
      'content-type': 'application/octet-stream',
    })
    res.end(body)
  }, async (base) => {
    const cwdBefore = process.cwd()
    // 相对 output 的落点取决于进程 cwd（aria2/curl 子进程没有指定 cwd，
    // 继承的就是这个 cwd）—— 记录里必须把同一件事写成绝对值，否则下载管理器
    // 拿到的路径在别的 cwd 下会指向完全不同的文件。
    process.chdir(tmpRoot)
    try {
      const dlDir = process.env.DSH_DOWNLOAD_PROGRESS_DIR!
      const beforeJson = dlDir.length > 0 && existsSync(dlDir) ? filesIn(dlDir, '.json') : new Set<string>()
      const result = await run({ url: `${base}/relative-record.bin`, output: 'relative-record.bin' })
      assert.equal(result.success, true)
      assert.equal(result.path, path.join(tmpRoot, 'relative-record.bin'), '返回的路径也必须是绝对路径')
      const newJson = newFiles(beforeJson, filesIn(dlDir, '.json'))
      const task = JSON.parse(readFileSync(path.join(dlDir, newJson[0]!), 'utf-8')) as {
        outPath?: string
      }
      assert.equal(
        task.outPath,
        path.join(tmpRoot, 'relative-record.bin'),
        '记录必须是绝对路径（否则删除时会按另一个 cwd 去猜）',
      )
      assert.equal(existsSync(path.join(tmpRoot, 'relative-record.bin')), true)
    } finally {
      process.chdir(cwdBefore)
    }
  })
})

test('批量：并发窗口按「批内总连接数有界」反推（不再是单条目最高档 8）', async () => {
  // 期望值从与实现相同的规则算出来，而不是写死一个数字：单条目最高档 × 2 的连接预算
  // 除以单条目可能占用的连接数。规则一旦改（或档位阶梯改），这里会跟着变红/变绿。
  const perItemTier = decideConcurrency(LARGE_FILE)
  const expectedWindow = Math.max(1, Math.floor((perItemTier * 2) / perItemTier))
  // 规则在当前阶梯下的取值本身也是要守的事实：8 连接 → 窗口 2（峰值 ~16，不是 64）
  assert.equal(expectedWindow, 2, `当前档位 ${perItemTier} 下窗口应为 2`)
  assert.ok(
    expectedWindow < perItemTier,
    '窗口必须比单条目最高档小：否则峰值连接数 = 窗口 × 高档，仍然会触发按 IP 限并发',
  )
  assert.equal(expectedWindow * perItemTier, perItemTier * 2, '窗口 × 单条目档位 = 批内连接预算')

  let active = 0
  let maxActive = 0
  const body = Buffer.alloc(512, 0x56)
  await withServer((_req, res) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    setTimeout(() => {
      res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' })
      res.end(body)
      active -= 1
    }, 40)
  }, async (base) => {
    // 12 条与 t8 实测时用的条数一致：条目够多才能看出窗口的真实宽度
    const targets = Array.from({ length: 12 }, (_, i) => ({
      url: `${base}/c${i}.bin`,
      output: path.join(tmpRoot, `conc-${i}.bin`),
    }))
    const result = await runBatch(targets)
    assert.equal(result.succeeded, targets.length)
    assert.equal(
      maxActive,
      expectedWindow,
      `实测峰值并发 ${maxActive} 必须等于推导出的窗口 ${expectedWindow}（12 条足够把窗口占满）`,
    )
  })
})

/* ---------------- timeoutMs（D3）：超时后的进度呈现 ---------------- */

test('timeoutMs：非法值在发起任何请求之前抛错（与 maxBandwidth 同一套做法）', async () => {
  let hits = 0
  const body = Buffer.alloc(1024, 0x61)
  await withServer((_req, res) => {
    hits += 1
    res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' })
    res.end(body)
  }, async (base) => {
    // 0 / 负数 / 低于下限 / 高于上限 / 小数 / null / NaN / 非数字
    for (const bad of [0, -1, 999, 1_800_001, 1.5, null, Number.NaN, 'abc']) {
      await assert.rejects(
        () =>
          run({
            url: `${base}/to.bin`,
            output: path.join(tmpRoot, 'to.bin'),
            timeoutMs: bad,
          }),
        /timeoutMs/,
        `timeoutMs=${JSON.stringify(bad)} 必须在发请求前拒绝`,
      )
    }
    assert.equal(hits, 0, '超时参数非法时一个请求都不该发出')

    // 正向：两个边界值都必须被接受并照常下载 —— 否则「只校验、不生效」也能骗过上面那批断言
    for (const ok of [1_000, 1_800_000]) {
      const result = await run({
        url: `${base}/to-ok-${ok}.bin`,
        output: path.join(tmpRoot, `to-ok-${ok}.bin`),
        timeoutMs: ok,
      })
      assert.equal(result.success, true, `timeoutMs=${ok} 是合法边界值，必须照常下载`)
    }
    assert.ok(hits >= 3, '合法超时值必须真的发起下载')
  })
})

test('timeoutMs：批量下超时的条目失败、其余条目继续、已完成条目不被改判', async () => {
  const body = Buffer.alloc(1024, 0x62)
  const dlDir = process.env.DSH_DOWNLOAD_PROGRESS_DIR!
  const taskDir = process.env.DSH_PROGRESS_DIR!
  const beforeJson = filesIn(dlDir, '.json')
  const beforeJsonl = filesIn(taskDir, '.jsonl')
  await withServer((req, res) => {
    if (req.url?.includes('hang')) {
      // 声明 9MB、只发 1KB 后既不结束也不关闭：只有超时能结束这一条
      res.writeHead(200, { 'content-length': '9999999' })
      res.write(body)
      return
    }
    res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' })
    res.end(body)
  }, async (base) => {
    const result = await runBatch(
      [
        { url: `${base}/first.bin`, output: path.join(tmpRoot, 'to-first.bin') },
        { url: `${base}/hang.bin`, output: path.join(tmpRoot, 'to-hang.bin') },
        { url: `${base}/last.bin`, output: path.join(tmpRoot, 'to-last.bin') },
      ],
      { timeoutMs: 1_000 },
    )

    // 超时那一条：失败（不是取消），原因里带出超时与毫秒数
    assert.equal(result.succeeded, 2, '没超时的两条必须照常成功')
    assert.equal(result.failed, 1, '超时的那一条记失败')
    assert.equal(result.cancelled, 0, '超时不是取消：cancelled 计数必须为 0')
    const hang = result.results.find((r) => r.url.includes('hang')) as BatchItemResult
    assert.equal(hang.success, false)
    assert.notEqual(hang.cancelled, true, '超时不得被标成取消')
    assert.match(hang.error ?? '', /下载超时/)
    assert.match(hang.error ?? '', /1000ms/, '文案必须带出设置的毫秒数，便于核对')
    assert.doesNotMatch(hang.error ?? '', /取消/, '超时文案不得说成取消')

    // 已完成条目不被改判：两条成功的文件必须真的落盘
    for (const name of ['to-first.bin', 'to-last.bin']) {
      assert.equal(existsSync(path.join(tmpRoot, name)), true, `${name} 必须落盘`)
    }
    assert.equal(result.results[0]?.success, true, '第一条已完成的条目不得被改判')

    // 进度呈现：轨道二里超时那条必须是 failed（不是 running、也不是 cancelled）——
    // 这正是「超时后进度如何呈现」要守的东西。
    const newJson = newFiles(beforeJson, filesIn(dlDir, '.json'))
    assert.equal(newJson.length, 3, '三条都要有轨道二记录')
    const byTask = newJson.map((file) => {
      const rec = JSON.parse(readFileSync(path.join(dlDir, file), 'utf-8')) as {
        id: string
        status: string
        name: string
      }
      return rec
    })
    const statuses = byTask.map((r) => r.status).sort()
    assert.deepEqual(statuses, ['completed', 'completed', 'failed'])
    const timedOut = byTask.find((r) => r.status === 'failed') as { id: string; name: string }
    assert.equal(timedOut.name, path.join(tmpRoot, 'to-hang.bin'), 'failed 记录必须属于超时那一条')

    // 轨道一的终态同理：done / done / failed，且不得停在 running
    const newJsonl = newFiles(beforeJsonl, filesIn(taskDir, '.jsonl'))
    assert.equal(newJsonl.length, 3)
    const states = newJsonl.map((file) => {
      const lines = readFileSync(path.join(taskDir, file), 'utf-8').trim().split('\n')
      return (JSON.parse(lines[lines.length - 1]!) as { state?: string }).state
    })
    assert.deepEqual(states.sort(), ['done', 'done', 'failed'])
  })
})

test('timeoutMs：单条目超时 -> 抛错（不返回 success），且进度记成失败而不是取消', async () => {
  const body = Buffer.alloc(1024, 0x63)
  const dlDir = process.env.DSH_DOWNLOAD_PROGRESS_DIR!
  const beforeJson = filesIn(dlDir, '.json')
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-length': '9999999' })
    res.write(body)
  }, async (base) => {
    await assert.rejects(
      () =>
        run({
          url: `${base}/hang-single.bin`,
          output: path.join(tmpRoot, 'to-single.bin'),
          timeoutMs: 1_000,
        }),
      /下载超时/,
      '单条目超时必须抛错，而不是「成功但没下完」',
    )

    const newJson = newFiles(beforeJson, filesIn(dlDir, '.json'))
    assert.equal(newJson.length, 1, '单条目也要留下一条轨道二记录')
    const rec = JSON.parse(readFileSync(path.join(dlDir, newJson[0]!), 'utf-8')) as {
      status: string
    }
    assert.equal(rec.status, 'failed', '超时的终态是 failed（不是 cancelled，也不是停在 running）')
  })
})

/* ---------------- P1-2 抬档路径：真实下载建桶 → 命中历史 → decide() 抬档 ---------------- */

/**
 * 端到端串联（P1-2 的「抬档侧」证据，数值全部来自真实下载）：
 *
 *   真实 aria2 下 8MB（走满上限档 8 连接）→ 缓存里出现该主机的记录，`cn` 达到抬档门槛
 *   → 同一主机「第二次调用」时 `decide()` 按这条历史把 4MB 文件的档位从 4 抬到 8；
 *   清空缓存后同一个 4MB 只拿到 4 —— 这个差值就是抬档生效的证明。
 *
 * 为什么第一次是 8MB 而不是更大的文件（t25 起）：观测取整段的 **CN 峰值**，所以收尾排空
 * 不再污染记录。t24 时这里被迫用 32MB —— 那时取的是「最后一条摘要」，8MB 的最后一条是
 * `(96%) CN:1`（中途 `{60%, CN:8}`），正好落在门槛之下。现在 8MB 就够了，而「小文件也满足
 * 门槛」本身就是那条修复的守护。
 */
test('P1-2 抬档路径（端到端）：真实 8MB 下载写入门槛内历史后，同一主机第二次 decide() 真的抬档', async (t) => {
  if (getAria2Path() === null) {
    t.skip('本机无 aria2 子包，无法覆盖真实下载建桶')
    return
  }
  const cacheDir = process.env.DSH_SMARTDL_THROUGHPUT_DIR!
  const firstSize = 8 * 1024 * 1024 // 走满上限档；F2 修好后小文件的 CN 峰值也进记录
  const secondSize = 4 * 1024 * 1024 // 第二次「按文件大小」只该给 4
  const env = { platform: 'linux', arch: 'x64' }

  await withServer(
    serveThrottledRanged(firstSize, {
      chunk: 32 * 1024,
      delayMs: 40,
      stallAt: 4 * 1024 * 1024,
      stallMs: 1000,
    }),
    async (base) => {
      const url = `${base}/raise-path.bin`
      // ① 第一次调用：真实下载
      const first = await run({ url, output: path.join(tmpRoot, 'raise-path-1.bin') })
      assert.equal(first.method, 'aria2')
      assert.equal(first.success, true)
      assert.equal(first.size, firstSize)

      // ② 真实写入的记录必须自己满足抬档的两条证据（否则后面的抬档没有依据）
      const recorded = readThroughput(url, { dir: cacheDir })
      assert.ok(recorded, '第一次下载必须写出该主机的记录')
      assert.equal(recorded.record.concurrency, MAX_CONCURRENCY, '第一次必须走满上限档')
      assert.ok(
        recorded.record.cn >= RAISE_MIN_EFFECTIVE_CONNECTIONS,
        `实测实际有效连接数必须达到门槛 ${RAISE_MIN_EFFECTIVE_CONNECTIONS}，实际 ${recorded.record.cn}`,
      )
      assert.ok(recorded.record.medianThroughput > 0, '吞吐中位数必须是正数')

      const emptyDir = mkdtempSync(path.join(os.tmpdir(), 'raise-path-empty-'))
      try {
        // ③ 对照：清空缓存（换一个空目录）后，同一个文件大小只能按大小分档
        const withoutHistory = decide(
          { supportsMultiThread: true, contentLength: secondSize },
          true,
          env,
          { url, dir: emptyDir },
        )
        assert.equal(withoutHistory.concurrency, 4, '对照：无历史时必须按大小给 4')
        assert.doesNotMatch(withoutHistory.reason, new RegExp(HISTORY_RAISE_REASON))

        // ④ 第二次调用：同一主机 + 真实历史 → 必须抬到上限档
        const withHistory = decide(
          { supportsMultiThread: true, contentLength: secondSize },
          true,
          env,
          { url, dir: cacheDir },
        )
        assert.equal(withHistory.concurrency, MAX_CONCURRENCY, '命中历史后必须抬到上限档')
        assert.ok(
          withHistory.concurrency > withoutHistory.concurrency,
          `抬档必须体现为档位上升（对照 ${withoutHistory.concurrency} → 本次 ${withHistory.concurrency}）`,
        )
        assert.notEqual(withHistory.reason, withoutHistory.reason, '两种决策的文案必须可区分')
        assert.match(withHistory.reason, new RegExp(HISTORY_RAISE_REASON))
        const key = throughputKey(url)
        assert.ok(key)
        assert.match(withHistory.reason, new RegExp(key.hostHash), 'reason 必须带主机标识')
        assert.match(withHistory.reason, new RegExp(`端口 ${key.port}`))
        assert.match(
          withHistory.reason,
          new RegExp(`实测实际有效 ${recorded.record.cn} 条`),
          'reason 里的连接数必须与真实写入的记录一致',
        )
        assert.match(withHistory.reason, /按大小只给 4/)
        assert.match(withHistory.reason, /提到 8/)
      } finally {
        rmSync(emptyDir, { recursive: true, force: true })
      }
    },
  )
})

/**
 * F1 的端到端守护（t25 起）：**真实的第二次工具调用**必须抬档。
 *
 * t24 时这条用例断言的是反面（「第二次仍按大小分档、只有 4 连接」），因为 `src/index.ts`
 * 的调用点漏传了 history；t25 把 `decide(probe, aria2Path !== null, {}, { url: requestedUrl })`
 * 接上之后，这里翻转成断言抬档 —— 若有人再把那个参数拿掉，本用例立刻变红。
 *
 * 两个文件落在**同一个 host:port**（同一个缓存桶）上：第一次 8MB（走满上限档，
 * F2 修好后观测到的 CN 峰值 ≥ 4），第二次 4MB（按大小只该给 4，必须被历史抬到 8）。
 */
test('P1-2 抬档路径：同一主机的第二次真实工具调用必须抬档到 8（F1 端到端守护）', async (t) => {
  if (getAria2Path() === null) {
    t.skip('本机无 aria2 子包')
    return
  }
  const cacheDir = process.env.DSH_SMARTDL_THROUGHPUT_DIR!
  // 第一次用 8MB（不是 32MB）：F2 修好后小文件也能满足 cn ≥ 4 —— 这条尺寸本身就是 F2 的守护
  const bigSize = 8 * 1024 * 1024
  const smallSize = 4 * 1024 * 1024
  await withServer(
    // 同一个 server（同一 host:port，同一个缓存桶）按路径给两种大小
    serveThrottledRanged(
      (reqUrl) => (reqUrl.includes('small') ? smallSize : bigSize),
      { chunk: 32 * 1024, delayMs: 40, stallAt: 4 * 1024 * 1024, stallMs: 1000 },
    ),
    async (base) => {
      const bigUrl = `${base}/big.bin`
      const first = await run({ url: bigUrl, output: path.join(tmpRoot, 'wired-1.bin') })
      assert.equal(first.method, 'aria2')
      assert.equal(first.success, true)
      const recorded = readThroughput(bigUrl, { dir: cacheDir })
      assert.ok(recorded)
      // 这道门槛是 F2 的守护：修之前 8MB 记下来的是尾部排空的 cn=1，这里就会红
      assert.ok(
        recorded.record.cn >= RAISE_MIN_EFFECTIVE_CONNECTIONS,
        `8MB 的观测也必须满足门槛（F2：取整段峰值而不是尾部摘要），实际 cn=${recorded.record.cn}`,
      )
      assert.equal(recorded.record.concurrency, MAX_CONCURRENCY)

      // 对照：同一条历史直接交给 decide()，4MB 会被抬到 8（读侧行为）
      const direct = decide(
        { supportsMultiThread: true, contentLength: smallSize },
        true,
        { platform: 'linux', arch: 'x64' },
        { url: bigUrl, dir: cacheDir },
      )
      assert.equal(direct.concurrency, MAX_CONCURRENCY)

      // 真实工具调用的第二次：同一 host:port、4MB —— 必须抬档（F1 就是这条）
      const second = await run({ url: `${base}/small.bin`, output: path.join(tmpRoot, 'wired-2.bin') })
      assert.equal(second.success, true)
      assert.equal(second.size, smallSize)
      assert.match(
        String(second.reason),
        new RegExp(HISTORY_RAISE_REASON),
        `第二次真实调用必须写明依据历史抬档：${second.reason}`,
      )
      assert.match(String(second.reason), /提到 8/, '必须抬到上限档 8')
      assert.doesNotMatch(
        String(second.reason),
        /使用 4 连接/,
        '不得再出现「按大小分档给 4」的结论（那就是没抬档）',
      )
      assert.match(String(second.reason), /按大小只给 4/, 'reason 要说明按大小本来只给 4')
    },
  )
})

/* ---------------- P1-2 写入接线：下载结束点真的写缓存 ---------------- */


/**
 * 限速 + 支持 Range 的本地服务。
 *
 * 为什么要限速：不延迟的话 8MB 本地下载几十毫秒就结束，aria2 的 `--summary-interval=1`
 * 一条带速度的摘要都来不及吐 —— 那就没有任何观测值可写，用例变成「因为太快所以没缓存」
 * 的假绿（既有进度透传用例踩过同一个坑）。中途再插一段停顿，保证跨过摘要周期。
 */
function serveThrottledRanged(
  size: number | ((reqUrl: string) => number),
  opts: { chunk?: number; delayMs?: number; stallAt?: number; stallMs?: number } = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const chunk = opts.chunk ?? 32 * 1024
  const delayMs = opts.delayMs ?? 40
  const stallAt = opts.stallAt ?? -1
  const stallMs = opts.stallMs ?? 0
  // size 支持传函数：同一个 server（= 同一个 host:port = 同一个缓存桶）下按路径给不同大小，
  // 「第一次下大文件、第二次下小文件」这种场景才能落在同一个桶里。
  const bodies = new Map<number, Buffer>()
  const bodyFor = (n: number): Buffer => {
    const cached = bodies.get(n)
    if (cached) return cached
    const created = Buffer.alloc(n, 0x6b)
    bodies.set(n, created)
    return created
  }
  return (req, res) => {
    const reqUrl = req.url ?? ''
    const total = typeof size === 'function' ? size(reqUrl) : size
    const body = bodyFor(total)
    const range = typeof req.headers.range === 'string' ? req.headers.range : undefined
    let start = 0
    let end = total - 1
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range)
      start = m && m[1] ? Number(m[1]) : 0
      end = m && m[2] ? Math.min(Number(m[2]), total - 1) : total - 1
      res.writeHead(206, {
        'content-range': `bytes ${start}-${end}/${total}`,
        'content-length': String(end - start + 1),
        'accept-ranges': 'bytes',
        'content-type': 'application/octet-stream',
      })
    } else {
      res.writeHead(200, {
        'content-length': String(total),
        'accept-ranges': 'bytes',
        'content-type': 'application/octet-stream',
      })
    }
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    let off = start
    const tick = (): void => {
      if (off > end) {
        res.end()
        return
      }
      const next = Math.min(off + chunk, end + 1)
      res.write(body.subarray(off, next))
      const crossedStall = stallAt > 0 && off <= stallAt && next > stallAt
      off = next
      setTimeout(tick, crossedStall ? stallMs : delayMs)
    }
    tick()
  }
}

test('P1-2 写入接线（端到端）：真实 aria2 下载成功后，缓存里出现该主机的哈希记录', async (t) => {
  if (getAria2Path() === null) {
    t.skip('本机无 aria2 子包，无法覆盖 aria2 观测写入')
    return
  }
  const cacheDir = process.env.DSH_SMARTDL_THROUGHPUT_DIR!
  const size = LARGE_FILE // 8MB：档位就是上限档 8，与抬档判定要的「历史那次用满上限」一致
  const before = filesIn(cacheDir, '.json')
  await withServer(
    serveThrottledRanged(size, { chunk: 32 * 1024, delayMs: 40, stallAt: 4 * 1024 * 1024, stallMs: 1000 }),
    async (base) => {
      const result = await run({ url: `${base}/observed.bin`, output: path.join(tmpRoot, 'observed.bin') })
      assert.equal(result.method, 'aria2', '这条用例要的就是 aria2 路径（只有它有 CN 可观测）')
      assert.equal(result.success, true)
      assert.equal(result.size, size)

      const created = newFiles(before, filesIn(cacheDir, '.json'))
      assert.equal(
        created.length,
        1,
        '成功的 aria2 下载必须写出一条缓存记录（t20 交付时这里是零调用点，本项就是来消掉它的）',
      )
      const file = path.join(cacheDir, created[0]!)
      const text = readFileSync(file, 'utf-8')
      const record = JSON.parse(text) as {
        hostHash: string
        port: string
        samples: number[]
        medianThroughput: number
        concurrency: number
        cn: number
        updatedAt: number
      }
      const parsed = new URL(base)
      assert.equal(
        record.hostHash,
        createHash('sha256').update(parsed.hostname).digest('hex').slice(0, 32),
        '记录必须按「主机名的 sha256」分桶（同时证明没存明文）',
      )
      assert.equal(record.port, parsed.port, '端口必须进键')
      assert.equal(
        record.concurrency,
        decideConcurrency(size),
        '写入的并发数必须是本次请求的档位（不是猜的）',
      )
      assert.ok(
        Number.isInteger(record.cn) && record.cn >= 1,
        `cn 必须来自 aria2 摘要里的实际连接数，实际 ${record.cn}`,
      )
      assert.equal(record.samples.length, 1, '首次观测只有 1 个样本')
      assert.ok(
        (record.samples[0] as number) > 0 && record.medianThroughput > 0,
        '吞吐必须是正数（同时挡住「单位换算搞反」这类错）',
      )
      assert.ok(record.updatedAt > 0)
      // 隐私口径：缓存里只应有哈希，不该出现明文主机名
      assert.equal(text.includes(parsed.hostname), false, '缓存内容里不得出现明文主机名')
      assert.equal(
        created[0]!.includes(parsed.hostname),
        false,
        '缓存文件名里同样不得出现明文主机名',
      )

      // 写→读闭环：t20 的读侧真的能把这条记录解析回来（形状写歪了这里会返回 null）
      const hit = readThroughput(`${base}/observed.bin`, { dir: cacheDir })
      assert.ok(hit, '刚写下的记录必须能被读侧解析（写侧与读侧的形状契约）')
      assert.equal(hit.record.concurrency, decideConcurrency(size))
      assert.deepEqual(hit.record.samples, record.samples)
    },
  )
})

test('P1-2 写入接线：下载完成但 sha256 校验失败的条目也不写缓存（而观测值确实产生过）', async (t) => {
  if (getAria2Path() === null) {
    t.skip('本机无 aria2 子包，无法覆盖 aria2 观测路径')
    return
  }
  const cacheDir = process.env.DSH_SMARTDL_THROUGHPUT_DIR!
  const before = filesIn(cacheDir, '.json')
  const size = LARGE_FILE
  // 故意给一个与内容不符的摘要：下载本身**完整成功**（aria2 退出码 0、跨过摘要周期、
  // 观测值真的产生过），失败发生在校验层。用例必须这么构造 —— 若失败发生在下载阶段，
  // 「不写缓存」的断言会因为「压根没有观测值」而恒真，那种绿是假的。
  const wrongSha = createHash('sha256').update(Buffer.alloc(size, 0x00)).digest('hex')
  await withServer(
    serveThrottledRanged(size, { chunk: 32 * 1024, delayMs: 40, stallAt: 4 * 1024 * 1024, stallMs: 1000 }),
    async (base) => {
      const out = path.join(tmpRoot, 'sha-failed-write.bin')
      await assert.rejects(
        () => run({ url: `${base}/sha-failed-write.bin`, output: out, sha256: wrongSha }),
        /完整性校验失败.*SHA-256 不匹配/,
      )
      // 正向断言（证明前提成立）：文件确实完整落盘 —— 也就是说下载阶段是成功的，
      // 观测值在那一刻是存在的，只是不该被写进缓存。
      assert.equal(readFileSync(out).length, size, '下载阶段必须真的完成，否则前提不成立')
      assert.deepEqual(
        newFiles(before, filesIn(cacheDir, '.json')),
        [],
        '校验失败的条目不得写缓存（它的速度不代表这台主机的能力）',
      )
    },
  )
})

test('P1-2 写入接线：缓存目录不可写时下载照常成功（写缓存失败不得让下载失败）', async (t) => {
  if (getAria2Path() === null) {
    t.skip('本机无 aria2 子包，无法覆盖 aria2 观测路径')
    return
  }
  const saved = process.env.DSH_SMARTDL_THROUGHPUT_DIR
  const root = mkdtempSync(path.join(os.tmpdir(), 'throughput-blocked-'))
  const blocker = path.join(root, 'blocker')
  const size = 4 * 1024 * 1024
  try {
    // 父路径被一个文件占住 → mkdir 必然失败 → recordThroughput 只能静默放弃。
    // 这条用例守的是「缓存是优化而不是功能」：写不进去不该让已经成功的下载变成失败
    // （与 writeMarker() 的既有处理方式同构）。
    writeFileSync(blocker, 'occupied', 'utf-8')
    process.env.DSH_SMARTDL_THROUGHPUT_DIR = path.join(blocker, 'throughput')
    await withServer(
      serveThrottledRanged(size, { chunk: 32 * 1024, delayMs: 40, stallAt: 2 * 1024 * 1024, stallMs: 800 }),
      async (base) => {
        const out = path.join(tmpRoot, 'unwritable-cache.bin')
        const result = await run({ url: `${base}/unwritable.bin`, output: out })
        assert.equal(result.success, true, '缓存写不进去绝不能让成功的下载失败')
        assert.equal(result.method, 'aria2')
        assert.equal(readFileSync(out).length, size, '文件必须完整落盘')
        assert.equal(
          existsSync(path.join(blocker, 'throughput')),
          false,
          '写不进去时不该在那里留下任何东西',
        )
      },
    )
  } finally {
    if (saved === undefined) delete process.env.DSH_SMARTDL_THROUGHPUT_DIR
    else process.env.DSH_SMARTDL_THROUGHPUT_DIR = saved
    rmSync(root, { recursive: true, force: true })
  }
})

test('P1-2 写入接线：取消与 curl 路径都不写缓存（样本不得污染中位数）', async () => {
  const cacheDir = process.env.DSH_SMARTDL_THROUGHPUT_DIR!
  const before = filesIn(cacheDir, '.json')

  // ① 取消：下载中途 abort
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-length': '9999999', 'accept-ranges': 'bytes' })
      if (req.method === 'HEAD') res.end()
      else res.write(Buffer.alloc(1024, 0x22))
    },
    async (base) => {
      const controller = new AbortController()
      const pending = tool.execute(
        { url: `${base}/cancelled.bin`, output: path.join(tmpRoot, 'cancelled.bin') },
        { signal: controller.signal },
      )
      await new Promise((r) => setTimeout(r, 400))
      controller.abort()
      await assert.rejects(() => pending, /取消|终止/)
      assert.deepEqual(
        newFiles(before, filesIn(cacheDir, '.json')),
        [],
        '被取消的下载不得留下缓存记录',
      )
    },
  )

  // ② curl 路径成功也不写：curl 的进度解析只给百分比、没有字节速率，硬写只能编数字
  const small = Buffer.alloc(512 * 1024, 0x33) // < 1MB 阈值 -> 固定走 curl
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-length': String(small.length), 'accept-ranges': 'bytes' })
      res.end(small)
    },
    async (base) => {
      const result = await run({ url: `${base}/small.bin`, output: path.join(tmpRoot, 'small.bin') })
      assert.equal(result.success, true)
      assert.equal(result.method, 'curl')
      assert.deepEqual(
        newFiles(before, filesIn(cacheDir, '.json')),
        [],
        'curl 路径没有 CN / 字节速率可观测，因此不写（刻意的，见 recordObservedThroughput 的注释）',
      )
    },
  )
})
