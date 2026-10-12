/**
 * 自动镜像：从内置候选表里挑一个「确认与原地址同源」的镜像。
 *
 * 为什么需要：官方文档给出的下载地址**永远是原始地址**（`github.com/...`），
 * 而能不能连上、快不快取决于调用方所处的网络。此前 `mirror` 只能由调用方
 * 手填 —— 也就是说模型得先「知道」gh-proxy 这类域名，否则只能下原始地址。
 * `mirror: "auto"` 把这件事交回插件：候选表内置，插件自己挑一个可用的。
 *
 * 为什么不是「谁能连上就用谁」（改动前务必先读）：
 * 镜像站是**第三方**，它返回的可以是任何东西 —— 另一个版本的同名文件、
 * 一个 200 的 HTML 错误页、甚至被投毒的字节。只测「有没有响应」等于把
 * 「下载到什么」交给第三方决定，而本插件整套完整性校验的前提是
 * 「期望值来自原始地址」。因此这里要求候选镜像**证明自己与原地址同源**：
 *   1. 文件长度必须与原始地址探测到的完全一致；
 *   2. 原始地址给了 `ETag` 时，候选也必须给出 `ETag` 且（归一化后）相等。
 * 长度不符、或原始有 ETag 而候选没有，都判定为「无法证实同源」，直接跳过。
 * 宁可退回原始地址慢一点，也不接受一个无法证实的来源。
 *
 * 代价（如实记录）：部分镜像会剥掉 `ETag`。对这类镜像本模块一律不选，
 * 于是自动镜像在这些站点上不会生效 —— 这是有意的取舍，不是遗漏。
 *
 * ⚠️ 「同源证明」的强度要说清楚：`ETag` 是**镜像自己声明的**。一个恶意镜像
 * 完全可以照抄原始 ETag 再返回一份等长但不同的内容，此时长度与 ETag 都对得上，
 * 本模块会采用它，字节数校验也拦不住。因此这道证明防的是「镜像缓存了旧版本 /
 * 返回了错误页」这类**无心之失**，不是防投毒。要防投毒只有 `sha256` —— 调用方
 * 从官方文档拿到的摘要，镜像无法伪造。README 的镜像一节同样提醒了这一点。
 *
 * 网络由调用方以 `probe` 注入，本模块自身不发起请求，便于单测。
 */
import { RECOMMENDED_MIRRORS, isGithubUrl, mirrorCandidates } from './mirror.js'
import type { MirrorCandidate } from './mirror.js'
import { normalizeEtag } from './resume.js'

/**
 * 覆盖内置候选镜像表的环境变量。
 *
 * 为什么要留这个口子：内置候选是三个**公开第三方**服务，能不能连上完全取决于
 * 调用方所处的网络；企业内网 / 自建代理的场景下它们一个都用不了，而调用方
 * 除了手填 `mirror` 前缀没有别的办法。与 `DSH_PROGRESS_DIR` /
 * `DSH_DOWNLOAD_PROGRESS_DIR` / `DSH_HOME` 同属「显式覆盖」一类。
 *
 * 取值：逗号分隔的前缀表，按顺序即为候选优先级。空 / 纯空白视为未设置。
 */
export const MIRRORS_ENV = 'DSH_SMARTDL_MIRRORS'

/**
 * 解析本次生效的候选镜像表：环境变量优先，否则用内置表。
 *
 * 每次调用都重新读环境变量（不在模块加载时固化），否则测试与运行期改配置
 * 都不会生效。
 */
export function resolveMirrorPrefixes(): readonly string[] {
  const fromEnv = process.env[MIRRORS_ENV]
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    const parts = fromEnv
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
    if (parts.length > 0) return parts
  }
  return RECOMMENDED_MIRRORS
}

/** 原始地址的指纹：候选镜像必须与它一致才被采用 */
export interface MirrorFingerprint {
  /** 原始地址探测到的文件长度；未知时自动镜像不启用 */
  contentLength?: number
  /** 原始地址的 ETag（含引号，原样） */
  etag?: string
}

/** 一次候选探测的结果 */
export interface MirrorProbeOutcome {
  /** 是否拿到了可用的响应（有 Content-Length 才算） */
  ok: boolean
  /** 响应声明的文件长度 */
  contentLength?: number
  /** 响应的 ETag（原样） */
  etag?: string
}

/** 探测一个候选地址；实现方负责超时与取消，失败时返回 `ok: false` */
export type MirrorProbe = (url: string) => Promise<MirrorProbeOutcome>

/** 选中的镜像与判定依据 */
export interface AutoMirrorPick {
  candidate: MirrorCandidate
  /** 写进返回结果说明的判定依据 */
  reason: string
}

/**
 * 判定候选的 ETag 能否证实「与原始地址是同一份内容」。
 *
 * - 原始地址没有 ETag：无从比对，只靠长度（见文件头，这是本模块最弱的路径）；
 * - 候选没有 ETag 而原始有：**不能**证实，判否 —— 这正是「部分镜像剥 ETag
 *   就不再被采用」那条取舍的落点；
 * - 两者都有：归一化（去 `W/` 弱校验前缀与 `-gzip` 后缀）后必须相等。
 */
function etagMatches(expected: string | undefined, actual: string | undefined): boolean {
  if (expected === undefined) return true
  if (actual === undefined) return false
  return normalizeEtag(expected) === normalizeEtag(actual)
}

/**
 * 按候选表顺序挑第一个与原地址同源的镜像。
 *
 * 所有候选**并行**探测（串行会让最坏耗时随候选数线性增长），随后按候选表
 * 顺序取第一个通过校验的 —— 顺序仍然由候选表决定，结果可预期。
 *
 * @param url 原始下载地址
 * @param expected 原始地址的指纹；`contentLength` 未知时直接返回 null
 * @param probe 探测函数（调用方注入，通常包一层 `probeUrl`）
 * @param prefixes 候选前缀表，缺省用 `RECOMMENDED_MIRRORS`
 * @returns 选中的候选与依据；没有可用候选时返回 null
 */
export async function pickMirrorServingSameFile(
  url: string,
  expected: MirrorFingerprint,
  probe: MirrorProbe,
  prefixes?: readonly string[],
): Promise<AutoMirrorPick | null> {
  // 没有原始长度就没有比对基准，自动镜像无从证实同源
  if (expected.contentLength === undefined) return null

  const candidates = mirrorCandidates(url, prefixes ?? resolveMirrorPrefixes())
  if (candidates.length === 0) return null

  const settled = await Promise.allSettled(
    candidates.map(async (candidate) => ({ candidate, outcome: await probe(candidate.url) })),
  )

  for (const entry of settled) {
    if (entry.status !== 'fulfilled') continue
    const { candidate, outcome } = entry.value
    if (!outcome.ok) continue
    if (outcome.contentLength !== expected.contentLength) continue
    if (!etagMatches(expected.etag, outcome.etag)) continue

    const etagNote = expected.etag === undefined ? '' : '，ETag 一致'
    return {
      candidate,
      reason: `镜像 ${candidate.mirror} 返回同一文件（${expected.contentLength} 字节${etagNote}）`,
    }
  }

  return null
}

/* ------------------------------ 对外入口 ------------------------------ */

/** 目标不是 GitHub：自动镜像没有意义 */
export const AUTO_MIRROR_SKIP_NOT_GITHUB = '未使用自动镜像：只有 GitHub 地址支持'
/** 拿不到原始长度：没有比对基准，无从证实同源 */
export const AUTO_MIRROR_SKIP_NO_LENGTH =
  '未使用自动镜像：无法从原始地址取得文件长度，无从证实镜像返回的是同一个文件'
/** 候选表全部落空 */
export const AUTO_MIRROR_SKIP_NO_CANDIDATE =
  '未使用自动镜像：内置镜像均不可达，或返回的文件与原始地址不一致'

/** 自动镜像的解析结果 */
export interface AutoMirrorResolution {
  /** 实际应当请求的地址（未启用镜像时等于原始地址） */
  url: string
  /** 是否走了镜像 */
  mirrored: boolean
  /** 采用的镜像前缀（`mirrored` 为真时出现） */
  mirror?: string
  /** 采用镜像时的判定依据，用于写进度文案 */
  reason?: string
  /** 未启用镜像时的说明；调用方必须把它透出给用户，不得静默 */
  skipped?: string
}

/**
 * 解析 `mirror: "auto"`：决定这次到底用不用镜像、用哪一个。
 *
 * 这个函数把「什么时候不启用」的三条路径全部收在这里，而不是散在
 * `smart_download.execute()` 里 —— 那三行如果留在执行函数里就无法被单测
 * 覆盖（要覆盖「选中镜像」那条还得有真实可达的 GitHub 与镜像）。
 *
 * @param url 原始下载地址
 * @param expected 原始地址的指纹（来自探测）
 * @param probe 候选探测函数（调用方注入）
 * @param prefixes 候选前缀表，缺省用 `RECOMMENDED_MIRRORS`
 */
export async function resolveAutoMirror(
  url: string,
  expected: MirrorFingerprint,
  probe: MirrorProbe,
  prefixes?: readonly string[],
): Promise<AutoMirrorResolution> {
  if (!isGithubUrl(url)) {
    return { url, mirrored: false, skipped: AUTO_MIRROR_SKIP_NOT_GITHUB }
  }
  if (expected.contentLength === undefined) {
    return { url, mirrored: false, skipped: AUTO_MIRROR_SKIP_NO_LENGTH }
  }

  const picked = await pickMirrorServingSameFile(
    url,
    expected,
    probe,
    prefixes ?? resolveMirrorPrefixes(),
  )
  if (!picked) {
    return { url, mirrored: false, skipped: AUTO_MIRROR_SKIP_NO_CANDIDATE }
  }
  return {
    url: picked.candidate.url,
    mirrored: true,
    mirror: picked.candidate.mirror,
    reason: picked.reason,
  }
}
