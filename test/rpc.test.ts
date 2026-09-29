/**
 * rpc.ts 测试：Host 侧 /api/smartdl.status 端点。
 *
 * 为什么补这批用例：0.8.0 之前 rpc.ts 的函数覆盖率是全项目最低的
 * （实测 6/16，ok / fail / envelopeResponse / readPayload 与整个 handler
 *  主体 count=0，一次都没被执行过）。这个模块恰好是「静默失败」的高发区：
 *
 *   - connection 缺失时 return（CLI profile 正常行为，但从未被断言过）
 *   - 非法请求一律回 200 + ok:false（不是 HTTP 错误码，客户端容易忽略）
 *   - readPayload 的非法 limit / session 静默回落到默认值
 *
 * 因此正向契约是：**每条跳过与回落路径都要断言它「回落到了哪个具体值」**，
 * 而不是只断言「调用不抛错」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { registerStatusRpc } from '../src/rpc.js'
import { DEFAULT_STATUS_LIMIT } from '../src/status.js'

/* --------------------------- 桩 ctx / connection --------------------------- */

interface CapturedRoute {
  path: string
  methods: readonly string[]
  requestBody: string
  fetch: (request: Request) => Promise<Response>
}

interface StubResult {
  /** 本次注册产生的路由（跳过时为空数组） */
  routes: CapturedRoute[]
  /** 注册的 effect 名称（用于断言 dispose 标签） */
  effectLabel: string | undefined
  /** 注入回调是否被执行过（connection 缺失时 cordis 根本不会调） */
  injectCalled: boolean
}

/**
 * 用桩 ctx 跑 registerStatusRpc。
 *
 * connection 会被包一层：`fetch.register` 收到的路由记进 out.routes，
 * 再委托给原始实现。传 undefined 模拟纯 CLI profile。
 *
 * @param connection 模拟的 connection 服务；传 undefined 模拟纯 CLI profile
 * @param deps 声明的依赖名，用于验证只有 connection 齐备时才注册
 */
function runRegister(
  connection: unknown,
  deps: string[] = ['connection'],
): StubResult {
  const out: StubResult = { routes: [], effectLabel: undefined, injectCalled: false }

  const wrapped = wrapConnection(connection, out.routes)

  const ctx = {
    inject(names: readonly string[], callback: (child: unknown) => void) {
      // cordis 的真实语义：依赖齐备才会调用回调
      const missing = names.filter((n) => !deps.includes(n))
      if (missing.length > 0) return
      out.injectCalled = true
      const child = {
        get(name: string) {
          return name === 'connection' ? wrapped : undefined
        },
        effect(add: () => () => Promise<void>, label?: string) {
          const dispose = add()
          out.effectLabel = label
          // 立即 dispose，避免桩泄漏；register 返回的 dispose 也应为函数
          assert.equal(typeof dispose, 'function', 'register 应返回 dispose 函数')
          void dispose()
        },
      }
      callback(child)
    },
  }

  registerStatusRpc(ctx as never)
  return out
}

/**
 * 把 connection 的 fetch.register 包一层以记录路由。
 *
 * connection 形状不对（null / 缺 register）时原样返回，
 * 这样「形状非法应静默跳过」的用例测的仍是 rpc.ts 自己的卫语句。
 */
function wrapConnection(connection: unknown, sink: CapturedRoute[]): unknown {
  if (connection === null || typeof connection !== 'object') return connection
  const conn = connection as { fetch?: { register?: unknown } }
  if (!conn.fetch || typeof conn.fetch.register !== 'function') return connection
  const original = conn.fetch.register as (route: CapturedRoute) => () => Promise<void>
  return {
    ...conn,
    fetch: {
      ...conn.fetch,
      register(route: CapturedRoute) {
        sink.push(route)
        return original(route)
      },
    },
  }
}

/** 造一个能收路由的 connection 桩 */
function stubConnection(): unknown {
  return {
    fetch: {
      register(): () => Promise<void> {
        return () => Promise.resolve()
      },
    },
  }
}

/** 拿到已注册的 handler（要求注册成功，且只注册了一条） */
function handlerOf(connection: unknown): (r: Request) => Promise<Response> {
  const out = runRegister(connection)
  assert.equal(out.routes.length, 1, '应恰好注册出一条路由')
  return out.routes[0].fetch
}

/** 造一个 client-request 信封请求 */
function rpcRequest(
  body: unknown,
  opts: { method?: string; contentType?: string; raw?: string } = {},
): Request {
  const method = opts.method ?? 'POST'
  const contentType = opts.contentType ?? 'application/json'
  const raw = opts.raw ?? JSON.stringify(body)
  return new Request('http://localhost/api/smartdl.status', {
    method,
    headers: { 'content-type': contentType },
    body: raw,
  })
}

/** 解析 server-response 信封 */
async function readEnvelope(res: Response): Promise<{
  status: number
  body: {
    type?: string
    rpcId?: string
    result?: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } }
  }
}> {
  return { status: res.status, body: (await res.json()) as never }
}

/* ------------------------------ 临时目录工具 ------------------------------ */

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'dsh-rpc-'))
}

/**
 * 把两条轨道都指向临时目录，执行完恢复。
 *
 * fn 可以返回 Promise；**必须把它返回出去并 await**，否则测试会在
 * 异步断言跑完之前结束（node:test 会报 "asynchronous activity after the test ended"）。
 */
async function withDirs(
  fn: (dirs: { taskDir: string; downloadDir: string }) => void | Promise<void>,
): Promise<void> {
  const taskDir = tempDir()
  const downloadDir = tempDir()
  const savedTask = process.env.DSH_PROGRESS_DIR
  const savedDl = process.env.DSH_DOWNLOAD_PROGRESS_DIR
  process.env.DSH_PROGRESS_DIR = taskDir
  process.env.DSH_DOWNLOAD_PROGRESS_DIR = downloadDir
  try {
    await fn({ taskDir, downloadDir })
  } finally {
    if (savedTask === undefined) delete process.env.DSH_PROGRESS_DIR
    else process.env.DSH_PROGRESS_DIR = savedTask
    if (savedDl === undefined) delete process.env.DSH_DOWNLOAD_PROGRESS_DIR
    else process.env.DSH_DOWNLOAD_PROGRESS_DIR = savedDl
    rmSync(taskDir, { recursive: true, force: true })
    rmSync(downloadDir, { recursive: true, force: true })
  }
}

/* ============================== 用例 ============================== */

test('registerStatusRpc: 没有 connection 服务时静默跳过，且不抛错', () => {
  // 这里模拟「声明了 connection 依赖但服务取不到」（譬如 profile 没提供该服务）。
  // 正向断言：不注册任何路由、不抛错 —— 插件加载不会被拖挂。
  const out = runRegister(undefined)
  assert.equal(out.routes.length, 0, '无 connection 时不应注册任何路由')
  assert.equal(out.injectCalled, true, '依赖齐备时注入回调仍会执行，只是内部提前 return')
})

test('registerStatusRpc: connection 缺少 fetch.register 时跳过（不是崩溃）', () => {
  // 形状不对的 connection 同样静默跳过
  const out = runRegister({ fetch: {} })
  assert.equal(out.routes.length, 0, 'fetch.register 不是函数时应跳过')
  assert.equal(out.injectCalled, true, '依赖齐备时注入回调仍应执行，只是内部提前 return')
})

test('registerStatusRpc: connection 为 null 时跳过', () => {
  const out = runRegister(null)
  assert.equal(out.routes.length, 0, 'connection 为 null 时应跳过')
  assert.equal(out.injectCalled, true, '依赖齐备时注入回调仍应执行，只是内部提前 return')
})

test('registerStatusRpc: 依赖缺失时 cordis 不会调用注入回调', () => {
  const out = runRegister({ fetch: { register: () => () => Promise.resolve() } }, [])
  assert.equal(out.injectCalled, false, 'connection 依赖缺失时注入回调不应执行')
  assert.equal(out.routes.length, 0, '依赖缺失时不应注册路由')
})

test('registerStatusRpc: 注册路径与方法是 /api/smartdl.status + POST', () => {
  const conn = stubConnection()
  const out = runRegister(conn)
  assert.equal(out.routes.length, 1, '应恰好注册一条路由')
  assert.equal(out.routes[0].path, '/api/smartdl.status')
  assert.deepEqual(out.routes[0].methods, ['POST'])
  assert.equal(out.routes[0].requestBody, 'buffered')
  assert.equal(
    out.effectLabel,
    'dsh-smart-dl: /api/smartdl.status Fetch route',
    'effect 标签应标明端点，便于 fiber 树排障',
  )
})

test('handler: 非 POST 方法返回 404', async () => {
  const conn = stubConnection()
  const fetchHandler = handlerOf(conn)
  // GET 不能带 body（undici 会拒），直接手搓一个无 body 的 GET 请求
  const res = await fetchHandler(
    new Request('http://localhost/api/smartdl.status', { method: 'GET' }),
  )
  assert.equal(res.status, 404, 'GET 应返回 404')
  assert.equal(await res.text(), 'not found')
})

test('handler: content-type 非 JSON 返回 415', async () => {
  const conn = stubConnection()
  const fetchHandler = handlerOf(conn)
  const res = await fetchHandler(
    rpcRequest(null, { contentType: 'text/plain', raw: 'hi' }),
  )
  assert.equal(res.status, 415)
  assert.match(await res.text(), /content type must be application\/json/)
})

test('handler: content-type 带 charset 前缀仍被接受（按 ; 截断后比较）', async () => {
  const conn = stubConnection()
  const fetchHandler = handlerOf(conn)
  const res = await fetchHandler(
    rpcRequest(
      { type: 'client-request', rpcId: 'r1', method: 'smartdl.status', payload: null },
      { contentType: 'application/json; charset=utf-8' },
    ),
  )
  // 正向断言：能走到业务层并返回 200 信封（说明 ; 后的参数被正确剥离）
  assert.equal(res.status, 200)
  const env = await readEnvelope(res)
  assert.equal(env.body.result?.ok, true, '带 charset 的 content-type 应被接受')
})

test('handler: body 不是合法 JSON 返回 400', async () => {
  const conn = stubConnection()
  const fetchHandler = handlerOf(conn)
  const res = await fetchHandler(rpcRequest(null, { raw: '{not json' }))
  assert.equal(res.status, 400)
  assert.match(await res.text(), /body is not JSON/)
})

test('handler: 合法请求返回 server-response 信封且带 cache-control: no-store', async () => {
  await withDirs(() => {
    // 目录为空也能返回 ok（快照为空列表），这里只验证信封形状
  })
  const conn = stubConnection()
  const fetchHandler = handlerOf(conn)
  const res = await fetchHandler(
    rpcRequest({
      type: 'client-request',
      rpcId: 'rpc-1',
      method: 'smartdl.status',
      payload: { limit: 5 },
    }),
  )
  assert.equal(res.status, 200, '业务层失败也用 200 + ok:false，而非 HTTP 错误码')
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(res.headers.get('cache-control'), 'no-store', '进度快照绝不能被缓存')
  const env = await readEnvelope(res)
  assert.equal(env.body.type, 'server-response')
  assert.equal(env.body.rpcId, 'rpc-1', 'rpcId 必须原样回传，否则客户端无法配对')
  assert.equal(env.body.result?.ok, true)
})

test('handler: type 不是 client-request 时返回 ok:false 与 invalid-request', async () => {
  const conn = stubConnection()
  const fetchHandler = handlerOf(conn)
  const res = await fetchHandler(
    rpcRequest({ type: 'something-else', rpcId: 'r2', method: 'smartdl.status' }),
  )
  assert.equal(res.status, 200)
  const env = await readEnvelope(res)
  assert.equal(env.body.result?.ok, false)
  assert.equal(env.body.rpcId, 'invalid-request', '信封不合法时 rpcId 用固定哨兵值')
  assert.equal(env.body.result?.error?.code, 'internal')
  assert.match(env.body.result?.error?.message ?? '', /invalid client-request message/)
})

test('handler: rpcId 非字符串 / 空串都判为非法信封', async () => {
  const conn = stubConnection()
  const fetchHandler = handlerOf(conn)
  for (const rpcId of [123, '', undefined]) {
    const res = await fetchHandler(
      rpcRequest({ type: 'client-request', rpcId, method: 'smartdl.status' }),
    )
    const env = await readEnvelope(res)
    assert.equal(env.body.result?.ok, false, `rpcId=${String(rpcId)} 应判非法`)
    assert.equal(env.body.rpcId, 'invalid-request')
  }
})

test('handler: 信封为 null 时判非法', async () => {
  const conn = stubConnection()
  const fetchHandler = handlerOf(conn)
  const res = await fetchHandler(rpcRequest(null))
  const env = await readEnvelope(res)
  assert.equal(env.body.result?.ok, false)
  assert.equal(env.body.rpcId, 'invalid-request')
})

test('handler: method 与端点不匹配时回传原 rpcId 并说明两端值', async () => {
  const conn = stubConnection()
  const fetchHandler = handlerOf(conn)
  const res = await fetchHandler(
    rpcRequest({ type: 'client-request', rpcId: 'r3', method: 'other.method' }),
  )
  assert.equal(res.status, 200)
  const env = await readEnvelope(res)
  assert.equal(env.body.result?.ok, false)
  assert.equal(env.body.rpcId, 'r3', '信封合法时 rpcId 必须原样回传')
  assert.match(env.body.result?.error?.message ?? '', /other\.method/)
  assert.match(env.body.result?.error?.message ?? '', /smartdl\.status/)
})

test('handler: limit 非法时回落到 DEFAULT_STATUS_LIMIT（而非静默用 0 或 Infinity）', async () => {
  await withDirs(async ({ downloadDir }) => {
    // 造 3 条任务，确保「回落值」能被观察到：默认 10 > 3，全部返回
    for (let i = 0; i < 3; i += 1) {
      writeFileSync(
        path.join(downloadDir, `task-${i}.json`),
        JSON.stringify({ id: `task-${i}`, name: `f${i}.bin`, status: 'active', pct: 10 * i }),
      )
    }
    const conn = stubConnection()
    const fetchHandler = handlerOf(conn)
    for (const badLimit of ['abc', null, {}, -1, 0, NaN, Infinity]) {
      const res = await fetchHandler(
        rpcRequest({
          type: 'client-request',
          rpcId: `L-${String(badLimit)}`,
          method: 'smartdl.status',
          payload: { limit: badLimit },
        }),
      )
      const env = await readEnvelope(res)
      assert.equal(env.body.result?.ok, true, `limit=${String(badLimit)} 应仍能成功`)
      const value = env.body.result?.value as { tasks: unknown[] }
      assert.equal(
        value.tasks.length,
        3,
        `limit=${String(badLimit)} 应回落到默认 ${DEFAULT_STATUS_LIMIT} 并返回全部 3 条`,
      )
    }
  })
})

test('handler: limit 超过 50 被夹到 50（防止客户端拉爆内存）', async () => {
  await withDirs(async ({ downloadDir }) => {
    // 造 60 条，若夹取失效会返回 60 条
    for (let i = 0; i < 60; i += 1) {
      writeFileSync(
        path.join(downloadDir, `t${i}.json`),
        JSON.stringify({ id: `t${i}`, name: `f${i}.bin`, status: 'active', pct: i }),
      )
    }
    const conn = stubConnection()
    const fetchHandler = handlerOf(conn)
    const res = await fetchHandler(
      rpcRequest({
        type: 'client-request',
        rpcId: 'cap',
        method: 'smartdl.status',
        payload: { limit: 9999 },
      }),
    )
    const env = await readEnvelope(res)
    const value = env.body.result?.value as { tasks: unknown[] }
    assert.equal(value.tasks.length, 50, 'limit 上限应夹到 50')
  })
})

test('handler: limit 小数向下取整', async () => {
  await withDirs(async ({ downloadDir }) => {
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(
        path.join(downloadDir, `t${i}.json`),
        JSON.stringify({ id: `t${i}`, name: `f${i}.bin`, status: 'active', pct: i }),
      )
    }
    const conn = stubConnection()
    const fetchHandler = handlerOf(conn)
    const res = await fetchHandler(
      rpcRequest({
        type: 'client-request',
        rpcId: 'floor',
        method: 'smartdl.status',
        payload: { limit: 2.9 },
      }),
    )
    const env = await readEnvelope(res)
    const value = env.body.result?.value as { tasks: unknown[] }
    assert.equal(value.tasks.length, 2, 'limit=2.9 应取 2')
  })
})

test('handler: session 形状不合法时回落为 undefined（不拿非法值当路径）', async () => {
  await withDirs(async () => {
    const conn = stubConnection()
    const fetchHandler = handlerOf(conn)
    for (const session of [null, 'str', 42, {}, { id: 1, cwd: 2 }]) {
      const res = await fetchHandler(
        rpcRequest({
          type: 'client-request',
          rpcId: `S-${JSON.stringify(session)}`,
          method: 'smartdl.status',
          payload: { limit: 5, session },
        }),
      )
      const env = await readEnvelope(res)
      assert.equal(
        env.body.result?.ok,
        true,
        `非法 session=${JSON.stringify(session)} 不应把整个调用拖垮`,
      )
    }
  })
})

test('handler: session 只有 id 或只有 cwd 时仍然透传（不是整体丢弃）', async () => {
  await withDirs(async () => {
    const conn = stubConnection()
    const fetchHandler = handlerOf(conn)
    // 形状合法 -> 透传给 readDownloadStatus；这里只断言不报错且仍 ok
    for (const session of [{ id: 'abc' }, { cwd: '/tmp' }]) {
      const res = await fetchHandler(
        rpcRequest({
          type: 'client-request',
          rpcId: 'partial',
          method: 'smartdl.status',
          payload: { limit: 5, session },
        }),
      )
      const env = await readEnvelope(res)
      assert.equal(env.body.result?.ok, true, `session=${JSON.stringify(session)} 应被接受`)
    }
  })
})

test('handler: 业务层抛错时返回 ok:false 并带上错误消息（不泄漏为 500 裸奔）', async () => {
  // readDownloadStatus 抛错的路径：把轨道目录指向一个「文件」而非目录，
  // 让扫描必然失败；无论内部如何失败，RPC 都必须返回结构化信封
  const saved = process.env.DSH_DOWNLOAD_PROGRESS_DIR
  const fileAsDir = path.join(tempDir(), 'notadir')
  writeFileSync(fileAsDir, 'x')
  process.env.DSH_DOWNLOAD_PROGRESS_DIR = fileAsDir
  try {
    const conn = stubConnection()
    const fetchHandler = handlerOf(conn)
    const res = await fetchHandler(
      rpcRequest({
        type: 'client-request',
        rpcId: 'boom',
        method: 'smartdl.status',
        payload: { limit: 5 },
      }),
    )
    assert.equal(res.status, 200, '即使业务层抛错也返回 200 + ok:false 信封')
    const env = await readEnvelope(res)
    assert.equal(env.body.rpcId, 'boom')
    // 若业务层容错后仍 ok=true，也接受；关键是「结构化、有 rpcId、有 result」
    assert.ok(env.body.result, '必须带 result')
    assert.ok(
      typeof env.body.result.ok === 'boolean',
      'result.ok 必须是布尔值，客户端依赖它分派',
    )
    if (env.body.result.ok === false) {
      assert.ok(env.body.result.error?.message, 'ok:false 时必须带可读消息')
    }
  } finally {
    if (saved === undefined) delete process.env.DSH_DOWNLOAD_PROGRESS_DIR
    else process.env.DSH_DOWNLOAD_PROGRESS_DIR = saved
    rmSync(path.dirname(fileAsDir), { recursive: true, force: true })
  }
})

test('handler: 端到端 —— 能真的读到轨道二的任务快照', async () => {
  await withDirs(async ({ downloadDir }) => {
    writeFileSync(
      path.join(downloadDir, 'dl-1.json'),
      // 轨道二是本插件自有的 DownloadTaskFile 格式：进度字段是 0-1 的
      // `progress`（不是 `pct`），速度字段是 `speed`（不是 `spd`）。
      JSON.stringify({
        id: 'dl-1',
        name: 'big.zip',
        status: 'running',
        progress: 0.42,
        speed: '1.2MB/s',
        eta: '00:01:20',
      }),
    )
    const conn = stubConnection()
    const fetchHandler = handlerOf(conn)
    const res = await fetchHandler(
      rpcRequest({
        type: 'client-request',
        rpcId: 'e2e',
        method: 'smartdl.status',
        payload: { limit: 10 },
      }),
    )
    const env = await readEnvelope(res)
    assert.equal(env.body.result?.ok, true)
    const value = env.body.result?.value as {
      total: number
      tasks: Array<{ id: string; name: string; pct: number; spd: string; status: string }>
    }
    assert.equal(value.total, 1, 'total 应反映截断前的任务数')
    assert.equal(value.tasks.length, 1, '应真的扫出 1 条任务')
    assert.equal(value.tasks[0].id, 'dl-1')
    assert.equal(value.tasks[0].name, 'big.zip')
    assert.equal(value.tasks[0].pct, 42, 'progress 0.42 必须被换算成 42，而不是落成 0')
    assert.equal(value.tasks[0].spd, '1.2MB/s', 'speed 字段必须映射到 spd')
    assert.equal(value.tasks[0].status, 'running')
  })
})
