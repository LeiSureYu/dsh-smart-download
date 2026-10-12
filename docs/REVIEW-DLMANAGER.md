# 下载管理器改造 —— 对抗性审查报告（t33）

- 审查人：captain（用户明确授权接手；原四次成员尝试全部因池故障在启动瞬间失败，详见 §6）
- 审查对象：t31（服务端）+ t32（客户端）的合并状态
- 审查版本：`src/client.js` mtime 2026-10-12 14:4x、`src/rpc.ts`/`src/progress.ts`/`src/status.ts`/`src/types.ts` 同轮；`dist/` 已由 captain 重建（`src/client.js` 与 `dist/client.js` SHA256 一致 `BAC38763752E`）
- 方法：**把 `POST /api/smartdl.manage` 当攻击面**，用两支探针（仓库外 `dlmgr-probe/`，跑完即删）直接驱动真实代码；探针 v1 走导出函数、探针 v2 走 `registerStatusRpc` 捕获到的**真实 fetch handler**（从信封进、从信封出，含 confirm 检查与信封校验）

## Verdict：needs_revision

八类绕过尝试**全部被正确拒绝**，confirm 守卫在真实分派层成立 —— 这部分是扎实的。
但发现 1 处 **medium** 缺陷（恰好落在用户最关心的「同时删除本地文件」交互上）与 2 处 low。

---

## §1 八类绕过尝试：全部被拒（探针 1，8/8）

每条都构造了真实文件系统状态（真建文件/目录/链接、真写记录、真改尺寸）：

| # | 尝试 | 结果 | 证据 |
|---|---|---|---|
| 1a | 载荷只给 `path` 不给 `taskId` | 解析层拒绝 | `readManagePayload` 返回固定文案 |
| 1b | 合法 `taskId` + 额外 `path`/`outPath` 字段指向受害者文件 | **path 字段被完全忽略**；只删记录里那个 | victim 存活 ✓ 记录目标被删 ✓ |
| 2 | `taskId` = `..\\..\\secret` / `../../secret` / `C:evil` / NUL / `a/b` / `a\\b` / 空串 / 70 字符 | 全部被白名单拒 | 8/8 ✓ |
| 3 | 记录 `outPath` 指向目录 | `is-dir`，目录与内容存活 | reason=is-dir |
| 4 | 记录指向符号链接 | `is-link`，链接与目标都存活 | （Windows 本机建链接成功，实测） |
| 5 | 文件尺寸与记录不符 | `changed`，文件存活 | reason=changed |
| 6 | 任务 `running` | `running`，文件与记录都存活 | recordRemoved=[] |
| 7 | 老记录（无 `outPath`） | `no-path`，只删记录、旁观文件存活 | 记录已删 ✓ |
| 8 | 目标落在插件自己的记录目录内 | `denied` + `errorCode:'BAD_PATH'`，文件存活 | ✓ |

**结论：八类全部被拒，且拒绝时的 `reason` 与钉死的契约一致。**

## §2 分派层（探针 2，6/6）

| 检查 | 结果 |
|---|---|
| **C1** 不带 `confirm` / `confirm:false` / `confirm:"yes"`（非布尔真）打向 manage 端点 | **全部拒绝**（`MANAGE_CONFIRM_REQUIRED`），文件与记录存活 |
| **C2** 正向对照：`confirm:true` | `fileDeleted:true`，文件与记录都被删 |
| **C3** `op:'forget'` | 只删记录，产物不动，`recordRemoved` 报出被删的记录路径 |
| **C4** 打向 manage 端点但信封 `method` 写 `smartdl.status` | 拒绝「method does not match endpoint」—— **不被当成 status 执行** |
| **A** 真·未归一化路径（字符串拼接保留 `..`）判 `bad-path`；已归一化但不存在的判 `missing` | 两者正确区分 |
| **E** 三个端点（status/cleanup/manage）都在 | ✓ |

**C1 是本轮最重要的通过项**：`confirm` 守卫在**真实分派层**成立（不是只在某个导出函数里）。

## §3 契约一致性（两端比对）

- 服务端 `ManagePresence = 'present'|'changed'|'missing'|'unknown'|'blocked'`（`rpc.ts:290`）；
  客户端 5 个值全部出现（present×3 / changed×2 / missing×2 / unknown×4 / blocked×2）。✓
- 服务端 `DeleteReason` 8 个值（`rpc.ts:293-301`）与契约一字不差。✓
- 客户端 `op` 只发 `'inspect'`/`'forget'`/`'delete'`，`forget` **不带** `confirm`（`:1509-1511` 有注释说明为什么）。✓
- **未发现两端分叉。**

## §4 `presence` → 选项矩阵：正确

`canDeleteLocalFile(presence)`（`client.js:288`）= **白名单** `presence === 'present'`；
`missing` / `changed` / `blocked` / `unknown` 一律只给「删除记录」，且各自有原因文案（`presenceBlockerKey`，`:322`）。
与用户原话「如果移走便只有删除记录」逐字对应。✓

## §5 断言强度：不是恒真的

`test/rpc.test.ts` 有 **15 处**断言到**具体** `reason` / `errorCode`（`:804 gone`、`:823 no-path`、`:845 running`、`:867 changed`、`:889 is-dir`、`:915 is-link`、`:940/941 denied+BAD_PATH`、`:967/968 …），不是「没抛错」式的弱断言。✓

## §6 审查过程说明

本任务四次成员尝试（verify-a×2 / reviewer / res-p1，跨 step5 与 global）**全部在启动瞬间因 503 no_healthy_account 失败**，当时所有成员均空闲。用户授权 captain 接手。探针两支共 14 项检查，全部真实驱动代码（未 mock 掉被测路径），脚本放仓库外、跑完已删。

---

## §7 Findings

### PANEL-DL-1（medium）删除失败时，行会短暂消失且无解释

**位置**：`src/client.js:1512-1521`（`remove()`）

**问题**：服务端的 `ok(...)` 语义是「**请求被处理**」，不是「文件被删了」。`busy` / `denied` / `changed` / `is-dir` / `is-link` / `running` 这些**删除失败**的情况，返回的也是 `ok:true` + `fileDeleted:false`（`rpc.ts:681-691` 对成功处理的请求一律 `ok(...)` 包装；`fail()` 只用于信封/解析错误与缺 confirm）。而客户端：

```js
if (result && result.ok) {
  panelStore.publish(tasks.filter((row) => row.id !== task.id));  // ← 行被移除
} else { setNotice(t('actionFailed')); }
```

把 `result.ok` 当成「删掉了」。后果：**文件还在、记录还在，但那一行消失**（直到下一次 ≤2s 的轮询被 `publish` 带回），并且**没有任何解释**。用户点了「同时删除本地文件」，看到行闪一下又回来，不知道为什么文件还在。

**这不是静默失败**（有 notice 路径，只是走不到），但它是**语义错配**，而且恰好落在用户主动选择破坏性操作的那条路径上。

**requiredFix**：`remove()` 改为读 `result.value.fileDeleted` 与 `result.value.reason`：
- `fileDeleted === true` → 现在的行为（移除行 + 刷 presence）
- `fileDeleted === false` → **不移除行**，`setNotice` 用按 `reason`/`presenceBlockerKey` 取的**具体文案**（沿用既有 i18n 字典，`busy`/`denied`/`changed` 等各一句；`errorCode` 可附在细节里）
- 并补断言：`changed`（尺寸被换）时行**不得**被移除、notice 必须出现 —— 按本仓库惯例做反证（把判定改回 `result.ok`，断言必须变红）

### PANEL-DL-2（low）失败提示文案不区分原因

**位置**：同上，`setNotice(t('actionFailed'))`。

**问题**：服务端精心返回的 `reason`（8 种）与 `errorCode`（errno）被客户端整体丢弃 —— `src/client.js` 里 **0 处**引用 `reason`/`errorCode`/`fileDeleted`/`recordRemoved`。用户无法区分「文件被占用」与「权限不足」与「文件被换过」。

**requiredFix**：随 PANEL-DL-1 一并处理 —— 为 8 种 `reason` 各配一句 i18n 文案（中英），`errorCode` 作为次要行展示。

### PANEL-DL-3（low）`confirm` 只在分派层强制，`deleteManagedTask` 本身不设防

**位置**：`rpc.ts:690`（唯一检查点）；`deleteManagedTask`（`:542`）签名里没有 `confirm`。

**问题**：探针 v1 直接调 `deleteManagedTask()` 时**绕过了 confirm**、直接删了文件。当前唯一的调用方是带检查的分派层，所以**现在不是缺陷**；但这是**纵深防御缺口** —— 将来任何新调用方（新 op、CLI、脚本）都拿不到这层保护。

**requiredFix**（可选，低优先）：给 `deleteManagedTask` 加 `confirm` 参数（缺省 `false` 即不删），分派层把已校验的值传下去；或在函数头注释里用大写字样写明「本函数不做 confirm 校验，调用方必须先过 `readManagePayload` + confirm 检查」。二选一即可。

---

## §8 通过项汇总（无 finding）

- 八类绕过全部被拒（§1）
- confirm 守卫在真实分派层成立（§2 C1）
- `forget` 与 `delete` 语义/返回形状分离正确（§2 C3）
- 信封 `method` 不匹配拒绝（§2 C4）
- **删除顺序安全**：产物删不掉时记录保留（探针1 加成B；`rpc.ts:596-607` 失败分支一律 `recordRemoved: []`）—— 用户不会失去重试入口
- `presence` → 选项矩阵白名单正确（§4）
- 断言强度：15 处具体 reason/errorCode 断言（§5）
- 服务端改动未破坏既有能力：`/api/smartdl.status` 与 `/api/smartdl.cleanup` 仍注册（§2 E）
- 无跨调用可变状态：manage 的全部状态来自记录文件与本次请求
- `docs/SECURITY.md` 已写「不可逆：删除不进回收站」与输出路径的隐私口径
