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
interface ComponentRig {
  states: unknown[]
  effects: Map<number, EffectSlot>
}

/**
 * 测试用的 hook 环境，**按组件隔离**。
 *
 * 为什么必须隔离：面板（`shell.overlay`）与入口按钮（会话头部）是同一份
 * `src/client.js` 里的两个函数组件，它们共用 factory 里那一个 `react`；
 * 若 state/effect 槽仍按「一个数组」编号，两个组件的 hook 0/1 会互相覆盖
 * （表现成「点入口按钮改了面板的 state」这种假象），断言也就不可信了。
 * 真实 React 靠 fiber 的组件实例隔离，这里用 `components` 映射表达同一件事。
 */
interface Rig {
  components: Map<string, ComponentRig>
  active: ComponentRig
}

/** 测试用的 React 桩：hook API 之外还带一个「新一次渲染开始」的标记。 */
interface ReactStub {
  markRender(componentKey?: string): void
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): FakeElement
  useState(initial: unknown): [unknown, (next: unknown) => void]
  useEffect(fn: () => void | (() => void), deps?: unknown[]): void
  useMemo(fn: () => unknown): unknown
  /** 订阅式 store 的 `useEffect` 清理用不上，但组件可能传函数回来；保持签名宽松 */
  useRef(initial: unknown): { current: unknown }
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
  return { components: new Map(), active: { states: [], effects: new Map() } }
}

/** 取（必要时创建）某个组件的 hook 环境。 */
function componentRig(rig: Rig, key: string): ComponentRig {
  let found = rig.components.get(key)
  if (!found) {
    found = { states: [], effects: new Map() }
    rig.components.set(key, found)
  }
  return found
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
    markRender(componentKey) {
      sequence = 0
      rig.active = componentRig(rig, componentKey ?? 'default')
    },
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children } }
    },
    useState(initial) {
      const index = sequence
      sequence += 1
      const states = rig.active.states
      if (index >= states.length) {
        states[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
      }
      const set = (next: unknown): void => {
        states[index] =
          typeof next === 'function' ? (next as (prev: unknown) => unknown)(states[index]) : next
      }
      return [states[index], set]
    },
    useEffect(fn, deps) {
      const index = sequence
      sequence += 1
      const effects = rig.active.effects
      const slot = effects.get(index) ?? {}
      effects.set(index, slot)
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
    useRef(initial) {
      return { current: initial }
    },
  }
}

/* ------------------------- __ModuleLoader__ / slot 桩 ------------------------- */

interface CapturedSlot {
  slotName: string
  id: string
  inject: Record<string, unknown>
  component: (props: Record<string, unknown>) => unknown
}

/** 两个 slot 的 id（与 src/client.js 的常量一致；测试里显式写死，防止被悄悄改名）。 */
const OVERLAY_SLOT = 'shell.overlay'
/** t32：侧边栏入口（只画图标，按钮由侧边栏渲染）。 */
const SIDEBAR_SLOT = 'sidebar.panellist'
/** t32：占满主区的下载管理页面。 */
const MAIN_SLOT = 'main'

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
  /** 渲染面板（overlay）并返回元素树（null 表示「按设计不显示」） */
  render: (sessionState?: { byId: Record<string, unknown> }) => unknown
  /** 读一次面板渲染产出的正文文本 */
  text: () => string
  /**
   * 渲染侧边栏入口（t32 之后它只是一个 SVG 图标：按钮、点击、aria、选中态
   * 全部由侧边栏自己渲染，我们只提供图标）。
   */
  renderEntry: () => { tree: unknown; text: string; svg: FakeElement | undefined }
  /**
   * t32 改写（原为 `clickEntry`）：侧边栏入口不再有自己的 onClick，「打开」
   * 由侧边栏调 `ctx.layout.selectPanel(id)` 完成。这里等价地驱动共享 store，
   * 并记一次 selectPanel 调用（开合契约的观测点）。
   */
  openManager: () => unknown
  /** 渲染 main 下载管理页面 */
  renderManager: () => unknown
  /** main slot 本身：供 mountWithManage 在渲染前替换注入面上的 manage */
  __mainSlot: { inject: Record<string, unknown> }
  /** main 页面注入面上的 manage（Host 调用替身） */
  manage: (body: Record<string, unknown>) => Promise<unknown>
  /** main 页面注入面上的 reveal（文件管理器调用替身） */
  reveal: (outPath: string) => Promise<unknown>
  /** 记录 selectPanel 的调用序列（开合断言用） */
  panelCalls: Array<string | null>
  /** 点击面板上的 × 关闭按钮（调它的 onClick），返回点击后重新渲染的面板树 */
  clickClose: () => unknown
  /** 直接往共享 store 里灌一份快照（等价于面板轮询拿到新数据） */
  publish: (tasks: Array<Record<string, unknown>>) => void
  /** 直接往共享 store 里灌一条 inspect 判定（管理器用例用） */
  setPresence: (id: string, verdict: Record<string, unknown>) => void
  /** 卸载（清理 interval，避免拖住测试进程） */
  dispose: () => void
}

/**
 * 装配面板、侧边栏入口与 main 页面。
 *
 * t32 改写说明（原注释写的是「装配面板与入口按钮」，只接 overlay 与会话头部）：
 * 会话头部入口按用户要求移除，改成 **`sidebar.panellist`（入口）+ `main`（页面）**。
 * 三个 slot 都要接住，它们的 `inject` 都会**真跑一次**（业务面在那里构造），
 * 组件拿到的是同一份注入对象 + 框架 prop。
 *
 * 桩的 `inject` 同时接受 generator 与非 generator 两种形态：侧边栏按官方惯例
 * 用 `inject(slot, () => register(...))`（单个 registration），其余两个是
 * `function* () { yield register(...) }`。
 *
 * @param requestStatus 面板向 Host 取快照的替身
 */
function mountPanel(
  requestStatus: (payload: unknown, signal?: AbortSignal) => Promise<unknown>,
): Panel {
  const spec = getSpec()
  const rig = createRig()
  const react = makeReact(rig)
  const slots = new Map<string, CapturedSlot>()
  const pluginCleanups: Array<() => void> = []

  const mod = spec.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require: ${name}`)
  }) as { apply: (ctx: unknown) => void }

  const ctx = {
    locale: { register: () => () => undefined },
    slots: {
      inject: (slotName: string, fn: () => Generator<unknown, void, unknown> | unknown) => {
        const produced = fn() as Generator<unknown, void, unknown>
        const steps: unknown[] =
          produced && typeof (produced as Generator)[Symbol.iterator] === 'function'
            ? [...(produced as Generator<unknown, void, unknown>)]
            : [produced]
        for (const step of steps) {
          const registered = step as {
            options: { name: string; id: string; inject?: () => Record<string, unknown> }
            component: CapturedSlot['component']
          }
          // 业务面必须真的构造一次：漏跑它，组件拿到的是「取数函数是 undefined」
          // 的世界，表现为永远不显示（测试里就是「状态更新了但树是 null」）。
          const injected = registered.options.inject ? registered.options.inject() : {}
          slots.set(registered.options.name, {
            slotName: slotName,
            id: registered.options.id,
            inject: injected,
            component: registered.component,
          })
        }
        return () => undefined
      },
      register: (options: unknown, component: CapturedSlot['component']) => ({
        options,
        component,
      }),
    },
    effect: (fn: () => unknown) => {
      const cleanup = fn()
      // 插件级 effect 的清理函数要留着：`dispose()` 时跑一遍，等价于「插件被停用」。
      // 提示音的待响计时器就在其中（不跑的话那一声会留在测试进程里）。
      if (typeof cleanup === 'function') pluginCleanups.push(cleanup as () => void)
      return () => undefined
    },
    connection: { rpc: { call: () => Promise.resolve({ ok: true, value: { tasks: [] } }) } },
    remote: { session: { openWorkspacePath: () => Promise.resolve({ ok: true }) } },
    layout: { selectPanel: () => undefined },
  }
  mod.apply(ctx)
  assert.ok(slots.has(OVERLAY_SLOT), 'apply 必须注册 shell.overlay 面板')
  assert.ok(slots.has(SIDEBAR_SLOT), 'apply 必须注册 sidebar.panellist 入口')
  assert.ok(slots.has(MAIN_SLOT), 'apply 必须注册 main 下载管理页面')

  const renderSlot = (
    slotName: string,
    sessionState?: { byId: Record<string, unknown> },
  ): unknown => {
    const slot = slots.get(slotName)
    assert.ok(slot, `slot 未注册：${slotName}`)
    // 每个 slot 用**自己的** hook 环境：两个组件共用一份 state 槽会互相覆盖。
    react.markRender(slotName)
    const element = slot.component({
      ...slot.inject,
      // requestStatus 面板自己会覆盖（下面的 render 里注入替身），入口按钮不需要它
      useSessions: sessionsOf(sessionState),
      t: translator(),
    })
    // 展开函数组件（TaskRow 等）：不展开的话行内内容一行都不会执行
    return renderHostTree(element)
  }

  const renderPanel = (sessionState?: { byId: Record<string, unknown> }): unknown => {
    const slot = slots.get(OVERLAY_SLOT)
    assert.ok(slot)
    react.markRender(OVERLAY_SLOT)
    const element = slot.component({
      ...slot.inject,
      requestStatus: requestStatus,
      useSessions: sessionsOf(sessionState),
      t: translator(),
    })
    return renderHostTree(element)
  }

  const store = (slots.get(OVERLAY_SLOT) as CapturedSlot).inject.panelStore as {
    publish: (tasks: Array<Record<string, unknown>>) => void
    open: () => void
    close: () => void
    setPresence: (id: string, verdict: Record<string, unknown>) => void
    clearPresence: (id: string) => void
  }

  let last: unknown = null
  /** 记录 main 页面拿到的注入面（manage / reveal / onClose），供管理器用例断言。 */
  const mainInject = (slots.get(MAIN_SLOT) as CapturedSlot).inject as {
    manage: (body: Record<string, unknown>) => Promise<unknown>
    reveal: (outPath: string) => Promise<unknown>
    onClose: () => void
  }
  /** 记录 layout.selectPanel 的调用（开合契约的观测点）。 */
  const panelCalls: Array<string | null> = []

  /** 渲染 main 下载管理页面。 */
  const renderManager = (): unknown => {
    const slot = slots.get(MAIN_SLOT)
    assert.ok(slot, 'main 页面必须已注册')
    react.markRender(MAIN_SLOT)
    // manage / reveal / onClose 每次都从 `slot.inject` 现取：用例要在渲染前替换
    // manage（页面的 inspectAll 在挂载时跑，替换晚一步就打在默认桩上）。
    const element = slot.component({
      ...slot.inject,
      onClose: () => panelCalls.push(null),
      t: translator(),
    })
    return renderHostTree(element)
  }

  return {
    rig,
    render(sessionState) {
      last = renderPanel(sessionState)
      return last
    },
    text() {
      return textOf(last)
    },
    /**
     * 渲染侧边栏入口（t32 之后它只是一个图标：按钮由侧边栏自己渲染）。
     * 返回元素树与 svg 元素。
     */
    renderEntry() {
      const tree = renderSlot(SIDEBAR_SLOT)
      const svg = findAll(tree, (el) => el.type === 'svg')[0]
      return { tree, text: textOf(tree), svg }
    },
    /**
     * 打开管理器：等价于「侧边栏按钮被点」—— 侧边栏自己调 selectPanel(id)，
     * 我们这里直接驱动共享 store 的 open()，并记录一次 selectPanel 调用。
     */
    openManager() {
      panelCalls.push('smartdl.downloads')
      store.open()
      return renderManager()
    },
    /** 渲染 main 下载管理页面（不记 selectPanel 调用）。 */
    renderManager,
    /**
     * main slot 本身（供 `mountWithManage` 在渲染前替换注入面上的 manage）。
     * 暴露它是为了让「替换」发生在 `renderManager()` 之前 —— 页面的 inspectAll
     * 在挂载时跑，晚一步替换就打在了默认桩上。
     */
    __mainSlot: slots.get(MAIN_SLOT) as CapturedSlot,
    /** main 页面注入面上的 manage（默认桩） */
    manage: mainInject.manage,
    reveal: mainInject.reveal,
    panelCalls,
    clickClose() {
      const tree = renderPanel()
      const close = findAll(tree, (el) => el.props?.['data-dsh-smart-dl'] === 'close')[0]
      assert.ok(close, '打开的面板必须有一个关闭控件')
      const onClick = close.props.onClick as (() => void) | undefined
      assert.equal(typeof onClick, 'function', '关闭控件必须可点')
      onClick?.()
      return renderPanel()
    },
    publish(tasks) {
      store.publish(tasks)
    },
    setPresence(id, verdict) {
      store.setPresence(id, verdict)
    },
    dispose() {
      // 卸载语义：**所有组件**的 effect 槽清理函数都要跑（面板的轮询计时器就在其中），
      // 否则 2 秒一次的 interval 会一直把测试进程拖住不让它退出。
      for (const component of rig.components.values()) {
        for (const slot of component.effects.values()) {
          slot.cleanup?.()
          slot.cleanup = undefined
        }
      }
      // 再跑插件级 effect 的清理（音频解锁监听 + 待响提示音）。
      for (const cleanup of pluginCleanups.splice(0)) cleanup()
    },
  }
}

/* ------------------------- 音频 / localStorage / 定时器桩（t28） ------------------------- */

/** 一次 `osc.start()` + `osc.stop()` 排出来的音。 */
interface ScheduledNote {
  wave: string
  freq: number
  start: number
  end: number
}

/** AudioContext 桩的记账。 */
interface FakeAudio {
  /** 创建过几个 AudioContext（自动播放策略要求复用，不是每次播放新建） */
  contexts: number
  resumes: number
  /** 排出来的音符（按上下文累计） */
  notes: ScheduledNote[]
}

interface FakePageOptions {
  /** 不给 AudioContext（老浏览器）：播放必须静默退化。 */
  withoutAudio?: boolean
  /** `resume()` 返回被拒绝的 promise（模拟自动播放策略拒绝）。 */
  resumeRejects?: boolean
  /** 预置 localStorage 内容（模拟「上次的选择被记住了」）。 */
  stored?: Record<string, string>
  /** 不给 localStorage（隐私模式） */
  withoutStorage?: boolean
}

interface FakePage {
  audio: FakeAudio
  storage: Map<string, string>
  /** 记录到的 addEventListener 调用（断言 capture/once）。 */
  listeners: Array<{ type: string; options: unknown }>
  /** 触发一次「首次用户交互」。 */
  gesture: () => void
  restore: () => void
}

/**
 * 给测试用的全局 `window` 补上音频/存储/事件三件套。
 *
 * `src/client.js` 的 apply 只碰这三个（AudioContext、localStorage、
 * pointerdown/keydown），所以桩只补这些；`__ModuleLoader__` 原样保留。
 * 必须在 `mountPanel()` **之前**装好：store 创建时就读 localStorage。
 */
function installFakePage(options: FakePageOptions = {}): FakePage {
  const win = (globalThis as unknown as { window: Record<string, unknown> }).window
  const audio: FakeAudio = { contexts: 0, resumes: 0, notes: [] }
  const storage = new Map<string, string>(Object.entries(options.stored ?? {}))
  const listeners: FakePage['listeners'] = []
  const handlers = new Map<string, (event?: unknown) => void>()
  const had = new Map<string, unknown>()
  for (const key of ['AudioContext', 'localStorage', 'addEventListener', 'removeEventListener']) {
    had.set(key, win[key])
  }

  if (!options.withoutAudio) {
    class AudioContextStub {
      state = 'suspended'
      currentTime = 0
      destination = { name: 'destination' }
      constructor() {
        audio.contexts += 1
      }
      resume(): Promise<void> {
        audio.resumes += 1
        if (options.resumeRejects) return Promise.reject(new Error('NotAllowedError'))
        this.state = 'running'
        return Promise.resolve()
      }
      createGain(): Record<string, unknown> {
        return {
          gain: {
            setValueAtTime: () => undefined,
            linearRampToValueAtTime: () => undefined,
            exponentialRampToValueAtTime: () => undefined,
          },
          connect: () => undefined,
        }
      }
      createOscillator(): Record<string, unknown> {
        const osc: Record<string, unknown> = {
          type: 'sine',
          frequency: { setValueAtTime: (freq: number) => (osc.freq = freq) },
          freq: 0,
          start: (at: number) => (osc.startedAt = at),
          stop: (at: number) =>
            audio.notes.push({
              wave: String(osc.type),
              freq: Number(osc.freq),
              start: Number(osc.startedAt),
              end: at,
            }),
          connect: () => undefined,
        }
        return osc
      }
    }
    win.AudioContext = AudioContextStub
    win.webkitAudioContext = undefined
  } else {
    win.AudioContext = undefined
    win.webkitAudioContext = undefined
  }

  if (!options.withoutStorage) {
    win.localStorage = {
      getItem: (key: string) => (storage.has(key) ? (storage.get(key) as string) : null),
      setItem: (key: string, value: string) => void storage.set(key, String(value)),
      removeItem: (key: string) => void storage.delete(key),
    }
  } else {
    win.localStorage = undefined
  }
  win.addEventListener = (type: string, handler: (event?: unknown) => void, opts: unknown) => {
    listeners.push({ type, options: opts })
    handlers.set(type, handler)
  }
  win.removeEventListener = (type: string) => {
    handlers.delete(type)
  }

  return {
    audio,
    storage,
    listeners,
    gesture() {
      // capture + once：真实浏览器里一次交互后 handlers 会被摘掉，这里同样处理。
      for (const [type, handler] of [...handlers]) {
        handler({ type })
        handlers.delete(type)
      }
    },
    restore() {
      for (const [key, value] of had) {
        if (value === undefined) delete win[key]
        else win[key] = value
      }
    },
  }
}

interface FakeTimers {
  pending: Array<{ fn: () => void; delay: number }>
  /** 触发所有待跑的 setTimeout（合流窗口到期）。 */
  fireAll: () => void
  restore: () => void
}

/**
 * 只截 `setTimeout`（`setInterval` 留给真实实现）。
 *
 * 为什么必须截：合流窗口是「1 秒后响」，真等一秒会让每条音频断言都变慢；而
 * `clearTimeout` 也要一起截，否则「卸载时清掉待响的一声」没法断言。
 * 注意本文件里 `settle()`（10ms）与真实轮询等待（2200ms）用的也是 setTimeout ——
 * 所以装了假计时器的用例**不能再 await settle/真实等待**，数据要走 `publish()`。
 */
function installFakeTimers(): FakeTimers {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const pending: FakeTimers['pending'] = []
  const cancelled = new Set<number>()

  globalThis.setTimeout = ((fn: () => void, delay?: number) => {
    pending.push({ fn, delay: Number(delay ?? 0) })
    return pending.length as unknown as NodeJS.Timeout
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((handle: unknown) => {
    cancelled.add(Number(handle))
  }) as unknown as typeof clearTimeout

  return {
    pending,
    fireAll() {
      const due = [...pending]
      pending.length = 0
      due.forEach((entry, index) => {
        if (!cancelled.has(index + 1)) entry.fn()
      })
    },
    restore() {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
    },
  }
}

/** 让轮询里那个 async tick 跑完（1 个宏任务足够：await requestStatus + setState）。 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10))
}

/**
 * 等一次真实轮询计时器跳（POLL_INTERVAL_MS = 2000）。
 *
 * 用它而不是直接调 store.publish 的地方，要的就是「定时器真的会驱动可见性变化」
 * 这条链路：只灌数据不跳表，等于把被测的那根导线短路掉。
 */
const POLL_WAIT_MS = 2200

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

/**
 * t32 改写说明（原用例名为「apply 注册了 overlay 面板 + 会话头部入口 + 字典」）：
 *
 * 改什么、为什么：
 * 1. **桩的 `inject` 现在同时接受 generator 与非 generator 两种形态。**
 *    侧边栏入口按 `dsh-client-ui-sidebar` 的惯例用 `inject(slot, () => register(...))`
 *    （返回单个 registration，不是 generator；官方插件管理器就是这么写的），
 *    而 `main` / `shell.overlay` 仍是 `function* () { yield register(...) }`。
 *    原桩只会 `for (const step of fn())`，遇到前者直接抛 TypeError。
 *    这不是放宽断言 —— 下面照旧逐条断言「注册了哪几个 slot、哪个 id」。
 * 2. **期望的 slot 集合从「overlay + 会话头部」改成「overlay + main + sidebar」。**
 *    会话头部入口（`smartdl.progress-entry`）按用户明确要求**移除**（那个位置不对），
 *    它的职能由侧边栏入口 + main 全局面板接替。断言改成**正向**列出新集合，
 *    并额外断言头部 slot 不再出现（防止以后有人把它加回来）。
 */
test('面板：apply 注册了 overlay 面板 + main 页面 + 侧边栏入口 + 字典（会话头部入口已移除）', () => {
  const labels: string[] = []
  const spec = getSpec()
  const rig = createRig()
  const react = makeReact(rig)
  const registered: Array<{ name: string; id?: string; key?: string }> = []
  const mod = spec.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require: ${name}`)
  }) as { apply: (ctx: unknown) => void }
  mod.apply({
    locale: { register: () => () => undefined },
    slots: {
      inject: (_name: string, fn: () => Generator<unknown, void, unknown> | unknown) => {
        // 两种形态都走同一条归集路径：generator 逐个 yield，非 generator 直接就是
        // 那一个 registration。
        const produced = fn() as Generator<unknown, void, unknown>
        const steps: unknown[] =
          produced && typeof (produced as Generator)[Symbol.iterator] === 'function'
            ? [...(produced as Generator<unknown, void, unknown>)]
            : [produced]
        for (const step of steps) {
          const options = (step as { options: { name: string; id?: string; key?: string } }).options
          registered.push({ name: options.name, id: options.id, key: options.key })
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
    remote: { session: { openWorkspacePath: () => Promise.resolve({ ok: true }) } },
    layout: { selectPanel: () => undefined },
  })

  // 三个 slot 都要在：浮层（只播报）、main 页面（管理器）、侧边栏入口。
  assert.deepEqual(
    registered.map((r) => `${r.name}#${r.id ?? r.key ?? ''}`),
    [
      'shell.overlay#smartdl.progress',
      'main#smartdl.downloads',
      'sidebar.panellist#smartdl.downloads',
    ],
    'overlay 条目 id 必须保持不变；管理器走 main keyed slot；入口走侧边栏',
  )
  // main 的 key 必须与侧边栏入口的 id 相同 —— 这是「点入口能选中这个面板」的前提
  // （dsh-client-ui-layout：selectPanel(key)，key 不存在会抛错并保留当前面板）。
  const main = registered.find((r) => r.name === 'main')
  const sidebar = registered.find((r) => r.name === 'sidebar.panellist')
  assert.ok(main && sidebar, 'main 与 sidebar.panellist 都必须注册')
  assert.equal(main.key, sidebar.id, 'main 的 key 必须与侧边栏入口的 id 相同')
  // 会话头部入口必须已经不在（用户明确说那个位置不对）
  assert.equal(
    registered.some((r) => r.name === 'conversation.session.header.actions'),
    false,
    '会话头部入口必须已移除',
  )
  assert.equal(
    registered.some((r) => r.id === 'smartdl.progress-entry'),
    false,
    'progress-entry 这个 id 不应再出现',
  )
  assert.ok(labels.includes('dsh-smart-dl: shell.overlay progress pill'))
  assert.ok(labels.includes('dsh-smart-dl: main downloads page'))
  assert.ok(labels.includes('dsh-smart-dl: sidebar downloads entry'))
  assert.ok(labels.includes('dsh-smart-dl: dictionaries'))
  assert.equal(
    labels.includes('dsh-smart-dl: session header entry'),
    false,
    '会话头部入口的 effect 标签必须一并消失',
  )
})

/* ==================== t26：固定入口 / 完整历史 / 主动关闭 / 5 秒消失 ==================== */

/**
 * t32 改写说明（原用例名「入口：会话头部按钮可点、带 aria-label，打开后面板是
 * dialog 且空列表给空态」）：
 *
 * 改什么、为什么：
 * - **入口从「会话头部按钮」改为「侧边栏图标」**：用户明确说头部那个位置不对。
 *   侧边栏按官方约定自己渲染按钮（点击 / aria / 选中态都在它那儿，见
 *   `dsh-client-ui-sidebar/lib/client.js:173-199`），我们只提供图标 ——
 *   所以断言从「button + onClick + aria-label + aria-expanded」改成
 *   「svg 图标存在、aria-hidden、跟随 size 绘制」。这不是删断言，是把断言
 *   移到**我们真正负责的那一层**。
 * - **「打开」的观测点从「点入口按钮」改为「selectPanel(id)」**：开合契约是
 *   `ctx.layout.selectPanel(PANEL_ID)`（方案 §1.4），这是本次改造的正面契约，
 *   必须被断言。
 * - overlay 浮层的 dialog / 空态 / × 三条断言**原样保留**（浮层职责不变）。
 */
test('入口：侧边栏只提供图标（按钮由侧边栏渲染），打开走 selectPanel(id)，浮层仍是 dialog', async () => {
  const { request } = serve([])
  const panel = mountPanel(request)
  try {
    panel.render()
    await settle()

    const entry = panel.renderEntry()
    assert.ok(entry.svg, '侧边栏入口必须渲染一个图标元素')
    assert.equal(entry.svg.type, 'svg')
    assert.equal(entry.svg.props['aria-hidden'], true, '图标必须对读屏隐藏（按钮的可读名由侧边栏给）')
    assert.equal(entry.svg.props.width, 18, '未指定 size 时用默认尺寸')
    // 我们**不**自己写 onClick：写了也是死代码（侧边栏不调它）
    assert.equal(entry.svg.props.onClick, undefined, '入口图标不应自带 onClick（那是侧边栏的职责）')

    assert.equal(panel.render(), null, '没有任务时自动层不该显示')

    panel.openManager()
    assert.deepEqual(panel.panelCalls, ['smartdl.downloads'], '打开必须走 selectPanel(PANEL_ID)')
    const root = panel.render()
    assert.ok(root, '打开状态下面板必须持续渲染')
    const dialogs = findAll(root, (el) => el.props.role === 'dialog')
    assert.equal(dialogs.length, 1, '用户主动打开的面板在无障碍语义上是 dialog')
    assert.equal(dialogs[0].props['aria-label'], 'title', 'dialog 必须带可读标签')
    assert.match(textOf(root), /empty/, '没有任何任务时给出空态文案，而不是空白面板')
    // × 关闭控件本身也要有可读标签（不依赖 title 悬停）
    const close = findAll(root, (el) => el.props?.['data-dsh-smart-dl'] === 'close')
    assert.equal(close.length, 1, '打开的面板必须有且只有一个关闭控件')
    assert.equal(close[0].props['aria-label'], 'close', '关闭控件必须有 aria-label')
  } finally {
    panel.dispose()
  }
})

/**
 * t32 改写说明（原用例名「入口：打开后列出已完成的历史任务（超出回执期也看得到）」）：
 * 「打开」的驱动从 `clickEntry()` 换成 `openManager()`（等价于侧边栏按钮被点），
 * 其余断言（历史文件名可见 / 终态标签 / 非空态 / progressbar 语义）**逐条保留** ——
 * 这条本来是 t26 为「入口要能看到完整历史」立的，现在历史改由 main 页面承担，
 * 浮层这条仍然成立（它自己也走 panelRows）。
 */
test('入口：打开后列出已完成的历史任务（超出回执期也看得到）', async () => {
  const longAgo = Date.now() - 10 * 60 * 1000
  const { request } = serve([
    task({ id: 'h1', name: 'old.iso', status: 'completed', pct: 100, msg: '下载完成', updatedAt: longAgo }),
  ])
  const panel = mountPanel(request)
  try {
    panel.render()
    await settle()

    assert.equal(panel.render(), null, '终态早就超过回执期，自动层必须已经不显示')

    panel.openManager()
    const root = panel.render()
    assert.ok(root, '打开后必须显示完整历史')
    const text = textOf(root)
    assert.match(text, /old\.iso/, '历史任务的文件名必须可见')
    assert.match(text, /completed/, '终态标签必须可见')
    assert.doesNotMatch(text, /empty/, '有历史时不该显示空态')
    assert.equal(
      findAll(root, (el) => el.props.role === 'progressbar').length,
      1,
      '打开态下既有进度条语义（role=progressbar）不得丢失',
    )
  } finally {
    panel.dispose()
  }
})

test('关闭：× 关掉后不会被轮询弹回（同一批任务），新任务才回来', async () => {
  const live = [task({ id: 'r1', name: 'running.bin', status: 'running', updatedAt: Date.now() })]
  const { request } = serve(live)
  const panel = mountPanel(request)
  try {
    panel.render()
    await settle()
    assert.ok(panel.render(), '进行中必须自动出现')

    // × 关闭：同时压住自动层，否则下一轮轮询会立刻把它弹回来（那按钮等于没用）
    assert.equal(panel.clickClose(), null, '× 关闭后必须立刻消失')
    panel.publish(live)
    assert.equal(panel.render(), null, '同一批任务不得把面板弹回来')

    // ② t32 改写：原来这里断言「再次点入口能打开」（入口按钮有自己的 onClick）。
    //    现在入口是侧边栏图标，开合由 selectPanel 承担，浮层的重开语义改为
    //    「新任务 id 出现时自动层重新武装」—— 这正是 t26 立的同一条不变量。
    panel.publish([
      ...live,
      task({ id: 'r2', name: 'second.bin', status: 'running', updatedAt: Date.now() }),
    ])
    assert.ok(panel.render(), '出现新任务后自动层必须重新显示')
  } finally {
    panel.dispose()
  }
})

/**
 * PANEL-R1（t27 审查留下的 low）：上面那条关闭用例用 `store.publish()` 直灌数据，
 * 把 2 秒轮询那根导线**短路**了；审查者的独立探针证明风险真实存在（删掉
 * `autoHidden = true` 后，真实轮询确实会把面板弹回来），但仓库里没有断言守它。
 * 这条把它固化：不调 publish，让真计时器自己跳两轮。
 */
test('关闭：× 关掉后，真实的 2 秒轮询不会把面板弹回（走真计时器，不直灌 store）', async () => {
  const live = [task({ id: 'r1', name: 'running.bin', status: 'running', updatedAt: Date.now() })]
  const { request, payloads } = serve(live)
  const panel = mountPanel(request)
  try {
    panel.render() // 挂载 → effect 里 tick() 立刻跑一次（真实 requestStatus）
    await settle()
    assert.ok(panel.render(), '进行中必须自动出现')
    const callsAfterMount = payloads.length
    assert.ok(callsAfterMount >= 1, '首次 tick 必须已经问过 Host')

    panel.clickClose()
    assert.equal(panel.render(), null, '× 关闭后必须立刻消失')

    // 真实 2 秒计时器跳两轮：每一轮都会把同一批 running 任务重新灌进 store
    await new Promise((resolve) => setTimeout(resolve, POLL_WAIT_MS))
    assert.ok(
      payloads.length > callsAfterMount,
      '轮询必须仍在跑（RPC 调用次数还在增长，否则这条用例只是「没数据所以没显示」）',
    )
    const callsAfterFirstTick = payloads.length
    await new Promise((resolve) => setTimeout(resolve, POLL_WAIT_MS))
    assert.ok(payloads.length > callsAfterFirstTick, '第二轮 tick 也必须真的发生')
    assert.equal(panel.render(), null, '真实轮询不得把关掉的面板弹回来')
  } finally {
    panel.dispose()
  }
})

test('自动消失：全部任务终态后 5 秒自动层消失（走真实轮询计时器，注入时钟）', async () => {
  const realNow = Date.now
  const base = realNow()
  const done = [
    task({ id: 'd1', name: 'done.bin', status: 'completed', pct: 100, updatedAt: base - 1000 }),
  ]
  const { request } = serve(done)
  const panel = mountPanel(request)
  try {
    Date.now = () => base
    panel.render()
    await settle()
    assert.ok(panel.render(), '刚结束 1 秒时必须还显示（旧行为 30 秒，本轮改成 5 秒）')

    // 时钟前进到「结束后 6 秒」，等真实轮询计时器（2 秒一跳）跑一次
    Date.now = () => base + 6000
    await new Promise((resolve) => setTimeout(resolve, POLL_WAIT_MS))
    assert.equal(panel.render(), null, '全部终态 5 秒后自动层必须消失')
  } finally {
    Date.now = realNow
    panel.dispose()
  }
})

/* ==================== t28：提示音（合成 / 去重 / 合流 / 静音开关） ==================== */

/**
 * 声音相关的公共装配：装桩 → apply → 手势解锁 → 首屏播种。
 *
 * `first` 是**页面加载后的第一份快照**（默认空）。刷新场景要专门传历史任务进来：
 * 那一份快照里的终态一条都不该响，所以它必须是「第一份」。
 */
function mountSoundPanel(
  options: FakePageOptions & { first?: Array<Record<string, unknown>> } = {},
) {
  const timers = installFakeTimers()
  const page = installFakePage(options)
  const { request } = serve([])
  const panel = mountPanel(request)
  page.gesture() // 用户交互过：音频上下文已解锁
  panel.publish(options.first ?? []) // 首屏
  return { panel, page, timers }
}

test('提示音：成功与失败是两段不同的音（音高走向与波形都不同）', () => {
  const { panel, page, timers } = mountSoundPanel()
  try {
    panel.publish([task({ id: 'ok1', status: 'running' })])
    panel.publish([task({ id: 'ok1', status: 'completed', msg: '下载完成' })])
    timers.fireAll()
    assert.equal(page.audio.notes.length, 2, '成功音是两个音（上行两音）')
    const ok = page.audio.notes.map((n) => ({ wave: n.wave, freq: n.freq }))
    assert.deepEqual(ok, [
      { wave: 'sine', freq: 659.25 },
      { wave: 'sine', freq: 987.77 },
    ], '成功音：正弦 + 上行 E5→B5')

    panel.publish([
      task({ id: 'ok1', status: 'completed', msg: '下载完成' }),
      task({ id: 'bad1', status: 'failed', msg: '失败: 网络中断' }),
    ])
    timers.fireAll()
    const after = page.audio.notes.slice(2)
    assert.equal(after.length, 2, '失败音也是两个音')
    assert.deepEqual(after.map((n) => ({ wave: n.wave, freq: n.freq })), [
      { wave: 'triangle', freq: 392 },
      { wave: 'triangle', freq: 261.63 },
    ], '失败音：三角波 + 下行 G4→C4')
    assert.notDeepEqual(
      after.map((n) => n.freq),
      ok.map((n) => n.freq),
      '两种音必须在音高上就能分辨',
    )
  } finally {
    panel.dispose()
    timers.restore()
    page.restore()
  }
})

test('提示音：同一任务被反复轮询只响一次（id + 终态去重）', () => {
  const { panel, page, timers } = mountSoundPanel()
  try {
    const done = [task({ id: 'same', status: 'completed', msg: '下载完成' })]
    panel.publish(done)
    timers.fireAll()
    assert.equal(page.audio.notes.length, 2, '第一次进终态要响')

    // 2 秒轮询会把同一份快照一遍遍送进来：一次都不该再响
    for (let i = 0; i < 3; i += 1) panel.publish(done)
    timers.fireAll()
    assert.equal(page.audio.notes.length, 2, '同一任务重复轮询必须只响一次')
  } finally {
    panel.dispose()
    timers.restore()
    page.restore()
  }
})

test('提示音：1 秒窗口内多条完成只响一次，且失败优先', () => {
  const { panel, page, timers } = mountSoundPanel()
  try {
    // 一批同时结束：两条成功 + 一条失败，都在同一个窗口内到达
    panel.publish([task({ id: 'b1', status: 'completed', msg: '下载完成' })])
    panel.publish([
      task({ id: 'b1', status: 'completed', msg: '下载完成' }),
      task({ id: 'b2', status: 'completed', msg: '下载完成' }),
    ])
    panel.publish([
      task({ id: 'b1', status: 'completed', msg: '下载完成' }),
      task({ id: 'b2', status: 'completed', msg: '下载完成' }),
      task({ id: 'b3', status: 'failed', msg: '失败: 校验不通过' }),
    ])
    assert.equal(page.audio.notes.length, 0, '窗口没到之前不该先响（否则就是连响）')
    timers.fireAll()
    assert.equal(page.audio.notes.length, 2, '三条一起完成只响一次（两个音的一段）')
    assert.deepEqual(
      page.audio.notes.map((n) => n.wave),
      ['triangle', 'triangle'],
      '窗口内有失败 → 响失败音（失败优先）',
    )
  } finally {
    panel.dispose()
    timers.restore()
    page.restore()
  }
})

test('提示音：取消不响（用户自己取消的不需要提醒）', () => {
  const { panel, page, timers } = mountSoundPanel()
  try {
    panel.publish([task({ id: 'c1', status: 'running' })])
    panel.publish([task({ id: 'c1', status: 'cancelled', msg: '已取消' })])
    timers.fireAll()
    assert.equal(page.audio.notes.length, 0, 'cancelled 不该出声')
  } finally {
    panel.dispose()
    timers.restore()
    page.restore()
  }
})

test('提示音：刷新页面后首屏的历史终态任务不会被补播一遍', () => {
  const longAgo = Date.now() - 60 * 60 * 1000
  const history = [
    task({ id: 'h1', status: 'completed', updatedAt: longAgo, msg: '下载完成' }),
    task({ id: 'h2', status: 'failed', updatedAt: longAgo, msg: '失败: 超时' }),
    task({ id: 'h3', status: 'cancelled', updatedAt: longAgo }),
  ]
  // 关键在「第一份快照就是历史」：刷新后的页面看到的正是这个
  const { panel, page, timers } = mountSoundPanel({ first: history })
  try {
    timers.fireAll()
    assert.equal(page.audio.notes.length, 0, '历史任务一条都不该响')

    // 之后真的有新任务结束 → 照常响（首屏播种不能把后续也一起哑掉）
    panel.publish([...history, task({ id: 'n1', status: 'completed', msg: '下载完成' })])
    timers.fireAll()
    assert.equal(page.audio.notes.length, 2, '首屏之后的真终态要响')
  } finally {
    panel.dispose()
    timers.restore()
    page.restore()
  }
})

test('提示音：默认开着，开关在打开的面板里，关掉后不响并把选择写进 localStorage', () => {
  const { panel, page, timers } = mountSoundPanel()
  try {
    // 自动浮现的面板不放设置项
    panel.publish([task({ id: 's1', status: 'running' })])
    assert.equal(
      findAll(panel.render(), (el) => el.props?.['data-dsh-smart-dl'] === 'sound-toggle').length,
      0,
      '自动浮现时不该出现静音开关（那是设置，不是播报）',
    )

    // 打开面板 → 开关出现，默认是「开着」
    // （t32：`clickEntry()` → `openManager()`，只为「把面板打开」这一个意图换驱动方式，
    //  声音相关的断言一条未动。）
    panel.openManager()
    const open = findAll(panel.render(), (el) => el.props?.['data-dsh-smart-dl'] === 'sound-toggle')
    assert.equal(open.length, 1, '打开的面板必须有静音开关')
    assert.equal(open[0].props.checked, true, '首次使用默认开着')
    assert.equal(open[0].props['aria-label'], 'sound')

    // 关掉
    ;(open[0].props.onChange as () => void)()
    assert.equal(page.storage.get('dsh-smart-dl.muted'), '1', '选择必须写进 localStorage')

    panel.publish([task({ id: 's1', status: 'completed', msg: '下载完成' })])
    timers.fireAll()
    assert.equal(page.audio.notes.length, 0, '静音后不得调用播放')

    const after = findAll(
      panel.render(),
      (el) => el.props?.['data-dsh-smart-dl'] === 'sound-toggle',
    )
    assert.equal(after[0].props.checked, false, '关掉后开关状态要跟着变')
  } finally {
    panel.dispose()
    timers.restore()
    page.restore()
  }
})

test('提示音：刷新后沿用上次的选择（localStorage 里是静音就还是静音）', () => {
  const { panel, page, timers } = mountSoundPanel({ stored: { 'dsh-smart-dl.muted': '1' } })
  try {
    // t32：clickEntry() → openManager()（只为「打开面板」换驱动，声音断言未动）
    panel.openManager()
    const box = findAll(panel.render(), (el) => el.props?.['data-dsh-smart-dl'] === 'sound-toggle')
    assert.equal(box[0].props.checked, false, '上次选了静音，刷新后必须还是静音')

    panel.publish([task({ id: 'm1', status: 'failed', msg: '失败: 超时' })])
    timers.fireAll()
    assert.equal(page.audio.notes.length, 0, '记住的静音同样不能响')
  } finally {
    panel.dispose()
    timers.restore()
    page.restore()
  }
})

test('提示音：AudioContext 在首次用户交互时创建一次并复用，不每次播放新建', () => {
  const timers = installFakeTimers()
  const page = installFakePage()
  const { request } = serve([])
  const panel = mountPanel(request)
  try {
    assert.equal(page.audio.contexts, 0, '还没交互就不该建 AudioContext（建了也会被挂起）')
    panel.publish([])
    panel.publish([task({ id: 'p1', status: 'completed', msg: '下载完成' })])
    timers.fireAll()
    assert.equal(page.audio.contexts, 0, '没有手势时不该建上下文')
    assert.equal(page.audio.notes.length, 0, '没有手势时不出声（浏览器也不会允许）')

    // 首次交互：capture + once 的 pointerdown
    const pointer = page.listeners.filter((l) => l.type === 'pointerdown')
    assert.equal(pointer.length, 1, '必须注册一个 pointerdown 监听')
    assert.deepEqual(
      pointer[0].options,
      { capture: true, once: true },
      '解锁监听必须是 capture + once',
    )
    assert.ok(
      page.listeners.some((l) => l.type === 'keydown'),
      '键盘交互同样要解锁（键盘用户也要听得到）',
    )
    page.gesture()
    assert.equal(page.audio.contexts, 1, '首次交互应创建一个 AudioContext')

    // 之后两次独立的完成事件 → 还是同一个上下文
    panel.publish([task({ id: 'p1', status: 'completed' }), task({ id: 'p2', status: 'failed' })])
    timers.fireAll()
    panel.publish([
      task({ id: 'p1', status: 'completed' }),
      task({ id: 'p2', status: 'failed' }),
      task({ id: 'p3', status: 'completed' }),
    ])
    timers.fireAll()
    assert.equal(page.audio.contexts, 1, '播放必须复用同一个 AudioContext')
    assert.ok(page.audio.notes.length >= 4, '解锁后的终态应当出声')
  } finally {
    panel.dispose()
    timers.restore()
    page.restore()
  }
})

test('提示音：没有 AudioContext / resume 被拒时静默退化，面板照常渲染', () => {
  for (const options of [{ withoutAudio: true }, { resumeRejects: true }]) {
    const { panel, page, timers } = mountSoundPanel(options)
    try {
      panel.publish([task({ id: 'x1', status: 'failed', msg: '失败: 网络中断' })])
      timers.fireAll()
      const root = panel.render()
      assert.ok(root, '播放失败不能让面板消失或报错')
      assert.match(textOf(root), /失败|failed/, '面板内容照旧')
      if (options.withoutAudio) assert.equal(page.audio.notes.length, 0)
    } finally {
      panel.dispose()
      timers.restore()
      page.restore()
    }
  }
})

test('提示音：卸载时清掉待响的那一声（插件停用后不该再出声）', () => {
  const { panel, page, timers } = mountSoundPanel()
  try {
    panel.publish([task({ id: 'd9', status: 'completed', msg: '下载完成' })])
    assert.equal(timers.pending.length, 1, '终态应排一个待响的窗口计时器')
    panel.dispose() // = 插件被停用
    timers.fireAll()
    assert.equal(page.audio.notes.length, 0, '被清掉的待响音不该再响')
  } finally {
    timers.restore()
    page.restore()
  }
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

/* ==================== t32：下载管理器（侧边栏入口 + main 页面 + 删除） ==================== */

/**
 * 造一个「记住调用、返回给定结果」的 manage 替身。
 *
 * 为什么要可编程：删除的三条路径（只删记录 / 同时删文件 / 取消）必须各自断言
 * 「发了什么 body」，而 body 里的 `op` / `taskId` / `confirm` 正是服务端契约。
 */
function manageStub(handler: (body: Record<string, unknown>) => unknown) {
  const calls: Array<Record<string, unknown>> = []
  const fn = (body: Record<string, unknown>) => {
    calls.push(body)
    return Promise.resolve(handler(body))
  }
  return { fn, calls }
}

/** 一条带输出路径与尺寸的管理器任务快照。 */
function managedTask(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'm1',
    name: 'report.pdf',
    pct: 100,
    msg: '下载完成',
    status: 'completed',
    spd: '',
    eta: '',
    updatedAt: Date.now(),
    outPath: 'D:\\Downloads\\report.pdf',
    size: 5242880,
    ...over,
  }
}

/**
 * 把注入面上的 manage 换成可编程替身。
 *
 * 必须换在 `renderManager()` **之前**：页面的 `inspectAll()` 在挂载 effect 里跑，
 * 晚一步替换就打在了默认桩上（presence 永远 unknown）。第一版把替换写在渲染之后，
 * 三条用例因此断言的是 unknown 而不是它们想测的 present/missing。
 */
function replaceManage(panel: Panel, manage: (body: Record<string, unknown>) => Promise<unknown>): void {
  ;(panel.__mainSlot.inject as { manage: unknown }).manage = manage
}

/**
 * 渲染一次 main 页面并**等 inspect 落定**，返回刷新后的树。
 *
 * 为什么必须「渲染 → await → 再渲染」：`inspectAll()` 是 async 的（每条任务一次
 * Host 调用），而桩的 `useEffect` 在渲染时同步执行。所以渲染完立刻读树，读到的是
 * inspect **之前**的状态。第一版就是这么写的，presence 徽标断言因此看到 unknown。
 */
/**
 * 点一个元素（按 data 属性找），找不到就断言失败。
 *
 * 单独一个 helper 而不是在每条用例里写 `as (() => void) | undefined`：
 * `FakeElement['props']` 是 `Record<string, unknown>`，直接调 `el.props.onClick()`
 * 过不了 `pnpm check`（TS18046）。既有用例（:574）用的是就地强转，这里改成
 * helper 只是不想在同一文件里混两种写法。
 */
function clickByData(node: unknown, dataAttr: string, label: string): void {
  const el = findAll(node, (e) => e.props?.['data-dsh-smart-dl'] === dataAttr)[0]
  assert.ok(el, `${label}：必须找到 data-dsh-smart-dl=${dataAttr} 的元素`)
  const onClick = el.props.onClick as (() => void) | undefined
  assert.equal(typeof onClick, 'function', `${label}：必须可点`)
  onClick?.()
}

/**
 * 渲染一次 main 页面并**等 inspect 落定**，返回刷新后的树。
 *
 * 为什么必须「渲染 → await → 再渲染」：`inspectAll()` 是 async 的（每条任务一次
 * Host 调用），而桩的 `useEffect` 在渲染时同步执行。所以渲染完立刻读树，读到的是
 * inspect **之前**的状态。第一版就是这么写的，presence 徽标断言因此看到 unknown。
 */
async function renderManagerSettled(panel: Panel): Promise<unknown> {
  panel.renderManager() // 触发挂载 effect（首轮 inspect）
  await settle() // 等 inspect 的 promise 落地
  return panel.renderManager() // 读刷新后的树
}

test('管理器：页面占满主区、每行显示文件名/状态/进度/时间/大小/presence 徽标', async () => {
  // 固定时间戳（本地时区构造 → 格式化结果与 TZ 无关）：验收要求行内能看见「时间」
  const fixed = new Date(2026, 9, 12, 14, 40).getTime()
  const { request } = serve([managedTask({ updatedAt: fixed })])
  const manage = manageStub((body) =>
    body.op === 'inspect'
      ? { ok: true, value: { presence: 'present', outPath: 'D:\\Downloads\\report.pdf', size: 5242880 } }
      : { ok: true, value: {} },
  )
  const panel = mountPanel(request)
  try {
    panel.render()
    await settle()
    replaceManage(panel, manage.fn)
    const tree = await renderManagerSettled(panel)
    const text = textOf(tree)
    assert.match(text, /report\.pdf/, '文件名必须可见')
    assert.match(text, /completed/, '状态必须可见')
    assert.match(text, /100%/, '进度必须可见')
    assert.match(text, /presencePresent|文件在原位/, 'presence 徽标必须可见')
    assert.match(text, /5\.0 MB/, '文件大小必须可见（验收要求行内有大小）')
    assert.match(text, /10-12 14:40/, '更新时间必须可见（验收要求行内有时间）')
    // 时间那一格必须是它自己的元素，并带可读标签（悬停/读屏都能知道这是什么时间）
    const when = findAll(tree, (el) => el.props?.['data-dsh-smart-dl'] === 'updated-at')
    assert.equal(when.length, 1, '每行有且只有一个时间元素')
    assert.equal(when[0].props.title, 'updatedAt', '时间元素必须带 i18n 标签')
  } finally {
    panel.dispose()
  }
})

test('管理器：没有可用时间戳时不渲染时间格（不留空位）', async () => {
  const { request } = serve([managedTask({ updatedAt: 0 })])
  const manage = manageStub(() => ({ ok: true, value: { presence: 'present', outPath: 'x', size: 1 } }))
  const panel = mountPanel(request)
  try {
    panel.render()
    await settle()
    replaceManage(panel, manage.fn)
    const tree = await renderManagerSettled(panel)
    assert.equal(
      findAll(tree, (el) => el.props?.['data-dsh-smart-dl'] === 'updated-at').length,
      0,
      'updatedAt=0 时不该渲染一个空的时间格',
    )
  } finally {
    panel.dispose()
  }
})

test('管理器：打开时对每条任务 inspect 一次（presence 来自 Host，不在浏览器里猜）', async () => {
  const { request } = serve([managedTask({ id: 'a' }), managedTask({ id: 'b' })])
  const manage = manageStub(() => ({ ok: true, value: { presence: 'present', outPath: 'x', size: 1 } }))
  const panel = mountPanel(request)
  try {
    panel.render()
    await settle()
    replaceManage(panel, manage.fn)
    await renderManagerSettled(panel)
    const inspects = manage.calls.filter((c) => c.op === 'inspect')
    assert.equal(inspects.length, 2, '每条任务都要 inspect 一次')
    assert.deepEqual(
      inspects.map((c) => c.taskId).sort(),
      ['a', 'b'],
      'inspect 必须带上 taskId',
    )
  } finally {
    panel.dispose()
  }
})

test('管理器：present → 同时提供「只删记录」与「同时删除本地文件」', async () => {
  const { request } = serve([managedTask()])
  const manage = manageStub((body) =>
    body.op === 'inspect'
      ? { ok: true, value: { presence: 'present', outPath: 'D:\\Downloads\\report.pdf', size: 5242880 } }
      : { ok: true, value: { recordRemoved: ['x'] } },
  )
  const panel = mountPanel(request)
  try {
    panel.render()
    await settle()
    replaceManage(panel, manage.fn)
    const tree = await renderManagerSettled(panel)

    const del = findAll(tree, (el) => el.props?.['data-dsh-smart-dl'] === 'delete')[0]
    assert.ok(del, '每行必须有「删除记录」按钮')
    clickByData(tree, 'delete', '删除按钮')
    // 二次确认：完整绝对路径 + 大小 + 不可恢复声明都必须出现
    const dialog = await renderManagerSettled(panel)
    const text = textOf(dialog)
    assert.match(text, /D:\\Downloads\\report\.pdf/, '确认框必须显示完整绝对路径（不得截断）')
    assert.match(text, /5\.0 MB|5 MB/, '确认框必须显示文件大小')
    assert.match(text, /confirmIrreversible|不进回收站|recycle bin/, '必须明写删除不可恢复、不进回收站')

    const withFile = findAll(dialog, (el) => el.props?.['data-dsh-smart-dl'] === 'confirm-with-file')[0]
    const recordOnly = findAll(dialog, (el) => el.props?.['data-dsh-smart-dl'] === 'confirm-record-only')[0]
    assert.ok(withFile, 'present 必须提供「同时删除本地文件」')
    assert.ok(recordOnly, 'present 也必须提供「只删记录」')

    // 点「同时删除」→ 发 delete + confirm:true
    clickByData(dialog, 'confirm-with-file', '同时删除按钮')
    await settle()
    const del2 = manage.calls.find((c) => c.op === 'delete')
    assert.ok(del2, '必须发出 delete')
    assert.equal(del2.confirm, true, 'delete 必须带 confirm:true')
    assert.equal(del2.taskId, 'm1')
  } finally {
    panel.dispose()
  }
})

test('管理器：missing（文件已移走）→ 只给「删除记录」，不给「同时删除本地文件」', async () => {
  const { request } = serve([managedTask()])
  const manage = manageStub((body) =>
    body.op === 'inspect'
      ? { ok: true, value: { presence: 'missing', outPath: 'D:\\Downloads\\report.pdf', size: 5242880 } }
      : { ok: true, value: { recordRemoved: ['x'] } },
  )
  const panel = mountPanel(request)
  try {
    panel.render()
    await settle()
    replaceManage(panel, manage.fn)
    const tree = await renderManagerSettled(panel)

    clickByData(tree, 'delete', '删除按钮')
    const dialog = await renderManagerSettled(panel)
    assert.equal(
      findAll(dialog, (el) => el.props?.['data-dsh-smart-dl'] === 'confirm-with-file').length,
      0,
      'missing 时不得提供「同时删除本地文件」（用户：移走便只有删除记录）',
    )
    assert.ok(
      findAll(dialog, (el) => el.props?.['data-dsh-smart-dl'] === 'confirm-record-only').length === 1,
      'missing 时仍必须提供「只删记录」',
    )
    assert.match(
      textOf(dialog),
      /confirmPresenceMissing|已不在原位置|no longer at/,
      '必须说明为什么不能删文件',
    )

    // 只删记录走 forget，且**不带** confirm
    clickByData(dialog, 'confirm-record-only', '只删记录按钮')
    await settle()
    const forget = manage.calls.find((c) => c.op === 'forget')
    assert.ok(forget, '只删记录必须发 forget')
    assert.ok(!Object.hasOwn(forget, 'confirm'), 'forget 不应带 confirm')
  } finally {
    panel.dispose()
  }
})

test('管理器：changed / blocked / unknown 一律只给删记录（白名单式判定，不枚举失败）', async () => {
  for (const presence of ['changed', 'blocked', 'unknown']) {
    const { request } = serve([managedTask()])
    const manage = manageStub((body) =>
      body.op === 'inspect'
        ? { ok: true, value: { presence, outPath: 'D:\\Downloads\\report.pdf', size: 1 } }
        : { ok: true, value: { recordRemoved: ['x'] } },
    )
    const panel = mountPanel(request)
    try {
      panel.render()
      await settle()
      replaceManage(panel, manage.fn)
      const tree = await renderManagerSettled(panel)
      clickByData(tree, 'delete', '删除按钮')
      const dialog = await renderManagerSettled(panel)
      assert.equal(
        findAll(dialog, (el) => el.props?.['data-dsh-smart-dl'] === 'confirm-with-file').length,
        0,
        `presence=${presence} 不得提供「同时删除本地文件」`,
      )
    } finally {
      panel.dispose()
    }
  }
})

/**
 * 反证记录（t32）：把 `canReveal` 的 `presence !== 'unknown'` 判据删掉，这条断言
 * **第一版是绿的** —— 因为当时用例的任务 `outPath: ''`，`outPath !== ''` 那道门
 * 照样把它挡住，等于测的是另一条判据。所以这里补一个「有路径 + unknown」的任务：
 * 老记录（1.4.0 之前）没有 outPath，但**有** outPath 而 inspect 判 unknown 的
 * 组合（Host 判定失败 / 记录与磁盘不一致到无法判断）同样必须置灰。
 */
test('管理器：unknown 判定 → 「在文件夹中显示」置灰（有路径也置灰）', async () => {
  const { request } = serve([managedTask()])
  const manage = manageStub(() => ({
    ok: true,
    value: { presence: 'unknown', outPath: 'D:\\Downloads\\report.pdf', size: 0 },
  }))
  const panel = mountPanel(request)
  try {
    panel.render()
    await settle()
    replaceManage(panel, manage.fn)
    const tree = await renderManagerSettled(panel)
    const reveal = findAll(tree, (el) => el.props?.['data-dsh-smart-dl'] === 'reveal')[0]
    assert.ok(reveal, '按钮仍要渲染（置灰），不是消失')
    assert.equal(reveal.props.disabled, true, 'presence=unknown 时即使有路径也必须置灰')
  } finally {
    panel.dispose()
  }
})

test('管理器：unknown（老记录无路径）→ 「在文件夹中显示」置灰', async () => {
  const { request } = serve([managedTask({ outPath: '' })])
  const manage = manageStub(() => ({ ok: true, value: { presence: 'unknown', outPath: '', size: 0 } }))
  const panel = mountPanel(request)
  try {
    panel.render()
    await settle()
    replaceManage(panel, manage.fn)
    const tree = await renderManagerSettled(panel)
    const reveal = findAll(tree, (el) => el.props?.['data-dsh-smart-dl'] === 'reveal')[0]
    assert.ok(reveal, '按钮仍要渲染（置灰），不是消失')
    assert.equal(reveal.props.disabled, true, '没有路径时「在文件夹中显示」必须置灰')
  } finally {
    panel.dispose()
  }
})

test('管理器：「在文件夹中显示」走注入的 reveal，参数是记录里的绝对路径', async () => {
  const { request } = serve([managedTask()])
  const revealed: string[] = []
  const manage = manageStub((body) =>
    body.op === 'inspect'
      ? { ok: true, value: { presence: 'present', outPath: 'D:\\Downloads\\report.pdf', size: 5242880 } }
      : { ok: true, value: {} },
  )
  const panel = mountPanel(request)
  try {
    panel.render()
    await settle()
    replaceManage(panel, manage.fn)
    ;(panel.__mainSlot.inject as { reveal: unknown }).reveal = (outPath: string) => {
      revealed.push(outPath)
      return Promise.resolve({ ok: true })
    }
    const tree = await renderManagerSettled(panel)
    const revealBtn = findAll(tree, (el) => el.props?.['data-dsh-smart-dl'] === 'reveal')[0]
    assert.equal(revealBtn.props.disabled, false, 'present 时「在文件夹中显示」必须可用')
    clickByData(tree, 'reveal', '在文件夹中显示按钮')
    await settle()
    assert.deepEqual(revealed, ['D:\\Downloads\\report.pdf'], '必须用记录里的绝对路径调 reveal')
  } finally {
    panel.dispose()
  }
})

test('管理器：关闭走 selectPanel(null)（回到会话界面）', async () => {
  const { request } = serve([managedTask()])
  const manage = manageStub(() => ({ ok: true, value: { presence: 'present', outPath: 'x', size: 1 } }))
  const panel = mountPanel(request)
  try {
    panel.render()
    await settle()
    replaceManage(panel, manage.fn)
    const tree = await renderManagerSettled(panel)
    const close = findAll(tree, (el) => el.props?.['data-dsh-smart-dl'] === 'manager-close')[0]
    assert.ok(close, '管理器必须有「返回会话」按钮')
    clickByData(tree, 'manager-close', '返回会话按钮')
    assert.deepEqual(panel.panelCalls, [null], '关闭必须调 selectPanel(null)')
  } finally {
    panel.dispose()
  }
})

test('管理器：inspect 失败 → 该行保持 conservative（不给删文件选项），页面不崩', async () => {
  const { request } = serve([managedTask()])
  const manage = manageStub((body) => {
    if (body.op === 'inspect') throw new Error('host down')
    return { ok: true, value: {} }
  })
  const panel = mountPanel(request)
  try {
    panel.render()
    await settle()
    replaceManage(panel, manage.fn)
    const tree = await renderManagerSettled(panel)
    // 页面照常渲染
    assert.match(textOf(tree), /report\.pdf/)
    clickByData(tree, 'delete', '删除按钮')
    const dialog = await renderManagerSettled(panel)
    assert.equal(
      findAll(dialog, (el) => el.props?.['data-dsh-smart-dl'] === 'confirm-with-file').length,
      0,
      'inspect 失败时不得提供「同时删除本地文件」',
    )
    assert.ok(
      findAll(dialog, (el) => el.props?.['data-dsh-smart-dl'] === 'confirm-record-only').length === 1,
      'inspect 失败时仍必须允许删记录',
    )
  } finally {
    panel.dispose()
  }
})

