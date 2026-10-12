/**
 * hash.ts 测试：摘要归一化、流式计算与比对。
 *
 * 遵循本仓库的「正向信号」契约：每条用例都断言“真的产出了正确结果”，而不是
 * “没有崩溃”。哈希校验的静默失败形态是「没验却看起来验过了」，所以归一化的
 * 失败路径必须断言**返回 null**（调用方据此在下载前拒绝），而不是断言不抛错。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HASH_UNREADABLE_MESSAGE,
  HASH_VERIFIED_MESSAGE,
  describeHashFailure,
  describeHashMismatch,
  normalizeSha256,
  sha256File,
  verifySha256,
} from '../src/hash.js'

/** 已知向量：sha256("abc") */
const ABC_HEX = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
/** 同一摘要的 SRI（base64）写法 */
const ABC_B64 = Buffer.from(ABC_HEX, 'hex').toString('base64')

/* ------------------------------ 归一化 ------------------------------ */

test('normalizeSha256: 裸十六进制（大小写均可）', () => {
  assert.equal(normalizeSha256(ABC_HEX), ABC_HEX)
  assert.equal(normalizeSha256(ABC_HEX.toUpperCase()), ABC_HEX, '大写必须归一成小写')
  assert.equal(normalizeSha256(`  ${ABC_HEX}  `), ABC_HEX, '首尾空白必须裁掉')
})

test('normalizeSha256: 带算法前缀的三种常见写法', () => {
  assert.equal(normalizeSha256(`sha256:${ABC_HEX}`), ABC_HEX)
  assert.equal(normalizeSha256(`sha256=${ABC_HEX}`), ABC_HEX)
  assert.equal(normalizeSha256(`SHA256(${ABC_HEX})`), ABC_HEX)
  assert.equal(normalizeSha256(`sha256: ${ABC_HEX}`), ABC_HEX, '冒号后允许空格')
})

test('normalizeSha256: SRI 写法 sha256-<base64>（网页 integrity 属性里的形式）', () => {
  assert.equal(normalizeSha256(`sha256-${ABC_B64}`), ABC_HEX)
  // base64 解出来不是 32 字节 -> 拒绝，而不是悄悄截断
  assert.equal(normalizeSha256('sha256-YWJj'), null, '3 字节的 base64 不是 SHA-256')
})

test('normalizeSha256: 不合法输入一律返回 null（调用方据此在下载前拒绝）', () => {
  assert.equal(normalizeSha256(''), null)
  assert.equal(normalizeSha256('   '), null)
  // 少一位 / 多一位：长度必须精确是 64
  assert.equal(normalizeSha256(ABC_HEX.slice(0, 63)), null)
  assert.equal(normalizeSha256(`${ABC_HEX}0`), null)
  // 含非十六进制字符
  assert.equal(normalizeSha256('z'.repeat(64)), null)
  assert.equal(normalizeSha256(`${ABC_HEX.slice(0, 63)}z`), null)
  // 别的算法前缀：本插件只认 SHA-256，不做算法协商
  assert.equal(normalizeSha256(`md5:${ABC_HEX}`), null)
  assert.equal(normalizeSha256(`sha1:${ABC_HEX}`), null)
  // 完全不是摘要
  assert.equal(normalizeSha256('not-a-hash'), null)
})

/* ------------------------------ 文件摘要 ------------------------------ */

test('sha256File: 真实文件算出已知向量', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hash-test-'))
  try {
    const file = join(dir, 'abc.txt')
    writeFileSync(file, 'abc')
    assert.equal(await sha256File(file), ABC_HEX)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sha256File: 大文件走流式，结果与整体一致（不整份读进内存）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hash-test-'))
  try {
    const file = join(dir, 'big.bin')
    // 8MB：远超单次读取的典型分块，用来证明流式拼接不会丢块
    const chunk = Buffer.alloc(1024 * 1024, 0x5a)
    writeFileSync(file, Buffer.concat(Array.from({ length: 8 }, () => chunk)))
    const digest = await sha256File(file)
    assert.equal(typeof digest, 'string')
    assert.equal(digest?.length, 64)
    // 与一次性计算的结果必须一致
    const { createHash } = await import('node:crypto')
    const expected = createHash('sha256')
      .update(Buffer.concat(Array.from({ length: 8 }, () => chunk)))
      .digest('hex')
    assert.equal(digest, expected)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sha256File: 文件不存在 -> null（不是抛异常，也不是空串）', async () => {
  assert.equal(await sha256File(join(tmpdir(), 'definitely-missing-dsh-smartdl.bin')), null)
})

/* ------------------------------ 比对 ------------------------------ */

test('verifySha256: 一致 -> ok，并带回实际摘要', () => {
  const outcome = verifySha256(ABC_HEX, ABC_HEX)
  assert.equal(outcome.kind, 'ok')
  assert.equal(outcome.kind === 'ok' ? outcome.digest : '', ABC_HEX)
})

test('verifySha256: 等长但内容不同 -> mismatch（这正是长度校验挡不住的场景）', () => {
  const other = 'f'.repeat(64)
  const outcome = verifySha256(ABC_HEX, other)
  assert.equal(outcome.kind, 'mismatch')
  assert.equal(outcome.kind === 'mismatch' ? outcome.expected : '', ABC_HEX)
  assert.equal(outcome.kind === 'mismatch' ? outcome.actual : '', other)
})

test('verifySha256: 文件读不到 -> unreadable（不是 mismatch，也不是 ok）', () => {
  const outcome = verifySha256(ABC_HEX, null)
  assert.equal(outcome.kind, 'unreadable')
})

test('describeHashMismatch: 期望与实际都出现在文案里，且标明是校验失败', () => {
  const message = describeHashMismatch({ kind: 'mismatch', expected: ABC_HEX, actual: 'f'.repeat(64) })
  assert.match(message, /完整性校验失败/)
  assert.match(message, /SHA-256/)
  assert.ok(message.includes(ABC_HEX), '期望摘要必须可见')
  assert.ok(message.includes('f'.repeat(64)), '实际摘要必须可见')
})

test('describeHashMismatch: 两个 64 位摘要不并排在同一行（否则人眼定位不到差异）', () => {
  const other = 'f'.repeat(64)
  const message = describeHashMismatch({ kind: 'mismatch', expected: ABC_HEX, actual: other })
  const lines = message.split('\n')
  const expectedLine = lines.find((l) => l.includes(ABC_HEX))
  const actualLine = lines.find((l) => l.includes(other))
  assert.ok(expectedLine, '期望摘要必须在某一行上出现')
  assert.ok(actualLine, '实际摘要必须在某一行上出现')
  // 关键正向断言：两者必须落在**不同的行**上，且各自那一行不包含对方
  assert.notEqual(expectedLine, actualLine, '两个摘要不得并排在同一行')
  assert.ok(!expectedLine!.includes(other), '期望摘要那一行不得同时含实际摘要')
  assert.ok(!actualLine!.includes(ABC_HEX), '实际摘要那一行不得同时含期望摘要')
})

test('describeHashMismatch: 带「下一步」，且提示「期望摘要可能抄错」', () => {
  const message = describeHashMismatch({ kind: 'mismatch', expected: ABC_HEX, actual: 'f'.repeat(64) })
  // 只断言「下一步信息存在」，不逐字断言整句（以后改措辞不该让用例红）
  assert.match(message, /下一步/)
  assert.match(message, /重跑|重试/)
  assert.match(message, /旁车/)
  // 摘要不符有两种原因（内容被换 / 期望值抄错），后者不提示就会一直重下
  assert.match(message, /期望摘要|抄错/)
})

test('HASH_UNREADABLE_MESSAGE: 与 mismatch 是两句不同的话，且都带「下一步」', () => {
  assert.match(HASH_UNREADABLE_MESSAGE, /下一步/)
  assert.match(HASH_UNREADABLE_MESSAGE, /重跑|重试/)
  assert.notEqual(HASH_UNREADABLE_MESSAGE, describeHashMismatch({
    kind: 'mismatch',
    expected: ABC_HEX,
    actual: 'f'.repeat(64),
  }))
})

test('describeHashFailure: 两条失败路径各自给出固定文案', () => {
  const mismatch = { kind: 'mismatch', expected: ABC_HEX, actual: 'f'.repeat(64) } as const
  // 摘要不符：文案就是 describeHashMismatch 的那一句
  assert.equal(describeHashFailure(mismatch), describeHashMismatch(mismatch))
  // 文件读不到：必须是**另一句**，否则「没读成」与「内容不对」在用户眼里长得一样
  assert.equal(describeHashFailure({ kind: 'unreadable' }), HASH_UNREADABLE_MESSAGE)
  assert.notEqual(describeHashFailure({ kind: 'unreadable' }), describeHashFailure(mismatch))
})

test('固定文案是常量，不是就地拼串（改动会被用例拦下）', () => {
  // 断言的是「以原因句开头」而不是整串相等：原因句是常量、后续的「下一步」
  // 段落可以调整措辞。整串相等的断言会让每次改措辞都要动测试。
  assert.ok(
    HASH_UNREADABLE_MESSAGE.startsWith('下载完整性校验失败：无法读取落盘文件以计算 SHA-256'),
    `不可读文案的原因句必须固定，实际：${HASH_UNREADABLE_MESSAGE}`,
  )
  assert.equal(HASH_VERIFIED_MESSAGE, 'SHA-256 已校验')
})
