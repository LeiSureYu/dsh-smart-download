/**
 * 元契约测试：防止“防护措施自己在 CI 里静默失效”。
 *
 * 它枚举 test/ 下所有 *.test.ts，并断言 package.json 的 test 脚本
 * （glob 或显式列表）确实覆盖了每一个文件。这样：
 * - 用 glob 时，验证 glob 真的能匹配到所有文件（含 test/ 根目录文件）；
 * - 新增测试文件但漏进脚本时，CI 直接红，而不是悄悄只跑一部分。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url)) // test 目录
const root = dirname(here)

/** 递归枚举 test/ 下所有 *.test.ts，返回相对 root 的正斜杠路径 */
async function listTestFiles(): Promise<string[]> {
  const entries = (await readdir(here, { recursive: true })) as string[]
  return entries
    .map((p) => p.replace(/\\/g, '/'))
    .filter((p) => p.endsWith('.test.ts'))
    .map((p) => `test/${p}`)
}

/** 极简 glob（支持 ** / * / ?）转正则，路径统一为正斜杠 */
function globToRegExp(glob: string): RegExp {
  let re = '^'
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        // **/ 匹配零或多个目录
        if (glob[i + 1] === '/') {
          re += '(?:.*/)?'
          i++
        } else {
          re += '.*'
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '.'
    } else if ('.+^${}()|[]'.includes(c)) {
      re += `\\${c}`
    } else {
      re += c
    }
  }
  return new RegExp(`${re}$`)
}

test('元契约：test 脚本覆盖 test/ 下所有测试文件', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf-8'))
  const script = pkg.scripts?.test
  assert.ok(typeof script === 'string' && script.includes('--test'), '缺少 test 脚本')

  // 提取脚本中所有指向 *.test.ts 的 token（带引号的 glob 或显式路径）
  const tokens = [
    ...script.matchAll(/"([^"]+)"|'([^']+)'|(\S*test\.ts)/g),
  ]
    .map((m) => m[1] ?? m[2] ?? m[3])
    .filter((t): t is string => !!t)
  assert.ok(tokens.length >= 1, 'test 脚本未包含任何测试路径或 glob')

  const matchers = tokens.map((t) => globToRegExp(t.replace(/\\/g, '/')))

  const files = await listTestFiles()
  assert.ok(files.length >= 7, `应至少有 7 个测试文件，实际 ${files.length}`)

  const uncovered = files.filter((f) => !matchers.some((rx) => rx.test(f)))
  assert.deepEqual(uncovered, [], `未被 test 脚本覆盖的测试文件：${uncovered.join(', ')}`)
})
