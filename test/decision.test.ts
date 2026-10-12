/**
 * decision.ts 单测：覆盖决策树的所有分支，以及 P1-2 读侧（历史吞吐抬档）的全部降级路径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  HISTORY_RAISE_REASON,
  MAX_CONCURRENCY,
  RAISE_MIN_EFFECTIVE_CONNECTIONS,
  decide,
  decideConcurrency,
  LARGE_FILE,
  SIZE_THRESHOLD,
} from '../src/decision.js'
import { recordThroughput, throughputKey } from '../src/throughput-cache.js'
import type { Decision, ProbeResult } from '../src/types.js'

const MB = 1024 * 1024

/** 构造一个默认“支持多线程”的探测结果，按需覆盖字段 */
function probe(overrides: Partial<ProbeResult>): ProbeResult {
  return { supportsMultiThread: true, ...overrides }
}

/* ------------------------------ decideConcurrency ------------------------------ */

test('decideConcurrency: < 8MB -> 4（0.7.0 实测：2MB 文件 x=2 就到顶，再高反而略降）', () => {
  assert.equal(decideConcurrency(2 * MB), 4)
  assert.equal(decideConcurrency(7 * MB), 4)
})

test('decideConcurrency: >= 8MB -> 8（0.7.0 实测：8MB 下 x=8 比 x=4 快近一倍）', () => {
  assert.equal(decideConcurrency(LARGE_FILE), 8)
  assert.equal(decideConcurrency(49 * MB), 8)
  assert.equal(decideConcurrency(200 * MB), 8)
})

test('LARGE_FILE 阈值已从 50MB 下调为 8MB（0.7.0 实测依据）', () => {
  // 正向断言：钉住实测结论，防止有人无意改回 50MB 让 8~50MB 掉回 4 连接
  assert.equal(LARGE_FILE, 8 * 1024 * 1024)
})

/* ------------------------------ decide: 回退分支 ------------------------------ */

test('decide: 不支持多线程 -> curl，reason 透传', () => {
  const d = decide({ supportsMultiThread: false, reason: '服务器不支持 Range' }, true)
  assert.equal(d.method, 'curl')
  assert.equal(d.concurrency, 1)
  assert.equal(d.fellback, true)
  assert.equal(d.reason, '服务器不支持 Range')
})

test('decide: 探测失败无 reason -> curl，带默认理由', () => {
  const d = decide({ supportsMultiThread: false }, true)
  assert.equal(d.method, 'curl')
  assert.match(d.reason, /探测判定/)
})

test('decide: 无 contentLength -> curl', () => {
  const d = decide(probe({ contentLength: undefined }), true)
  assert.equal(d.method, 'curl')
  assert.match(d.reason, /无法获取文件大小/)
})

test('decide: 文件 < 1MB -> curl，理由含 KB', () => {
  const d = decide(probe({ contentLength: 500 * 1024 }), true)
  assert.equal(d.method, 'curl')
  assert.match(d.reason, /500KB/)
})

test('decide: aria2 不可用 -> curl', () => {
  const d = decide(probe({ contentLength: 100 * MB }), false)
  assert.equal(d.method, 'curl')
  assert.match(d.reason, /aria2/)
})

test('decide: aria2 不可用时的理由带当前平台（env 可注入，平台依赖已纯函数化）', () => {
  // 0.6.0 之前 decide() 直接读 process.platform，测试跑在哪个平台就只能断言
  // 哪个平台；现在通过 env 注入，可以覆盖任意平台组合。
  const d = decide(probe({ contentLength: 100 * MB }), false, {
    platform: 'darwin',
    arch: 'arm64',
  })
  assert.equal(d.method, 'curl')
  assert.match(d.reason, /darwin-arm64/)
})

test('decide: 不传 env 时仍回落真实 process.platform / process.arch（行为不变）', () => {
  const d = decide(probe({ contentLength: 100 * MB }), false)
  assert.match(d.reason, new RegExp(`${process.platform}-${process.arch}`))
})

test('decide: env 只给一个字段时，另一个仍取真实环境', () => {
  const d = decide(probe({ contentLength: 100 * MB }), false, { platform: 'linux' })
  assert.match(d.reason, new RegExp(`linux-${process.arch}`))
})

/* ------------------------------ decide: aria2 分支 ------------------------------ */

test('decide: 1MB~8MB + aria2 可用 -> aria2 4 连接', () => {
  const d = decide(probe({ contentLength: 2 * MB }), true)
  assert.equal(d.method, 'aria2')
  assert.equal(d.concurrency, 4)
  assert.equal(d.fellback, false)
  assert.match(d.reason, /4 连接/)
})

test('decide: 8MB~50MB + aria2 可用 -> aria2 8 连接（0.7.0 修正：此前被压在 4）', () => {
  const d = decide(probe({ contentLength: 10 * MB }), true)
  assert.equal(d.method, 'aria2')
  assert.equal(d.concurrency, 8)
  assert.equal(d.fellback, false)
  assert.match(d.reason, /8 连接/)
})

test('decide: >= 50MB + aria2 可用 -> aria2 8 连接', () => {
  const d = decide(probe({ contentLength: 200 * MB }), true)
  assert.equal(d.method, 'aria2')
  assert.equal(d.concurrency, 8)
  assert.equal(d.fellback, false)
  assert.match(d.reason, /8 连接/)
})

test('decide: 刚好等于 1MB 阈值 -> aria2 4 连接（边界）', () => {
  const d = decide(probe({ contentLength: SIZE_THRESHOLD }), true)
  assert.equal(d.method, 'aria2')
  assert.equal(d.concurrency, 4)
})

test('decide: 刚好等于 8MB 阈值 -> aria2 8 连接（边界）', () => {
  const d = decide(probe({ contentLength: LARGE_FILE }), true)
  assert.equal(d.method, 'aria2')
  assert.equal(d.concurrency, 8)
})

/* ------------------------- P1-2 读侧：历史吞吐抬档 ------------------------- */

const NOW = 1_700_000_000_000
const HISTORY_URL = 'https://dl.example.com/a.zip'
/** 决策里带平台的分支要固定住平台，否则断言会随跑测试的机器变 */
const ENV = { platform: 'linux', arch: 'x64' }

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'decision-history-'))
}

/**
 * 基线：**不传**历史入参时的返回值。所有降级用例都要求与它 `deepEqual`（逐字段相同），
 * 而不是「没抛错」—— 这是「只抬档、不降档」这条不变量的硬回归项。
 */
function baseline(size: number): Decision {
  return decide(probe({ contentLength: size }), true, ENV)
}

/** 写入一条「证据充分」的历史：上次就用满上限 8 连接，且实际开出了 6 条 */
function seedStrong(dir: string, options: { url?: string; now?: number } = {}): void {
  recordThroughput(
    { url: options.url ?? HISTORY_URL, throughput: 12 * MB, concurrency: MAX_CONCURRENCY, cn: 6 },
    { dir, now: options.now ?? NOW },
  )
}

test('P1-2 抬档：1MB~8MB 的文件遇到强证据历史 -> 提到上限 8，reason 写明依据与数值', () => {
  const dir = tmpDir()
  const size = 6 * MB
  try {
    seedStrong(dir)
    const d = decide(probe({ contentLength: size }), true, ENV, {
      url: HISTORY_URL,
      dir,
      now: NOW + 1000,
    })
    assert.equal(d.method, 'aria2')
    assert.equal(d.concurrency, MAX_CONCURRENCY, '6MB 按大小只给 4，命中历史后应提到 8')
    assert.equal(d.fellback, false)

    // 必须能一眼区分「按大小分档」与「按历史抬档」——这是验收里点名的那条
    assert.match(d.reason, new RegExp(HISTORY_RAISE_REASON))
    assert.notDeepEqual(d, baseline(size), '抬档后的返回值必须与按大小分档的结果不同')
    const key = throughputKey(HISTORY_URL)
    assert.ok(key)
    assert.match(d.reason, new RegExp(key.hostHash), 'reason 必须带上主机标识（哈希）')
    assert.match(d.reason, new RegExp(`端口 ${key.port}`))
    assert.match(d.reason, /实测实际有效 6 条/, 'reason 必须带上当时实际有效连接数')
    assert.match(d.reason, /吞吐中位数 12\.00MB\/s/, 'reason 必须带上吞吐中位数')
    assert.match(d.reason, /按大小只给 4/, 'reason 必须说明按大小本来给几档')
    assert.doesNotMatch(d.reason, /example\.com/, '隐私口径：文案里也不得出现明文域名')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P1-2 降级①：无历史（目录存在但没这条主机）-> 与不传历史逐字段相同', () => {
  const dir = tmpDir()
  try {
    mkdirSync(dir, { recursive: true })
    const d = decide(probe({ contentLength: 6 * MB }), true, ENV, { url: HISTORY_URL, dir, now: NOW })
    assert.deepEqual(d, baseline(6 * MB))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P1-2 降级②：缓存不存在（目录都没有）-> 与不传历史逐字段相同，且不创建目录', () => {
  const root = tmpDir()
  const dir = path.join(root, 'never-created')
  try {
    const d = decide(probe({ contentLength: 6 * MB }), true, ENV, { url: HISTORY_URL, dir, now: NOW })
    assert.deepEqual(d, baseline(6 * MB))
    assert.equal(existsSync(dir), false, '决策不得因为「查了历史」就建目录')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('P1-2 降级③：缓存损坏 -> 与不传历史逐字段相同（绝不半信半疑地用）', () => {
  const dir = tmpDir()
  try {
    const key = throughputKey(HISTORY_URL)
    assert.ok(key)
    writeFileSync(path.join(dir, `${key.hostHash}-${key.port}.json`), '{not json', 'utf-8')
    const d = decide(probe({ contentLength: 6 * MB }), true, ENV, { url: HISTORY_URL, dir, now: NOW })
    assert.deepEqual(d, baseline(6 * MB))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P1-2 降级④：目录不可写（父路径被文件占住）-> 与不传历史逐字段相同', () => {
  const root = tmpDir()
  const dir = path.join(root, 'blocker', 'throughput')
  try {
    writeFileSync(path.join(root, 'blocker'), 'occupied', 'utf-8')
    // 写侧：静默忽略（不抛错）
    seedStrong(dir)
    // 读侧：当作没有历史
    const d = decide(probe({ contentLength: 6 * MB }), true, ENV, { url: HISTORY_URL, dir, now: NOW })
    assert.deepEqual(d, baseline(6 * MB))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('P1-2 降级⑤：目录只读（记录文件不可写）-> 与不传历史逐字段相同，且文件不被改动', () => {
  const dir = tmpDir()
  const file = path.join(
    dir,
    `${(throughputKey(HISTORY_URL) as { hostHash: string }).hostHash}-443.json`,
  )
  try {
    // 只读记录里只有弱证据（并发 4、实际 2 条）：读得到但不足以抬档
    recordThroughput({ url: HISTORY_URL, throughput: 2 * MB, concurrency: 4, cn: 2 }, { dir, now: NOW })
    const before = readFileSync(file, 'utf-8')
    chmodSync(file, 0o444)

    // 只读时再想写一条强证据：静默失败（不抛错、不改内容）
    seedStrong(dir)
    assert.equal(readFileSync(file, 'utf-8'), before, '只读记录不得被改写')

    const d = decide(probe({ contentLength: 6 * MB }), true, ENV, { url: HISTORY_URL, dir, now: NOW })
    assert.deepEqual(d, baseline(6 * MB))
  } finally {
    chmodSync(file, 0o666)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P1-2 降级：历史入参的 URL 不合法 -> 与不传历史逐字段相同', () => {
  const dir = tmpDir()
  try {
    const d = decide(probe({ contentLength: 6 * MB }), true, ENV, { url: 'not a url', dir, now: NOW })
    assert.deepEqual(d, baseline(6 * MB))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P1-2 只抬不降：证据不足（没开满 / 实际只有 1 条）一律回到按大小分档', () => {
  const dir = tmpDir()
  try {
    // 证据一：上次只请求了 4 连接（没到上限档）
    recordThroughput({ url: HISTORY_URL, throughput: 12 * MB, concurrency: 4, cn: 4 }, { dir, now: NOW })
    assert.deepEqual(
      decide(probe({ contentLength: 6 * MB }), true, ENV, { url: HISTORY_URL, dir, now: NOW }),
      baseline(6 * MB),
      '没开满上限的历史不足以抬档',
    )

    // 证据二：请求了 8 连接，但实际只跑出 1 条（服务器限并发 / 分片不够）
    const dir2 = tmpDir()
    try {
      recordThroughput({ url: HISTORY_URL, throughput: 12 * MB, concurrency: 8, cn: 1 }, { dir: dir2, now: NOW })
      assert.deepEqual(
        decide(probe({ contentLength: 6 * MB }), true, ENV, { url: HISTORY_URL, dir: dir2, now: NOW }),
        baseline(6 * MB),
        `实际有效连接数低于 ${RAISE_MIN_EFFECTIVE_CONNECTIONS} 时不得抬档`,
      )
    } finally {
      rmSync(dir2, { recursive: true, force: true })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P1-2 只抬不降：历史再难看也不把已有档位降下来', () => {
  const dir = tmpDir()
  try {
    // 一条「极慢」的历史（并发 1、实际 1 条）：如果实现有降档逻辑，100MB 会被降成 4 或 1
    recordThroughput({ url: HISTORY_URL, throughput: 0.05 * MB, concurrency: 1, cn: 1 }, { dir, now: NOW })
    assert.deepEqual(
      decide(probe({ contentLength: 100 * MB }), true, ENV, { url: HISTORY_URL, dir, now: NOW }),
      baseline(100 * MB),
      '历史慢不足以证明这次慢（可能是临时拥塞）：100MB 必须仍然是 8',
    )
    assert.equal(baseline(100 * MB).concurrency, MAX_CONCURRENCY)

    // 已经在上限档的文件不产生任何「抬档」文案：没有可抬的空间就与今天逐字段相同
    const dir2 = tmpDir()
    try {
      seedStrong(dir2)
      const d = decide(probe({ contentLength: 20 * MB }), true, ENV, { url: HISTORY_URL, dir: dir2, now: NOW })
      assert.deepEqual(d, baseline(20 * MB), '本来就给 8 的文件不该出现抬档文案')
      assert.doesNotMatch(d.reason, new RegExp(HISTORY_RAISE_REASON))
    } finally {
      rmSync(dir2, { recursive: true, force: true })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P1-2 抬档不得越过既有上限 8：即使记录声称 16 连接，也只能到 8', () => {
  const dir = tmpDir()
  const key = throughputKey(HISTORY_URL)
  assert.ok(key)
  try {
    // 手工构造一条越界记录（模拟别的版本写的 / 手改的文件）：形状合法，但并发是 16
    writeFileSync(
      path.join(dir, `${key.hostHash}-${key.port}.json`),
      JSON.stringify({
        hostHash: key.hostHash,
        port: key.port,
        samples: [20 * MB],
        medianThroughput: 20 * MB,
        concurrency: 16,
        cn: 16,
        updatedAt: NOW,
      }),
      'utf-8',
    )
    const d = decide(probe({ contentLength: 6 * MB }), true, ENV, { url: HISTORY_URL, dir, now: NOW })
    assert.equal(d.concurrency, MAX_CONCURRENCY, '抬档的上限就是既有的 8 连接取舍')
    assert.equal(MAX_CONCURRENCY, 8)
    assert.equal(decideConcurrency(1024 * MB), MAX_CONCURRENCY)
    // 历史里的并发数可以原样引用（那是当时的观测事实），但**不得**说成本次使用的并发：
    // 最终用的是上限档，且文案必须明写这是「插件并发上限」。
    assert.match(d.reason, /提到 8（插件并发上限）/)
    assert.doesNotMatch(d.reason, /(提到|使用) 16/, '不得把越界的历史并发说成本次会用的档位')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P1-2 不传历史时不碰磁盘：缓存目录指向坏路径也照样按大小分档', () => {
  const saved = process.env.DSH_SMARTDL_THROUGHPUT_DIR
  const root = tmpDir()
  try {
    // 把默认缓存目录指到一个「父路径是文件」的坏位置：只要 decide 去读它就会失败
    writeFileSync(path.join(root, 'blocker'), 'occupied', 'utf-8')
    process.env.DSH_SMARTDL_THROUGHPUT_DIR = path.join(root, 'blocker', 'throughput')
    assert.deepEqual(decide(probe({ contentLength: 6 * MB }), true, ENV), baseline(6 * MB))
    assert.deepEqual(decide(probe({ contentLength: 100 * MB }), true, ENV), baseline(100 * MB))
  } finally {
    if (saved === undefined) delete process.env.DSH_SMARTDL_THROUGHPUT_DIR
    else process.env.DSH_SMARTDL_THROUGHPUT_DIR = saved
    rmSync(root, { recursive: true, force: true })
  }
})

test('P1-2 抬档不影响 curl 分支：不支持多线程 / 太小 / 无长度时一律与今天相同', () => {
  const dir = tmpDir()
  try {
    seedStrong(dir)
    const history = { url: HISTORY_URL, dir, now: NOW }
    const cases: ProbeResult[] = [
      probe({ supportsMultiThread: false, reason: '不支持 Range' }),
      probe({ contentLength: 512 * 1024 }),
      probe({ contentLength: undefined }),
    ]
    for (const p of cases) {
      assert.deepEqual(
        decide(p, true, ENV, history),
        decide(p, true, ENV),
        'curl 分支（走不了 aria2）不该被历史改动',
      )
    }
    // aria2 不可用时同理
    const noAria2 = probe({ contentLength: 6 * MB })
    assert.deepEqual(decide(noAria2, false, ENV, history), decide(noAria2, false, ENV))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
