/**
 * `startRetry()` 的端到端测试（1.6.0）。
 *
 * 为什么不能只测 `parseRetryRequest()`：重试真正的风险在「记录 → 重新发起下载」
 * 这条链路上 —— 读错轨道、复用错 taskId、把请求头重新带上、或者返回了
 * `started:true` 却根本没有跑起来。这里用本地 HTTP server 跑一遍真实下载，
 * 断言最终记录确实变成 `completed`，而不是只看一个同步返回值。
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startRetry } from '../src/index.js'
import { readTaskRecord, resolveDownloadProgressDir } from '../src/progress.js'
import {
  isRunning,
  parseRetryRequest,
  resetTaskRegistry,
} from '../src/tasks.js'

let tmpRoot = ''
let downloadDir = ''
let taskDir = ''

before(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'retry-test-'))
  downloadDir = path.join(tmpRoot, 'downloads')
  taskDir = path.join(tmpRoot, 'progress')
  mkdirSync(downloadDir, { recursive: true })
  mkdirSync(taskDir, { recursive: true })
  process.env.DSH_DOWNLOAD_PROGRESS_DIR = downloadDir
  process.env.DSH_PROGRESS_DIR = taskDir
  process.env.DSH_SMARTDL_THROUGHPUT_DIR = path.join(tmpRoot, 'throughput')
})

after(() => {
  resetTaskRegistry()
  delete process.env.DSH_DOWNLOAD_PROGRESS_DIR
  delete process.env.DSH_PROGRESS_DIR
  delete process.env.DSH_SMARTDL_THROUGHPUT_DIR
  rmSync(tmpRoot, { recursive: true, force: true })
})

beforeEach(() => {
  resetTaskRegistry()
})

/** 写一条轨道二任务记录（`readTaskRecord` 只读这一条轨道）。 */
function writeRecord(
  taskId: string,
  over: Record<string, unknown> = {},
): string {
  const outPath = path.join(tmpRoot, `${taskId}.bin`)
  const record = {
    id: taskId,
    name: `${taskId}.bin`,
    status: 'failed',
    progress: 0.25,
    updatedAt: Date.now(),
    outPath,
    request: { url: 'http://127.0.0.1:9/never', output: outPath },
    ...over,
  }
  writeFileSync(
    path.join(resolveDownloadProgressDir(), `${taskId}.json`),
    JSON.stringify(record, null, 2),
    'utf-8',
  )
  return outPath
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
            // 与 execute.test.ts 同一理由：重试被 abort / 连接挂起时，
            // 不主动 destroy 会让 node:test 等事件循环排空而挂住。
            for (const socket of sockets) socket.destroy()
            server.close(() => r())
          }),
      })
    })
  })
}

/** 轮询等待条件成立；超时直接失败，避免用例挂死。 */
async function waitFor(
  check: () => boolean,
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.fail(`等待超时：${label}`)
}

test('重试：未知 taskId -> unknown', () => {
  assert.deepEqual(startRetry('no-such-task'), {
    started: false,
    taskId: 'no-such-task',
    reason: 'unknown',
  })
})

test('重试：已完成的任务 -> not-retryable', () => {
  writeRecord('done-task', { status: 'completed', progress: 1 })
  assert.deepEqual(startRetry('done-task'), {
    started: false,
    taskId: 'done-task',
    reason: 'not-retryable',
  })
})

test('重试：没有 request 的旧记录 -> no-request', () => {
  writeRecord('old-task', { request: undefined })
  assert.deepEqual(startRetry('old-task'), {
    started: false,
    taskId: 'old-task',
    reason: 'no-request',
  })
})

test('重试：非法 URL / sha256 / checksum -> not-retryable（不发起下载）', () => {
  writeRecord('bad-url', { request: { url: 'file:///etc/passwd' } })
  assert.equal(startRetry('bad-url').reason, 'not-retryable')

  writeRecord('bad-sha', {
    request: { url: 'https://example.com/x.bin', sha256: 'not-a-hash' },
  })
  assert.equal(startRetry('bad-sha').reason, 'not-retryable')

  writeRecord('bad-checksum', {
    request: { url: 'https://example.com/x.bin', checksum: 'md5:zzzz' },
  })
  assert.equal(startRetry('bad-checksum').reason, 'not-retryable')
})

test('重试：后台真正重新下载，最终记录变为 completed，且不重放请求头', async () => {
  const body = Buffer.from('retry-ok-payload')
  const seen: Array<IncomingMessage['headers']> = []
  const server = await startServer((req, res) => {
    seen.push(req.headers)
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'content-length': String(body.length),
        'accept-ranges': 'bytes',
        'content-type': 'application/octet-stream',
      })
      res.end()
      return
    }
    res.writeHead(200, {
      'content-length': String(body.length),
      'accept-ranges': 'bytes',
      'content-type': 'application/octet-stream',
    })
    res.end(body)
  })

  try {
    const taskId = 'retry-success'
    const outPath = writeRecord(taskId, {
      request: {
        url: `${server.base}/file.bin`,
        output: path.join(tmpRoot, `${taskId}.bin`),
        // 这些字段即使被写进磁盘，也不得在重试时被解析 / 重放。
        headers: { authorization: 'Bearer should-not-be-replayed' },
        userAgent: 'should-not-be-replayed',
      },
    })

    const first = startRetry(taskId)
    assert.deepEqual(first, { started: true, taskId })
    // 返回 started 时任务必须已经登记：否则面板立刻再点一次会重复启动。
    assert.equal(isRunning(taskId), true)
    assert.deepEqual(startRetry(taskId), {
      started: false,
      taskId,
      reason: 'running',
    })

    await waitFor(
      () => readTaskRecord(taskId)?.status === 'completed',
      '重试任务完成并写回 completed',
    )
    assert.equal(readFileSync(outPath, 'utf-8'), 'retry-ok-payload')

    const authorization = seen.map((h) => h.authorization).filter(Boolean)
    assert.deepEqual(authorization, [], 'Authorization 绝不能从记录里重放')
    assert.equal(
      seen.some((h) => h['user-agent'] === 'should-not-be-replayed'),
      false,
      '自定义 User-Agent 绝不能从记录里重放',
    )
  } finally {
    resetTaskRegistry()
    await server.close()
  }
})

/* --------------------- 1.7.0：connections 在重试元数据里的取舍 --------------------- */

/**
 * connections 与 timeoutMs 的失败方向相反，这是本批用例的全部意义：
 *
 *   - timeoutMs 越界 → **整条拒绝**。丢掉一个超时等于把「有界等待」变成无限等待；
 *   - connections 越界 → **只丢字段**。丢掉它只是回到自动分档，下载照样正确完成。
 *
 * 因此「非法 connections 不会让重试失败」必须被显式断言，否则日后有人为了
 * 「统一校验风格」把它改成 return undefined，用户就会白点一次重试。
 */
test('parseRetryRequest: 合法的 connections 被保留（数字与字符串都行）', () => {
  assert.equal(parseRetryRequest({ url: 'https://a/b', connections: 16 })?.connections, 16)
  assert.equal(parseRetryRequest({ url: 'https://a/b', connections: '9' })?.connections, 9)
  assert.equal(parseRetryRequest({ url: 'https://a/b', connections: 'auto' })?.connections, 'auto')
})

test('parseRetryRequest: 非法 connections 只丢字段，**不整条拒绝**', () => {
  for (const bad of [0, 17, -1, 1.5, 'abc', '16x', true, {}]) {
    const parsed = parseRetryRequest({ url: 'https://a/b', connections: bad })
    assert.ok(parsed, `输入 ${JSON.stringify(bad)} 时整条记录必须仍然有效`)
    assert.equal(parsed.url, 'https://a/b')
    assert.equal(parsed.connections, undefined, '非法值必须被丢弃，而不是带进下载')
  }
})

test('parseRetryRequest: 没有 connections 字段时结果里也不出现它（不能是 undefined 键）', () => {
  const parsed = parseRetryRequest({ url: 'https://a/b' })
  assert.ok(parsed)
  assert.equal('connections' in parsed, false, '缺省字段不该以 undefined 的形式落进对象')
})

test('parseRetryRequest: timeoutMs 越界仍然整条拒绝（与 connections 的宽松方向相反）', () => {
  assert.equal(parseRetryRequest({ url: 'https://a/b', timeoutMs: 10 }), undefined)
  // 同一条记录里 connections 非法、timeoutMs 合法 → 通过，且只丢 connections
  const parsed = parseRetryRequest({ url: 'https://a/b', timeoutMs: 60_000, connections: 99 })
  assert.equal(parsed?.timeoutMs, 60_000)
  assert.equal(parsed?.connections, undefined)
})
