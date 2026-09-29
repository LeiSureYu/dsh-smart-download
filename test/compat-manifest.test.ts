/**
 * 清单兼容性测试：把「插件在 DSH 0.2.0 上不会被前置检查拒绝」这件事
 * 变成可执行的断言，而不是只写在文档里的一句话。
 *
 * 背景：DSH 0.2.0 起，装载一个 bundle 前会先检查它声明的 `peerDependencies`
 * 里所有 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 范围是否匹配当前运行时版本；
 * 不匹配的 **bundle 会被整层跳过**（`skipping profile bundle`），插件一行都不加载。
 * 也就是说：范围写错 = 插件静默消失，`dsh plugin add` 还会在 pnpm 之前直接拒绝。
 *
 * 因此这里断言的是**正向信号**：拿真实的运行时版本去比，必须匹配。
 * 只断言「范围字符串长什么样」是不够的 —— 那样写错了照样绿。
 *
 * 不引入 semver 依赖：DSH 只发布预发布版，下面的比较器专门按
 * 「预发布段逐段比较、且 `-0` 排在正式版之前」的规则实现。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)

interface Pkg {
  version: string
  engines?: Record<string, string>
  dsh?: {
    manifestVersion?: number
    bundle?: { patch?: string | string[] }
    client?: { platform?: string; inject?: string[]; external?: string[] }
  }
  peerDependencies?: Record<string, string>
}

const pkg = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf-8'),
) as Pkg

/** 0.2.0 的运行时版本，也是 DSH 0.2.0 桌面版实际报告的版本。 */
const RUNTIME_0_2_0 = '0.2.0-rc.2'

type Parsed = { nums: [number, number, number]; pre: string[] }

function parse(v: string): Parsed {
  const [core, ...rest] = v.split('-')
  const nums = core.split('.').map((n) => Number(n))
  assert.equal(nums.length, 3, `版本号必须是 x.y.z：${v}`)
  assert.ok(
    nums.every((n) => Number.isInteger(n) && n >= 0),
    `版本号段必须是整数：${v}`,
  )
  return {
    nums: [nums[0], nums[1], nums[2]],
    pre: rest.length > 0 ? rest.join('-').split('.') : [],
  }
}

/** 语义化版本比较：正式版 > 同号预发布版；预发布段逐段比较（数字按数值）。 */
function cmp(a: Parsed, b: Parsed): number {
  for (let i = 0; i < 3; i++) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] < b.nums[i] ? -1 : 1
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  const len = Math.max(a.pre.length, b.pre.length)
  for (let i = 0; i < len; i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) return Number(x) < Number(y) ? -1 : 1
    if (nx) return -1
    if (ny) return 1
    return x < y ? -1 : 1
  }
  return 0
}

/**
 * 判断版本是否落在 DSH 那种 `||` 分隔的元组范围里。
 * 每个元组由若干比较符子句组成，子句之间是「与」，元组之间是「或」。
 */
function satisfies(version: string, range: string): boolean {
  const v = parse(version)
  return range.split('||').some((tuple) => {
    const clauses = tuple.trim().split(/\s+/).filter(Boolean)
    assert.ok(clauses.length > 0, `空的范围元组：${range}`)
    return clauses.every((clause) => {
      const m = /^(>=|<=|>|<|=)?(.+)$/.exec(clause)
      assert.ok(m, `无法解析的范围子句：${clause}`)
      const op = m[1] ?? '='
      const c = cmp(v, parse(m[2]))
      if (op === '>=') return c >= 0
      if (op === '>') return c > 0
      if (op === '<=') return c <= 0
      if (op === '<') return c < 0
      return c === 0
    })
  })
}

// ── 比较器自身的正向断言：先证明它会判否，再看它判是 ──────────────────────────

test('compat: 版本比较器本身能区分预发布与正式版', () => {
  // 若比较器永远返回 true，下面这些断言会失败 —— 这是防止测试自己退化成空壳
  const range = '>=0.2.0-rc.1 <0.3.0-0'
  assert.equal(satisfies('0.2.0-rc.1', range), true)
  assert.equal(satisfies('0.2.0-rc.2', range), true)
  assert.equal(satisfies('0.2.0', range), true)
  assert.equal(satisfies('0.2.9', range), true)
  assert.equal(satisfies('0.3.0-0', range), false) // 上界是排他
  assert.equal(satisfies('0.1.9', range), false)
  // 关键语义：0.2.0-rc.2 < 0.2.0，正式版必须也能被 <0.3.0-0 放进来
  assert.equal(cmp(parse('0.2.0-rc.2'), parse('0.2.0')) < 0, true)
})

// ── 清单本身 ────────────────────────────────────────────────────────────────

test('compat: dsh.manifestVersion 声明为 1', () => {
  assert.equal(pkg.dsh?.manifestVersion, 1)
})

test('compat: engines.dsh 声明了兼容范围（纯声明，不参与前置检查）', () => {
  const range = pkg.engines?.dsh
  assert.ok(typeof range === 'string' && range.length > 0, '缺少 engines.dsh')
  // 声明应当覆盖当前运行时，否则这份声明就是错的
  assert.equal(
    satisfies(RUNTIME_0_2_0, range),
    true,
    `engines.dsh 未覆盖 ${RUNTIME_0_2_0}：${range}`,
  )
})

test('compat: 每个 @deepseek-ai/dsh* peer 范围都放行 0.2.0-rc.2', () => {
  const peers = pkg.peerDependencies ?? {}
  const dshPeers = Object.entries(peers).filter(
    ([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'),
  )
  // 下限保护：这条断言必须真的检查到了包，否则改名后会自动变成空检查
  assert.ok(
    dshPeers.length >= 4,
    `应至少有 4 个 @deepseek-ai/dsh* peer，实际 ${dshPeers.length}`,
  )
  for (const [name, range] of dshPeers) {
    assert.equal(
      satisfies(RUNTIME_0_2_0, range),
      true,
      `${name} 的范围未覆盖 ${RUNTIME_0_2_0}：${range}`,
    )
  }
})

test('compat: peer 范围同时覆盖 0.1.7 / 0.1.8 / 0.2.x 三个分支', () => {
  const peers = pkg.peerDependencies ?? {}
  const dshPeers = Object.entries(peers).filter(([name]) =>
    name.startsWith('@deepseek-ai/dsh-'),
  )
  const cases = ['0.1.7-rc.1', '0.1.8-rc.1', '0.2.0-rc.1', '0.2.0', '0.2.5']
  for (const [name, range] of dshPeers) {
    for (const v of cases) {
      assert.equal(satisfies(v, range), true, `${name} 未覆盖 ${v}：${range}`)
    }
    // 下个预发布分支必须是明确排除的，否则「不兼容」这件事被无意中承诺掉了
    assert.equal(satisfies('0.3.0-rc.1', range), false, `${name} 意外放行 0.3.0-rc.1`)
  }
})

test('compat: 客户端清单只用平台基线，不额外声明 external', () => {
  // 桌面版与 web profile 都按 platform: 'web' 消费客户端脚本；
  // 客户端脚本唯一的 require('react') 属于平台基线，无需写进 external。
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.equal(pkg.dsh?.client?.external, undefined)
  assert.deepEqual(pkg.dsh?.client?.inject, [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-client-ui-slots',
  ])
})

test('compat: bundle patch 仍然指向仓库里的 cordis.patch.yml', () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
})
