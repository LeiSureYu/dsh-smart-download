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

test('apply(): 工具 schema 通过 dsh-tools 校验并成功注册 smart_download', () => {
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

  assert.equal(registered.length, 1)
  assert.equal(registered[0]?.name, 'smart_download')
})
