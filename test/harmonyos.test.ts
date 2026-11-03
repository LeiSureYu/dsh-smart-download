/**
 * 1.9.1 鸿蒙（OpenHarmony / HarmonyOS）适配测试：
 * - 平台映射表认识 ohos-arm64，且不为公开设备里不存在的 ohos-x64 编造条目；
 * - DSH_SMARTDL_ARIA2_PATH 覆盖：有效路径优先于一切自动来源、无效路径
 *   显式返回 null（不静默回落其它来源）、空白视为未设置；
 * - decide() 在「覆盖被拒绝」时给出的 reason 指向环境变量，而不是误导性的
 *   「子包未安装」。
 *
 * 用 Node 自身（`node --version` 退出码 0）充当「验证可通过的二进制」，
 * 不依赖 aria2 / 鸿蒙设备 / 网络 —— 与 runprocess 系列同一套做法。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ARIA2_PATH_OVERRIDE_ENV,
  aria2PathOverride,
  aria2TargetFor,
  getAria2Path,
} from '../src/downloader.js'
import { decide } from '../src/decision.js'
import type { ProbeResult } from '../src/types.js'

/** 保存 / 恢复环境变量，避免用例之间（以及对本机 shell）泄漏。 */
function withOverrideEnv(value: string | undefined, fn: () => void): void {
  const previous = process.env[ARIA2_PATH_OVERRIDE_ENV]
  try {
    if (value === undefined) {
      delete process.env[ARIA2_PATH_OVERRIDE_ENV]
    } else {
      process.env[ARIA2_PATH_OVERRIDE_ENV] = value
    }
    fn()
  } finally {
    if (previous === undefined) {
      delete process.env[ARIA2_PATH_OVERRIDE_ENV]
    } else {
      process.env[ARIA2_PATH_OVERRIDE_ENV] = previous
    }
  }
}

/* ------------------------------ 平台映射 ------------------------------ */

test('ohos-arm64 有映射条目（OpenHarmony Node 运行时报告 platform === ohos）', () => {
  const target = aria2TargetFor('ohos', 'arm64')
  assert.notEqual(target, null)
  assert.equal(target?.pkg, '@leisureyu/dsh-aria2-ohos-arm64')
  assert.equal(target?.bin, 'bin/aria2c')
})

test('ohos-x64 没有条目：公开在售的鸿蒙设备均为 arm64，不编造未验证的目标', () => {
  assert.equal(aria2TargetFor('ohos', 'x64'), null)
})

test('决定回退文案的平台名不会被 ohos 适配改动：非 aria2 缺失分支不读平台', () => {
  // 守护性断言：harmonyos 分支只允许出现在「aria2 不可用」的 reason 里，
  // 其余回退（不支持 Range / 无大小 / 文件过小）的文案保持平台无关。
  const probe: ProbeResult = { supportsMultiThread: false, reason: '不支持 Range' }
  const decision = decide(probe, false)
  assert.equal(decision.method, 'curl')
  assert.doesNotMatch(decision.reason, /ohos/)
})

/* --------------------------- 环境变量覆盖 --------------------------- */

test('aria2PathOverride：未设置 / 空串 / 纯空白都视为未设置，其余去除首尾空白', () => {
  assert.equal(aria2PathOverride(undefined), null)
  assert.equal(aria2PathOverride(''), null)
  assert.equal(aria2PathOverride('   '), null)
  assert.equal(aria2PathOverride('  /opt/aria2/bin/aria2c '), '/opt/aria2/bin/aria2c')
  // Windows 路径原样保留（不加工引号 / 大小写 —— 那是 shell 语义，不是这里的事）
  assert.equal(aria2PathOverride('D:\\tools\\aria2c.exe'), 'D:\\tools\\aria2c.exe')
})

test('getAria2Path：有效覆盖优先于随包子包（本机装了子包也必须用覆盖值）', () => {
  withOverrideEnv(process.execPath, () => {
    // process.execPath 必然存在且 `--version` 退出码 0 —— 与「验证通过」同判据
    assert.equal(getAria2Path(), process.execPath)
  })
})

test('getAria2Path：覆盖指向不存在的文件 -> null，且不回落随包子包 / PATH', () => {
  // 本机 / CI 上通常装着随包子包（win32-x64 / linux-x64）：如果实现错误地
  // 「覆盖失败就回落」，这条断言会在子包存在的环境上立刻爆出来。
  withOverrideEnv('Z:\\not-a-real-place\\aria2c.exe', () => {
    assert.equal(getAria2Path(), null)
  })
})

test('getAria2Path：覆盖指向目录 -> null', () => {
  withOverrideEnv(process.cwd(), () => {
    assert.equal(getAria2Path(), null)
  })
})

test('getAria2Path：纯空白覆盖等价于未设置（走正常解析链，结果与基线一致）', () => {
  withOverrideEnv(undefined, () => {
    const baseline = getAria2Path()
    withOverrideEnv('   ', () => {
      assert.equal(getAria2Path(), baseline)
    })
  })
})

/* ------------------------------ 决策文案 ------------------------------ */

test('decide：aria2 不可用且设置了覆盖 -> reason 指向环境变量而不是子包', () => {
  const probe: ProbeResult = {
    supportsMultiThread: true,
    contentLength: 100 * 1024 * 1024,
  }
  withOverrideEnv('Z:\\broken\\aria2c.exe', () => {
    const decision = decide(probe, false)
    assert.equal(decision.method, 'curl')
    assert.equal(decision.fellback, true)
    assert.match(decision.reason, /DSH_SMARTDL_ARIA2_PATH/)
    assert.match(decision.reason, /当前平台/)
  })
})

test('decide：未设置覆盖时 reason 保持原样（不带覆盖提示）', () => {
  const probe: ProbeResult = {
    supportsMultiThread: true,
    contentLength: 100 * 1024 * 1024,
  }
  withOverrideEnv(undefined, () => {
    const decision = decide(probe, false, { platform: 'ohos', arch: 'arm64' })
    assert.equal(decision.method, 'curl')
    assert.match(decision.reason, /ohos-arm64 不受支持或子包未安装/)
    assert.doesNotMatch(decision.reason, /DSH_SMARTDL_ARIA2_PATH/)
  })
})
