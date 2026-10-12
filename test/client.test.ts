/**
 * src/client.js（浏览器端进度面板）测试。
 *
 * 11 条断言全部真正执行（无 skip）。曾经它们被 `test.skip` 屏蔽过一轮，原因与结论
 * 记在这里，免得下次再误判：
 *
 * 症状：断言激活后，`node --test` 跑完全绿却永不退出。
 * 真因：**面板自己的 2 秒轮询计时器**（`src/client.js` 的 `POLL_INTERVAL_MS`）。
 *   最小实验（把全局 `setInterval`/`clearInterval` 换成记账版，跑完打印）：
 *     EVIDENCE created = 18 | still live = 8 | handles =（空）
 *   → 18 个计时器只清了 10 个；此刻进程里**没有任何 socket**，而显式清掉那 8 个
 *     之后进程立刻自己退出。所以与 tsx/esbuild 无关（那是上一轮的误判）。
 *   泄漏路径：用例里 `panel.dispose()` 之后再 `panel.render()` 取渲染树时，
 *   effect 被无条件重跑、新计时器没人清。已修两处：React 桩按依赖数组跳过重复
 *   effect；`dispose()` 清掉所有 effect 槽。
 * 防回归：文件末尾那条断言现在真的盯住「活计时器 = 0」，并额外断言
 *   `intervalsCreated > 0`，防止计数再次接错对象退化成恒真（上一轮就是栽在这里）。
 *
 * 为什么以前没有这个文件：它是给 DSH web shell 的
 * `window.__ModuleLoader__.load({ factory })` 直接加载的经典脚本，不经过 tsc、
 * 也没有打包器 —— 常规 import 拿不到它。而它正是 P0-4 的主要交付物：
 * 没有测试的话，「失败原因进正文」「信息位不减少」「无障碍不退」只能靠肉眼看。
 *
 * 加载方式（不需要 React 依赖）：脚本本体只把自己注册进
 * `window.__ModuleLoader__`，真正的代码在 factory 里。所以这里先塞一个假的
 * `window`，再把源文件读成字符串、用 `new Function` 执行一次（不走 require，
 * 也不进 tsx 的加载器），最后从 `spec.factory(require)` 里取 `apply`。
 *
 * 渲染方式：`apply` 里 `ctx.slots.inject` 的生成器会 yield 出真实的 slot 注册
 * （含业务面 `statusInjected` 与组件），本文件把它接住；然后用一套极小的
 * React 桩（useState / useEffect / createElement）直接调用组件函数，检查它返回
 * 的 element 树。桩的 `useEffect` 同步跑一次回调，于是组件里的轮询 `tick()`
 * 立刻发生，测试只需 await 一个宏任务再调用一次组件即可拿到真实渲染结果。
 * 注意 `createElement(TaskRow, props)` 只是描述：`renderHostTree` 会把函数组件
 * 真正展开，否则行内内容一行都不会执行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本文件所在目录（test/）；用来定位仓库里的 src/client.js。 */
function hereDir(): string {
  return dirname(fileURLToPath(import.meta.url))
}

/* ------------------------------ 极小的 React 桩 ------------------------------ */

/** 够本文件断言用的 ReactElement 形状。 */
interface FakeElement {
  type: unknown
  props: Record<string, unknown>
}

/**
 * 每次渲染里一个 effect 槽：记住依赖与清理函数，语义对齐 React。
 *
 * 为什么必须带依赖比较：面板的 effect 依赖 `[requestStatus, sessionId, sessionCwd]`，
 * 在一次用例里这些值不会变。t7 的桩**无条件**执行 effect，于是「settle 之后再渲染
 * 一次拿树」这种写法每写一次就多建一个 2 秒轮询计时器；那些计时器没人清理，
 * 子进程因此永不退出 —— 实测 11 条用例共创 18 个计时器、跑完还剩 8 个活着。
 */
interface EffectSlot {
  deps?: unknown[]
  cleanup?: () => void
}

/** 最小 hook 环境：状态槽 + effect 槽（effect 按 hook 序号存，稀疏也不怕）。 */
interface Rig {
  states: unknown[]
  effects: Map<number, EffectSlot>
}

/** 测试用的 React 桩：hook API 之外还带一个「新一次渲染开始」的标记。 */
interface ReactStub {
  markRender(): void
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): FakeElement
  useState(initial: unknown): [unknown, (next: unknown) => void]
  useEffect(fn: () => void | (() => void), deps?: unknown[]): void
  useMemo(fn: () => unknown): unknown
}

/** 本文件跑过的所有面板轮询计时器（仍然活着的会留在集合里）。 */
const liveIntervals = new Set<unknown>()
/** 一共创建过多少个；用来保证「收尾断言」不是恒真的空转。 */
let intervalsCreated = 0

/**
 * 把全局 `setInterval` / `clearInterval` 换成会记账的版本。
 *
 * 为什么必须挂在 **globalThis** 上：`src/client.js` 是浏览器经典脚本，里面写的是
 * 裸的 `setInterval(...)` / `clearInterval(timer)`，它们解析到全局 —— **不会**走
 * React 桩上的同名成员。t7 当时把计数包在桩里，于是 `liveIntervals` 永远是空集合，
 * 收尾断言恒真、放过了 8 个泄漏的计时器，把真凶误判成了「tsx/esbuild 的 IPC socket」
 * （实测那个时刻 `_getActiveHandles()` 是空的 —— 根本没有 socket）。
 *
 * 必须在 `src/client.js` 执行**之前**装好；凡是它建的计时器都会经过这两个函数。
 */
function installIntervalTracker(): void {
  const nativeSet = globalThis.setInterval
  const nativeClear = globalThis.clearInterval
  globalThis.setInterval = ((handler: () => void, ms?: number) => {
    const timer = nativeSet(handler, ms)
    liveIntervals.add(timer)
    intervalsCreated += 1
    return timer
  }) as typeof globalThis.setInterval
  globalThis.clearInterval = ((timer?: unknown) => {
    liveIntervals.delete(timer)
    nativeClear(timer as NodeJS.Timeout)
  }) as typeof globalThis.clearInterval
}

function createRig(): Rig {
  // effects 用 Map（不是数组）：hook 序号会因为 useMemo 这类不占槽的调用而出现空洞，
  // 数组遍历空洞会拿到 undefined，`dispose()` 一句 `slot.cleanup` 就崩 —— 崩了
  // 计时器就没人清，进程又不会退（这条踩过一次）。
  return { states: [], effects: new Map() }
}

/**
 * 真正的 React 桩。
 *
 * `useState` / `useEffect` 共用一个 **sequence** 索引，`markRender()` 把它归零 ——
 * 也就是「每次渲染都从 hook 0 数起」，这正是 React 的规则。
 *
 * 为什么需要显式标记而不是让桩自己判断「这是新一轮渲染」：靠 `sequence` 与
 * 已见 hook 数的比较会在**第二次调用**时就误判成新一轮（sequence=1、seen=1），
 * 于是第二个 hook 也拿到 index 0。这个 bug 的表现是「状态更新了、界面却对不上」，
 * 曾经让 8 个用例集体假红。真实 React 靠 begin-work 单元做这件事，测试里
 * 由调用方在每次渲染前显式声明，语义最直白。
 */
function makeReact(rig: Rig): ReactStub {
  let sequence = 0
  return {
    markRender() {
      sequence = 0
    },
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children } }
    },
    useState(initial) {
      const index = sequence
      sequence += 1
      if (index >= rig.states.length) {
        rig.states[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
      }
      const set = (next: unknown): void => {
        rig.states[index] =
          typeof next === 'function' ? (next as (prev: unknown) => unknown)(rig.states[index]) : next
      }
      return [rig.states[index], set]
    },
    useEffect(fn, deps) {
      const index = sequence
      sequence += 1
      const slot = rig.effects.get(index) ?? {}
      rig.effects.set(index, slot)
      const next = deps ? [...deps] : undefined
      // React 语义：没有依赖数组 => 每次渲染都跑；给了数组 => 浅比较相等就跳过。
      // 「跳过」正是这里的关键：否则 settle 之后的再一次渲染会重复建轮询计时器。
      const changed =
        next === undefined ||
        slot.deps === undefined ||
        next.length !== slot.deps.length ||
        next.some((dep, i) => !Object.is(dep, slot.deps?.[i]))
      if (!changed) return
      // 依赖变了 = 先卸载上一次（真实 React 会在重跑前调用上一次的清理函数）
      slot.cleanup?.()
      slot.deps = next
      const cleanup = fn()
      slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    },
    useMemo(fn) {
      return fn()
    },
  }
}

/* ------------------------- __ModuleLoader__ / slot 桩 ------------------------- */

interface CapturedSlot {
  inject: {
    requestStatus: (payload: unknown, signal?: AbortSignal) => Promise<unknown>
  }
  component: (props: Record<string, unknown>) => unknown
}

/** 翻译替身：字典键原样返回，`eta` 插值保留成 `eta:<值>` 便于断言。 */
function translator(): (key: string, vars?: Record<string, string>) => string {
  return (key, vars) => (vars && vars.eta ? `${key}:${vars.eta}` : key)
}

/** 会话快照替身：默认没有会话，与「未挂载主视图」的 shell 一致。 */
function sessionsOf(state?: { byId: Record<string, unknown> }) {
  return (selector: (s: unknown) => unknown) => selector(state)
}

function collectText(node: unknown, out: string[]): void {
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return
  }
  if (Array.isArray(node)) {
    // `visible.map(...)` 会作为**一个**子节点传进来（嵌套数组），必须展开，
    // 否则每行任务的文字都不会被看到。
    for (const child of node) collectText(child, out)
    return
  }
  if (!node || typeof node !== 'object') return
  const children = (node as FakeElement).props?.children
  if (!Array.isArray(children)) return
  for (const child of children) collectText(child, out)
}

function textOf(node: unknown): string {
  const out: string[] = []
  collectText(node, out)
  return out.join('|')
}

/**
 * 把元素树「渲染」成宿主元素树：递归调用函数组件（TaskRow 等），直到树上只剩
 * 宿主元素（type 是字符串）。
 *
 * 为什么必须这一步：`createElement(TaskRow, props)` 只是**描述**，TaskRow 的
 * 花括号里那些 createElement 一行都不会执行。测试若直接检查这棵树，看到的
 * 永远是空行 —— 这正是本文件最初 8 个用例假红的根因。
 *
 * @param node 组件返回的元素树
 * @param depth 展开上限；超过就抛错而不是静默返回半个树（那会变成假绿）
 */
function renderHostTree(node: unknown, depth = 32): unknown {
  if (depth <= 0) throw new Error('renderHostTree: 组件展开层数超限（疑似无限递归）')
  if (Array.isArray(node)) return node.map((child) => renderHostTree(child, depth - 1))
  if (!node || typeof node !== 'object') return node
  const el = node as FakeElement
  if (typeof el.type === 'function') {
    return renderHostTree(
      (el.type as (props: Record<string, unknown>) => unknown)(el.props),
      depth - 1,
    )
  }
  const children = el.props?.children
  return {
    type: el.type,
    props: {
      ...el.props,
      ...(Array.isArray(children)
        ? { children: children.map((child) => renderHostTree(child, depth - 1)) }
        : {}),
    },
  }
}

function findAll(
  node: unknown,
  pred: (el: FakeElement) => boolean,
  out: FakeElement[] = [],
): FakeElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, pred, out)
    return out
  }
  if (!node || typeof node !== 'object') return out
  const el = node as FakeElement
  if (typeof el.type === 'string' && pred(el)) out.push(el)
  const children = el.props?.children
  if (Array.isArray(children)) {
    for (const child of children) findAll(child, pred, out)
  }
  return out
}

/** 取出 src/client.js 通过 __ModuleLoader__ 注册的 spec（见文件头说明）。 */
function getSpec(): {
  id: string
  factory: (request: (name: string) => unknown) => Record<string, unknown>
} {
  assert.ok(loadedSpec, 'src/client.js 必须把 spec 交给 window.__ModuleLoader__.load')
  return loadedSpec as ReturnType<typeof getSpec>
}

/**
 * 加载一次 src/client.js，留下它注册的 spec。
 *
 * 为什么是「读源码 + new Function」而不是 require：`createRequire` 让 tsx 的
 * 加载器去处理这个 `.js`，实测会出现「10 个用例全绿、进程却再也不退出」
 * （beforeExit 不触发、连 unref 的计时器都不再跑），而 `--test` 会一直等那个
 * 子进程 —— 一个跑不完的测试文件等于把整条 CI 挂死。直接读文本执行绕开了
 * 加载器，只在全局补一个 `window.__ModuleLoader__`，正是脚本唯一需要的东西。
 *
 * 必须在模块顶层只做一次：脚本把自己注册进 `window`，第二次执行会覆盖同一份。
 */
let loadedSpec: unknown = null
{
  const g = globalThis as unknown as {
    window?: { __ModuleLoader__?: { load: (spec: unknown) => void } }
  }
  g.window = {
    __ModuleLoader__: {
      load(spec) {
        loadedSpec = spec
      },
    },
  }
  // 必须在 src/client.js 执行前装好：它建计时器时调的是全局 setInterval
  installIntervalTracker()
  const clientSource = readFileSync(join(hereDir(), '..', 'src', 'client.js'), 'utf-8')
  // eslint-disable-next-line no-new-func —— 经典脚本没有模块包装，只能这样执行
  new Function(clientSource)()
}

/** 一个测试用的面板装配：apply 一次、渲染一次、读结果。 */
interface Panel {
  rig: Rig
  /** 渲染面板并返回元素树（null 表示「按设计不显示」） */
  render: (sessionState?: { byId: Record<string, unknown> }) => unknown
  /** 读一次渲染产出的正文文本 */
  text: () => string
  /** 卸载（清理 interval，避免拖住测试进程） */
  dispose: () => void
}

/**
 * 装配面板。
 *
 * @param requestStatus 面板向 Host 取快照的替身
 */
function mountPanel(
  requestStatus: (payload: unknown, signal?: AbortSignal) => Promise<unknown>,
): Panel {
  const spec = getSpec()
  const rig = createRig()
  const react = makeReact(rig)
  const componentRef: { current: CapturedSlot['component'] | null } = { current: null }

  const mod = spec.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require: ${name}`)
  }) as { apply: (ctx: unknown) => void }

  const ctx = {
    locale: { register: () => () => undefined },
    slots: {
      inject: (_name: string, fn: () => Generator<unknown, void, unknown>) => {
        for (const step of fn()) {
          const registered = step as {
            options: { inject: () => CapturedSlot['inject'] }
            component: CapturedSlot['component']
          }
          void registered.options.inject()
          componentRef.current = registered.component
        }
        return () => undefined
      },
      register: (options: unknown, component: CapturedSlot['component']) => ({
        options,
        component,
      }),
    },
    effect: (fn: () => unknown) => {
      fn()
      return () => undefined
    },
    connection: { rpc: { call: () => Promise.resolve({ ok: true, value: { tasks: [] } }) } },
  }
  mod.apply(ctx)
  assert.ok(componentRef.current, 'apply 必须注册 overlay 组件')

  const render = (sessionState?: { byId: Record<string, unknown> }): unknown => {
    react.markRender()
    // `requestStatus` 是 slot 的业务面（statusInjected）注入进来的 **prop**，
    // 不是 hook：漏了它组件会 render 出一个「取数函数是 undefined」的世界，
    // 表现为永远不显示（测试里就是「状态更新了但树是 null」）。
    const element = componentRef.current!({
      requestStatus,
      useSessions: sessionsOf(sessionState),
      t: translator(),
    })
    // 展开函数组件（TaskRow 等）：不展开的话行内内容一行都不会执行
    return renderHostTree(element)
  }

  let last: unknown = null
  return {
    rig,
    render(sessionState) {
      last = render(sessionState)
      return last
    },
    text() {
      return textOf(last)
    },
    dispose() {
      // 卸载语义：每个 effect 槽的清理函数都要跑（面板的轮询计时器就在其中），
      // 否则 2 秒一次的 interval 会一直把测试进程拖住不让它退出。
      for (const slot of rig.effects.values()) {
        slot.cleanup?.()
        slot.cleanup = undefined
      }
    },
  }
}

/** 让轮询里那个 async tick 跑完（1 个宏任务足够：await requestStatus + setState）。 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10))
}

/** 一条面板任务快照；缺省字段按「正在下载」补齐。 */
function task(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 't1',
    name: 'file.bin',
    pct: 42,
    msg: '下载中',
    status: 'running',
    spd: '1.2MB/s',
    eta: '2m10s',
    updatedAt: Date.now(),
    ...over,
  }
}

/** 造一个「返回固定任务列表」的 requestStatus。 */
function serve(tasks: Array<Record<string, unknown>>): {
  request: (payload: unknown) => Promise<unknown>
  payloads: unknown[]
} {
  const payloads: unknown[] = []
  return {
    payloads,
    request: (payload) => {
      payloads.push(payload)
      return Promise.resolve({ ok: true, value: { tasks } })
    },
  }
}

/* ============================== 用例 ============================== */

test('面板：请求快照时带 limit=50（与服务端 MAX_STATUS_LIMIT 对齐）', async () => {
  const { request, payloads } = serve([task({ status: 'completed' })])
  const panel = mountPanel(request)
  panel.render()
  await settle()
  panel.dispose()
  assert.deepEqual(payloads[0], { limit: 50 }, '第一次取数必须立刻发生且 limit=50')
})

test('面板：有主会话时把 session 一起传上去', async () => {
  const { request, payloads } = serve([])
  const panel = mountPanel(request)
  const state = { byId: { s1: { id: 's1', cwd: 'C:\\work', retainedBy: { mainView: 1 } } } }
  panel.render(state)
  await settle()
  panel.dispose()
  assert.deepEqual(payloads[0], { limit: 50, session: { id: 's1', cwd: 'C:\\work' } })
})

test('面板：失败原因出现在正文，title 只留被截断的名字', async () => {
  const { request } = serve([
    task({
      status: 'failed',
      pct: 37,
      name: 'big.zip',
      msg: '失败: curl 退出码 22：HTTP 服务器返回错误码（如 404 / 403）',
    }),
  ])
  const panel = mountPanel(request)
  panel.render()
  await settle()
  panel.dispose()
  const root = panel.render()
  const text = textOf(root)
  assert.match(text, /curl 退出码 22/, '失败原因必须能在正文里读到')
  assert.match(text, /37%/, '百分比信息位保留')
  const titles = findAll(root, (el) => typeof el.props.title === 'string').map(
    (el) => el.props.title as string,
  )
  assert.deepEqual(titles, ['big.zip'], 'title 只记录名字本身，不重复正文里的原因')
})

test('面板：取消原因同样进正文', async () => {
  const { request } = serve([task({ status: 'cancelled', name: 'x.iso', msg: '已取消' })])
  const panel = mountPanel(request)
  panel.render()
  await settle()
  panel.dispose()
  assert.match(textOf(panel.render()), /已取消/)
})

test('面板：成功任务不显示「原因」行', async () => {
  const { request } = serve([task({ status: 'completed', pct: 100, msg: '下载完成' })])
  const panel = mountPanel(request)
  panel.render()
  await settle()
  panel.dispose()
  const text = textOf(panel.render())
  assert.match(text, /completed/, '终态标签仍在')
  assert.doesNotMatch(text, /下载完成/, '已完成的 msg 不是失败原因，不该顶进正文')
})

test('面板：msg 与行标签相同时不重复渲染一行', async () => {
  const { request } = serve([task({ status: 'failed', name: 'same.bin', msg: 'same.bin' })])
  const panel = mountPanel(request)
  panel.render()
  await settle()
  panel.dispose()
  const root = panel.render()
  const blocks = findAll(root, (el) => el.props?.style !== undefined).map((el) => textOf(el))
  assert.equal(blocks.filter((t) => t === 'same.bin').length, 1, '重复文案只应出现一次')
})

test('面板：失败行的进度条带 aria-valuetext，进行中不带原因', async () => {
  const { request } = serve([
    task({ id: 'a', status: 'failed', pct: 10, msg: '失败: 网络中断' }),
    task({ id: 'b', status: 'running', pct: 20 }),
  ])
  const panel = mountPanel(request)
  panel.render()
  await settle()
  panel.dispose()
  const bars = findAll(panel.render(), (el) => el.props.role === 'progressbar')
  assert.equal(bars.length, 2, '每行一条进度条')
  const failed = bars.find((el) => el.props['aria-valuenow'] === 10)
  assert.ok(failed)
  assert.match(String(failed.props['aria-valuetext']), /网络中断/)
  const running = bars.find((el) => el.props['aria-valuenow'] === 20)
  assert.ok(running)
  assert.equal(running.props['aria-valuetext'], '20%')
})

test('面板：四条既有信息位与无障碍属性全部保留', async () => {
  const { request } = serve([
    task({
      name: 'C:\\downloads\\very-big-archive-name-that-gets-trimmed-because-it-is-long.tar.gz',
      pct: 42,
      spd: '3.5MB/s',
      eta: '2m10s',
    }),
  ])
  const panel = mountPanel(request)
  panel.render()
  await settle()
  panel.dispose()
  const root = panel.render()
  const text = textOf(root)
  assert.match(text, /very-big-archive-name/)
  assert.match(text, /42%/)
  assert.match(text, /3\.5MB\/s/)
  assert.match(text, /eta:2m10s/)

  const bars = findAll(root, (el) => el.props.role === 'progressbar')
  assert.equal(bars.length, 1, 'role="progressbar" 必须保留')
  assert.equal(bars[0].props['aria-valuenow'], 42, 'aria-valuenow 必须保留')
  // style 是 unknown（props 是 Record<string, unknown>），断言前先收窄
  const fill = findAll(bars[0], (el) => (el.props?.style as { width?: string } | undefined)?.width === '42%')
  assert.equal(fill.length, 1, '进度条填充宽度仍按百分比计算')
})

test('面板：title 用完整名字（行内仍是截断的），没有任何标识时整个不挂', async () => {
  const longName = 'C:\\downloads\\very-big-archive-name-that-gets-trimmed-because-it-is-long.tar.gz'
  const { request } = serve([task({ name: longName })])
  const panel = mountPanel(request)
  panel.render()
  await settle()
  panel.dispose()
  const withTitle = findAll(panel.render(), (el) => typeof el.props.title === 'string')
  assert.equal(withTitle.length, 1, '有名字时应挂一个 title')
  assert.equal(withTitle[0].props.title, longName, 'title 必须是未截断的全名')
  assert.match(textOf(withTitle[0]), /…/, '行内仍然截断')

  // 没有任何标识（连 id 都没有）时不挂空 title：空字符串会让浏览器弹出空白气泡
  const bare = serve([task({ id: '', name: '', msg: '' })])
  const barePanel = mountPanel(bare.request)
  barePanel.render()
  await settle()
  barePanel.dispose()
  const emptyTitle = findAll(barePanel.render(), (el) => 'title' in el.props)
  assert.equal(emptyTitle.length, 0, '无标识的任务不该挂 title')
})

test('面板：apply 注册了 overlay 入口与字典（effect 标签不变）', () => {
  const labels: string[] = []
  const spec = getSpec()
  const rig = createRig()
  const react = makeReact(rig)
  let registeredId: string | null = null
  const mod = spec.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require: ${name}`)
  }) as { apply: (ctx: unknown) => void }
  mod.apply({
    locale: { register: () => () => undefined },
    slots: {
      inject: (_name: string, fn: () => Generator<unknown, void, unknown>) => {
        for (const step of fn()) {
          registeredId = (step as { options: { id: string } }).options.id
        }
        return () => undefined
      },
      register: (options: unknown, component: unknown) => ({ options, component }),
    },
    effect: (fn: () => unknown, label?: string) => {
      if (label) labels.push(label)
      fn()
      return () => undefined
    },
    connection: { rpc: { call: () => Promise.resolve({ ok: true }) } },
  })
  assert.equal(registeredId, 'smartdl.progress', 'overlay 条目 id 必须保持不变')
  assert.ok(labels.includes('dsh-smart-dl: shell.overlay progress pill'))
  assert.ok(labels.includes('dsh-smart-dl: dictionaries'))
})

/**
 * 收尾断言：本文件跑完之后，面板轮询计时器一个都不能还活着。
 *
 * 这条用例的来历（也是 t13 的根因）：先前 11 条用例全绿，进程却永远不退、
 * `node --test` 跟着挂死。当时把计数包在了 React 桩上，而 `src/client.js` 调的是
 * **全局** `setInterval` —— 桩上那两个成员是死代码，集合恒为空、断言恒真，
 * 于是真凶被误判成「tsx/esbuild 的 IPC socket」。
 *
 * 把计数改挂到 globalThis 之后，最小实验给出的证据是：
 *   EVIDENCE created = 18 | still live = 8 | handles =（空）
 * → 18 个计时器只清了 10 个，剩 8 个活着的 2 秒轮询；那一刻没有任何 socket，
 *   而显式 clearInterval 掉这 8 个之后进程立刻自己退出。
 * 泄漏路径：`panel.dispose()` 之后再 `panel.render()` 取渲染树时，effect 又被
 * 无条件执行一次，新计时器无人清理。修法两处：桩按依赖数组跳过重复 effect，
 * `dispose()` 清所有 effect 槽。
 *
 * `intervalsCreated > 0` 是防「空转假绿」的：如果哪天计数又接错了对象（比如接回
 * 桩上），集合同样为空、断言同样恒真 —— 这一条会立刻红。
 */
test('面板：收尾 —— 面板轮询计时器全部被 dispose 清掉', async () => {
  await settle()
  assert.ok(
    intervalsCreated > 0,
    '一个轮询计时器都没建过，说明计数没接在全局 setInterval 上（断言会退化成空转）',
  )
  assert.deepEqual(
    [...liveIntervals],
    [],
    '还有活着的轮询计时器，说明某个面板没有被 dispose',
  )
})
