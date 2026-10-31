/**
 * expectedSize 的 execute 层端到端测试（1.7.0）。
 *
 * 静默失败形态：远端没声明 Content-Length（chunked）时，字节数校验只能「跳过」，
 * 一个被截断的下载与完整的下载在返回值里只差一句 verifySkipped。调用方给出
 * expectedSize 之后，这个洞必须真正补上。正向契约：
 * - 远端声明长度 ≠ expectedSize → **发请求之前**拒绝（服务器 hits === 0）；
 * - 远端没声明长度 + expectedSize 相符 → 成功，且**不再**报 verifySkipped；
 * - 远端没声明长度 + expectedSize 不符 → 校验失败，文案里写明「调用方声明的
 *   expectedSize」（不是「远端声明」）；
 * - 非法值（0 / 负数 / 小数 / 非数字）在发请求之前拒绝。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../src/index.js'
import type { SmartDownloadResult } from '../src/types.js'

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

let tmpRoot = ''
let tool: ToolDef

before(async () => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'expected-size-test-'))
  process.env.DSH_PROGRESS_DIR = path.join(tmpRoot, 'progress')
  process.env.DSH_DOWNLOAD_PROGRESS_DIR = path.join(tmpRoot, 'downloads')
  tool = loadToolNamed('smart_download')
})

after(async () => {
  delete process.env.DSH_PROGRESS_DIR
  delete process.env.DSH_DOWNLOAD_PROGRESS_DIR
  rmSync(tmpRoot, { recursive: true, force: true })
})

async function run(args: Record<string, unknown>): Promise<SmartDownloadResult> {
  const exec = { signal: new AbortController().signal }
  return (await tool.execute(args, exec)) as SmartDownloadResult
}

function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ base: string; close: () => Promise<void>; hits: () => number }> {
  let hits = 0
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      hits += 1
      handler(req, res)
    })
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
        hits: () => hits,
      })
    })
  })
}

test('远端声明长度 ≠ expectedSize：发请求之前拒绝（服务器零命中）', async () => {
  const s = await startServer((_req, res) => {
    res.writeHead(200, { 'content-length': '1000' })
    res.end(Buffer.alloc(1000))
  })
  try {
    const err = await run({
      url: `${s.base}/a.bin`,
      output: path.join(tmpRoot, 'mismatch.bin'),
      expectedSize: 2000,
    }).then(
      () => null,
      (e: unknown) => e as Error,
    )
    assert.ok(err, '声明长度与 expectedSize 打架必须拒绝')
    assert.match(err!.message, /expectedSize/)
    assert.match(err!.message, /2000/)
    assert.match(err!.message, /1000/)
    // 对账在探测之后、下载之前完成：源站只应收到一次探测（HEAD），
    // 不得再收到任何下载请求（curl / aria2 都没开工）。
    assert.equal(s.hits(), 1, '只允许探测请求，不得发起下载')
  } finally {
    await s.close()
  }
})

test('远端未声明长度（chunked）+ expectedSize 相符：成功且不再报 verifySkipped', async () => {
  const body = Buffer.alloc(4096, 0x41)
  const s = await startServer((_req, res) => {
    // 无 content-length（chunked）：远端长度未知，字节数校验本来只能跳过
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(body)
  })
  try {
    const out = path.join(tmpRoot, 'chunked-ok.bin')
    const result = await run({ url: `${s.base}/ok.bin`, output: out, expectedSize: body.length })
    assert.equal(result.success, true)
    assert.equal(
      result.verifySkipped,
      undefined,
      'expectedSize 已完成字节核对，不得再报「未做字节数校验」',
    )
    assert.ok(existsSync(out))
    assert.equal(statSync(out).size, body.length)
  } finally {
    await s.close()
  }
})

test('远端未声明长度 + expectedSize 不符：判失败，文案写明是「调用方声明」', async () => {
  const body = Buffer.alloc(4096, 0x42)
  const s = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(body) // 实际 4096 字节
  })
  try {
    const out = path.join(tmpRoot, 'chunked-bad.bin')
    const err = await run({
      url: `${s.base}/bad.bin`,
      output: out,
      expectedSize: 8192,
    }).then(
      () => null,
      (e: unknown) => e as Error,
    )
    assert.ok(err, '落盘字节数与 expectedSize 不符必须判失败')
    assert.match(err!.message, /完整性校验失败/)
    assert.match(err!.message, /expectedSize/, '文案必须写明期望值来自调用方')
    assert.match(err!.message, /8192/)
    assert.match(err!.message, /4096/)
    assert.ok(!err!.message.includes('远端声明'), '不得把调用方声明说成远端声明')
    assert.ok(existsSync(out), '产物保留（与其它完整性失败同一约定）')
  } finally {
    await s.close()
  }
})

test('非法 expectedSize（0 / 负数 / 小数 / 非数字）：发请求之前拒绝', async () => {
  const s = await startServer((_req, res) => {
    res.writeHead(200, { 'content-length': '10' })
    res.end(Buffer.alloc(10))
  })
  try {
    for (const bad of [0, -1, 1.5, 'big']) {
      const err = await run({
        url: `${s.base}/a.bin`,
        output: path.join(tmpRoot, `bad-${String(bad)}.bin`),
        expectedSize: bad as number,
      }).then(
        () => null,
        (e: unknown) => e as Error,
      )
      assert.ok(err, `非法 expectedSize（${String(bad)}）必须拒绝`)
      assert.match(err!.message, /expectedSize/)
    }
    assert.equal(s.hits(), 0, '全部拒绝都发生在任何请求之前')
  } finally {
    await s.close()
  }
})

test('合法 expectedSize 且远端声明相等：正常完成（对账通过不改变成功路径）', async () => {
  const body = Buffer.alloc(2048, 0x43)
  const s = await startServer((_req, res) => {
    res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' })
    res.end(body)
  })
  try {
    const out = path.join(tmpRoot, 'match.bin')
    const result = await run({ url: `${s.base}/match.bin`, output: out, expectedSize: body.length })
    assert.equal(result.success, true)
    assert.ok(existsSync(out))
  } finally {
    await s.close()
  }
})

test('ifExists=skip + expectedSize：已有文件被校验（与摘要同一待遇）', async () => {
  // 1.7.0 收口的一致性缺口：skip 分支此前只在「给了摘要」时校验已有文件，
  // 只给 expectedSize 时不校验 —— 同类校验两种待遇。现在三种来源任一给出都验。
  const good = Buffer.alloc(1024, 0x46)
  const s = await startServer((_req, res) => {
    res.writeHead(200, { 'content-length': String(good.length) })
    res.end(good)
  })
  try {
    const out = path.join(tmpRoot, 'skip-size-ok.bin')
    writeFileSync(out, good)
    // 服务器 hits 为 0 断言不可靠（探测会命中），这里断言的是「文件未被覆盖」
    const result = await run({
      url: `${s.base}/ok.bin`,
      output: out,
      expectedSize: good.length,
      ifExists: 'skip',
    })
    assert.equal(result.success, true)
    assert.equal(result.skipped, true)
    assert.equal(result.verifySkipped, undefined, 'expectedSize 已完成核对，不得报「未做字节数校验」')
    assert.ok(readFileSync(out).equals(good), '已有文件原样保留')
  } finally {
    await s.close()
  }
})

test('ifExists=skip + expectedSize 不符：判失败且原文件保留', async () => {
  const existing = Buffer.alloc(1024, 0x47)
  const s = await startServer((_req, res) => {
    // 刻意不声明 content-length（chunked）：远端长度未知时对账（2c-0）不触发，
    // 走到 skip 分支的「已有文件 vs expectedSize」校验 —— 这正是本用例的目标路径。
    // 若声明了长度，对账会在发请求前以「声明与 expectedSize 不一致」先行拒绝。
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(Buffer.alloc(1024, 0x48))
  })
  try {
    const out = path.join(tmpRoot, 'skip-size-bad.bin')
    writeFileSync(out, existing)
    const err = await run({
      url: `${s.base}/bad.bin`,
      output: out,
      expectedSize: 2048,
      ifExists: 'skip',
    }).then(
      () => null,
      (e: unknown) => e as Error,
    )
    assert.ok(err, '已有文件与 expectedSize 不符必须判失败')
    assert.match(err!.message, /完整性校验失败/)
    assert.match(err!.message, /expectedSize/)
    assert.ok(readFileSync(out).equals(existing), '校验失败时原文件与旁车指纹原样保留')
  } finally {
    await s.close()
  }
})

test('批量条目可逐条带 expectedSize（与 sha256 同构）', async () => {
  const body = Buffer.alloc(1024, 0x44)
  const s = await startServer((req, res) => {
    if (req.url?.includes('bad')) {
      // 无长度声明，实际 1024 字节；条目声称 2048 -> 该条失败
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(body)
      return
    }
    res.writeHead(200, { 'content-length': String(body.length) })
    res.end(body)
  })
  try {
    const result = (await tool.execute(
      {
        targets: [
          { url: `${s.base}/good.bin`, output: path.join(tmpRoot, 'b-good.bin'), expectedSize: body.length },
          { url: `${s.base}/bad.bin`, output: path.join(tmpRoot, 'b-bad.bin'), expectedSize: 2048 },
        ],
      },
      { signal: new AbortController().signal },
    )) as {
      succeeded: number
      failed: number
      results: Array<{ success: boolean; error?: string }>
    }
    assert.equal(result.succeeded, 1, '一条失败不影响其余（批量既定语义）')
    assert.equal(result.failed, 1)
    assert.match(result.results[1]!.error ?? '', /expectedSize/)
  } finally {
    await s.close()
  }
})
