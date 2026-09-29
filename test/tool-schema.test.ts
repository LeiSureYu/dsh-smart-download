/**
 * 工具定义测试：
 * 用桩 ctx 调用插件 apply()，确保 defineTool 的 schema 能通过 dsh-tools 的
 * 严格校验，覆盖两条曾经各让插件在 DSH 里激活失败一次的规则：
 * - parameters 的属性若写 `required`，只能是 `true`（可选参数须省略该字段）；
 * - object 类型的 schema 节点必须显式声明 `additionalProperties: true|false`。
 *
 * 桩 ctx 还需要提供 `inject`：apply() 会通过 `ctx.inject(['connection'], …)`
 * 挂载进度面板的 Host RPC 端点（纯 CLI profile 下没有 connection 服务时该
 * 分支静默跳过），桩里不做任何事即可。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/index.js'

/** 最小桩上下文：只满足 apply() 在纯 CLI profile 下会碰到的成员。 */
function stubCtx(register: (tool: never) => void) {
  return {
    tools: { register },
    inject: () => {},
  }
}

test('apply(): 工具 schema 通过 dsh-tools 校验并注册两个工具', () => {
  const registered: Array<{ name: string }> = []
  const ctx = stubCtx((tool: { name: string }) => {
    registered.push(tool)
  })

  // 若 schema 不合法，defineTool 会在此抛 JsonSchemaError。
  apply(ctx as never)

  assert.deepEqual(
    registered.map((t) => t.name),
    ['smart_download', 'download_status'],
  )
})

test('smart_download 的 parameters 含 url/output/mirror，且仅 url 必填', () => {
  const registered: Array<{ name: string; parameters: Record<string, unknown> }> = []
  const ctx = stubCtx((tool: { name: string; parameters: Record<string, unknown> }) => {
    registered.push(tool)
  })
  apply(ctx as never)

  const tool = registered.find((t) => t.name === 'smart_download')
  assert.ok(tool, '应注册 smart_download')
  const params = tool.parameters as {
    properties: Record<string, { type?: string; description?: string }>
    required?: string[]
  }
  assert.deepEqual(
    Object.keys(params.properties).sort(),
    ['mirror', 'output', 'url'],
  )
  assert.deepEqual(params.required, ['url'])
  assert.equal(params.properties.mirror?.type, 'string')
  // mirror 的 description 必须提示这是前缀，否则模型不知道该怎么传
  assert.match(params.properties.mirror?.description ?? '', /prefix|mirror/i)
})

/* ------------------------------ render 文案 ------------------------------ */

/** 取出已注册工具的 output.render（宿主用它把结果渲染成给模型看的文本） */
function loadRender(name: string): (args: never, value: never) => Array<{ type: string; text: string }> {
  const registered: Array<{
    name: string
    output?: { render?: (args: never, value: never) => Array<{ type: string; text: string }> }
  }> = []
  apply(stubCtx((tool: never) => registered.push(tool)) as never)
  const tool = registered.find((t) => t.name === name)
  assert.ok(tool?.output?.render, `${name} 应带 render`)
  return tool.output.render
}

test('smart_download.render：成功 / 回退 / 镜像三种修饰都出现在文案里', () => {
  const render = loadRender('smart_download')
  const text = (value: unknown): string =>
    render({} as never, value as never)
      .map((part) => part.text)
      .join('')

  assert.equal(text({ success: true, method: 'aria2' }), 'Download succeeded via aria2')
  // 回退时必须带原因，否则模型不知道为什么会是单线程
  assert.equal(
    text({ success: true, method: 'curl', fellback: true, reason: '文件过小' }),
    'Download succeeded via curl (fallback: 文件过小)',
  )
  // fellback 但没有 reason：不能拼出空的 "(fallback: )"
  assert.equal(
    text({ success: true, method: 'curl', fellback: true }),
    'Download succeeded via curl',
  )
  assert.equal(
    text({ success: false, method: 'curl', mirrored: true }),
    'Download failed via curl (via mirror)',
  )
})

test('download_status.render：无任务给固定文案，有任务逐行列出（速度 / ETA 可选）', () => {
  const render = loadRender('download_status')
  const text = (value: unknown): string =>
    render({} as never, value as never)
      .map((part) => part.text)
      .join('')

  assert.equal(
    text({ tasks: [] }),
    'No download tasks found.',
  )
  // name 缺失时回落到 id；spd/eta 缺失时不留多余空格
  assert.equal(
    text({
      tasks: [
        { id: 'dl-1', name: 'ubuntu.iso', pct: 42, status: 'running', spd: '8.2MB/s', eta: '4m51s' },
        { id: 'dl-2', name: '', pct: 100, status: 'completed' },
      ],
    }),
    'ubuntu.iso: 42% (running) 8.2MB/s eta 4m51s\ndl-2: 100% (completed)',
  )
})
