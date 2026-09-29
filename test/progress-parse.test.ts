/**
 * progress-parse.ts 单测：
 * - aria2 摘要行解析（真实格式 + 兼容格式 + 非摘要行）；
 * - curl --progress-bar 百分比解析；
 * - 逐行切分 splitIntoLines（生产代码与 LineBuffer 共用的那一份）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseAria2Summary,
  parseCurlProgress,
  splitIntoLines,
} from '../src/progress-parse.js'

test('解析真实 aria2 1.37.0 摘要行（DL，十六进制 GID）', () => {
  const r = parseAria2Summary('[#de8d33 11MiB/40MiB(27%) CN:4 DL:10MiB ETA:2s]')
  assert.ok(r)
  assert.equal(r.pct, 27)
  assert.equal(r.spd, '10MiB/s')
  assert.equal(r.eta, '2s')
})

test('解析兼容格式（SIZE 前缀 + SPD，KiBs 写法）', () => {
  const r = parseAria2Summary(
    '[#1 SIZE:400.0KiB/33.2MiB(1%) CN:1 SPD:115.7KiBs ETA:4m51s]',
  )
  assert.ok(r)
  assert.equal(r.pct, 1)
  assert.equal(r.spd, '115.7KiB/s')
  assert.equal(r.eta, '4m51s')
})

test('100% 行可解析', () => {
  const r = parseAria2Summary('[#ab12 40MiB/40MiB(100%) CN:4 DL:0B ETA:0s]')
  assert.ok(r)
  assert.equal(r.pct, 100)
})

test('非摘要行返回 null', () => {
  assert.equal(parseAria2Summary('=============================================================================='), null)
  assert.equal(parseAria2Summary('FILE: C:/tmp/cap.bin'), null)
  assert.equal(parseAria2Summary('*** Download Progress Summary ***'), null)
  assert.equal(parseAria2Summary(''), null)
  assert.equal(parseAria2Summary('09/26 [NOTICE] Downloading 1 item(s)'), null)
})

test('摘要行不含 ETA（临近完成 aria2 会省略）-> eta 为 undefined 但其余字段照常', () => {
  // 实测：下载接近完成时 aria2 的摘要行会丢掉 ETA 段。此时必须仍然解析出
  // 百分比与速度，而不是整行判为「非摘要」而丢掉最后一次进度。
  const r = parseAria2Summary('[#de8d33 40MiB/40MiB(100%) CN:4 DL:12MiB]')
  assert.ok(r, '无 ETA 的摘要行仍应被解析')
  assert.equal(r.pct, 100)
  assert.equal(r.spd, '12MiB/s')
  assert.equal(r.eta, undefined)
})

test('速度已是 /s 形式 -> 不重复补 /s（normalizeSpeed 早退分支）', () => {
  // aria2 1.38+ 的 readout 直接把速度写成 "1.0MiB/s"，normalizeSpeed 必须原样返回，
  // 否则会得到 "1.0MiB/s/s"。
  const r = parseAria2Summary('[#ab12 1MiB/10MiB(10%) CN:1 DL:1.0MiB/s ETA:9s]')
  assert.ok(r)
  assert.equal(r.spd, '1.0MiB/s')
  assert.equal(r.spd.includes('/s/s'), false)
})

/* ------------------------------ curl 进度解析 ------------------------------ */

test('parseCurlProgress: 真实 curl --progress-bar 行 -> 百分比', () => {
  // 实测 curl 8.13.0 在管道（非 tty）下仍输出百分比行，形如：
  // "#########          12.5%"
  assert.equal(parseCurlProgress('#########          12.5%'), 12.5)
  assert.equal(parseCurlProgress('######## 100.0%'), 100)
  assert.equal(parseCurlProgress('  0.0%'), 0)
})

test('parseCurlProgress: 非进度行返回 null', () => {
  // 这是「不得产生假 report」的关键防线：curl 的警告 / 错误行里偶然带数字
  // 也不能被当成进度。
  assert.equal(parseCurlProgress(''), null)
  assert.equal(parseCurlProgress('curl: (18) end of response with 5242880 bytes missing'), null)
  assert.equal(parseCurlProgress('  % Total    % Received % Xferd'), null)
  assert.equal(parseCurlProgress('100 bytes transferred'), null)
})

/* ------------------------------ 逐行切分 ------------------------------ */

test('splitIntoLines: \\r\\n / \\r / \\n 三种终止符都切', () => {
  // curl 的进度条用 \r 分段、aria2 用 \n，LineBuffer 依赖这一份实现。
  assert.deepEqual(splitIntoLines('a\r\nb'), ['a', 'b'])
  assert.deepEqual(splitIntoLines('a\rb'), ['a', 'b'])
  assert.deepEqual(splitIntoLines('a\nb'), ['a', 'b'])
  assert.deepEqual(splitIntoLines('a\r\nb\rc\nd'), ['a', 'b', 'c', 'd'])
})

test('splitIntoLines: 末尾无终止符时最后一段原样返回（半截行的语义）', () => {
  // 半截内容的去留交给调用方（LineBuffer 会把它留在 pending 里），这里只锁定
  // 「不丢数据」这一点。
  assert.deepEqual(splitIntoLines('a\nb'), ['a', 'b'])
  assert.deepEqual(splitIntoLines('a\n'), ['a', ''])
  assert.deepEqual(splitIntoLines(''), [''])
})
