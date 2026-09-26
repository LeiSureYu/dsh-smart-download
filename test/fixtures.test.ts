/**
 * 真实样本 fixture 契约测试。
 *
 * 设计要点：
 * - fixture 存原始字节，测试不做预处理；curl 样本必须保留 \r（专门断言）；
 * - 切分使用生产代码 splitIntoLines，避免测试自己复刻换行逻辑而绕过 LineBuffer；
 * - “值断言”锁定本次已知数字，“结构断言”锁定该类行的形状，二者都要；
 * - 全部为正向断言：必须真的解析出进度，而不是“不抛错”。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  parseAria2Summary,
  parseCurlProgress,
  splitIntoLines,
} from '../src/progress-parse.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixtureDir = join(here, 'fixtures')

/* ------------------------------ aria2 真实 summary ------------------------------ */

test('aria2 真实样本：结构契约 + 值断言（含噪声行）', async () => {
  const raw = await readFile(join(fixtureDir, 'aria2-summary-real.txt'), 'utf8')

  // 结构断言：原始文本中必须存在 summary 行的整体形状（DL 字段）
  assert.match(
    raw,
    /\[#[\w]+\s+[\d.]+\s*[KMGTPE]?i?B\/[\d.]+\s*[KMGTPE]?i?B\(\d+%\)\s+CN:\d+\s+DL:[\d.]+\s*[KMGTPE]?i?B/,
  )

  // 用生产切分器在真实噪声里逐行解析
  const parsed = splitIntoLines(raw)
    .map((line) => parseAria2Summary(line))
    .filter((v): v is NonNullable<typeof v> => v !== null)

  // 正向信号：必须认出 27 / 55 / 82 三条摘要
  const byPct = new Map(parsed.map((p) => [p.pct, p]))
  assert.ok(byPct.has(27), '应解析出 27%')
  assert.ok(byPct.has(55), '应解析出 55%')
  assert.ok(byPct.has(82), '应解析出 82%（无 ETA 的临近完成行）')

  // 值断言：速度规范化、ETA 字段
  assert.equal(byPct.get(27)?.spd, '10MiB/s')
  assert.equal(byPct.get(27)?.eta, '2s')
  assert.equal(byPct.get(55)?.eta, '1s')
  assert.equal(byPct.get(82)?.eta, undefined, '82% 行 aria2 省略 ETA')
})

/* ------------------------------ aria2 兼容（旧 readout） ------------------------------ */

test('aria2 兼容样本：SIZE:/SPD: 旧格式仍可解析', async () => {
  const raw = await readFile(join(fixtureDir, 'aria2-summary-compat.txt'), 'utf8')

  // 结构断言：旧 SPD/SIZE 形状
  assert.match(
    raw,
    /\[#\d+\s+SIZE:[\d.]+\s*[KMGT]?i?B\/[\d.]+\s*[KMGT]?i?B\(\d+%\)\s+CN:\d+\s+SPD:[\d.]+\s*[KMGT]?i?Bs/,
  )

  const parsed = splitIntoLines(raw)
    .map((l) => parseAria2Summary(l))
    .filter((v): v is NonNullable<typeof v> => v !== null)

  const byPct = new Map(parsed.map((p) => [p.pct, p]))
  assert.equal(byPct.get(1)?.pct, 1)
  assert.equal(byPct.get(1)?.spd, '115.7KiB/s')
  assert.equal(byPct.get(1)?.eta, '4m51s')
  assert.equal(byPct.get(24)?.spd, '2.5MiB/s')
  assert.equal(byPct.get(24)?.eta, '0m10s')
})

/* ------------------------------ curl 原始字节（\r） ------------------------------ */

test('curl 真实样本：原始 \\r 字节，解析出单调递增到 100%', async () => {
  const buf = await readFile(join(fixtureDir, 'curl-progress-real.bin'))
  // latin1 单字节解码，原样保留 \r
  const raw = buf.toString('latin1')

  // 元断言：fixture 仍是原始字节，必须含 \r（防止被人换成 \n 而绕过切分逻辑）
  assert.ok(raw.includes('\r'), 'curl fixture 必须保留 \\r')
  // 结构断言：进度条形状
  assert.match(raw, /#+\s+\d+(?:\.\d+)?%/)

  // 用生产切分器（按 \r 切）+ 生产百分比解析
  const pcts = splitIntoLines(raw)
    .map((line) => parseCurlProgress(line))
    .filter((v): v is number => v !== null)

  // 正向信号：必须解析出多个进度点
  assert.ok(pcts.length >= 10, `应解析出多个进度点，实际 ${pcts.length}`)
  assert.equal(pcts[0], 3.1)
  assert.equal(pcts[pcts.length - 1], 100, '最终进度应为 100%')

  // 值断言：单调非递减
  for (let i = 1; i < pcts.length; i++) {
    assert.ok(pcts[i] >= pcts[i - 1], `进度回退：${pcts[i - 1]} -> ${pcts[i]}`)
  }
})
