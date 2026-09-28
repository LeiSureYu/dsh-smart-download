/**
 * 工具定义测试：
 * 用桩 ctx 调用插件 apply()，确保 defineTool 的 schema 能通过 dsh-tools 的
 * 严格校验，覆盖两条曾经各让插件在 DSH 里激活失败一次的规则：
 * - parameters 的属性若写 `required`，只能是 `true`（可选参数须省略该字段）；
 * - object 类型的 schema 节点必须显式声明 `additionalProperties: true|false`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/index.js'

test('apply(): 工具 schema 通过 dsh-tools 校验并注册两个工具', () => {
  const registered: Array<{ name: string }> = []
  const ctx = {
    tools: {
      register(tool: { name: string }) {
        registered.push(tool)
      },
    },
  }

  // 若 schema 不合法，defineTool 会在此抛 JsonSchemaError。
  apply(ctx as never)

  assert.deepEqual(
    registered.map((t) => t.name),
    ['smart_download', 'download_status'],
  )
})

test('smart_download 的 parameters 含 url/output/mirror，且仅 url 必填', () => {
  const registered: Array<{ name: string; parameters: Record<string, unknown> }> = []
  const ctx = {
    tools: {
      register(tool: { name: string; parameters: Record<string, unknown> }) {
        registered.push(tool)
      },
    },
  }
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
