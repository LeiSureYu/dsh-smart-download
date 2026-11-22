/**
 * 发布一致性守卫（1.9.3 审计）。
 *
 * 发布流水线对「optionalDependencies 的 pin 指向一个不存在的子包版本」没有任何
 * 拦截：pnpm 会**静默跳过**缺失的 optional dep，check job 的测试全绿（curl 路径
 * 依然可测），结果发出去的主包声明了一个不存在的随包 aria2 —— 每个平台的用户
 * 都静默退化成 curl 单线程。同理，子包版本改了而主包 pin 忘了改，用户会一直拿
 * 旧二进制。这条测试把三类漂移全部拦在 PR 阶段：
 *   1. pin ↔ 子包 package.json 的 version 不一致（双向都是事故）；
 *   2. 目录 / 包名 / os+cpu / ARIA2_TARGETS 之间的映射漂移（新增平台忘了配套）；
 *   3. win32 不声明 bin（npm 会为 bin 生成 .cmd shim，PE 二进制不能进）与 POSIX
 *      必须声明 `dsh-aria2c` 的纪律（1.9.2 的安装侧补执行位依赖它）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ARIA2_TARGETS } from '../src/downloader.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const main = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')) as {
  version: string
  optionalDependencies?: Record<string, string>
}
const deps = main.optionalDependencies ?? {}

/** packages/ 下实际存在的子包目录（形如 aria2-win32-x64） */
const subpackageDirs = readdirSync(path.join(repoRoot, 'packages')).filter((name) =>
  /^aria2-.+/.test(name),
)

/** 目录名 → 期望的子包包名（aria2-win32-x64 → @leisureyu/dsh-aria2-win32-x64） */
function depNameFor(dir: string): string {
  return `@leisureyu/dsh-aria2-${dir.slice('aria2-'.length)}`
}

function readSubpackage(dir: string): {
  name: string
  version: string
  os?: string[]
  cpu?: string[]
  bin?: Record<string, string>
} {
  const file = path.join(repoRoot, 'packages', dir, 'package.json')
  assert.ok(existsSync(file), `子包目录 ${dir} 必须有 package.json`)
  return JSON.parse(readFileSync(file, 'utf-8'))
}

test('主包版本在 CHANGELOG 里有对应条目（版本号与发布文档不漂移）', () => {
  const changelog = readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf-8')
  assert.match(
    changelog,
    new RegExp(`## \\[${main.version.replace(/\./g, '\\.')}\\]`),
    `CHANGELOG 缺少 [${main.version}] 条目 —— 版本号改了但发布文档没跟上`,
  )
})

test('每个 optionalDependencies 的 pin 都指向一个真实存在的子包目录（双向）', () => {
  // pin → 目录：pin 写了但目录没有，说明 pin 指向一个仓库里根本不存在的东西
  for (const [name, version] of Object.entries(deps)) {
    const dir = `aria2-${name.slice('@leisureyu/dsh-aria2-'.length)}`
    assert.ok(
      subpackageDirs.includes(dir),
      `pin ${name}@${version} 没有对应的 packages/${dir} 目录`,
    )
  }
  // 目录 → pin：目录存在但没有 pin，发布流水线会把它的变更静默丢弃
  // （aria2-ohos-arm64 是刻意的例外：构建配方未落地、子包未发布，见
  //   src/downloader.ts 的 ARIA2_TARGETS 注释）
  const pinnedDirs = Object.keys(deps).map((name) =>
    `aria2-${name.slice('@leisureyu/dsh-aria2-'.length)}`,
  )
  for (const dir of subpackageDirs) {
    const name = depNameFor(dir)
    if (dir === 'aria2-ohos-arm64') {
      assert.equal(
        deps[name],
        undefined,
        'ohos 子包发布后必须同步加入 optionalDependencies（现在它是刻意的例外）',
      )
      continue
    }
    assert.ok(
      pinnedDirs.includes(dir),
      `packages/${dir} 存在但主包 optionalDependencies 没有 ${depNameFor(dir)} 的 pin`,
    )
  }
})

test('pin 的版本与子包 package.json 的 version 严格一致（双向漂移都算失败）', () => {
  for (const [name, version] of Object.entries(deps)) {
    const dir = `aria2-${name.slice('@leisureyu/dsh-aria2-'.length)}`
    const sub = readSubpackage(dir)
    assert.equal(
      sub.version,
      version,
      `${name} 的 pin 是 ${version}，但 packages/${dir}/package.json 是 ${sub.version}` +
        ' —— 两边必须同步改，否则发布出去的包要么 pin 到不存在的版本（用户拿不到随包 aria2），要么永远装旧二进制',
    )
  }
})

test('子包的 name / os / cpu 与目录名对应，ARIA2_TARGETS 与 pin 对应', () => {
  for (const [name] of Object.entries(deps)) {
    const dir = `aria2-${name.slice('@leisureyu/dsh-aria2-'.length)}`
    const sub = readSubpackage(dir)
    assert.equal(sub.name, name, `packages/${dir} 的 name 必须是 ${name}`)
    const platform = dir.slice('aria2-'.length) // win32-x64 / linux-arm64 / …
    const [os, cpu] = platform.split('-')
    assert.deepEqual(sub.os, [os], `${name} 的 os 字段必须与目录平台一致`)
    assert.deepEqual(sub.cpu, [cpu], `${name} 的 cpu 字段必须与目录平台一致`)
    // 决策表：受支持平台的二进制解析顺序依赖这张表 —— 表里有而 pin 没有，
    // 等于该平台的「随包优先」永远落空（静默查 PATH / 回退 curl）。
    if (dir !== 'aria2-ohos-arm64') {
      assert.ok(
        ARIA2_TARGETS[platform] !== undefined,
        `平台 ${platform} 有子包但 src/downloader.ts 的 ARIA2_TARGETS 没有它`,
      )
    }
  }
  // ARIA2_TARGETS 里的每个条目（除 ohos 占位）都必须有 pin + 目录
  for (const [platform, target] of Object.entries(ARIA2_TARGETS)) {
    if (platform === 'ohos-arm64') continue
    assert.equal(
      deps[target.pkg],
      versionOf(target.pkg),
      `ARIA2_TARGETS 的 ${platform}（${target.pkg}）必须与 optionalDependencies 的 pin 一致`,
    )
    const dir = `aria2-${platform}`
    assert.ok(subpackageDirs.includes(dir), `ARIA2_TARGETS 的 ${platform} 缺少 packages/${dir}`)
  }

  function versionOf(pkg: string): string {
    const version = deps[pkg]
    assert.ok(version, `${pkg} 必须出现在 optionalDependencies 里`)
    return version as string
  }
})

test('bin 字段纪律：win32 不声明 bin，POSIX 声明 dsh-aria2c → bin/aria2c', () => {
  for (const [name] of Object.entries(deps)) {
    const dir = `aria2-${name.slice('@leisureyu/dsh-aria2-'.length)}`
    const sub = readSubpackage(dir)
    if (dir.startsWith('aria2-win32')) {
      assert.equal(
        sub.bin,
        undefined,
        `${name} 不得声明 bin —— npm 会为 bin 目标生成 .cmd shim，PE 二进制进 bin 只会得到依赖 sh 的假可执行（1.9.2 的刻意取舍）`,
      )
    } else {
      assert.equal(
        sub.bin?.['dsh-aria2c'],
        'bin/aria2c',
        `${name} 必须声明 bin.dsh-aria2c（安装侧靠它补回执行位，1.9.2）`,
      )
    }
  }
})
