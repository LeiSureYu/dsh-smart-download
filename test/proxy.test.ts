/**
 * proxy.ts 测试：代理解析（三层一致性的唯一收口）。
 *
 * 静默失败形态：环境变量里配了代理，但探测 / aria2 / curl 三者各自为政 ——
 * 探测直连失败、aria2 直连失败、curl 走代理成功，净效果是「静默降级单线程」
 * 且探测结论建立在下载根本不成立的网络路径上。正向契约：
 * - 参数显式给 → 三层都用它（非法值在 preflight 拒绝，见 execute 层用例）；
 * - 参数没给 → 环境变量按 scheme 取值，非法环境变量被忽略而不是炸掉调用；
 * - NO_PROXY 命中 → 直连（对显式参数同样生效，与 curl 语义一致）；
 * - 探测真的走了代理（集成：本地「代理」server 收到绝对 URI 请求行）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import * as net from 'node:net'
import { checkProxyParam, hostMatchesNoProxy, resolveProxy, validateProxyValue } from '../src/proxy.js'
import { probeUrl } from '../src/probe.js'
import { ProxyAgent } from 'undici'

test('validateProxyValue：http(s) 合法；空值 / 非 URL / 非 http(s) / 缺主机名拒绝', () => {
  assert.equal(validateProxyValue('http://127.0.0.1:7890').ok, true)
  assert.equal(validateProxyValue('  https://proxy.corp:8443  ').ok, true, '首尾空白允许（trim）')
  assert.equal(validateProxyValue('').ok, false)
  assert.equal(validateProxyValue('   ').ok, false)
  assert.equal(validateProxyValue('not a url').ok, false)
  assert.equal(validateProxyValue('ftp://127.0.0.1:21').ok, false)
  assert.equal(validateProxyValue('socks5://127.0.0.1:1080').ok, false)
  assert.equal(validateProxyValue('http://').ok, false)
  const reason = validateProxyValue('socks5://127.0.0.1:1080')
  assert.equal(reason.ok, false)
  if (!reason.ok) assert.match(reason.reason, /SOCKS/)
})

test('checkProxyParam：把拒绝原因包成 preflight 可用的文案', () => {
  assert.equal(checkProxyParam('http://p:1').ok, true)
  const bad = checkProxyParam('javascript://alert')
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.match(bad.reason, /proxy 参数不合法/)
})

test('resolveProxy：显式参数最优先', () => {
  const env = { HTTPS_PROXY: 'http://env:1', HTTP_PROXY: 'http://env:2' }
  const outcome = resolveProxy('https://example.com/a.zip', 'http://param:9', env)
  assert.deepEqual(outcome, { proxyUrl: 'http://param:9', source: 'param' })
})

test('resolveProxy：无参数时按 scheme 查环境变量（https 查 HTTPS_PROXY，http 查 HTTP_PROXY）', () => {
  const outcomeHttps = resolveProxy('https://example.com/a.zip', undefined, {
    HTTPS_PROXY: 'http://env:1',
  })
  assert.deepEqual(outcomeHttps, { proxyUrl: 'http://env:1', source: 'env' })
  const outcomeHttp = resolveProxy('http://example.com/a.zip', undefined, {
    HTTPS_PROXY: 'http://env:1',
    HTTP_PROXY: 'http://env:2',
  })
  assert.deepEqual(outcomeHttp, { proxyUrl: 'http://env:2', source: 'env' })
  // 小写变体同样生效（生态里两种大小写都常见）
  const lower = resolveProxy('https://example.com/a.zip', undefined, {
    https_proxy: 'http://env:3',
  })
  assert.deepEqual(lower, { proxyUrl: 'http://env:3', source: 'env' })
  // ALL_PROXY 兜底
  const all = resolveProxy('https://example.com/a.zip', undefined, {
    ALL_PROXY: 'http://env:4',
  })
  assert.deepEqual(all, { proxyUrl: 'http://env:4', source: 'env' })
})

test('resolveProxy：什么都没有 -> 直连', () => {
  assert.deepEqual(resolveProxy('https://example.com/a.zip', undefined, {}), {
    proxyUrl: null,
    source: 'none',
  })
})

test('resolveProxy：非法环境变量被忽略（不让一个写错的全局变量打断所有下载）', () => {
  const outcome = resolveProxy('https://example.com/a.zip', undefined, {
    HTTPS_PROXY: 'socks5://127.0.0.1:1080',
    https_proxy: 'not a url',
  })
  assert.deepEqual(outcome, { proxyUrl: null, source: 'none' })
})

test('resolveProxy：NO_PROXY 命中 -> 直连（对显式参数同样生效，与 curl 一致）', () => {
  const env = {
    HTTPS_PROXY: 'http://env:1',
    NO_PROXY: 'example.com,.internal.corp',
  }
  assert.deepEqual(resolveProxy('https://example.com/a.zip', undefined, env), {
    proxyUrl: null,
    source: 'none',
  })
  assert.deepEqual(
    resolveProxy('https://example.com/a.zip', 'http://param:9', env).proxyUrl,
    null,
    '显式参数也被 NO_PROXY 压过 —— 与 curl 的 -x + no_proxy 语义一致',
  )
  // 后缀匹配：foo.example.com 命中 example.com；evilexample.com 不命中
  assert.equal(
    resolveProxy('https://foo.example.com/a', undefined, env).proxyUrl,
    null,
  )
  assert.equal(
    resolveProxy('https://evilexample.com/a', undefined, {
      HTTPS_PROXY: 'http://env:1',
      NO_PROXY: 'example.com',
    }).proxyUrl,
    'http://env:1',
  )
  // 大小写不敏感
  assert.equal(
    resolveProxy('https://EXAMPLE.com/a', undefined, {
      HTTPS_PROXY: 'http://env:1',
      NO_PROXY: 'Example.Com',
    }).proxyUrl,
    null,
  )
  // 环境变量代理（no_proxy 未命中）照常生效
  assert.deepEqual(resolveProxy('https://other.com/a.zip', undefined, env), {
    proxyUrl: 'http://env:1',
    source: 'env',
  })
})

test('hostMatchesNoProxy：* 通配、host:port 精确、端口不匹配不命中', () => {
  assert.equal(hostMatchesNoProxy('anything.com', '443', '*'), true)
  assert.equal(hostMatchesNoProxy('example.com', '443', 'example.com:443'), true)
  assert.equal(
    hostMatchesNoProxy('example.com', '8443', 'example.com:443'),
    false,
    '带端口的条目要求端口也相等',
  )
  assert.equal(hostMatchesNoProxy('example.com', '443', ' example.com , other'), true)
  assert.equal(hostMatchesNoProxy('example.com', '443', undefined), false)
  assert.equal(hostMatchesNoProxy('example.com', '443', ''), false)
  assert.equal(hostMatchesNoProxy('[::1]', '8080', '::1'), true, 'IPv6 的方括号剥掉再比')
})

test('集成：探测真的走了代理（CONNECT 隧道 + 隧道内的真实请求）', async () => {
  // undici 7 的 ProxyAgent 默认对**所有**目标（含 http://）走 CONNECT 隧道
  //（lib/dispatcher/proxy-agent.js：proxyTunnel 默认 true）。因此这里的本地
  // 代理必须实现 CONNECT：收到 CONNECT 后向源站建立 TCP，回 200 并双向转发 ——
  // 隧道内的 GET 才会到达源站。断言两层都要命中：代理见到 CONNECT、源站见到
  // 真实请求 —— 这是「探测与下载同一条网络路径」的底层证据。
  const connectSeen: string[] = []
  const originHits: { method: string; url: string }[] = []
  const origin = createServer((req: IncomingMessage, res: ServerResponse) => {
    originHits.push({ method: req.method ?? '', url: req.url ?? '' })
    res.writeHead(200, {
      'content-length': '10',
      'accept-ranges': 'bytes',
      'content-type': 'application/octet-stream',
    })
    res.end(Buffer.alloc(10, 0x43))
  })
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve))
  const originAddr = origin.address()
  const originPort = typeof originAddr === 'object' && originAddr ? originAddr.port : 0

  const proxy = createServer((_req: IncomingMessage, _res: ServerResponse) => {
    // 非隧道的普通请求不该出现在这条路径上（undici 全走 CONNECT）
    originHits.push({ method: 'UNEXPECTED-PLAIN', url: '' })
  })
  proxy.on('connect', (req, clientSocket, head) => {
    connectSeen.push(`${req.method} ${req.url}`)
    const [host, portText] = (req.url ?? '').split(':')
    const upstream = net.connect(Number(portText), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const proxyAddr = proxy.address()
  const proxyPort = typeof proxyAddr === 'object' && proxyAddr ? proxyAddr.port : 0
  try {
    const probe = await probeUrl(`http://127.0.0.1:${originPort}/a.bin`, undefined, {
      proxy: `http://127.0.0.1:${proxyPort}`,
    })
    assert.equal(connectSeen.length, 1, '代理必须收到一次 CONNECT')
    assert.match(connectSeen[0]!, /^CONNECT 127\.0\.0\.1:\d+$/)
    assert.equal(originHits.length, 1, '源站必须收到隧道内的真实请求')
    // 探测先发 HEAD；本用例的源站带 Content-Length，HEAD 就足够判定，
    // 不会再兜底 Range GET —— 两种都算「真实请求到达了源站」。
    assert.match(originHits[0]!.method, /^(HEAD|GET)$/)
    assert.ok(probe.contentLength === 10)
  } finally {
    await new Promise<void>((resolve) => proxy.close(() => resolve()))
    await new Promise<void>((resolve) => origin.close(() => resolve()))
  }
})

test('dispatcher 生命周期：探测结束后 close() 必须被调用（资源清理的正向断言）', async () => {
  // 每次探测都 new 一个 ProxyAgent；不关闭会随 keepalive 连接积压（批量 50 条
  // = 50 个空闲连接）。这里的正向断言不是「不抛错」，而是 close 恰好被调用一次
  // —— 借 ProbeOptions.dispatcherFactory 测试接缝包一层计数。
  const origin = createServer((_req, res) => {
    res.writeHead(200, { 'content-length': '4' })
    res.end('abcd')
  })
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve))
  const originAddr = origin.address()
  const originPort = typeof originAddr === 'object' && originAddr ? originAddr.port : 0
  // 代理本身不可达也无所谓：结论不是「探测成功」，而是「无论探测成败都清理」。
  // 用一个真实 ProxyAgent 包计数，dispatch 原样转发。
  let closed = 0
  const factory = (proxy: string) => {
    const agent = new ProxyAgent(proxy)
    return {
      dispatch: (opts: never, handler: never) => agent.dispatch(opts, handler),
      close: async () => {
        closed += 1
        await agent.close()
      },
    }
  }
  try {
    const probe = await probeUrl(`http://127.0.0.1:${originPort}/a.bin`, undefined, {
      proxy: 'http://127.0.0.1:1', // 没有代理在监听：探测注定失败
      dispatcherFactory: factory as never,
    })
    // 探测失败（代理不通 -> notSupported）也必须清理
    assert.equal(probe.supportsMultiThread, false)
    assert.equal(closed, 1, '探测返回前 dispatcher.close() 必须恰好被调用一次')
  } finally {
    await new Promise<void>((resolve) => origin.close(() => resolve()))
  }
})

test('集成：无代理时探测直连（不构造 dispatcher，请求直接到源站）', async () => {
  let hits = 0
  const origin = createServer((_req: IncomingMessage, res: ServerResponse) => {
    hits += 1
    res.writeHead(200, { 'content-length': '4' })
    res.end('abcd')
  })
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve))
  const address = origin.address()
  const port = typeof address === 'object' && address ? address.port : 0
  try {
    const probe = await probeUrl(`http://127.0.0.1:${port}/a.bin`)
    assert.equal(hits, 1)
    assert.ok(probe.contentLength === 4)
  } finally {
    await new Promise<void>((resolve) => origin.close(() => resolve()))
  }
})
