/**
 * 续传安全策略：决定一个已存在的本地文件能不能接着往下续。
 *
 * 为什么需要这一层（0.6.0 实测坐实的静默损坏）：
 * 此前只要探测到服务器支持 Range 就无条件加 `-C -` / `-c`。但 curl 与 aria2
 * 都**只看本地文件长度**，不校验远端资源有没有变。用真实 curl 8.13.0 与随包
 * aria2 1.37.0 在 127.0.0.1 上实测（脚本 `work/_fix/probe-resume.mjs`）：
 *
 *   场景                              | curl -C -              | aria2 -c
 *   ----------------------------------|------------------------|------------------
 *   远端变大 400B→1000B（同源）        | exit 0，正确 1000B     | exit 0，正确 1000B
 *   远端变小 400B→200B                | **exit 0，仍是 400B**  | **exit 0，仍是 400B**
 *   远端等长但内容变了 400B→400B(异)   | **exit 0，旧内容**     | **exit 0，旧内容**
 *   服务器忽略 Range                   | exit 33（明确报错）    | exit 0，正确 1000B
 *
 * 前三行是最危险的：**退出码 0 且文件是错的**。用户拿到一个看起来下载成功、
 * 实际是旧内容或超长残文件的产物，没有任何提示。
 *
 * 策略：续传前先比对「远端长度 + 内容指纹」。只有能证实本地半包确实是同一个
 * 资源的前缀时才续传；否则删掉本地文件重下。指纹优先用 ETag（实测会随内容变），
 * 其次 Last-Modified，都没有时退化为只比长度（能挡住前两行，挡不住第三行）。
 */
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { ProbeResult } from './types.js'

/** 续传计划 */
export interface ResumePlan {
  /** 是否续传 */
  resume: boolean
  /** 决策依据（写进 reason，便于排查） */
  reason: string
  /** 是否删掉了本地文件 */
  discarded: boolean
}

/** 旁车文件后缀：存放上次下载时记下的资源指纹 */
const MARKER_SUFFIX = '.part.json'

/** 旁车文件内容 */
interface ResumeMarker {
  /** 格式版本，固定 1 */
  v: 1
  /** 远端资源总长度 */
  readonly length: number
  /** 远端 ETag */
  readonly etag?: string
  /** 远端 Last-Modified */
  readonly lastModified?: string
}

/** 取本地文件大小；不存在或不可读时返回 null */
export function localFileSize(outputPath: string): number | null {
  try {
    const st = statSync(outputPath)
    return st.isFile() ? st.size : null
  } catch {
    return null
  }
}

/** 读取旁车指纹；不存在 / 损坏时返回 null */
function readMarker(outputPath: string): ResumeMarker | null {
  let raw: string
  try {
    raw = readFileSync(markerPath(outputPath), 'utf-8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const rec = parsed as Record<string, unknown>
  if (rec.v !== 1) return null
  const length = Number(rec.length)
  if (!Number.isFinite(length) || length < 0) return null
  const marker: ResumeMarker & { etag?: string; lastModified?: string } = {
    v: 1,
    length,
  }
  if (typeof rec.etag === 'string') marker.etag = rec.etag
  if (typeof rec.lastModified === 'string') marker.lastModified = rec.lastModified
  return marker
}

/** 旁车文件路径 */
function markerPath(outputPath: string): string {
  return `${outputPath}${MARKER_SUFFIX}`
}

/** 写入旁车指纹；失败时静默忽略 */
export function writeMarker(outputPath: string, probe: ProbeResult): void {
  if (probe.contentLength === undefined) return
  const marker: ResumeMarker & { etag?: string; lastModified?: string } = {
    v: 1,
    length: probe.contentLength,
  }
  if (probe.etag) marker.etag = probe.etag
  if (probe.lastModified) marker.lastModified = probe.lastModified
  try {
    writeFileSync(markerPath(outputPath), JSON.stringify(marker), 'utf-8')
  } catch {
    /* 拿不到旁车最坏只是按长度续传，不致命 */
  }
}

/** 删除旁车文件（下载成功 / 失败后调用，避免留下过时指纹） */
export function clearMarker(outputPath: string): void {
  try {
    rmSync(markerPath(outputPath), { force: true })
  } catch {
    /* 忽略 */
  }
}

/** 归一化 ETag 以便比较：去掉弱校验前缀 W/ 与可能的 -gzip 后缀 */
export function normalizeEtag(etag: string): string {
  let out = etag.trim()
  if (/^W\//i.test(out)) out = out.slice(2)
  if (out.endsWith('-gzip')) out = out.slice(0, -'-gzip'.length)
  return out
}

/**
 * 判定本地半包能否续传，不能续传时直接删掉。
 *
 * 判定顺序：
 * 1. 没有本地文件 → 从头下，无风险；
 * 2. 远端长度未知 → 无法比对，删掉重下（宁可重下也不冒险拼接）；
 * 3. 本地比远端还长 → 资源一定变过，删掉重下；
 * 4. 有旁车指纹且 ETag / Last-Modified 与本次不一致 → 内容变了，删掉重下；
 * 5. 有旁车指纹且远端长度与旁车不一致 → 资源变了，删掉重下；
 * 6. 其余 → 按长度续传。
 *
 * @param outputPath 本地输出文件路径
 * @param probe 探测结果（含远端长度与指纹）
 * @param rangeSupported 服务器是否支持 Range（不支持时根本不该续传）
 */
export function planResume(
  outputPath: string,
  probe: ProbeResult,
  rangeSupported: boolean,
): ResumePlan {
  const localSize = localFileSize(outputPath)

  // 1. 没有本地文件：从头下，无风险
  if (localSize === null || localSize === 0) {
    return { resume: false, reason: '本地无文件，从头下载', discarded: false }
  }

  // 服务器不支持 Range 时，curl -C - 会直接 exit 33 失败（实测），
  // 此时保留文件反而挡住了全量重下 —— 必须删掉。
  if (!rangeSupported) {
    discard(outputPath)
    return {
      resume: false,
      reason: '服务器不支持 Range，删除本地半包后全量重下',
      discarded: true,
    }
  }

  const remoteSize = probe.contentLength

  // 2. 远端长度未知：无法证实本地半包同源
  if (remoteSize === undefined) {
    discard(outputPath)
    return {
      resume: false,
      reason: '无法获取远端文件大小，删除本地半包后全量重下',
      discarded: true,
    }
  }

  // 3. 本地比远端还长：远端一定变过（或本地是别的文件）
  if (localSize > remoteSize) {
    discard(outputPath)
    return {
      resume: false,
      reason: `本地 ${localSize} 字节 > 远端 ${remoteSize} 字节，资源已变化，全量重下`,
      discarded: true,
    }
  }

  const marker = readMarker(outputPath)

  // 4. 有指纹时优先比对指纹：这是唯一能挡住「等长但内容变了」的手段
  if (marker) {
    if (marker.etag && probe.etag && normalizeEtag(marker.etag) !== normalizeEtag(probe.etag)) {
      discard(outputPath)
      return {
        resume: false,
        reason: `ETag 变化（${marker.etag} → ${probe.etag}），资源已更新，全量重下`,
        discarded: true,
      }
    }
    if (marker.lastModified && probe.lastModified && marker.lastModified !== probe.lastModified) {
      discard(outputPath)
      return {
        resume: false,
        reason: `Last-Modified 变化，资源已更新，全量重下`,
        discarded: true,
      }
    }
    // 5. 旁车长度与本次远端长度不一致
    if (marker.length !== remoteSize) {
      discard(outputPath)
      return {
        resume: false,
        reason: `远端大小变化（${marker.length} → ${remoteSize} 字节），全量重下`,
        discarded: true,
      }
    }
  }

  // 6. 按长度续传
  return { resume: true, reason: `从 ${localSize}/${remoteSize} 字节处续传`, discarded: false }
}

/** 删除本地半包、aria2 控制文件与旁车指纹 */
function discard(outputPath: string): void {
  try {
    rmSync(outputPath, { force: true })
  } catch {
    /* 忽略：删不掉时调用方仍会走不续传路径 */
  }
  // aria2 的 .aria2 控制文件：留着它会让 aria2 按旧进度继续
  try {
    rmSync(`${outputPath}.aria2`, { force: true })
  } catch {
    /* 忽略 */
  }
  clearMarker(outputPath)
}
