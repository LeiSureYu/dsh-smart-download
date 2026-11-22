/**
 * 「失败定案前的落盘核对 + 自动续传」端到端测试（1.9.3，Issue #21）。
 *
 * 复现的正是 Issue #21 的形态：连接在传输尾部断开，curl 以非零退出码收场，但
 * 字节其实已经全部落盘 —— 用户实测 239 MB 文件 SHA-256 与上游 LFS oid 一致，
 * 面板却写着「100% 失败」，而且记录永远不会被复核。
 *
 * 关键的确定性来源（2026-11-22 在 Windows mingw64 curl 8.x 上实测核对）：
 * - **「全量数据 + 无终止块」= exit 18 且文件完整**：chunked 响应把全部数据字节
 *   发完、不发终止块就 end socket，curl 报 18（transfer closed with outstanding
 *   read data remaining），落盘字节与声明长度完全一致 —— 这正是「连接断了、但
 *   东西是全的」的离线等价物（Issue #21 的原始形态是 TLS 缺 close_notify 的 56）。
 * - **「声明 N 只发 K」= exit 18 且文件 K 字节**：curl 对截断响应报 18，
 *   插件的 `--retry 3 --retry-all-errors` 恰好重试 3 轮（一次 curl 调用共 4 次
 *   请求；每次内部重试会把输出文件截回本次调用开始时的长度再重写）。
 * - **独立的 curl 调用不会截掉已有半包**：`-C -` 下连接被拒（exit 7）之前不写
 *   输出文件 —— 插件级自动续传（一次全新的 curl 调用）失败后半包原样保留。
 *
 * 续传场景的文件一律取 2 MB（> 1MB 多线程阈值）：探测判「支持 Range」，planResume
 * 放行 `-C -`，与 Issue #21 的真实场景（hf-mirror 支持 Range）同形态。aria2 用
 * `DSH_SMARTDL_ARIA2_PATH` 指向不存在的路径强制关掉（显式覆盖失败不回落子包 /
 * PATH，见 src/downloader.ts），机器上装没装 aria2 都不影响这些用例走 curl。
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
import os from 'node:os'
import path from 'node:path'
import { apply } from '../src/index.js'
import { getAria2Path } from '../src/downloader.js'
import type { SmartDownloadResult } from '../src/types.js'

/** 续传场景的总长度与「断点」长度：探测拿到 2MB，截断响应只发 500KB。 */
const TOTAL = 2_000_000
const PARTIAL = 500_000

/** 「字节完整但连接断」场景的长度：200KB（< 1MB 阈值，决策恒为 curl）。 */
const SMALL_TOTAL = 200_000

interface RegisteredTool {
  name: string
  execute: (args: unknown, exec: unknown) => Promise<unknown>
  output: { schema: unknown }
}

/** 用桩 ctx 取出插件注册的 smart_download 工具定义（与 execute.test.ts 同一套）。 */
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

let tmpRoot = ''
let tool: RegisteredTool

before(async () => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'false-failure-test-'))
  process.env.DSH_PROGRESS_DIR = path.join(tmpRoot, 'progress')
  process.env.DSH_DOWNLOAD_PROGRESS_DIR = path.join(tmpRoot, 'downloads')
  const cacheDir = path.join(tmpRoot, 'throughput')
  mkdirSync(cacheDir, { recursive: true })
  process.env.DSH_SMARTDL_THROUGHPUT_DIR = cacheDir
  // 强制走 curl：显式覆盖指向一个不存在的二进制，verifyAria2Binary 判否后
  // getAria2Path 返回 null（不回落 PATH —— 显式配置错误必须显式失败）。
  process.env.DSH_SMARTDL_ARIA2_PATH = path.join(tmpRoot, 'no-such-aria2', 'aria2c.exe')
  tool = loadTool()
})

after(async () => {
  delete process.env.DSH_PROGRESS_DIR
  delete process.env.DSH_DOWNLOAD_PROGRESS_DIR
  delete process.env.DSH_SMARTDL_THROUGHPUT_DIR
  delete process.env.DSH_SMARTDL_ARIA2_PATH
  rmSync(tmpRoot, { recursive: true, force: true })
})

async function run(args: Record<string, unknown>): Promise<SmartDownloadResult> {
  const exec: Record<string, unknown> = { signal: new AbortController().signal }
  return (await tool.execute(args, exec)) as SmartDownloadResult
}

/** 按 outPath 读回轨道二的任务快照（status / progress / size 在这条轨道）。 */
function readTaskJsonByOutPath(outPath: string): Record<string, unknown> | null {
  const dir = process.env.DSH_DOWNLOAD_PROGRESS_DIR as string
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const parsed = JSON.parse(readFileSync(path.join(dir, name), 'utf-8')) as Record<
      string,
      unknown
    >
    if (parsed.outPath === outPath) return parsed
  }
  return null
}

/**
 * 按 outPath 读回轨道一（JSONL）的**最后一条**记录。
 *
 * 为什么 msg 断言走轨道一：轨道二的任务快照只存状态与指纹，**不存 msg**；
 * 人类可读的文案（完成 / 失败 / 自动续传）只写在 JSONL 的进度记录里。
 */
function readLastJsonlByOutPath(outPath: string): Record<string, unknown> | null {
  const dir = process.env.DSH_PROGRESS_DIR as string
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue
    const lines = readFileSync(path.join(dir, name), 'utf-8')
      .split('\n')
      .filter((line) => line.trim() !== '')
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const rec = JSON.parse(lines[i] as string) as Record<string, unknown>
        if (rec.outPath === outPath) return rec
      } catch {
        // 半截行：往上找
      }
    }
  }
  return null
}

/**
 * 扫描轨道一（JSONL），判断某任务的全部进度记录里是否出现过含指定子串的文案。
 * 终局断言只看最后一条，中间过程的说明（如 aria2 半包被丢弃）要用全量扫描。
 */
function jsonlHasMessage(outPath: string, substring: string): boolean {
  const dir = process.env.DSH_PROGRESS_DIR as string
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue
    for (const line of readFileSync(path.join(dir, name), 'utf-8').split('\n')) {
      if (line.trim() === '') continue
      try {
        const rec = JSON.parse(line) as Record<string, unknown>
        if (rec.outPath === outPath && String(rec.msg ?? '').includes(substring)) return true
      } catch {
        // 半截行：跳过
      }
    }
  }
  return false
}

/** 建一个跟踪连接的 server（被中止的下载会留下挂起 socket，close 必须主动断）。 */
function startServer(
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    server: ReturnType<typeof createServer>,
  ) => void,
): Promise<{ base: string; close: () => Promise<void>; server: ReturnType<typeof createServer> }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => handler(req, res, server))
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
        server,
        close: () =>
          new Promise((r) => {
            for (const socket of sockets) socket.destroy()
            server.close(() => r())
          }),
      })
    })
  })
}

/** 探测响应：HEAD 给 Content-Length 与 Accept-Ranges。 */
function serveHead(res: ServerResponse, total: number): void {
  res.writeHead(200, {
    'content-length': String(total),
    'accept-ranges': 'bytes',
    'content-type': 'application/octet-stream',
  })
  res.end()
}

/**
 * Issue #21 的「字节完整但连接断」响应：chunked 发完全部数据后不发终止块、
 * 直接 end socket —— curl 报 18，而落盘字节与声明长度完全一致。
 */
function serveChunkedComplete(res: ServerResponse, body: Buffer): void {
  res.writeHead(200, { 'transfer-encoding': 'chunked' })
  let sent = 0
  const write = (): void => {
    if (sent >= body.length) {
      // 全部数据字节都已送达；此时断开（无终止块）= 数据完整 + 连接异常收尾
      setTimeout(() => {
        res.socket?.end()
      }, 40)
      return
    }
    const n = Math.min(8192, body.length - sent)
    res.write(body.subarray(sent, sent + n))
    sent += n
    setTimeout(write, 2)
  }
  write()
}

test('失败定案前先核对落盘：字节已完整 -> 按成功收尾，不再记 failed（Issue #21 核心）', async () => {
  const body = Buffer.alloc(SMALL_TOTAL, 0x61)
  const sha = createHash('sha256').update(body).digest('hex')
  let gets = 0
  const out = path.join(tmpRoot, 'complete-disconnect.bin')
  const s = await startServer((req, res) => {
    if (req.method === 'HEAD') {
      serveHead(res, SMALL_TOTAL)
      return
    }
    gets += 1
    serveChunkedComplete(res, body)
  })
  try {
    const result = await run({ url: `${s.base}/complete.bin`, output: out, sha256: sha })
    // 关键断言：curl 以 exit 18 收场（连接断），但字节完整 -> 结果必须是成功，
    // 且 SHA-256 通过（与真实 Issue 里「SHA-256 与上游一致却被记失败」同一把尺子）。
    assert.equal(result.success, true, '字节已完整的下载不得记为失败')
    assert.equal(result.method, 'curl')
    assert.equal(result.sha256, sha)
    assert.equal(existsSync(out), true)
    assert.equal(readFileSync(out).length, SMALL_TOTAL)
    // 旁车指纹必须被清除（走的是成功收尾，与普通完成同一条纪律）
    assert.equal(existsSync(`${out}.part.json`), false, '成功后不得残留旁车指纹')
    // 记录终态（轨道一：msg 只在这里）与轨道二（status / progress）
    const record = readTaskJsonByOutPath(out)
    assert.ok(record, '轨道二任务快照应存在')
    assert.equal(record.status, 'completed')
    assert.equal(record.progress, 1)
    const journal = readLastJsonlByOutPath(out)
    assert.ok(journal, '轨道一进度记录应存在')
    assert.equal(
      journal.msg,
      '下载完成（连接中断，但落盘字节已完整）（SHA-256 已校验）',
      `完成文案必须写明「连接中断但字节完整」，实际：${String(journal.msg)}`,
    )
    // 请求计数 == 4：插件级的自动续传必须发生在落盘核对**之后** —— 字节已完整时
    // 不该有任何插件级重试（4 = curl 自己的 --retry 3 重试轮次，1 次初始 + 3 次重试）。
    assert.equal(gets, 4, `应恰好是 curl 内部重试的 4 次请求，实际 ${gets} 次`)
  } finally {
    await s.close()
  }
})

test('失败定案前先核对落盘：无摘要时同样转成功，且不假装「校验过」', async () => {
  const body = Buffer.alloc(SMALL_TOTAL, 0x62)
  const out = path.join(tmpRoot, 'complete-disconnect-nohash.bin')
  const s = await startServer((req, res) => {
    if (req.method === 'HEAD') {
      serveHead(res, SMALL_TOTAL)
      return
    }
    serveChunkedComplete(res, body)
  })
  try {
    const result = await run({ url: `${s.base}/complete.bin`, output: out })
    assert.equal(result.success, true)
    assert.equal(result.method, 'curl')
    assert.equal(result.sha256, undefined, '没给摘要就不该出现 sha256 字段')
    // 字节数真的比过且一致：verifySkipped 不得出现
    assert.equal(result.verifySkipped, undefined)
    assert.equal(readFileSync(out).length, SMALL_TOTAL)
    const journal = readLastJsonlByOutPath(out)
    assert.ok(journal)
    assert.equal(journal.msg, '下载完成（连接中断，但落盘字节已完整）')
  } finally {
    await s.close()
  }
})

test('瞬时故障 + 半包不完整：退避后自动续传一次并完成', async () => {
  const body = Buffer.alloc(TOTAL, 0x63)
  let gets = 0
  const out = path.join(tmpRoot, 'auto-resume.bin')
  const s = await startServer((req, res) => {
    if (req.method === 'HEAD') {
      serveHead(res, TOTAL)
      return
    }
    gets += 1
    if (gets <= 4) {
      // 前四次（curl 的 1 次初始 + --retry 3）只发一半：声明 TOTAL，实发 PARTIAL。
      // 每次 curl 内部重试会把输出截回本次调用开始时的长度（0）再重写，
      // 因此每次失败后半包都停在 PARTIAL。
      res.writeHead(200, { 'content-length': String(TOTAL) })
      res.end(body.subarray(0, PARTIAL))
      return
    }
    // 第五次 = 插件级的自动续传：这次按 Range 发余量（206），curl 从断点补完。
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? '')
    const offset = range ? Number(range[1]) : 0
    res.writeHead(206, {
      'content-length': String(TOTAL - offset),
      'content-range': `bytes ${offset}-${TOTAL - 1}/${TOTAL}`,
    })
    res.end(body.subarray(offset))
  })
  try {
    const result = await run({ url: `${s.base}/resume.bin`, output: out })
    assert.equal(result.success, true, '退避重试成功后必须按成功收尾')
    assert.equal(result.method, 'curl')
    assert.equal(readFileSync(out).length, TOTAL)
    // 恰好 5 次请求：4 次 curl 内部重试全失败 + 1 次插件级自动续传成功。
    // 少于 5 说明插件没重试（回归），多于 5 说明重试超过一次（失控）。
    assert.equal(gets, 5, `应恰好 4 次 curl 内部重试 + 1 次自动续传，实际 ${gets} 次`)
    const record = readTaskJsonByOutPath(out)
    assert.ok(record, '轨道二任务快照应存在')
    assert.equal(record.status, 'completed')
    const journal = readLastJsonlByOutPath(out)
    assert.ok(journal)
    assert.equal(
      journal.msg,
      '下载完成（自动续传）',
      `完成文案必须写明是自动续传完成的，实际：${String(journal.msg)}`,
    )
  } finally {
    await s.close()
  }
})

test('自动续传仍失败：按失败定案，记录带落盘字节真相（已落盘 X / 应为 Y）', async () => {
  const body = Buffer.alloc(TOTAL, 0x64)
  let gets = 0
  const out = path.join(tmpRoot, 'still-failed.bin')
  const s = await startServer((req, res, server) => {
    if (req.method === 'HEAD') {
      serveHead(res, TOTAL)
      return
    }
    gets += 1
    // curl 内部重试的 4 次请求都发一半（声明 TOTAL，实发 PARTIAL）——服务器
    // 保持存活，所以第一次 curl 调用结束后半包停在 PARTIAL。
    res.writeHead(200, { 'content-length': String(TOTAL) })
    res.end(body.subarray(0, PARTIAL))
    if (gets === 4) {
      // 第 4 次（curl 内部重试耗尽）之后关掉监听：插件级的自动续传与它的
      // 内部重试全部撞上拒绝连接（exit 7，Issue #21 日志的形态）。
      setTimeout(() => {
        server.close()
      }, 50)
    }
  })
  try {
    await assert.rejects(() => run({ url: `${s.base}/failed.bin`, output: out }), /退出码 7/)
    // 服务器只应收到第一次 curl 调用的 4 次请求：之后（插件级续传及其内部重试）
    // 全部被拒 —— 说明插件恰好自动续传了一次、没有失控地反复重试。
    assert.equal(gets, 4, `第一次调用后不应有请求再到达服务器，实际 ${gets} 次`)
    // 半包必须原样保留：独立的 curl 调用（-C -）在连接被拒之前不写输出文件
    // （这是「可续传」承诺的物理根据）
    assert.equal(readFileSync(out).length, PARTIAL)
    const record = readTaskJsonByOutPath(out)
    assert.ok(record, '轨道二任务快照应存在')
    assert.equal(record.status, 'failed')
    const journal = readLastJsonlByOutPath(out)
    assert.ok(journal)
    const msg = String(journal.msg)
    assert.ok(msg.includes('退出码 7'), '失败文案应保留 curl 的失败原因')
    assert.ok(
      msg.includes(`已落盘 ${PARTIAL} / ${TOTAL} 字节`),
      `失败记录必须写明落盘字节真相（已落盘 ${PARTIAL} / ${TOTAL} 字节），实际：${msg}`,
    )
    assert.ok(msg.includes('可续传'), '半包保留时应写明可续传')
  } finally {
    await s.close()
  }
})

/**
 * aria2 分片半包的安全闸（1.9.3，Issue #21 相邻隐患的端到端验证）。
 *
 * 实测背景（2026-11-23，随包 aria2 1.37.0 @ win32）：64MB、8 连接、
 * --file-allocation=none，中途硬杀后落盘 92%，但内部有 35MB 零字节空洞 ——
 * aria2 分片写入，文件长度只反映写得最远的分片。curl 的 -C - 只看长度，
 * 接着这种半包续传会拼出「长度对、内容错」的文件，字节数校验拦不住。
 *
 * 本用例驱动完整链条：预置一段连续前缀 + 旁车指纹（planResume 批准续传，
 * 回退 curl 时会拿到 resume=true —— 这正是旧代码会拼出坏文件的路径）->
 * aria2 每次请求只发一个完整分片就掐断（分片被写进盘，但声明的总长发不满，
 * 重试耗尽后以非零退出码收场，留下分片半包 + .aria2 控制文件）->
 * 安全闸发现控制文件、丢弃半包 -> curl 全量重下。
 *
 * 服务器按 User-Agent 区分两家（aria2/xxx vs curl/xxx），不依赖请求计数。
 * 「每次恰好送满一个分片」是刻意设计：送太少（64KB）连一个分片都凑不齐，
 * aria2 会什么都不写、连控制文件都不建（实测），安全闸就没有触发对象了。
 */
test('aria2 → curl 回退：分片半包先丢弃再全量重下，产物逐字节正确', async (t) => {
  // 本套件默认用「指向不存在路径」的覆盖强制走 curl；本用例需要真 aria2，
  // 先摘掉覆盖（显式覆盖失败不回落子包 / PATH，见 src/downloader.ts）。
  const savedOverride = process.env.DSH_SMARTDL_ARIA2_PATH
  delete process.env.DSH_SMARTDL_ARIA2_PATH
  if (getAria2Path() === null) {
    process.env.DSH_SMARTDL_ARIA2_PATH = savedOverride
    t.skip('本机无 aria2 子包，跳过 aria2 回退安全闸用例')
    return
  }
  const SIZE = 8 * 1024 * 1024
  const body = Buffer.alloc(SIZE)
  for (let i = 0; i < SIZE; i++) body[i] = (i % 251) + 1 // 非零字节模式：任何 0 字节都是没写过的洞
  const SEED = 1024 * 1024
  const PIECE = 1024 * 1024 // 与 -k 1M 对齐：一次响应恰好喂饱一个分片
  const out = path.join(tmpRoot, 'aria2-fallback.bin')
  // 预置连续前缀 + 旁车指纹：planResume 会批准续传（resume=true），
  // 从而让 aria2 以 -c 启动、失败后 curl 回退拿到 resume=true ——
  // 这正是旧代码会拼出坏文件的路径。
  writeFileSync(out, body.subarray(0, SEED))
  writeFileSync(`${out}.part.json`, JSON.stringify({ v: 1, length: SIZE }))

  const s = await startServer((req, res) => {
    if (req.method === 'HEAD') {
      serveHead(res, SIZE)
      return
    }
    const ua = String(req.headers['user-agent'] ?? '')
    if (/^aria2\//.test(ua)) {
      // aria2 的请求：按请求起点发整整一个分片的正确字节（aria2 收满一个
      // 完整分片会写盘），然后掐断 —— 声明的总长发不满，下载永远「失败」，
      // 重试耗尽后以非零退出码收场，留下分片半包 + 控制文件。
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '')
      const start = m ? Number(m[1]) : 0
      const piece = Math.min(PIECE, SIZE - start)
      if (m) {
        res.writeHead(206, {
          'content-length': String(SIZE - start),
          'content-range': `bytes ${start}-${SIZE - 1}/${SIZE}`,
          'accept-ranges': 'bytes',
        })
      } else {
        res.writeHead(200, { 'content-length': String(SIZE), 'accept-ranges': 'bytes' })
      }
      res.write(body.subarray(start, start + piece))
      setTimeout(() => res.socket?.destroy(), 30)
      return
    }
    // curl（回退后的全量重下；若安全闸未触发则按 Range 续传）
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? '')
    const start = m ? Number(m[1]) : 0
    if (m) {
      res.writeHead(206, {
        'content-length': String(SIZE - start),
        'content-range': `bytes ${start}-${SIZE - 1}/${SIZE}`,
        'accept-ranges': 'bytes',
      })
      res.end(body.subarray(start))
    } else {
      res.writeHead(200, { 'content-length': String(SIZE), 'accept-ranges': 'bytes' })
      res.end(body)
    }
  })
  try {
    const result = await run({ url: `${s.base}/fallback.bin`, output: out })
    assert.equal(result.success, true, '丢弃分片半包后 curl 全量重下必须成功')
    assert.equal(result.method, 'curl')
    assert.equal(result.fellback, true)
    // 终局不变量：产物与源逐字节一致（半包若被 curl 接着写，这里必然对不上）
    assert.equal(
      Buffer.compare(readFileSync(out), body),
      0,
      '产物必须逐字节等于源（aria2 的分片半包不得残留）',
    )
    assert.equal(existsSync(`${out}.aria2`), false, 'aria2 控制文件不得残留')
    // 进度轨道必须写明「半包被丢弃、全量重下」，而不是静默换一条路
    assert.equal(
      jsonlHasMessage(out, 'aria2 半包为分片写入'),
      true,
      '进度记录应写明 aria2 半包被丢弃的原因',
    )
  } finally {
    process.env.DSH_SMARTDL_ARIA2_PATH = savedOverride
    await s.close()
  }
})
