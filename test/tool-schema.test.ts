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
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.js'
import { describeExitCode } from '../src/downloader.js'

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

test('smart_download 的 parameters 含 10 项，url 与 targets 二选一（都不再是必填）', () => {
  const registered: Array<{ name: string; parameters: Record<string, unknown> }> = []
  const ctx = stubCtx((tool: { name: string; parameters: Record<string, unknown> }) => {
    registered.push(tool)
  })
  apply(ctx as never)

  const tool = registered.find((t) => t.name === 'smart_download')
  assert.ok(tool, '应注册 smart_download')
  const params = tool.parameters as {
    properties: Record<
      string,
      {
        type?: string
        description?: string
        additionalProperties?: boolean
        items?: {
          type?: string
          additionalProperties?: boolean
          properties?: Record<string, { type?: string; description?: string }>
          required?: string[]
        }
      }
    >
    required?: string[]
  }
  assert.deepEqual(
    Object.keys(params.properties).sort(),
    [
      'headers',
      'maxBandwidth',
      'mirror',
      'output',
      'referer',
      'sha256',
      'targets',
      'timeoutMs',
      'url',
      'userAgent',
    ],
  )
  // timeoutMs（D3）：必须是 integer（超时是毫秒数，不接受字符串或小数），且说明里
  // 必须写明「超时的那一条失败、批量里其余条目不中断」—— 这是用户拍板时要的语义，
  // 模型只看得见 description，写漏了它就只能靠猜。
  assert.equal(params.properties.timeoutMs?.type, 'integer', 'timeoutMs 必须声明为 integer')
  assert.match(params.properties.timeoutMs?.description ?? '', /milliseconds/i)
  assert.match(
    params.properties.timeoutMs?.description ?? '',
    /failed/i,
    '说明里必须写明超时后该条目是失败',
  )
  assert.match(
    params.properties.timeoutMs?.description ?? '',
    /other entries keep running|never re-labelled/i,
    '说明里必须写明批量下其余条目不中断、已完成条目不被改判',
  )
  // ─────────────────────── 设计决定记录（P0R-01，方案 c） ───────────────────────
  //
  // 目标约束：「url 与 targets 二选一（两个都给、两个都不给都要被拒绝）」。
  //
  // (b) 曾尝试把入参根节点写成 oneOf: [{required:['url']}, {required:['targets']}]。
  //     结论：**无法经 parameters 的 DSL 表达**。理由是可查的结构性事实：
  //       · `ParameterSchemaSpec` 的类型就是一个「属性名 → 属性 spec」的映射
  //         （dsh-tools 的 schema.d.ts），没有根级 oneOf 的位置；
  //       · `parameterSchemaSpecToJsonSchema()` 只产出 { type, properties, required? }
  //         三样东西（dsh-tools 的 index.js），根节点结构固定；
  //       · 把 `oneOf` 写成 parameters 的一个键，DSL 会把它当成**一个名叫 oneOf 的
  //         入参属性**（OneOfValueSchemaSpec 是合法的属性 spec），于是模型会在
  //         参数表里看到一个多余的 oneOf 入参 —— 那不是约束，是污染。
  //     上面的 (a) 也走不通：给 url 与 targets 都标 `required: true` 会要求两个都传，
  //     targets-only 的批量调用会被 schema 直接挡下。
  //
  // 因此采用 (c)：**schema 只表达「各自是什么」，二选一的强制放在 execute 里**
  // （`resolveTargets`），并做两件事把缺口显式化：
  //   1. 两个参数的 description 明写「两个都给或都不给都会被拒绝」（下面有断言）；
  //   2. 根节点必须仍然没有 required 列表 —— 这正是「schema 管不了这件事」的证据，
  //      一旦有人把 required 加回来（退回 (a)），这里会立刻红。
  assert.equal(
    params.required,
    undefined,
    'schema 不能表达二选一：加 required 会挡下 targets-only 的合法调用，因此必须保持无 required',
  )
  assert.equal(Object.hasOwn(params, 'oneOf'), false, '根节点不得出现 oneOf（DSL 也放不下它）')
  assert.deepEqual(
    Object.keys(params).sort(),
    ['properties', 'type'],
    '根节点只能是 { type, properties }：多出别的键说明有人以为在这层表达了约束',
  )
  assert.equal(params.properties.url?.type, 'string')
  assert.match(
    params.properties.url?.description ?? '',
    /targets/,
    'url 的说明必须点明与 targets 二选一，否则模型会两个都传',
  )
  // 缺口的第二道显式化：文案必须写明「两个都不给会被拒绝」，否则模型会以为
  // 省略两者等于「用默认目标」（而 execute 会直接拒绝）。
  assert.match(
    params.properties.url?.description ?? '',
    /neither/i,
    'url 的说明必须写明「两个都不给」的后果',
  )
  assert.match(
    params.properties.url?.description ?? '',
    /rejected/i,
    'url 的说明必须写明被拒绝，而不是含糊地说二选一',
  )
  assert.match(
    params.properties.targets?.description ?? '',
    /neither/i,
    'targets 的说明同样要写明「两个都不给」的后果',
  )

  // targets：数组 + 对象条目，条目里的 url 必填（批量里每条都要有地址）
  const targets = params.properties.targets
  assert.equal(targets?.type, 'array')
  assert.match(targets?.description ?? '', /batch|targets/i)
  assert.match(targets?.description ?? '', /targets/, '必须说明与 url 二选一')
  const items = targets?.items
  assert.ok(items, 'targets 必须声明 items，否则模型不知道条目长什么样')
  assert.equal(items.type, 'object')
  // object 节点必须显式声明 additionalProperties（dsh-tools 的硬规则）
  assert.equal(items.additionalProperties, false)
  assert.deepEqual(
    Object.keys(items.properties ?? {}).sort(),
    ['output', 'sha256', 'url'],
    '条目字段与单条目同构：url / output / sha256',
  )
  assert.deepEqual(items.required, ['url'], '条目的 url 必填')

  // 总带宽上限：字符串 + 必须说明单位与「一批共享」语义
  assert.equal(params.properties.maxBandwidth?.type, 'string')
  const bw = params.properties.maxBandwidth?.description ?? ''
  assert.match(bw, /K|M|G/, '必须说明接受哪些单位后缀')
  assert.match(bw, /aria2|curl/, '必须说明它落到哪两个命令行的开关上')

  assert.equal(params.properties.mirror?.type, 'string')
  // mirror 的 description 必须提示这是前缀，否则模型不知道该怎么传
  assert.match(params.properties.mirror?.description ?? '', /prefix|mirror/i)
  // 还必须说明 `auto` 的存在，否则内置镜像表永远没人用
  assert.match(params.properties.mirror?.description ?? '', /auto/i)
  // sha256 的 description 必须点明「官方文档里的摘要」这个用法，否则模型
  // 不会想到把文档里的校验和传进来 —— 这一项的全部价值就在这里
  assert.match(params.properties.sha256?.description ?? '', /checksum|SHA-256/i)
  assert.match(params.properties.sha256?.description ?? '', /official documentation/i)
  // headers 是 object 节点：dsh-tools 强制要求显式声明 additionalProperties
  assert.equal(params.properties.headers?.type, 'object')
  assert.equal(params.properties.headers?.additionalProperties, true)
})

test('证据（P0R-01）：parameters 的 DSL 把 oneOf 当成一个入参属性，而不是根级约束', () => {
  // 这条用例是上面那份「设计决定记录」的证据本身：把 oneOf 写成 parameters 的一个键，
  // DSL 会把它编译成**一个名叫 oneOf 的入参**（模型会在参数表里看到一个多余字段），
  // 而不是把它当成根节点的 oneOf 约束。这证明 (b) 方案无法经 parameters 透传，
  // 因此二选一只能在 execute 里强制（方案 c）。
  const def = defineTool({
    name: 'probe-oneof',
    description: 'probe',
    parameters: {
      url: { type: 'string' },
      oneOf: {
        type: 'object',
        additionalProperties: false,
        properties: { url: { type: 'string' } },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
      render: () => [],
    },
    execute: async () => ({ ok: true }),
  } as never) as unknown as { parameters: Record<string, unknown> & { properties: Record<string, unknown> } }

  assert.ok(
    def.parameters.properties.oneOf,
    'oneOf 被当成了入参属性 —— 说明根节点没有它的位置（若有，它不会出现在 properties 里）',
  )
  assert.equal(
    Object.hasOwn(def.parameters, 'oneOf'),
    false,
    '编译后的根节点没有 oneOf 键，因此无法用 DSL 表达「url 或 targets 二选一」',
  )
})

/* ---------------- render 文案 ---------------- */

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

test('smart_download.render：跳过完整性校验时必须出现在文案里（不得静默）', () => {
  const render = loadRender('smart_download')
  const text = (value: unknown): string =>
    render({} as never, value as never)
      .map((part) => part.text)
      .join('')

  // 跳过校验的说明必须可见：用户看到的不能只是「成功」，
  // 否则「没验过完整性」与「验过且一致」在回执上无法区分。
  assert.equal(
    text({
      success: true,
      method: 'curl',
      verifySkipped: '未做字节数校验：远端未声明文件长度',
    }),
    'Download succeeded via curl (未做字节数校验：远端未声明文件长度)',
  )
  // 与回退原因同时出现时两者都要在，不能互相顶掉
  assert.equal(
    text({
      success: true,
      method: 'curl',
      fellback: true,
      reason: '文件过小',
      verifySkipped: '未做字节数校验：远端声明了压缩编码',
    }),
    'Download succeeded via curl (fallback: 文件过小) (未做字节数校验：远端声明了压缩编码)',
  )
  // 没有跳过时不得凭空拼出一个空括号
  assert.equal(text({ success: true, method: 'aria2' }), 'Download succeeded via aria2')
})

test('smart_download.render：SHA-256 已校验与自动镜像未生效都必须出现在文案里', () => {
  const render = loadRender('smart_download')
  const text = (value: unknown): string =>
    render({} as never, value as never)
      .map((part) => part.text)
      .join('')

  // 传了 sha256 且通过：回执必须让「内容已逐字节核对」可见
  assert.equal(
    text({ success: true, method: 'aria2', sha256: 'a'.repeat(64) }),
    'Download succeeded via aria2 (SHA-256 verified)',
  )
  // 请求了自动镜像却没生效：原因必须可见，否则调用方以为走了镜像
  assert.equal(
    text({
      success: true,
      method: 'curl',
      mirrorSkipped: '未使用自动镜像：只有 GitHub 地址支持',
    }),
    'Download succeeded via curl (未使用自动镜像：只有 GitHub 地址支持)',
  )
  // 与回退原因、字节数校验跳过同时出现时，三者互不顶掉
  assert.equal(
    text({
      success: true,
      method: 'curl',
      fellback: true,
      reason: '文件过小',
      verifySkipped: '未做字节数校验：远端未声明文件长度',
      mirrorSkipped: '未使用自动镜像：内置镜像均不可达，或返回的文件与原始地址不一致',
    }),
    'Download succeeded via curl (fallback: 文件过小) (未做字节数校验：远端未声明文件长度) (未使用自动镜像：内置镜像均不可达，或返回的文件与原始地址不一致)',
  )
  // 都没有时不得凭空拼出空括号
  assert.equal(text({ success: true, method: 'aria2' }), 'Download succeeded via aria2')
})

/* ---------------- 1.3.0：批量（路线 A）的模型可见文案 ---------------- */

test('smart_download.render：批量结果先给汇总，再逐条列出成功条目', () => {
  const render = loadRender('smart_download')
  const text = (value: unknown): string =>
    render({} as never, value as never)
      .map((part) => part.text)
      .join('')

  assert.equal(
    text({
      batch: 'b-1',
      succeeded: 2,
      failed: 0,
      cancelled: 0,
      results: [
        { url: 'https://e/a.zip', output: '/tmp/a.zip', success: true, method: 'aria2', path: '/tmp/a.zip' },
        { url: 'https://e/b.zip', output: '/tmp/b.zip', success: true, method: 'curl', path: '/tmp/b.zip' },
      ],
    }),
    'Batch b-1: 2 succeeded, 0 failed, 0 cancelled\n' +
      '[ok] https://e/a.zip via aria2 -> /tmp/a.zip\n' +
      '[ok] https://e/b.zip via curl -> /tmp/b.zip',
  )
})

test('smart_download.render：批量里的失败与取消必须逐条给出原因（D4=②）', () => {
  const render = loadRender('smart_download')
  const text = (value: unknown): string =>
    render({} as never, value as never)
      .map((part) => part.text)
      .join('')

  const out = text({
    batch: 'b-2',
    succeeded: 1,
    failed: 1,
    cancelled: 1,
    results: [
      { url: 'https://e/ok.zip', output: '/tmp/ok.zip', success: true, method: 'curl', path: '/tmp/ok.zip' },
      { url: 'https://e/bad.zip', output: '/tmp/bad.zip', success: false, error: 'HTTP 404' },
      { url: 'https://e/slow.zip', output: '/tmp/slow.zip', success: false, cancelled: true, error: '已取消' },
    ],
  })
  // 汇总数字必须齐全
  assert.match(out, /1 succeeded, 1 failed, 1 cancelled/)
  // 成功条目照常列出（失败条目不得让它的结果消失）
  assert.match(out, /\[ok\] https:\/\/e\/ok\.zip/)
  // 失败与取消必须能区分，且各自带原因
  assert.match(out, /\[failed\] https:\/\/e\/bad\.zip: HTTP 404/)
  assert.match(out, /\[cancelled\] https:\/\/e\/slow\.zip: 已取消/)
})

test('download_status.render：无任务给固定文案，有任务逐行列出（速度 / ETA 可选）', () => {  const render = loadRender('download_status')
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

/* ---------------- 1.3.0：区分「读不到」与「没有任务」 ---------------- */

test('download_status.render：全部目录读不到时不得只说「No download tasks found.」', () => {
  const render = loadRender('download_status')
  const text = (value: unknown): string =>
    render({} as never, value as never)
      .map((part) => part.text)
      .join('')

  const out = text({
    ok: false,
    tasks: [],
    scanFailedDirs: ['/home/u/.dsh/downloads/tasks', '/w/.dsh-progress/sess-1'],
  })
  // 正向断言：模型必须看到「读不到」这件事，而不是一句干净的空列表
  assert.match(out, /读取失败/, '必须说明目录读取失败')
  assert.match(out, /\/home\/u\/\.dsh\/downloads\/tasks/, '必须报出具体目录')
  assert.match(out, /\/w\/\.dsh-progress\/sess-1/, '两个目录都要报出')
  assert.match(out, /下一步/, '必须给出下一步')
  // 而且必须**否定**那句空列表结论，否则模型会以为确实没有任务
  assert.doesNotMatch(out, /^No download tasks found\.$/, '不得只说没有任务')
})

test('download_status.render：部分目录读不到时列表照常给出，另附诊断', () => {
  const render = loadRender('download_status')
  const text = (value: unknown): string =>
    render({} as never, value as never)
      .map((part) => part.text)
      .join('')

  const out = text({
    ok: true,
    tasks: [{ id: 'dl-1', name: 'a.iso', pct: 10, status: 'running' }],
    scanFailedDirs: ['/w/.dsh-progress/sess-1'],
  })
  // 可读目录里的任务不得因为另一半失败而消失
  assert.match(out, /a\.iso: 10% \(running\)/)
  assert.match(out, /读取失败/)
  assert.match(out, /\/w\/\.dsh-progress\/sess-1/)
})

test('download_status.render：没有 scanFailedDirs 时输出与 1.2.0 逐字节相同', () => {
  const render = loadRender('download_status')
  const text = (value: unknown): string =>
    render({} as never, value as never)
      .map((part) => part.text)
      .join('')

  assert.equal(text({ ok: true, tasks: [] }), 'No download tasks found.')
  assert.equal(
    text({ ok: true, tasks: [{ id: 'dl-1', name: 'a.iso', pct: 10, status: 'running' }] }),
    'a.iso: 10% (running)',
  )
  // 空数组与缺失必须等价（老读取端可能给空数组）
  assert.equal(text({ ok: true, tasks: [], scanFailedDirs: [] }), 'No download tasks found.')
})

/* ------------- 文档契约：curl 33 / 36 的解释（P0R-04） ------------- */

/**
 * 本文件里放这条文档契约用例的原因：本轮 inScope 的测试文件只有它和 rpc.test.ts，
 * 而真正该落的家是 `test/downloader.test.ts`（那里能同时钉住代码文案与 README）。
 * 它检查两件事：**代码侧的 33 文案**与 **README 的措辞**说的是同一件事（官方定义
 * 33 = HTTP range error；36 = bad download resume），因此任何一边被改回
 * 「33 就是服务器不支持 Range」都会红。
 */
test('文档契约：curl 33 的解释在代码与 README 里都对齐官方定义（33 = range error；36 = bad download resume）', () => {
  const code = describeExitCode('curl', 33, null, '')
  assert.ok(code, 'curl 33 必须有解释文案')
  assert.match(code, /Range/i, '文案必须落在 Range 语义上（官方定义：HTTP range error）')

  const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'README.md'), 'utf-8')
  assert.match(readme, /HTTP range error/i, 'README 必须写出 33 的官方定义')
  assert.match(readme, /\b36\b/, 'README 必须点出相邻的 36（否则读者会把两码混为一谈）')
  assert.match(readme, /bad download resume/i, '36 的官方措辞必须出现')
  assert.match(
    readme,
    /忽略.*Range|Range.*忽略/,
    'README 必须给出「33 也可能意味着服务器忽略了你发的 Range」这层实测含义',
  )
})
