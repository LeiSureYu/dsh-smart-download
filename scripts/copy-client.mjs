/**
 * 构建收尾：把浏览器半边（src/client.js）原样复制到 dist/client.js。
 *
 * 它是给 DSH web shell 的 `window.__ModuleLoader__.load({ factory })` 直接加载的
 * 经典脚本，不经过 tsc（tsconfig 不开启 allowJs），也不需要打包器。
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const from = resolve(root, 'src/client.js')
const to = resolve(root, 'dist/client.js')

mkdirSync(dirname(to), { recursive: true })
copyFileSync(from, to)

console.log(`copied ${from} -> ${to}`)
