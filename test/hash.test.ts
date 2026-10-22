/**
 * hash.ts 测试：摘要归一化、流式计算与比对。
 *
 * 遵循本仓库的「正向信号」契约：每条用例都断言“真的产出了正确结果”，而不是
 * “没有崩溃”。哈希校验的静默失败形态是「没验却看起来验过了」，所以归一化的
 * 失败路径必须断言**返回 null**（调用方据此在下载前拒绝），而不是断言不抛错。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CHECKSUM_LABELS,
  HASH_UNREADABLE_MESSAGE,
  HASH_VERIFIED_MESSAGE,
  checksumUnreadableMessage,
  checksumVerifiedMessage,
  describeHashFailure,
  describeHashMismatch,
  hashFile,
  normalizeChecksum,
  normalizeSha256,
  sha256File,
  verifyChecksum,
  verifySha256,
} from '../src/hash.js'

/** 已知向量：sha256("abc") */
const ABC_HEX = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
/** 同一摘要的 SRI（base64）写法 */
const ABC_B64 = Buffer.from(ABC_HEX, 'hex').toString('base64')
/** 已知向量：md5("abc") / sha1("abc") / sha512("abc") */
const ABC_MD5 = '900150983cd24fb0d6963f7d28e17f72'
const ABC_SHA1 = 'a9993e364706816aba3e25717850c26c9cd0d89d'
const ABC_SHA512 =
  'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a' +
  '2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f'

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

/* ---------------------- 1.5.0：通用摘要（md5 / sha1 / sha512） ---------------------- */

test('normalizeChecksum: 裸十六进制按长度识别四种算法', () => {
  assert.deepEqual(normalizeChecksum(ABC_MD5), { algorithm: 'md5', digest: ABC_MD5 })
  assert.deepEqual(normalizeChecksum(ABC_SHA1), { algorithm: 'sha1', digest: ABC_SHA1 })
  assert.deepEqual(normalizeChecksum(ABC_HEX), { algorithm: 'sha256', digest: ABC_HEX })
  assert.deepEqual(normalizeChecksum(ABC_SHA512), { algorithm: 'sha512', digest: ABC_SHA512 })
  // 大写输入必须归一成小写，长度不受影响
  assert.deepEqual(normalizeChecksum(ABC_SHA1.toUpperCase()), {
    algorithm: 'sha1',
    digest: ABC_SHA1,
  })
  assert.deepEqual(normalizeChecksum(`  ${ABC_MD5}  `), { algorithm: 'md5', digest: ABC_MD5 })
})

test('normalizeChecksum: 带算法前缀的三种写法（冒号 / 等号 / 括号）', () => {
  assert.deepEqual(normalizeChecksum(`md5:${ABC_MD5}`), { algorithm: 'md5', digest: ABC_MD5 })
  assert.deepEqual(normalizeChecksum(`sha1=${ABC_SHA1}`), {
    algorithm: 'sha1',
    digest: ABC_SHA1,
  })
  assert.deepEqual(normalizeChecksum(`SHA512(${ABC_SHA512})`), {
    algorithm: 'sha512',
    digest: ABC_SHA512,
  })
  // 前缀大小写不敏感，冒号后允许空白
  assert.deepEqual(normalizeChecksum(`SHA256: ${ABC_HEX}`), {
    algorithm: 'sha256',
    digest: ABC_HEX,
  })
})

test('normalizeChecksum: SRI 的 sha256- / sha512- 会解码成十六进制', () => {
  assert.deepEqual(normalizeChecksum(`sha256-${ABC_B64}`), {
    algorithm: 'sha256',
    digest: ABC_HEX,
  })
  const sha512B64 = Buffer.from(ABC_SHA512, 'hex').toString('base64')
  assert.deepEqual(normalizeChecksum(`sha512-${sha512B64}`), {
    algorithm: 'sha512',
    digest: ABC_SHA512,
  })
  // base64 解出的字节数必须与算法匹配：20 字节不是 sha256
  assert.equal(
    normalizeChecksum(`sha256-${Buffer.from('a'.repeat(20)).toString('base64')}`),
    null,
  )
})

test('normalizeChecksum: 算法与长度不匹配 -> null（不按长度悄悄改算法）', () => {
  assert.equal(normalizeChecksum(`md5:${ABC_HEX}`), null)
  assert.equal(normalizeChecksum(`sha1:${ABC_HEX}`), null)
  assert.equal(normalizeChecksum(`sha512:${ABC_HEX}`), null)
  assert.equal(normalizeChecksum(`sha256:${ABC_MD5}`), null)
})

test('normalizeChecksum: 非十六进制 / 空串 / 非法长度 -> null', () => {
  assert.equal(normalizeChecksum(''), null)
  assert.equal(normalizeChecksum('   '), null)
  assert.equal(normalizeChecksum('z'.repeat(32)), null)
  assert.equal(normalizeChecksum('a'.repeat(31)), null)
  assert.equal(normalizeChecksum('a'.repeat(33)), null)
  assert.equal(normalizeChecksum('not-a-hash'), null)
})

test('hashFile: 四种算法对 "abc" 都算出标准向量', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hash-test-'))
  try {
    const file = join(dir, 'abc.txt')
    writeFileSync(file, 'abc')
    assert.equal(await hashFile(file, 'md5'), ABC_MD5)
    assert.equal(await hashFile(file, 'sha1'), ABC_SHA1)
    assert.equal(await hashFile(file, 'sha256'), ABC_HEX)
    assert.equal(await hashFile(file, 'sha512'), ABC_SHA512)
    // 与 Node crypto 现算结果一致（sha512 向量再核一次，防止手抄错误）
    assert.equal(
      await hashFile(file, 'sha512'),
      createHash('sha512').update('abc').digest('hex'),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hashFile: 文件不存在 -> null（四种算法一致）', async () => {
  const missing = join(tmpdir(), 'definitely-missing-dsh-smartdl-checksum.bin')
  for (const algorithm of ['md5', 'sha1', 'sha256', 'sha512'] as const) {
    assert.equal(await hashFile(missing, algorithm), null)
  }
})

test('verifyChecksum: 匹配 -> ok；不匹配 -> mismatch 且带算法', () => {
  const spec = { algorithm: 'md5' as const, digest: ABC_MD5 }
  const ok = verifyChecksum(spec, ABC_MD5)
  assert.equal(ok.kind, 'ok')
  assert.equal(ok.kind === 'ok' ? ok.digest : '', ABC_MD5)

  const mismatch = verifyChecksum(spec, 'f'.repeat(32))
  assert.equal(mismatch.kind, 'mismatch')
  assert.equal(mismatch.kind === 'mismatch' ? mismatch.algorithm : '', 'md5')
  assert.equal(mismatch.kind === 'mismatch' ? mismatch.expected : '', ABC_MD5)
  assert.equal(mismatch.kind === 'mismatch' ? mismatch.actual : '', 'f'.repeat(32))
})

test('verifyChecksum: 文件读不到 -> unreadable，并带上是哪种算法', () => {
  const outcome = verifyChecksum({ algorithm: 'sha512', digest: ABC_SHA512 }, null)
  assert.equal(outcome.kind, 'unreadable')
  assert.equal(outcome.kind === 'unreadable' ? outcome.algorithm : '', 'sha512')
})

test('checksumUnreadableMessage: 文案说出实际算法（MD5 不写成 SHA-256）', () => {
  const message = checksumUnreadableMessage('md5')
  assert.match(message, /MD5/)
  assert.doesNotMatch(message, /SHA-256/)
  assert.match(message, /下一步/)
})

test('checksumVerifiedMessage: 四种算法各自给出人类可读标签', () => {
  assert.equal(checksumVerifiedMessage({ algorithm: 'md5', digest: ABC_MD5 }), 'MD5 已校验')
  assert.equal(checksumVerifiedMessage({ algorithm: 'sha1', digest: ABC_SHA1 }), 'SHA-1 已校验')
  assert.equal(checksumVerifiedMessage({ algorithm: 'sha256', digest: ABC_HEX }), 'SHA-256 已校验')
  assert.equal(
    checksumVerifiedMessage({ algorithm: 'sha512', digest: ABC_SHA512 }),
    'SHA-512 已校验',
  )
  assert.deepEqual(Object.values(CHECKSUM_LABELS).sort(), ['MD5', 'SHA-1', 'SHA-256', 'SHA-512'])
})
