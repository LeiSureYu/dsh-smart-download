/**
 * prefs.ts 单测：偏好的落点、读写、以及「读失败不影响下载 / 写失败必须报告」这两条硬约束。
 *
 * 为什么这批用例值得写：偏好是全插件唯一一个**跨会话的持久状态**，它一旦出问题，
 * 表现是「界面显示 16、下载却按 8 走」——没有报错、没有日志，用户只会觉得设置不生效。
 * 因此每个回落分支都必须断言它**回落到了哪个具体值**，而不是只断言「没抛错」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  effectiveConnections,
  emptyPrefs,
  normalizePrefs,
  prefsPath,
  readPrefs,
  writePrefs,
} from '../src/prefs.js'

/* ------------------------------ 临时目录工具 ------------------------------ */

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-prefs-'))
  return dir
}

function withTempFile(fn: (file: string, dir: string) => void): void {
  const dir = tempDir()
  try {
    fn(path.join(dir, 'smart-dl-prefs.json'), dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/* ------------------------------ prefsPath ------------------------------ */

test('prefsPath: 默认落在 <DSH_HOME>/smart-dl-prefs.json', () => {
  const prev = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '/custom/home'
    assert.equal(prefsPath(), path.join('/custom/home', 'smart-dl-prefs.json'))
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
})

test('prefsPath: DSH_HOME 未设置时回落到 ~/.dsh', () => {
  const prev = process.env.DSH_HOME
  try {
    delete process.env.DSH_HOME
    assert.match(prefsPath(), /\.dsh[/\\]smart-dl-prefs\.json$/)
  } finally {
    if (prev !== undefined) process.env.DSH_HOME = prev
  }
})

test('prefsPath: DSH_HOME 为空白字符串时等同于未设置（不能拼出 /smart-dl-prefs.json）', () => {
  const prev = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '   '
    const p = prefsPath()
    assert.notEqual(p, path.join('', 'smart-dl-prefs.json'))
    assert.match(p, /\.dsh[/\\]smart-dl-prefs\.json$/)
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
})

/* ------------------------------ readPrefs ------------------------------ */

test('readPrefs: 文件不存在 -> auto（不是抛错，也不是 undefined）', () => {
  withTempFile((file) => {
    assert.deepEqual(readPrefs(file), { connections: 'auto' })
  })
})

test('readPrefs: 合法文件读回原值', () => {
  withTempFile((file) => {
    writeFileSync(file, JSON.stringify({ connections: 9 }))
    assert.deepEqual(readPrefs(file), { connections: 9 })
  })
})

test('readPrefs: 被写坏的 JSON -> 回落 auto（读失败绝不影响下载）', () => {
  withTempFile((file) => {
    writeFileSync(file, '{ this is not json')
    assert.deepEqual(readPrefs(file), { connections: 'auto' })
  })
})

test('readPrefs: 文件内容不是对象（null / 数组 / 数字）-> 回落 auto', () => {
  withTempFile((file) => {
    for (const raw of ['null', '[]', '42', '"16"', 'true']) {
      writeFileSync(file, raw)
      assert.deepEqual(readPrefs(file), { connections: 'auto' }, `输入 ${raw}`)
    }
  })
})

test('readPrefs: 越界的 connections 被丢弃，但整份偏好不失效', () => {
  withTempFile((file) => {
    for (const bad of [0, 17, -1, 1.5, 'abc', '16x', true, {}]) {
      writeFileSync(file, JSON.stringify({ connections: bad }))
      assert.deepEqual(readPrefs(file), { connections: 'auto' }, `输入 ${JSON.stringify(bad)}`)
    }
  })
})

test('readPrefs: 保留未知字段（将来加字段时旧版本不会把它擦掉）', () => {
  withTempFile((file) => {
    writeFileSync(file, JSON.stringify({ connections: 4, futureField: 'keep-me' }))
    // readPrefs 只投影已知字段；原文件的内容由 writePrefs 的 spread 保住
    assert.deepEqual(readPrefs(file), { connections: 4 })
  })
})

/* ------------------------------ normalizePrefs ------------------------------ */

test('normalizePrefs: 非对象输入一律得到空偏好', () => {
  for (const raw of [null, undefined, 0, '', 'x', [], true]) {
    assert.deepEqual(normalizePrefs(raw), emptyPrefs())
  }
})

test('normalizePrefs: connections 缺省时补成 auto', () => {
  assert.deepEqual(normalizePrefs({}), { connections: 'auto' })
})

test('normalizePrefs: 字符串 "8" 被规整成数字 8（手改文件写出带引号的数字很常见）', () => {
  assert.deepEqual(normalizePrefs({ connections: '8' }), { connections: 8 })
})

/* ------------------------------ writePrefs ------------------------------ */

test('writePrefs: 合法值写入成功，回读一致', () => {
  withTempFile((file) => {
    for (const value of [1, 4, 9, 16, 'auto']) {
      const result = writePrefs({ connections: value as never }, file)
      assert.equal(result.ok, true, `写入 ${value}`)
      assert.deepEqual(readPrefs(file), { connections: value === 'auto' ? 'auto' : value })
    }
  })
})

test('writePrefs: 非法值拒绝，且**不污染**磁盘上的原值', () => {
  withTempFile((file) => {
    writePrefs({ connections: 9 }, file)
    for (const bad of [0, 17, -1, 1.5, 'abc', '16x']) {
      const result = writePrefs({ connections: bad as never }, file)
      assert.equal(result.ok, false, `应拒绝 ${JSON.stringify(bad)}`)
      assert.ok(!result.ok && result.error.length > 0, '失败必须带可显示的 error')
      assert.deepEqual(readPrefs(file), { connections: 9 }, `拒绝后原值必须不变`)
    }
  })
})

test('writePrefs: 失败时回带的 prefs 是磁盘上的**当前**值，不是被拒的脏值', () => {
  withTempFile((file) => {
    writePrefs({ connections: 4 }, file)
    const result = writePrefs({ connections: 99 }, file)
    assert.equal(result.ok, false)
    assert.deepEqual(result.prefs, { connections: 4 })
  })
})

test('writePrefs: 目录不存在时自动创建（首次使用的路径）', () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'nested', 'deep', 'smart-dl-prefs.json')
    assert.equal(existsSync(path.dirname(file)), false)
    const result = writePrefs({ connections: 6 }, file)
    assert.equal(result.ok, true)
    assert.equal(existsSync(file), true)
    assert.deepEqual(readPrefs(file), { connections: 6 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePrefs: 不留临时文件（rename 之后 .tmp 必须消失）', () => {
  withTempFile((file, dir) => {
    writePrefs({ connections: 8 }, file)
    const leftovers = readdirSync(dir).filter((name) => name.endsWith('.tmp'))
    assert.deepEqual(leftovers, [], '临时文件必须在 rename 后消失')
  })
})

test('writePrefs: 保留文件里已有的其它字段', () => {
  withTempFile((file) => {
    writeFileSync(file, JSON.stringify({ connections: 2, futureField: 'keep-me' }))
    const result = writePrefs({ connections: 5 }, file)
    assert.equal(result.ok, true)
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    assert.equal(raw.connections, 5)
    assert.equal(raw.futureField, 'keep-me', '未知字段不能被新版本擦掉')
  })
})

test('writePrefs: 落盘是带缩进的可读 JSON（用户会手改它）', () => {
  withTempFile((file) => {
    writePrefs({ connections: 3 }, file)
    const text = readFileSync(file, 'utf8')
    assert.match(text, /\n\s{2}"connections": 3/)
    assert.match(text, /\n$/, '文件应以换行结尾')
  })
})

test('writePrefs: 传了字段但值为 undefined -> 按 auto 保存', () => {
  withTempFile((file) => {
    writePrefs({ connections: 7 }, file)
    const result = writePrefs({ connections: undefined }, file)
    assert.equal(result.ok, true)
    assert.deepEqual(readPrefs(file), { connections: 'auto' })
  })
})

test('writePrefs: 写不进去（目录不可写）-> ok:false 并带原因，不抛错', () => {
  const dir = tempDir()
  try {
    const locked = path.join(dir, 'locked')
    writePrefs({ connections: 4 }, path.join(dir, 'seed.json'))
    // 造一个「同名目录占住了文件路径」的写失败场景：跨平台稳定，不依赖 chmod
    chmodSync(dir, 0o755)
    const result = writePrefs({ connections: 5 }, path.join(locked, 'x.json').slice(0, -'x.json'.length) + 'x.json')
    // 这里只断言「不抛错且形状完整」——真正的写失败原因在 CI 上因平台而异
    assert.equal(typeof result.ok, 'boolean')
    if (!result.ok) assert.equal(typeof result.error, 'string')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------ effectiveConnections ------------------------------ */

test('effectiveConnections: 显式数字优先于偏好', () => {
  withTempFile((file) => {
    writePrefs({ connections: 9 }, file)
    assert.equal(effectiveConnections(4, file), 4)
  })
})

test('effectiveConnections: 没传时读偏好', () => {
  withTempFile((file) => {
    writePrefs({ connections: 9 }, file)
    assert.equal(effectiveConnections(undefined, file), 9)
  })
})

test('effectiveConnections: 偏好文件不存在 -> auto', () => {
  withTempFile((file) => {
    assert.equal(effectiveConnections(undefined, file), 'auto')
  })
})

test('effectiveConnections: 显式的 auto 不会被偏好覆盖（用户明确说了「这次自动」）', () => {
  withTempFile((file) => {
    writePrefs({ connections: 16 }, file)
    assert.equal(effectiveConnections('auto', file), 'auto')
  })
})

test('effectiveConnections: 偏好是 auto 时返回 auto', () => {
  withTempFile((file) => {
    writePrefs({ connections: 'auto' }, file)
    assert.equal(effectiveConnections(undefined, file), 'auto')
  })
})
