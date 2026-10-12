/**
 * 吞吐缓存（P1-2 存储层）测试。
 *
 * 为什么这些用例值得写：这份缓存是**隐私相关**的本地持久化（会留下「这台机器下过哪些
 * 主机」的痕迹），而且它的读取结果会参与「提并发」这个决策 —— 两件事都不能靠「没抛错」
 * 来证明。因此每条降级路径都断言具体返回值（`null` = 无历史），TTL 一定注入时钟。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  THROUGHPUT_DIR_ENV,
  THROUGHPUT_SAMPLES,
  THROUGHPUT_TTL_MS,
  median,
  readThroughput,
  recordThroughput,
  resolveThroughputDir,
  throughputKey,
} from '../src/throughput-cache.js'

/** 固定的「现在」：TTL 用例必须注入时钟，否则断言会随真实时间漂移 */
const NOW = 1_700_000_000_000
const MB = 1024 * 1024

function tmpDir(prefix = 'throughput-'): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix))
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * 记录文件的预期路径：测试里**独立**算一遍键的规则，而不是调用实现 ——
 * 否则「实现怎么生成文件名都对」，等于没测。
 */
function expectedPath(dir: string, url: string): string {
  const parsed = new URL(url)
  const port =
    parsed.port || (parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : '')
  return path.join(dir, `${sha256Hex(parsed.hostname).slice(0, 32)}-${port}.json`)
}

/* ------------------------------ 缓存键 ------------------------------ */

test('缓存键：按主机 + 端口分桶，同一主机的不同路径落进同一个桶', () => {
  const a = throughputKey('https://dl.example.com/a.zip')
  const b = throughputKey('https://dl.example.com/nested/b.zip?token=1')
  assert.deepEqual(a, b, '同一主机同一端口的两个不同 URL 必须同桶（否则永远命中不了）')

  const otherPort = throughputKey('https://dl.example.com:8443/a.zip')
  assert.notDeepEqual(a, otherPort, '端口不同必须分桶')
  assert.equal(otherPort?.port, '8443')

  const otherHost = throughputKey('https://cdn.example.com/a.zip')
  assert.notEqual(a?.hostHash, otherHost?.hostHash, '主机不同必须分桶')

  assert.equal(throughputKey('http://dl.example.com/a.zip')?.port, '80', 'http 默认端口补 80')
  assert.equal(throughputKey('https://dl.example.com/a.zip')?.port, '443', 'https 默认端口补 443')
  assert.deepEqual(
    throughputKey('https://dl.example.com:443/a.zip'),
    a,
    '显式 :443 与 https 默认端口必须同桶（它们是同一个站点）',
  )
})

test('缓存键：非法 URL 与非 http(s) 协议都返回 null（调用方按「无历史」处理）', () => {
  for (const bad of ['not a url', '', 'ftp://dl.example.com/a.zip', 'file:///tmp/a.zip']) {
    assert.equal(throughputKey(bad), null, `${bad} 不该建桶`)
  }
})

test('缓存键里不含明文主机名：hostHash 就是主机名的 sha256 前缀', () => {
  const key = throughputKey('https://secret-domain.example.com/a.zip')
  assert.ok(key)
  assert.equal(
    key.hostHash,
    sha256Hex('secret-domain.example.com').slice(0, 32),
    'hostHash 必须是主机名的 sha256（而不是别名、base64 或位置混淆）',
  )
  assert.equal(JSON.stringify(key).includes('secret-domain'), false, '键里不得出现明文域名')
})

/* ------------------------------ 记录形状 ------------------------------ */

test('缓存文件里 grep 不到任何明文域名（文件名与内容都只有哈希）', () => {
  const dir = tmpDir()
  try {
    recordThroughput(
      { url: 'https://secret-domain.example.com/a.zip', throughput: 5 * MB, concurrency: 8, cn: 6 },
      { dir, now: NOW },
    )
    const names = readdirSync(dir)
    assert.equal(names.length, 1)
    assert.equal(
      names[0]!.includes('secret-domain'),
      false,
      `文件名不得含明文域名：${names[0]}`,
    )
    const text = readFileSync(expectedPath(dir, 'https://secret-domain.example.com/a.zip'), 'utf-8')
    for (const needle of ['secret-domain', 'example.com', 'secret-domain.example.com']) {
      assert.equal(text.includes(needle), false, `缓存内容不得含「${needle}」：${text}`)
    }
    const parsed = JSON.parse(text) as { hostHash: string }
    assert.equal(parsed.hostHash, sha256Hex('secret-domain.example.com').slice(0, 32))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('记录含最近 N 次的吞吐中位数、当时的并发数、实际有效连接数与更新时间', () => {
  const dir = tmpDir()
  const url = 'https://dl.example.com/a.zip'
  try {
    // 连续记 7 次（超过 N=5）：只留最近 5 个样本；并发/CN/时间取最近一次
    for (let i = 1; i <= 7; i++) {
      recordThroughput(
        { url, throughput: i * MB, concurrency: i === 7 ? 8 : 4, cn: i === 7 ? 6 : 2 },
        { dir, now: NOW + i * 1000 },
      )
    }
    const hit = readThroughput(url, { dir, now: NOW + 10_000 })
    assert.ok(hit, '应当命中')
    assert.deepEqual(
      hit.record.samples,
      [3 * MB, 4 * MB, 5 * MB, 6 * MB, 7 * MB],
      `只保留最近 ${THROUGHPUT_SAMPLES} 个样本`,
    )
    assert.equal(hit.record.medianThroughput, 5 * MB, '中位数按 samples 算（不是均值）')
    assert.equal(hit.record.concurrency, 8, '并发数取最近一次观测')
    assert.equal(hit.record.cn, 6, '实际有效连接数取最近一次观测（P1-1 解析出来的 CN）')
    assert.equal(hit.record.updatedAt, NOW + 7000, '更新时间取最近一次观测')
    assert.equal(hit.key.port, '443')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('中位数：奇数取中间、偶数取中间两个的平均、单样本取自己、空样本返回 0', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 3, 2]), 2.5)
  assert.equal(median([7]), 7)
  assert.equal(median([]), 0, '空样本只是「没东西可算」，返回 0（不会被当成观测值使用）')
  assert.equal(median([5, 5, 1, 1]), 3, '中位数对离群值不敏感（与均值区分开）')
})

/* ------------------------------ TTL ------------------------------ */

test('TTL：窗口内命中，到期视为无历史并顺手淘汰该条', () => {
  const dir = tmpDir()
  const url = 'https://dl.example.com/a.zip'
  try {
    recordThroughput({ url, throughput: 6 * MB, concurrency: 8, cn: 6 }, { dir, now: NOW })
    const file = expectedPath(dir, url)

    assert.ok(readThroughput(url, { dir, now: NOW + THROUGHPUT_TTL_MS - 1 }), '窗口内必须命中')
    assert.equal(readThroughput(url, { dir, now: NOW + THROUGHPUT_TTL_MS }), null, '到期即无历史')
    assert.equal(existsSync(file), false, '过期条目必须被顺手淘汰（否则留下永远不用的死条目）')

    // 过期之后重新记：样本必须从头开始，不能把上一条的旧样本续上
    recordThroughput({ url, throughput: 2 * MB, concurrency: 4, cn: 4 }, { dir, now: NOW + THROUGHPUT_TTL_MS + 1 })
    const restarted = readThroughput(url, { dir, now: NOW + THROUGHPUT_TTL_MS + 2 })
    assert.deepEqual(restarted?.record.samples, [2 * MB], '过期后的新记录只含新样本')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------ 降级（每条都断言具体返回值） ------------------------------ */

test('降级：缓存不存在 -> read 返回 null，且不创建任何目录（读操作必须无副作用）', () => {
  const dir = path.join(tmpDir(), 'never-created')
  try {
    assert.equal(readThroughput('https://dl.example.com/a.zip', { dir, now: NOW }), null)
    assert.equal(existsSync(dir), false, '读路径不得创建目录')
  } finally {
    rmSync(path.dirname(dir), { recursive: true, force: true })
  }
})

test('降级：缓存损坏（各种坏形状）-> 一律 null，绝不半信半疑地用', () => {
  const dir = tmpDir()
  const url = 'https://dl.example.com/a.zip'
  const file = expectedPath(dir, url)
  const hostHash = sha256Hex('dl.example.com').slice(0, 32)
  const good = {
    hostHash,
    port: '443',
    samples: [MB],
    medianThroughput: MB,
    concurrency: 8,
    cn: 6,
    updatedAt: NOW,
  }
  try {
    const broken: Array<[string, string]> = [
      ['不是 JSON', '{oops'],
      ['不是对象', '"just a string"'],
      ['哈希对不上（文件被换过）', JSON.stringify({ ...good, hostHash: 'x'.repeat(32) })],
      ['端口对不上', JSON.stringify({ ...good, port: '8443' })],
      ['样本为空', JSON.stringify({ ...good, samples: [] })],
      ['样本超长（不是本版本写的）', JSON.stringify({ ...good, samples: Array(99).fill(MB) })],
      ['样本含非数字', JSON.stringify({ ...good, samples: [MB, 'fast'] })],
      ['样本含 0/负数', JSON.stringify({ ...good, samples: [0, -1] })],
      ['并发数不是正整数', JSON.stringify({ ...good, concurrency: 1.5 })],
      ['CN 为负', JSON.stringify({ ...good, cn: -1 })],
      ['缺少更新时间', JSON.stringify({ ...good, updatedAt: undefined })],
    ]
    for (const [label, text] of broken) {
      writeFileSync(file, text, 'utf-8')
      assert.equal(readThroughput(url, { dir, now: NOW }), null, `${label} 必须当作无历史`)
    }
    // 正向对照：同一路径下的完整记录必须命中，否则上面那批断言可能只是「永远返回 null」
    writeFileSync(file, JSON.stringify(good), 'utf-8')
    const hit = readThroughput(url, { dir, now: NOW })
    assert.ok(hit, '完整记录必须命中（否则前面的 null 断言是恒真的）')
    assert.equal(hit.record.medianThroughput, MB)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('降级：目录不可写（父路径被文件占住）-> 写入静默忽略、不抛错、不留半个文件', () => {
  const root = tmpDir()
  const blocker = path.join(root, 'blocker')
  const dir = path.join(blocker, 'throughput')
  const url = 'https://dl.example.com/a.zip'
  try {
    writeFileSync(blocker, 'this file occupies the path', 'utf-8')
    recordThroughput({ url, throughput: 5 * MB, concurrency: 8, cn: 6 }, { dir, now: NOW })
    assert.equal(existsSync(dir), false, '目录建不出来时不该留下任何东西')
    assert.equal(readThroughput(url, { dir, now: NOW }), null, '写不进去自然也没有历史')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('降级：目录只读（记录文件不可写）-> 新观测静默丢弃，且不破坏原有内容', () => {
  const dir = tmpDir()
  const url = 'https://dl.example.com/a.zip'
  const file = expectedPath(dir, url)
  try {
    // 先写入一条「证据很弱」的旧记录（并发 4、CN 2），再把它设成只读
    recordThroughput({ url, throughput: 2 * MB, concurrency: 4, cn: 2 }, { dir, now: NOW })
    const before = readFileSync(file, 'utf-8')
    chmodSync(file, 0o444)

    // 只读时的新观测必须静默失败：不抛错，也不把旧记录改坏
    recordThroughput({ url, throughput: 99 * MB, concurrency: 8, cn: 8 }, { dir, now: NOW + 1000 })
    assert.equal(readFileSync(file, 'utf-8'), before, '只读文件的原有内容不得被改动')

    const hit = readThroughput(url, { dir, now: NOW + 1000 })
    assert.ok(hit, '只读不影响读取：历史仍然读得到')
    assert.deepEqual(hit.record.samples, [2 * MB], '仍是旧样本')
    assert.equal(hit.record.updatedAt, NOW, '时间戳不得被同步')
  } finally {
    chmodSync(file, 0o666)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('降级：非法入参（坏 URL / 非正吞吐）-> 静默忽略，不写任何文件', () => {
  const dir = tmpDir()
  try {
    recordThroughput({ url: 'not a url', throughput: 5 * MB, concurrency: 8, cn: 6 }, { dir, now: NOW })
    recordThroughput({ url: 'https://dl.example.com/a.zip', throughput: 0, concurrency: 8, cn: 6 }, { dir, now: NOW })
    recordThroughput(
      { url: 'https://dl.example.com/a.zip', throughput: Number.NaN, concurrency: 8, cn: 6 },
      { dir, now: NOW },
    )
    assert.deepEqual(readdirSync(dir), [], '这些入参不该产生任何缓存文件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------ 目录解析 ------------------------------ */

test('缓存目录：DSH_SMARTDL_THROUGHPUT_DIR 优先，缺省为 <DSH_HOME>/downloads/throughput', () => {
  const savedDir = process.env[THROUGHPUT_DIR_ENV]
  const savedHome = process.env.DSH_HOME
  const explicit = tmpDir('throughput-explicit-')
  const fakeHome = tmpDir('throughput-home-')
  try {
    process.env[THROUGHPUT_DIR_ENV] = explicit
    assert.equal(resolveThroughputDir(), explicit, '环境变量必须优先（显式可覆盖的既有惯例）')

    delete process.env[THROUGHPUT_DIR_ENV]
    process.env.DSH_HOME = fakeHome
    assert.equal(
      resolveThroughputDir(),
      path.join(fakeHome, 'downloads', 'throughput'),
      '缺省位置必须与轨道二（downloads/tasks）并列，而不是另起一套目录规则',
    )
  } finally {
    if (savedDir === undefined) delete process.env[THROUGHPUT_DIR_ENV]
    else process.env[THROUGHPUT_DIR_ENV] = savedDir
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    rmSync(explicit, { recursive: true, force: true })
    rmSync(fakeHome, { recursive: true, force: true })
  }
})

test('缓存目录：resolveThroughputDir 的目录真的能被 recordThroughput 建出来并写进去', () => {
  const savedDir = process.env[THROUGHPUT_DIR_ENV]
  const root = tmpDir('throughput-env-')
  const dir = path.join(root, 'nested', 'cache')
  try {
    process.env[THROUGHPUT_DIR_ENV] = dir
    const url = 'https://dl.example.com/a.zip'
    recordThroughput({ url, throughput: 3 * MB, concurrency: 4, cn: 3 }, { now: NOW })
    assert.equal(existsSync(path.join(dir, readdirSync(dir)[0]!)), true, '应落到 env 指定的目录')
    assert.ok(readThroughput(url, { now: NOW }), '同一 env 下必须读得回来')
  } finally {
    if (savedDir === undefined) delete process.env[THROUGHPUT_DIR_ENV]
    else process.env[THROUGHPUT_DIR_ENV] = savedDir
    rmSync(root, { recursive: true, force: true })
  }
})

test('缓存目录：显式传入的 dir 优先于环境变量（测试与诊断要能隔离状态）', () => {
  const savedDir = process.env[THROUGHPUT_DIR_ENV]
  const envDir = tmpDir('throughput-env2-')
  const explicit = tmpDir('throughput-explicit2-')
  const url = 'https://dl.example.com/a.zip'
  try {
    process.env[THROUGHPUT_DIR_ENV] = envDir
    recordThroughput({ url, throughput: 4 * MB, concurrency: 8, cn: 5 }, { dir: explicit, now: NOW })
    assert.deepEqual(readdirSync(envDir), [], 'env 目录不该被写')
    assert.ok(readThroughput(url, { dir: explicit, now: NOW }), 'explicit dir 必须命中')
    assert.equal(readThroughput(url, { now: NOW }), null, 'env 目录下确实没有记录')
  } finally {
    if (savedDir === undefined) delete process.env[THROUGHPUT_DIR_ENV]
    else process.env[THROUGHPUT_DIR_ENV] = savedDir
    rmSync(envDir, { recursive: true, force: true })
    rmSync(explicit, { recursive: true, force: true })
  }
})

/* ------------------------------ 目录里混着别的文件 ------------------------------ */

test('缓存目录：混着无关文件与其他主机的记录时互不影响', () => {
  const dir = tmpDir()
  const a = 'https://a.example.com/a.zip'
  const b = 'https://b.example.com/b.zip'
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'README.txt'), 'not a cache entry', 'utf-8')
    recordThroughput({ url: a, throughput: 1 * MB, concurrency: 4, cn: 1 }, { dir, now: NOW })
    recordThroughput({ url: b, throughput: 9 * MB, concurrency: 8, cn: 7 }, { dir, now: NOW })
    assert.equal(readThroughput(a, { dir, now: NOW })?.record.medianThroughput, 1 * MB)
    assert.equal(readThroughput(b, { dir, now: NOW })?.record.medianThroughput, 9 * MB)
    assert.equal(
      readThroughput('https://c.example.com/c.zip', { dir, now: NOW }),
      null,
      '没见过的主机必须是没有历史（不猜测、不共享别的桶）',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
