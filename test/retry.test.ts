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
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { STALE_RUNNING_RECORD_MS } from '../src/progress.js'
import { startRetry } from '../src/index.js'
import { readTaskRecord, resolveDownloadProgressDir } from '../src/progress.js'
import {
  isRunning,
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

test('重试：request.expectedSize 参与校验 —— 与远端声明不一致时拒绝（1.9.3 修正回归项）', async () => {
  const body = Buffer.alloc(4096, 0x65)
  const server = await startServer((req, res) => {
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
    const taskId = 'retry-expected-size'
    const outPath = path.join(tmpRoot, `${taskId}.bin`)
    writeRecord(taskId, {
      request: {
        url: `${server.base}/exp.bin`,
        output: outPath,
        expectedSize: 999_999, // 与远端声明的 4096 不一致
      },
    })
    assert.deepEqual(startRetry(taskId), { started: true, taskId })
    await waitFor(
      () => readTaskRecord(taskId)?.status === 'failed',
      '重试任务因 expectedSize 对账失败',
    )
    const record = readTaskRecord(taskId)
    assert.ok(record)
    assert.ok(
      String(record.request?.expectedSize ?? '') === '999999',
      '失败后 request 里的 expectedSize 必须原样保留（下次重试仍参与校验）',
    )
    // 字节数校验的失败必须是对账文案（2c-0），而不是别的错误
    const raw = JSON.stringify(record)
    assert.ok(
      raw.includes('expectedSize'),
      `失败记录应带上 expectedSize 对账信息，实际：${raw.slice(0, 400)}`,
    )
  } finally {
    await server.close()
  }
})

test('重试：过期 running 残迹（宿主中断）-> started:true（1.9.3 豁免）', async () => {
  const taskId = 'retry-stale-running'
  const outPath = writeRecord(taskId, {
    status: 'running',
    progress: 0.5,
    updatedAt: Date.now() - STALE_RUNNING_RECORD_MS - 1000,
    request: { url: 'http://127.0.0.1:9/never', output: path.join(tmpRoot, `${taskId}.bin`) },
  })
  const first = startRetry(taskId)
  assert.deepEqual(first, { started: true, taskId }, '中断残迹必须可重试（从半包续传）')
  await waitFor(
    () => readTaskRecord(taskId)?.status === 'failed',
    '重试对死端口会很快失败并写回终态',
  )
  assert.equal(existsSync(outPath), false, '死端口连不上，产物本来就不存在')
})

test('重试：新鲜 running 依旧 not-retryable（豁免只针对过期残迹）', () => {
  writeRecord('retry-fresh-running', {
    status: 'running',
    progress: 0.5,
    updatedAt: Date.now(),
    request: { url: 'http://127.0.0.1:9/never', output: path.join(tmpRoot, 'retry-fresh-running.bin') },
  })
  assert.deepEqual(startRetry('retry-fresh-running'), {
    started: false,
    taskId: 'retry-fresh-running',
    reason: 'not-retryable',
  })
})
