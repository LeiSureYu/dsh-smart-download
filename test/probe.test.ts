/**
 * probe.ts 测试：
 * - 纯判定函数 evaluateRangeSupport / 头部解析的单测；
 * - 基于本地 HTTP server 的集成测试，不依赖真实网络。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  probeUrl,
  evaluateRangeSupport,
  parseContentLength,
  parseContentRangeTotal,
} from '../src/probe.js'

const BIG = 5 * 1024 * 1024 // 5MB，大于默认 1MB 阈值
const HUGE = 10 * 1024 * 1024 // 10MB

/* ------------------------------ 本地 HTTP server ------------------------------ */

function startHandler(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ base: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      const base = `http://127.0.0.1:${port}`
      resolve({
        base,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

let base = ''
let closeServer: () => Promise<void>

before(async () => {
  const server = await startHandler((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname

    if (req.method === 'HEAD') {
      switch (path) {
        case '/supported':
          res.writeHead(200, {
            'accept-ranges': 'bytes',
            'content-length': String(BIG),
            'content-type': 'application/octet-stream',
          })
          res.end()
          return
        case '/small':
          res.writeHead(200, {
            'accept-ranges': 'bytes',
            'content-length': '100',
          })
          res.end()
          return
        case '/no-ranges':
          res.writeHead(200, { 'content-length': String(BIG) })
          res.end()
          return
        case '/no-length':
          res.writeHead(200, { 'accept-ranges': 'bytes' })
          res.end()
          return
        case '/head405':
        case '/range-ignored':
          res.writeHead(405, { allow: 'GET' })
          res.end()
          return
        case '/slow':
          setTimeout(() => {
            try {
              res.writeHead(200, { 'accept-ranges': 'bytes', 'content-length': String(BIG) })
              res.end()
            } catch {
              // 客户端可能已超时断开
            }
          }, 1000)
          return
        default:
          res.writeHead(404)
          res.end()
          return
      }
    }

    if (req.method === 'GET') {
      if (path === '/head405') {
        // 明确支持 Range，返回 206
        res.writeHead(206, {
          'content-range': `bytes 0-0/${BIG}`,
          'accept-ranges': 'bytes',
          'content-length': '1',
        })
        res.end('x')
        return
      }
      if (path === '/no-length') {
        res.writeHead(206, {
          'content-range': `bytes 0-0/${HUGE}`,
          'accept-ranges': 'bytes',
          'content-length': '1',
        })
        res.end('x')
        return
      }
      if (path === '/range-ignored') {
        // 忽略 Range，返回 200 且不声明 bytes
        res.writeHead(200, { 'content-length': '50' })
        res.end('x')
        return
      }
    }

    res.writeHead(404)
    res.end()
  })
  base = server.base
  closeServer = server.close
})

after(async () => {
  await closeServer()
})

/* ------------------------------ 纯函数单测 ------------------------------ */

test('parseContentLength 正确解析 / 处理非法值', () => {
  assert.equal(parseContentLength('1234'), 1234)
  assert.equal(parseContentLength('0'), 0)
  assert.equal(parseContentLength(''), undefined)
  assert.equal(parseContentLength('abc'), undefined)
  assert.equal(parseContentLength(null), undefined)
})

test('parseContentRangeTotal 解析总长度', () => {
  assert.equal(parseContentRangeTotal('bytes 0-0/5242880'), 5242880)
  assert.equal(parseContentRangeTotal('bytes 100-200/999'), 999)
  assert.equal(parseContentRangeTotal('bytes 0-0/*'), undefined)
  assert.equal(parseContentRangeTotal(null), undefined)
})

test('evaluateRangeSupport: 200 + bytes + 大文件 -> 支持', () => {
  const r = evaluateRangeSupport({
    status: 200,
    acceptRanges: 'bytes',
    contentLength: BIG,
    threshold: 1024 * 1024,
  })
  assert.equal(r.supported, true)
  assert.equal(r.size, BIG)
})

test('evaluateRangeSupport: 200 + bytes + 小文件 -> 不支持(过小)', () => {
  const r = evaluateRangeSupport({
    status: 200,
    acceptRanges: 'bytes',
    contentLength: 100,
    threshold: 1024 * 1024,
  })
  assert.equal(r.supported, false)
  assert.match(r.reason ?? '', /过小/)
})

test('evaluateRangeSupport: 200 无 bytes + 大文件 -> 不支持', () => {
  const r = evaluateRangeSupport({
    status: 200,
    acceptRanges: 'none',
    contentLength: BIG,
    threshold: 1024 * 1024,
  })
  assert.equal(r.supported, false)
  assert.match(r.reason ?? '', /Range/)
})

test('evaluateRangeSupport: 206 + Content-Range 大文件(无 Accept-Ranges) -> 支持', () => {
  const r = evaluateRangeSupport({
    status: 206,
    contentLength: 1,
    contentRange: `bytes 0-0/${HUGE}`,
    threshold: 1024 * 1024,
  })
  assert.equal(r.supported, true)
  assert.equal(r.size, HUGE)
})

test('evaluateRangeSupport: 206 + Content-Range 小文件 -> 不支持', () => {
  const r = evaluateRangeSupport({
    status: 206,
    contentRange: 'bytes 0-0/50',
    threshold: 1024 * 1024,
  })
  assert.equal(r.supported, false)
})

test('evaluateRangeSupport: 缺少长度 -> 不支持', () => {
  const r = evaluateRangeSupport({ status: 200, threshold: 1024 * 1024 })
  assert.equal(r.supported, false)
  assert.match(r.reason ?? '', /Content-Length/)
})

test('evaluateRangeSupport: 自定义阈值生效', () => {
  const r = evaluateRangeSupport({
    status: 200,
    acceptRanges: 'bytes',
    contentLength: 500,
    threshold: 100,
  })
  assert.equal(r.supported, true)
})

/* ------------------------------ 集成测试（本地 server） ------------------------------ */

test('HEAD 声明 bytes 且文件大 -> 支持多线程', async () => {
  const r = await probeUrl(`${base}/supported`)
  assert.equal(r.supportsMultiThread, true)
  assert.equal(r.contentLength, BIG)
  assert.equal(r.contentType, 'application/octet-stream')
})

test('HEAD 声明 bytes 但文件小 -> 不支持', async () => {
  const r = await probeUrl(`${base}/small`)
  assert.equal(r.supportsMultiThread, false)
  assert.match(r.reason ?? '', /过小/)
})

test('HEAD 不声明 ranges -> 不支持', async () => {
  const r = await probeUrl(`${base}/no-ranges`)
  assert.equal(r.supportsMultiThread, false)
})

test('HEAD 405 -> Range GET 206 -> 支持多线程', async () => {
  const r = await probeUrl(`${base}/head405`)
  assert.equal(r.supportsMultiThread, true)
  assert.equal(r.contentLength, BIG)
})

test('HEAD 无 Content-Length -> Range GET 206 -> 支持多线程', async () => {
  const r = await probeUrl(`${base}/no-length`)
  assert.equal(r.supportsMultiThread, true)
  assert.equal(r.contentLength, HUGE)
})

test('Range GET 被忽略返回 200 -> 不支持', async () => {
  const r = await probeUrl(`${base}/range-ignored`)
  assert.equal(r.supportsMultiThread, false)
})

test('探测超时 -> 安全返回不支持', async () => {
  const r = await probeUrl(`${base}/slow`, undefined, { timeout: 200 })
  assert.equal(r.supportsMultiThread, false)
  assert.match(r.reason ?? '', /HEAD 请求失败/)
})

test('外部 AbortSignal 已取消 -> 不支持', async () => {
  const controller = new AbortController()
  controller.abort()
  const r = await probeUrl(`${base}/supported`, controller.signal)
  assert.equal(r.supportsMultiThread, false)
})

/* ------------------------------ Accept-Encoding（0.7.0 实测） ------------------------------ */

/** 真实 body 5000 字节；gzip 后声明 41 字节（模拟内容压缩后的长度） */
const RAW_SIZE = 5000
const GZIP_SIZE = 41

/**
 * 断言服务器看到的 accept-encoding **语义上**是 identity。
 * 不能直接比字符串：实测 Node 24 的 undici 在带 Range 的请求里会发出
 * `identity, identity`（把默认值和显式值拼在一起），这在 RFC 语义上仍等于
 * 未压缩，但字符串不等于 'identity'。
 */
function assertIdentityEncoding(seen: string[], label: string): void {
  assert.ok(seen.length > 0, `${label}: 应发出请求`)
  for (const v of seen) {
    const tokens = v
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t !== '')
    assert.ok(tokens.length > 0, `${label}: accept-encoding 不应为空`)
    for (const t of tokens) {
      assert.equal(t, 'identity', `${label}: accept-encoding 应只含 identity，实际 ${v}`)
    }
  }
}

test('探测强制 accept-encoding: identity，拿到的是未压缩长度（否则大小校验会 100% 误报）', async () => {
  const seen: string[] = []
  const s = await startHandler((req, res) => {
    seen.push(String(req.headers['accept-encoding'] ?? ''))
    // 模拟一个会按 Accept-Encoding 压缩的服务器
    const ae = String(req.headers['accept-encoding'] ?? '')
    const compresses = /gzip|deflate|br/.test(ae)
    if (compresses) {
      res.writeHead(200, {
        'accept-ranges': 'bytes',
        'content-length': String(GZIP_SIZE),
        'content-encoding': 'gzip',
      })
    } else {
      res.writeHead(200, {
        'accept-ranges': 'bytes',
        'content-length': String(RAW_SIZE),
      })
    }
    res.end()
  })
  try {
    const r = await probeUrl(`${s.base}/file.bin`)
    // 正向断言 1：服务器确实收到了 identity
    assertIdentityEncoding(seen, 'HEAD 探测')
    // 正向断言 2：因此拿到的是未压缩长度（若仍是 41，说明 identity 没生效）
    assert.equal(r.contentLength, RAW_SIZE, '应拿到未压缩长度 5000 而非 gzip 长度 41')
    // 正向断言 3：本次响应的编码是 identity，大小校验可以放心比对
    assert.equal(r.contentEncoding, undefined, '未压缩响应不应带 contentEncoding')
  } finally {
    await s.close()
  }
})

test('HEAD 405 时的 Range GET 同样强制 identity', async () => {
  const seen: string[] = []
  const s = await startHandler((req, res) => {
    const ae = String(req.headers['accept-encoding'] ?? '')
    const compresses = /gzip|deflate|br/.test(ae)
    if (req.method === 'HEAD') {
      res.writeHead(405, { allow: 'GET' })
      res.end()
      return
    }
    seen.push(ae)
    if (compresses) {
      res.writeHead(206, {
        'content-range': `bytes 0-0/${GZIP_SIZE}`,
        'accept-ranges': 'bytes',
        'content-length': '1',
        'content-encoding': 'gzip',
      })
    } else {
      res.writeHead(206, {
        'content-range': `bytes 0-0/${RAW_SIZE}`,
        'accept-ranges': 'bytes',
        'content-length': '1',
      })
    }
    res.end('x')
  })
  try {
    const r = await probeUrl(`${s.base}/file.bin`)
    assertIdentityEncoding(seen, 'Range GET 探测')
    assert.equal(r.contentLength, RAW_SIZE, 'Range GET 也应拿到未压缩总长度')
  } finally {
    await s.close()
  }
})

test('服务器无视 identity 仍返回 gzip -> contentEncoding 被捕获，供校验跳过', async () => {
  const s = await startHandler((_req, res) => {
    res.writeHead(200, {
      'accept-ranges': 'bytes',
      'content-length': String(GZIP_SIZE),
      'content-encoding': 'gzip',
    })
    res.end()
  })
  try {
    const r = await probeUrl(`${s.base}/file.bin`)
    // 正向断言：这类不合规服务器会被标记出来，verifySize 据此跳过而不是误判
    assert.equal(r.contentEncoding, 'gzip')
    assert.equal(r.contentLength, GZIP_SIZE)
  } finally {
    await s.close()
  }
})
