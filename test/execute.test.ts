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
import {
  existsSync,
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
