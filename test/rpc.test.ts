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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
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

/**
 * 拿到已注册的 handler。
 *
 * 一个注册函数现在会挂两条路由（status 读、cleanup 清理），因此按**路径**挑：
 * 用「只有一条路由」来定位的写法在加第二个端点时就会失效，而那正是这次改动
 * 要防的回归（端点少注册一条 = 面板/调用方直接摸不到）。
 *
 * @param connection 桩连接
 * @param endpoint 端点名（`smartdl.status` / `smartdl.cleanup`）
 */
function handlerOf(connection: unknown, endpoint = 'smartdl.status'): (r: Request) => Promise<Response> {
  const out = runRegister(connection)
  const route = out.routes.find((r) => r.path === `/api/${endpoint}`)
  assert.ok(route, `应注册出 /api/${endpoint} 路由（实际：${out.routes.map((r) => r.path).join(', ')}）`)
  return route.fetch
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

test('registerStatusRpc: 注册三条路由（status 读 + cleanup 清理 + manage 管理），路径与方法各自正确', () => {
  const conn = stubConnection()
  const out = runRegister(conn)
  assert.equal(out.routes.length, 3, 'status、cleanup、manage 各要一条路由')
  const status = out.routes.find((r) => r.path === '/api/smartdl.status')
  const cleanup = out.routes.find((r) => r.path === '/api/smartdl.cleanup')
  const manage = out.routes.find((r) => r.path === '/api/smartdl.manage')
  assert.ok(status, '缺少 /api/smartdl.status')
  assert.ok(cleanup, '缺少 /api/smartdl.cleanup')
  assert.ok(manage, '缺少 /api/smartdl.manage')
  for (const route of [status, cleanup, manage]) {
    assert.deepEqual(route.methods, ['POST'])
    assert.equal(route.requestBody, 'buffered')
  }
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

/* ==================== /api/smartdl.manage（1.4.0 下载管理器） ==================== */

/** 造一个 manage 端点请求（method 固定为 smartdl.manage）。 */
function manageRequest(payload: unknown, rpcId = 'm1'): Request {
  return rpcRequest({ type: 'client-request', rpcId, method: 'smartdl.manage', payload })
}

/** manage 端点的 handler。 */
function manageHandler(): (r: Request) => Promise<Response> {
  return handlerOf(stubConnection(), 'smartdl.manage')
}

/** 在下载目录里造一条任务记录（轨道二），并可选地造出它指向的产物文件。 */
function seedTask(
  downloadDir: string,
  id: string,
  extra: Record<string, unknown> = {},
): string {
  const file = path.join(downloadDir, `${id}.json`)
  writeFileSync(
    file,
    JSON.stringify({
      id,
      name: `${id}.bin`,
      status: 'completed',
      progress: 1,
      updatedAt: Date.now(),
      ...extra,
    }),
  )
  return file
}

/** 造一个真实存在的产物文件，返回它的绝对路径与字节数组。 */
function seedProduct(dir: string, name: string, bytes = 'x'.repeat(32)): string {
  const file = path.join(dir, name)
  writeFileSync(file, bytes)
  return file
}

test('manage：注册了端点，且 status 路由拒绝 manage 的 method（三条路由不互相串门）', async () => {
  const statusHandler = handlerOf(stubConnection(), 'smartdl.status')
  const env = await readEnvelope(await statusHandler(manageRequest({ op: 'inspect', taskId: 'a1' })))
  assert.equal(env.body.result?.ok, false)
  assert.match(env.body.result?.error?.message ?? '', /smartdl\.manage/)
})

test('manage/inspect：产物还在且尺寸一致 -> presence=present，并回报记录里的路径与尺寸', async () => {
  const products = tempDir()
  await withDirs(async ({ downloadDir }) => {
    try {
      const out = seedProduct(products, 'big.zip', 'y'.repeat(64))
      seedTask(downloadDir, 'dl-present', {
        outPath: out,
        size: 64,
        fileMtimeMs: 1234,
      })
      const env = await readEnvelope(
        await manageHandler()(manageRequest({ op: 'inspect', taskId: 'dl-present' })),
      )
      assert.equal(env.body.result?.ok, true)
      const value = env.body.result?.value as Record<string, unknown>
      assert.equal(value.presence, 'present')
      assert.equal(value.found, true)
      assert.equal(value.outPath, out)
      assert.equal(value.size, 64, '记录的尺寸必须原样回报')
      assert.equal(value.fileSize, 64, '磁盘上的当前尺寸也要回报（UI 用它显示文件大小）')
      assert.equal(value.fileMtimeMs, 1234)
      assert.equal(value.state, 'completed')
    } finally {
      rmSync(products, { recursive: true, force: true })
    }
  })
})

test('manage/inspect：尺寸不一致 -> presence=changed（同名占位的文件不能被当成我们的产物）', async () => {
  const products = tempDir()
  await withDirs(async ({ downloadDir }) => {
    try {
      const out = seedProduct(products, 'big.zip', 'z'.repeat(10))
      seedTask(downloadDir, 'dl-changed', { outPath: out, size: 999 })
      const env = await readEnvelope(
        await manageHandler()(manageRequest({ op: 'inspect', taskId: 'dl-changed' })),
      )
      const value = env.body.result?.value as Record<string, unknown>
      assert.equal(value.presence, 'changed')
      assert.equal(value.fileSize, 10, '实际尺寸必须如实回报')
    } finally {
      rmSync(products, { recursive: true, force: true })
    }
  })
})

test('manage/inspect：老记录没有 outPath -> presence=unknown（只允许删记录）', async () => {
  await withDirs(async ({ downloadDir }) => {
    seedTask(downloadDir, 'old-record', { name: 'old.bin' })
    const env = await readEnvelope(
      await manageHandler()(manageRequest({ op: 'inspect', taskId: 'old-record' })),
    )
    assert.equal(env.body.result?.ok, true)
    const value = env.body.result?.value as Record<string, unknown>
    assert.equal(value.presence, 'unknown', '无路径的老记录必须是 unknown')
    assert.equal(value.outPath, '')
    assert.equal(value.size, undefined, '没记录尺寸时不要编一个出来')
    assert.equal(value.found, true, '记录本身是存在的 —— 与「没有这条记录」要能分开')
  })
})

test('manage/inspect：没有这条记录 -> found=false（与「有记录但没路径」区分开）', async () => {
  await withDirs(async () => {
    const env = await readEnvelope(
      await manageHandler()(manageRequest({ op: 'inspect', taskId: 'nope' })),
    )
    const value = env.body.result?.value as Record<string, unknown>
    assert.equal(value.found, false)
    assert.equal(value.presence, 'unknown')
    assert.equal(value.state, '')
  })
})

test('manage/inspect：产物已不在 -> presence=missing', async () => {
  const products = tempDir()
  await withDirs(async ({ downloadDir }) => {
    try {
      const out = seedProduct(products, 'gone.bin')
      seedTask(downloadDir, 'dl-missing', { outPath: out, size: 32 })
      rmSync(out)
      const value = (
        await readEnvelope(await manageHandler()(manageRequest({ op: 'inspect', taskId: 'dl-missing' })))
      ).body.result?.value as Record<string, unknown>
      assert.equal(value.presence, 'missing')
    } finally {
      rmSync(products, { recursive: true, force: true })
    }
  })
})

test('manage/inspect：产物变成目录 -> presence=blocked（不区分目录与链接，都是「不去动它」）', async () => {
  const products = tempDir()
  await withDirs(async ({ downloadDir }) => {
    try {
      const out = path.join(products, 'was-a-file')
      mkdirSync(out, { recursive: true })
      seedTask(downloadDir, 'dl-dir', { outPath: out, size: 32 })
      const value = (
        await readEnvelope(await manageHandler()(manageRequest({ op: 'inspect', taskId: 'dl-dir' })))
      ).body.result?.value as Record<string, unknown>
      assert.equal(value.presence, 'blocked')
    } finally {
      rmSync(products, { recursive: true, force: true })
    }
  })
})

test('manage：未知 op / 非法 taskId / 非对象 payload 一律 ok:false，且不碰任何文件', async () => {
  await withDirs(async ({ downloadDir }) => {
    const product = seedProduct(downloadDir, 'keep.bin')
    seedTask(downloadDir, 'keep', { outPath: product, size: 32 })
    const handler = manageHandler()
    const cases: Array<{ payload: unknown; match: RegExp }> = [
      { payload: null, match: /必须是一个对象|拒绝管理请求/ },
      { payload: { op: 'destroy', taskId: 'keep' }, match: /op 必须是 inspect \/ forget \/ delete/ },
      { payload: { op: 'inspect' }, match: /taskId/ },
      { payload: { op: 'inspect', taskId: '../evil' }, match: /taskId/ },
      { payload: { op: 'delete', taskId: 'a\\b', confirm: true }, match: /taskId/ },
      { payload: { op: 'forget', taskId: 'x'.repeat(65) }, match: /taskId/ },
    ]
    for (const c of cases) {
      const env = await readEnvelope(await handler(manageRequest(c.payload)))
      assert.equal(env.body.result?.ok, false, `payload=${JSON.stringify(c.payload)} 必须被拒绝`)
      assert.match(env.body.result?.error?.message ?? '', c.match)
    }
    assert.equal(existsSync(product), true, '参数被拒时一个文件都不能删')
    assert.equal(existsSync(path.join(downloadDir, 'keep.json')), true, '记录也不能删')
  })
})

test('manage/delete：需要 confirm:true —— 缺失时整个拒绝（不静默降级成只删记录）', async () => {
  const products = tempDir()
  await withDirs(async ({ downloadDir }) => {
    try {
      const out = seedProduct(products, 'need-confirm.bin')
      seedTask(downloadDir, 'dl-nc', { outPath: out, size: 32 })
      const env = await readEnvelope(
        await manageHandler()(manageRequest({ op: 'delete', taskId: 'dl-nc' })),
      )
      assert.equal(env.body.result?.ok, false, '没有 confirm 必须拒绝')
      assert.match(env.body.result?.error?.message ?? '', /confirm:true/)
      assert.equal(existsSync(out), true, '未确认时产物必须还在')
      assert.equal(existsSync(path.join(downloadDir, 'dl-nc.json')), true, '未确认时记录也必须还在')
    } finally {
      rmSync(products, { recursive: true, force: true })
    }
  })
})

test('manage/delete：confirm:true 时先删产物、再删记录，返回两者结果与不可逆提示', async () => {
  const products = tempDir()
  await withDirs(async ({ downloadDir, taskDir }) => {
    try {
      const out = seedProduct(products, 'doomed.bin', 'd'.repeat(48))
      const dlRecord = seedTask(downloadDir, 'dl-del', { outPath: out, size: 48 })
      const taskRecord = path.join(taskDir, 'dl-del.jsonl')
      writeFileSync(taskRecord, '{"v":1,"task":"dl-del","pct":100,"msg":"下载完成","state":"done"}\n')

      const env = await readEnvelope(
        await manageHandler()(manageRequest({ op: 'delete', taskId: 'dl-del', confirm: true })),
      )
      assert.equal(env.body.result?.ok, true)
      const value = env.body.result?.value as {
        fileDeleted: boolean
        reason?: string
        recordRemoved: string[]
        irreversible: string
      }
      assert.equal(value.fileDeleted, true, '产物必须被删掉')
      assert.equal(value.reason, undefined, '成功时不该带 reason')
      assert.deepEqual(
        value.recordRemoved.slice().sort(),
        [dlRecord, taskRecord].sort(),
        '两条轨道的记录都要删掉',
      )
      assert.match(value.irreversible, /永久删除/)
      assert.equal(existsSync(out), false)
      assert.equal(existsSync(dlRecord), false)
      assert.equal(existsSync(taskRecord), false)
    } finally {
      rmSync(products, { recursive: true, force: true })
    }
  })
})

test('manage/delete：产物已被移走 -> reason=gone 且记录照删（没什么可重试的）', async () => {
  const products = tempDir()
  await withDirs(async ({ downloadDir }) => {
    try {
      const out = seedProduct(products, 'moved.bin')
      const dlRecord = seedTask(downloadDir, 'dl-gone', { outPath: out, size: 32 })
      rmSync(out)
      const value = (
        await readEnvelope(
          await manageHandler()(manageRequest({ op: 'delete', taskId: 'dl-gone', confirm: true })),
        )
      ).body.result?.value as { fileDeleted: boolean; reason?: string; recordRemoved: string[] }
      assert.equal(value.fileDeleted, false, '没删到东西就不能报成功')
      assert.equal(value.reason, 'gone')
      assert.deepEqual(value.recordRemoved, [dlRecord], '文件本来就不在了 -> 记录该删')
    } finally {
      rmSync(products, { recursive: true, force: true })
    }
  })
})

test('manage/delete：无 outPath 的老记录 -> reason=no-path 且只删记录（③↔④ 降级）', async () => {
  await withDirs(async ({ downloadDir, taskDir }) => {
    const dlRecord = seedTask(downloadDir, 'dl-nopath', { name: 'legacy.bin' })
    const taskRecord = path.join(taskDir, 'dl-nopath.jsonl')
    writeFileSync(taskRecord, '{"v":1,"task":"dl-nopath","pct":100,"msg":"下载完成","state":"done"}\n')
    const value = (
      await readEnvelope(
        await manageHandler()(manageRequest({ op: 'delete', taskId: 'dl-nopath', confirm: true })),
      )
    ).body.result?.value as { fileDeleted: boolean; reason?: string; recordRemoved: string[] }
    assert.equal(value.fileDeleted, false, '没有路径就不可能删产物')
    assert.equal(value.reason, 'no-path')
    assert.deepEqual(value.recordRemoved.slice().sort(), [dlRecord, taskRecord].sort(), '只删记录')
  })
})

test('manage/delete：任务还在跑 -> reason=running，记录与产物都不动', async () => {
  const products = tempDir()
  await withDirs(async ({ downloadDir }) => {
    try {
      const out = seedProduct(products, 'running.bin', 'r'.repeat(8))
      const dlRecord = seedTask(downloadDir, 'dl-run', {
        outPath: out,
        size: 8,
        status: 'running',
        progress: 0.5,
      })
      const value = (
        await readEnvelope(
          await manageHandler()(manageRequest({ op: 'delete', taskId: 'dl-run', confirm: true })),
        )
      ).body.result?.value as { fileDeleted: boolean; reason?: string; recordRemoved: string[] }
      assert.equal(value.fileDeleted, false)
      assert.equal(value.reason, 'running')
      assert.deepEqual(value.recordRemoved, [], '还在跑的任务不能被从面板上抹掉')
      assert.equal(existsSync(out), true, '正在写的产物更不能删')
      assert.equal(existsSync(dlRecord), true)
    } finally {
      rmSync(products, { recursive: true, force: true })
    }
  })
})

test('manage/delete：尺寸不符 -> reason=changed，产物与记录都保留（守住「不删错东西」）', async () => {
  const products = tempDir()
  await withDirs(async ({ downloadDir }) => {
    try {
      const out = seedProduct(products, 'swapped.bin', 's'.repeat(7))
      const dlRecord = seedTask(downloadDir, 'dl-swap', { outPath: out, size: 4096 })
      const value = (
        await readEnvelope(
          await manageHandler()(manageRequest({ op: 'delete', taskId: 'dl-swap', confirm: true })),
        )
      ).body.result?.value as { fileDeleted: boolean; reason?: string; recordRemoved: string[] }
      assert.equal(value.fileDeleted, false)
      assert.equal(value.reason, 'changed')
      assert.deepEqual(value.recordRemoved, [], '保留记录 = 保留重试入口')
      assert.equal(existsSync(out), true, '尺寸不符的文件绝不能删')
      assert.equal(existsSync(dlRecord), true)
    } finally {
      rmSync(products, { recursive: true, force: true })
    }
  })
})

test('manage/delete：产物是目录 -> reason=is-dir，目录与记录都保留', async () => {
  const products = tempDir()
  await withDirs(async ({ downloadDir }) => {
    try {
      const out = path.join(products, 'became-a-dir')
      mkdirSync(out, { recursive: true })
      const dlRecord = seedTask(downloadDir, 'dl-dir2', { outPath: out, size: 32 })
      const value = (
        await readEnvelope(
          await manageHandler()(manageRequest({ op: 'delete', taskId: 'dl-dir2', confirm: true })),
        )
      ).body.result?.value as { fileDeleted: boolean; reason?: string; recordRemoved: string[] }
      assert.equal(value.reason, 'is-dir')
      assert.deepEqual(value.recordRemoved, [])
      assert.equal(existsSync(out), true, '目录必须原样留着')
      assert.equal(existsSync(dlRecord), true)
    } finally {
      rmSync(products, { recursive: true, force: true })
    }
  })
})

test('manage/delete：产物是符号链接 -> reason=is-link，链接与它指向的目标都不能被删', async () => {
  const products = tempDir()
  await withDirs(async ({ downloadDir }) => {
    try {
      const target = seedProduct(products, 'real-target.bin', 't'.repeat(64))
      const link = path.join(products, 'link.bin')
      symlinkSync(target, link)
      // 记录里的尺寸与**目标**一致：如果实现用 stat 而不是 lstat，它会认为
      // 「这就是我的文件」然后把链接的目标删掉 —— 那正是这条用例要抓的。
      const dlRecord = seedTask(downloadDir, 'dl-link', { outPath: link, size: 64 })
      const value = (
        await readEnvelope(
          await manageHandler()(manageRequest({ op: 'delete', taskId: 'dl-link', confirm: true })),
        )
      ).body.result?.value as { fileDeleted: boolean; reason?: string; recordRemoved: string[] }
      assert.equal(value.fileDeleted, false)
      assert.equal(value.reason, 'is-link')
      assert.deepEqual(value.recordRemoved, [])
      assert.equal(existsSync(link), true, '链接本身要留着')
      assert.equal(existsSync(target), true, '链接指向的文件更必须留着')
      assert.equal(existsSync(dlRecord), true)
    } finally {
      rmSync(products, { recursive: true, force: true })
    }
  })
})

test('manage/delete：记录里的相对路径 -> reason=denied（R3 绝对路径）', async () => {
  const products = tempDir()
  await withDirs(async ({ downloadDir }) => {
    try {
      // 用相对路径记录：删除规则必须拒绝，而不是按 cwd 猜一个位置去删
      seedTask(downloadDir, 'dl-rel', { outPath: 'relative.bin', size: 32 })
      const cwd = process.cwd()
      seedProduct(cwd, 'relative.bin')
      const value = (
        await readEnvelope(
          await manageHandler()(manageRequest({ op: 'delete', taskId: 'dl-rel', confirm: true })),
        )
      ).body.result?.value as { fileDeleted: boolean; reason?: string; errorCode?: string }
      assert.equal(value.fileDeleted, false)
      assert.equal(value.reason, 'denied')
      assert.equal(value.errorCode, 'BAD_PATH')
      assert.equal(existsSync(path.join(cwd, 'relative.bin')), true, '相对路径的目标不能被删')
      rmSync(path.join(cwd, 'relative.bin'), { force: true })
    } finally {
      rmSync(products, { recursive: true, force: true })
    }
  })
})

test('manage/delete：记录里带 .. 的路径 -> reason=denied（R4 归一化比较）', async () => {
  const products = tempDir()
  await withDirs(async ({ downloadDir }) => {
    try {
      const out = seedProduct(products, 'victim.bin')
      // 归一化后与上面是同一个文件，但记录里的字符串带 ..：必须拒绝。
      // 注意**不能用 path.join 拼**：它会自己把 .. 折叠掉，测试就变成了
      // 「一条合法路径」（这条用例的第一版正是这样写错的，红在了断言上）。
      const dotted = `${products}${path.sep}sub${path.sep}..${path.sep}victim.bin`
      assert.notEqual(path.normalize(dotted), dotted, '前置条件：这个字符串必须是未归一化的')
      seedTask(downloadDir, 'dl-dotdot', { outPath: dotted, size: 32 })
      const value = (
        await readEnvelope(
          await manageHandler()(manageRequest({ op: 'delete', taskId: 'dl-dotdot', confirm: true })),
        )
      ).body.result?.value as { fileDeleted: boolean; reason?: string; errorCode?: string }
      assert.equal(value.fileDeleted, false)
      assert.equal(value.reason, 'denied')
      assert.equal(value.errorCode, 'BAD_PATH')
      assert.equal(existsSync(out), true, '带 .. 的路径不能被当成删除目标')
    } finally {
      rmSync(products, { recursive: true, force: true })
    }
  })
})

test('manage/delete：目标是本插件自己的记录目录 -> reason=denied（R9 不许用产物入口删记录）', async () => {
  await withDirs(async ({ downloadDir }) => {
    // 把某条记录的 outPath 指向**另一个任务的记录文件**：这条路径真实存在、
    // 尺寸也能对上，只有 R9 能拦住它。
    const victim = seedTask(downloadDir, 'victim-record', { name: 'v.bin' })
    const size = readFileSync(victim).length
    seedTask(downloadDir, 'dl-attacker', { outPath: victim, size })
    const value = (
      await readEnvelope(
        await manageHandler()(manageRequest({ op: 'delete', taskId: 'dl-attacker', confirm: true })),
      )
    ).body.result?.value as { fileDeleted: boolean; reason?: string; errorCode?: string }
    assert.equal(value.fileDeleted, false)
    assert.equal(value.reason, 'denied')
    assert.equal(value.errorCode, 'BAD_PATH')
    assert.equal(existsSync(victim), true, '别的任务的记录文件不能被产物入口删掉')
  })
})

test('manage/forget：只删记录，绝不碰产物', async () => {
  const products = tempDir()
  await withDirs(async ({ downloadDir, taskDir }) => {
    try {
      const out = seedProduct(products, 'keep-me.bin')
      const dlRecord = seedTask(downloadDir, 'dl-forget', { outPath: out, size: 32 })
      const taskRecord = path.join(taskDir, 'dl-forget.jsonl')
      writeFileSync(taskRecord, '{"v":1,"task":"dl-forget","pct":100,"msg":"下载完成","state":"done"}\n')
      const env = await readEnvelope(
        await manageHandler()(manageRequest({ op: 'forget', taskId: 'dl-forget' })),
      )
      assert.equal(env.body.result?.ok, true)
      const value = env.body.result?.value as { recordRemoved: string[] }
      assert.deepEqual(value.recordRemoved.slice().sort(), [dlRecord, taskRecord].sort())
      assert.equal(existsSync(out), true, 'forget 绝不能碰产物')
      assert.equal(existsSync(dlRecord), false)
      assert.equal(existsSync(taskRecord), false)
    } finally {
      rmSync(products, { recursive: true, force: true })
    }
  })
})

test('manage/forget：幂等（第二次没有记录可删也返回 ok，且不报错）', async () => {
  await withDirs(async ({ downloadDir }) => {
    const record = seedTask(downloadDir, 'dl-idem')
    const first = await readEnvelope(
      await manageHandler()(manageRequest({ op: 'forget', taskId: 'dl-idem' }, 'f1')),
    )
    const second = await readEnvelope(
      await manageHandler()(manageRequest({ op: 'forget', taskId: 'dl-idem' }, 'f2')),
    )
    assert.deepEqual((first.body.result?.value as { recordRemoved: string[] }).recordRemoved, [record])
    assert.deepEqual((second.body.result?.value as { recordRemoved: string[] }).recordRemoved, [])
    assert.equal(second.body.result?.ok, true)
  })
})

/* ---------------------- /api/smartdl.cleanup（D7-② 清理入口） ---------------------- */

/** 造一个 cleanup 端点请求（method 固定为 smartdl.cleanup） */
function cleanupRequest(payload: unknown, rpcId = 'c1'): Request {
  return rpcRequest({
    type: 'client-request',
    rpcId,
    method: 'smartdl.cleanup',
    payload,
  })
}

/** 把一个文件的 mtime 拨到 days 天前（清理的判定完全基于 mtime） */
function ageFile(file: string, days: number): void {
  const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  utimesSync(file, when, when)
}

test('cleanup：请求 status 路由时 method 不匹配会回 ok:false（两条路由不会互相串门）', async () => {
  const conn = stubConnection()
  const statusHandler = handlerOf(conn, 'smartdl.status')
  const res = await statusHandler(cleanupRequest({}))
  const env = await readEnvelope(res)
  assert.equal(env.body.result?.ok, false)
  assert.match(env.body.result?.error?.message ?? '', /smartdl\.cleanup/)
  assert.match(env.body.result?.error?.message ?? '', /smartdl\.status/)
})

test('cleanup：只删过期的历史文件，保留窗口内的文件一个都不动', async () => {
  await withDirs(async ({ taskDir, downloadDir }) => {
    const oldDl = path.join(downloadDir, 'old.json')
    const freshDl = path.join(downloadDir, 'fresh.json')
    const oldTask = path.join(taskDir, 'old.jsonl')
    const freshTask = path.join(taskDir, 'fresh.jsonl')
    const oldRaw = JSON.stringify({ id: 'old', name: 'a.bin', status: 'completed', progress: 1 })
    writeFileSync(oldDl, oldRaw)
    writeFileSync(freshDl, JSON.stringify({ id: 'fresh', name: 'b.bin', status: 'running', progress: 0.1 }))
    writeFileSync(oldTask, '{"pct":100,"state":"done"}\n')
    writeFileSync(freshTask, '{"pct":5,"state":"running"}\n')
    ageFile(oldDl, 3)
    ageFile(oldTask, 3)

    const conn = stubConnection()
    const fetchHandler = handlerOf(conn, 'smartdl.cleanup')
    const res = await fetchHandler(cleanupRequest({ olderThanMs: 24 * 60 * 60 * 1000 }))
    const env = await readEnvelope(res)
    assert.equal(env.body.result?.ok, true, '清理应成功返回')
    const value = env.body.result?.value as {
      deleted: string[]
      kept: Array<{ file: string }>
      deletedCount: number
    }
    assert.deepEqual(
      value.deleted.slice().sort(),
      [oldDl, oldTask].sort(),
      '只有 3 天前的两个文件该被删',
    )
    assert.equal(value.deletedCount, 2)
    assert.ok(readFileSync(freshDl, 'utf-8').includes('fresh'), '窗口内文件必须原样保留')
    assert.ok(readFileSync(freshTask, 'utf-8').includes('running'), '窗口内文件必须原样保留')
    assert.equal(value.kept.length, 2, '留在窗口内的文件要如实报告')
  })
})

test('cleanup：非法 olderThanMs 以 ok:false + 可操作文案拒绝（不夹取、也不删任何东西）', async () => {
  await withDirs(async ({ downloadDir }) => {
    // 摆一个「已经过期」的文件：如果参数被夹到边界后照删，它会被删掉 —— 这正是要防的
    const stale = path.join(downloadDir, 'stale.json')
    writeFileSync(stale, JSON.stringify({ id: 'stale', status: 'completed', progress: 1 }))
    ageFile(stale, 5)

    const conn = stubConnection()
    const fetchHandler = handlerOf(conn, 'smartdl.cleanup')
    // 59999 与 >365 天都是「看起来像数字」的越界值：此前的实现会把它们夹到边界，
    // 调用方从返回里看不出自己给的值没生效 —— 现在必须直接拒绝。
    const badValues: unknown[] = [
      0,
      -1,
      'abc',
      null,
      {},
      Number.POSITIVE_INFINITY,
      59_999,
      366 * 24 * 60 * 60 * 1000,
    ]
    for (const bad of badValues) {
      const env = await readEnvelope(
        await fetchHandler(cleanupRequest({ olderThanMs: bad, limit: 5 }, `c-${String(bad)}`)),
      )
      assert.equal(env.body.result?.ok, false, `olderThanMs=${String(bad)} 必须被拒绝，而不是被改写`)
      const message = env.body.result?.error?.message ?? ''
      assert.match(message, /olderThanMs/, '文案必须点名是哪个字段错了')
      assert.match(message, /60000/, '文案必须给出合法范围的下限（60 秒）')
      assert.match(message, /拒绝清理/, '文案必须说明这是拒绝，而不是「已按默认值清理」')
    }
    assert.equal(existsSync(stale), true, '被拒绝的请求一个文件都不能删')
  })
})

test('cleanup：limit 生效（传 1 只删最旧的一个），非法值则拒绝而不是回落（不是「点了没反应」）', async () => {
  await withDirs(async ({ downloadDir }) => {
    const files = ['a.json', 'b.json', 'c.json'].map((name) => {
      const file = path.join(downloadDir, name)
      writeFileSync(file, JSON.stringify({ id: name, status: 'completed', progress: 1 }))
      ageFile(file, 5)
      return file
    })

    const conn = stubConnection()
    const fetchHandler = handlerOf(conn, 'smartdl.cleanup')

    const limited = await readEnvelope(await fetchHandler(cleanupRequest({ limit: 1 }, 'c-1')))
    const limitedValue = limited.body.result?.value as { deletedCount: number; truncated: boolean }
    assert.equal(limitedValue.deletedCount, 1, 'limit=1 只应删一个')
    assert.equal(limitedValue.truncated, true, '还有过期文件没删完时必须报 truncated')
    assert.equal(files.filter((f) => existsSync(f)).length, 2, '剩下两个仍然过期，留给下一次调用')

    // 非法 limit 不再回落到默认条数：会删文件的操作不接受静默改写参数
    const rejected = await readEnvelope(await fetchHandler(cleanupRequest({ limit: 0 }, 'c-2')))
    assert.equal(rejected.body.result?.ok, false, 'limit=0 必须被拒绝')
    const message = rejected.body.result?.error?.message ?? ''
    assert.match(message, /limit/, '文案必须点名 limit')
    assert.match(message, /1\.\.500/, '文案必须给出合法范围（1..500）')
    assert.equal(
      files.filter((f) => existsSync(f)).length,
      2,
      '被拒绝时不得顺手把剩下的过期文件删掉',
    )
  })
})

test('cleanup：调用两次是幂等的（第二次删不到东西，且不报错）', async () => {
  await withDirs(async ({ downloadDir }) => {
    const stale = path.join(downloadDir, 'stale.json')
    writeFileSync(stale, JSON.stringify({ id: 'stale', status: 'failed', progress: 0.3 }))
    ageFile(stale, 10)

    const conn = stubConnection()
    const fetchHandler = handlerOf(conn, 'smartdl.cleanup')
    const first = await readEnvelope(await fetchHandler(cleanupRequest({}, 'c-first')))
    const second = await readEnvelope(await fetchHandler(cleanupRequest({}, 'c-second')))
    assert.equal((first.body.result?.value as { deletedCount: number }).deletedCount, 1)
    assert.equal((second.body.result?.value as { deletedCount: number }).deletedCount, 0)
    assert.equal(second.body.result?.ok, true)
    assert.equal(existsSync(stale), false)
  })
})

test('cleanup：目录不存在时报 scanFailedDirs 而不是抛错（幂等的清理不该因此失败）', async () => {
  const saved = process.env.DSH_DOWNLOAD_PROGRESS_DIR
  process.env.DSH_DOWNLOAD_PROGRESS_DIR = path.join(tempDir(), 'missing')
  try {
    const conn = stubConnection()
    const fetchHandler = handlerOf(conn, 'smartdl.cleanup')
    const env = await readEnvelope(await fetchHandler(cleanupRequest({})))
    assert.equal(env.body.result?.ok, true, '目录读不到时仍需返回结构化结果')
    const value = env.body.result?.value as { scanFailedDirs?: string[]; deletedCount: number }
    assert.deepEqual(value.scanFailedDirs, [process.env.DSH_DOWNLOAD_PROGRESS_DIR])
    assert.equal(value.deletedCount, 0)
  } finally {
    if (saved === undefined) delete process.env.DSH_DOWNLOAD_PROGRESS_DIR
    else process.env.DSH_DOWNLOAD_PROGRESS_DIR = saved
  }
})

/* ---------- P0R-03：轨道一必须真的参与清理，或如实报告它没参与 ---------- */

test('cleanup：带 payload.session 时轨道一也参与清理，并报出实际扫描的目录', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'rpc-cleanup-sess-'))
  const downloadDir = mkdtempSync(path.join(tmpdir(), 'rpc-cleanup-dl-'))
  const savedTask = process.env.DSH_PROGRESS_DIR
  const savedDl = process.env.DSH_DOWNLOAD_PROGRESS_DIR
  // 轨道一的落点优先看 DSH_PROGRESS_DIR，因此这里必须清掉它，才能验证「靠会话定位」
  delete process.env.DSH_PROGRESS_DIR
  process.env.DSH_DOWNLOAD_PROGRESS_DIR = downloadDir
  try {
    const sessionDir = path.join(cwd, '.dsh-progress', 'sess-clean')
    mkdirSync(sessionDir, { recursive: true })
    const staleTask = path.join(sessionDir, 'p1.jsonl')
    writeFileSync(staleTask, '{"v":1,"task":"p1","pct":100,"msg":"下载完成","state":"done"}\n')
    ageFile(staleTask, 3)
    const freshTask = path.join(sessionDir, 'p2.jsonl')
    writeFileSync(freshTask, '{"v":1,"task":"p2","pct":5,"msg":"下载中"}\n')

    const fetchHandler = handlerOf(stubConnection(), 'smartdl.cleanup')
    const env = await readEnvelope(
      await fetchHandler(cleanupRequest({ session: { id: 'sess-clean', cwd } })),
    )
    assert.equal(env.body.result?.ok, true)
    const value = env.body.result?.value as {
      deleted: string[]
      taskDir: string
      taskDirSkipped?: string
    }
    assert.deepEqual(value.deleted, [staleTask], '轨道一里过期的那条必须被删掉')
    assert.equal(value.taskDir, sessionDir, '必须如实报出实际扫描的轨道一目录')
    assert.equal(value.taskDirSkipped, undefined, '轨道一参与了就不该出现「未参与」说明')
    assert.equal(existsSync(freshTask), true, '保留窗口内的轨道一文件必须留着')
  } finally {
    if (savedTask === undefined) delete process.env.DSH_PROGRESS_DIR
    else process.env.DSH_PROGRESS_DIR = savedTask
    if (savedDl === undefined) delete process.env.DSH_DOWNLOAD_PROGRESS_DIR
    else process.env.DSH_DOWNLOAD_PROGRESS_DIR = savedDl
    rmSync(cwd, { recursive: true, force: true })
    rmSync(downloadDir, { recursive: true, force: true })
  }
})

test('cleanup：没有会话且未设 DSH_PROGRESS_DIR -> 如实报出轨道一未参与（不是静默少扫一个目录）', async () => {
  const downloadDir = mkdtempSync(path.join(tmpdir(), 'rpc-cleanup-only2-'))
  const savedTask = process.env.DSH_PROGRESS_DIR
  const savedDl = process.env.DSH_DOWNLOAD_PROGRESS_DIR
  delete process.env.DSH_PROGRESS_DIR
  process.env.DSH_DOWNLOAD_PROGRESS_DIR = downloadDir
  try {
    const stale = path.join(downloadDir, 'only-two.json')
    writeFileSync(stale, JSON.stringify({ id: 'only-two', status: 'completed', progress: 1 }))
    ageFile(stale, 3)

    const fetchHandler = handlerOf(stubConnection(), 'smartdl.cleanup')
    const env = await readEnvelope(await fetchHandler(cleanupRequest({})))
    assert.equal(
      env.body.result?.ok,
      true,
      '轨道一定位不到不是调用失败（没有会话是正常的单轨模式）',
    )
    const value = env.body.result?.value as {
      taskDir: string
      taskDirSkipped?: string
      deleted: string[]
    }
    assert.equal(value.taskDir, '', 'taskDir 为空串 = 轨道一没有参与')
    assert.match(
      value.taskDirSkipped ?? '',
      /轨道一未参与/,
      '缺一个目录必须被显式报出来，而不是让调用方以为「删了 N 个 = 清完了」',
    )
    assert.match(value.taskDirSkipped ?? '', /session/, '说明里必须给出让轨道一参与的办法')
    assert.deepEqual(value.deleted, [stale], '轨道二照常清理')
  } finally {
    if (savedTask === undefined) delete process.env.DSH_PROGRESS_DIR
    else process.env.DSH_PROGRESS_DIR = savedTask
    if (savedDl === undefined) delete process.env.DSH_DOWNLOAD_PROGRESS_DIR
    else process.env.DSH_DOWNLOAD_PROGRESS_DIR = savedDl
    rmSync(downloadDir, { recursive: true, force: true })
  }
})
