# dsh-smart-dl

[![npm version](https://img.shields.io/npm/v/@leisureyu/dsh-smart-dl.svg)](https://www.npmjs.com/package/@leisureyu/dsh-smart-dl)
[![npm downloads](https://img.shields.io/npm/dm/@leisureyu/dsh-smart-dl.svg)](https://www.npmjs.com/package/@leisureyu/dsh-smart-dl)
[![license](https://img.shields.io/npm/l/@leisureyu/dsh-smart-dl.svg)](https://www.npmjs.com/package/@leisureyu/dsh-smart-dl)
[![Publish](https://github.com/LeiSureYu/dsh-smart-download/actions/workflows/publish.yml/badge.svg)](https://github.com/LeiSureYu/dsh-smart-download/actions/workflows/publish.yml)
![platform](https://img.shields.io/badge/platform-windows%20%7C%20linux-0078D4)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/leisureyu/dsh-smart-download)

[简体中文](./README.md) · **English**

> **A downloader with aria2 built in, for DSH.** One command to install, nothing else to set up: large files download over multiple connections, it falls back automatically when a server won't cooperate, and an interrupted download can be resumed.

![Live progress panel on the web profile](docs/progress-pill.png)

```bash
dsh plugin --profile web add @leisureyu/dsh-smart-dl
```

**What you get:**

- ⚡ **Automatic multi-connection acceleration** — the target server is probed first; if it supports multiple connections the bundled `aria2c` downloads concurrently, otherwise it falls back to the system `curl`, so the download completes either way.
- 📦 **Zero configuration** — the aria2 binaries ship with the plugin via npm `optionalDependencies`; no manual download and no PATH setup.
- 👀 **Visible progress** — on the `web` profile a live panel sits in the bottom-right corner (file name / percentage / speed / ETA) and clears itself when the download finishes.
- 🔁 **Resumable downloads** — call again with the same `url` + `output` to resume an interrupted download.
- 🌐 **Mirror acceleration** — an optional `mirror` parameter routes the download through a GitHub mirror.
- 🔍 **Queryable progress** — the `download_status` tool reads back percentage / speed / ETA of recent tasks.

Supports **Windows x64 / arm64** and **Linux x64 / arm64**. Use `0.4.0` or newer.

`dsh-smart-dl` registers two tools with DSH:

- **`smart_download`** — download a file. It first probes whether the target server supports multi-threading; if it does it calls the bundled `aria2c` for accelerated multi-connection download, otherwise it falls back to the system `curl` single-threaded download, so the download completes either way. Supports an optional mirror prefix and resume.
- **`download_status`** — query download progress. Returns a read-only snapshot of recent tasks (percentage, speed, ETA), useful for answering "how far along is that download?".

## Install

```bash
dsh plugin --profile web add @leisureyu/dsh-smart-dl
```

No further configuration is needed: the aria2 binaries are installed together with the plugin via npm `optionalDependencies`.

**Supported profile**: `web` — the profile this plugin has been verified against (hence `--profile web` above). The install command is shaped `dsh plugin --profile <profile> add <package>`; substitute `<profile>` with the profile you actually use.

> **The progress panel is available on the `web` profile only.** On other profiles the plugin works exactly the same — there is simply no UI panel, and you can still query progress with the `download_status` tool.

> **Use `0.4.0` or newer.** `0.4.0` adds the **live progress panel** for the `web` profile and fixes two issues: the panel showing the task ID instead of the file name, and stale tasks pinning the panel on screen forever. Since `0.2.0` the plugin supports **Windows arm64** and **Linux x64 / arm64** (before that, Windows x64 only). The earlier `0.1.1` / `0.1.3` / `0.1.4` releases had defects in the DSH plugin manifest or the tool schema that caused either a rejected install (`Cannot validate installed package ... dsh.bundle.patch`) or a failed activation (`did not activate` in the startup log). See the version badge above for the current release; to pin explicitly, use `@leisureyu/dsh-smart-dl@0.4.0`.
>
> `0.2.1` also fixes a hard install failure: the previous `peerDependencies` range (`^0.1.0` on `@deepseek-ai/dsh-tools`) resolved to **no published version at all**, because dsh-tools only ever ships prereleases. Installing it produced `npm error notarget No matching version found for @deepseek-ai/dsh-tools@^0.1.0`.

## How it works

The decision flow, in text:

```
call smart_download(url, output?, mirror?)
        │
        ▼
[0] if mirror is given, prepend the prefix to the URL
     · mirror prefix + full original URL
     · skipped for non-http(s) URLs
     · output filename still derived from the original URL
        │
        ▼
[1] Probe the URL (5s timeout)
     · send a HEAD request first
     · if HEAD returns 405 or no Content-Length,
       retry with GET + "Range: bytes=0-0"
        │
        ▼
[2] decide() picks a tier by file size and aria2 availability:
     · no Range support / probe failed / size unknown / <1MB -> curl
     · 1MB ~ 50MB  -> aria2 with 4 connections
     · ≥ 50MB      -> aria2 with 8 connections (conservative cap, not 16)
        │
   ┌────┴──────────────────────────┐
   ▼ aria2 tier                     ▼ curl tier
[3a] bundled aria2c found?          [3b] curl single-threaded
   │ yes             │ no             (with progress bar)
   ▼                 ▼
 aria2 4/8 conns   curl single-threaded (fallback)
 (per-second summary progress)
 (resume: -c)      (resume: -C - when Range is supported)
   │ on failure
   ▼
 degrade to curl single-threaded
        │
        ▼
 return { success, path, method, size, fellback, reason?, requestedUrl, mirrored }
```

Key points:

- **Any probe anomaly** (timeout, network error, unknown file size) is safely treated as "multi-threading unsupported", so the download falls back to curl instead of failing outright.
- The connection count is chosen dynamically by file size (thresholds 1MB / 50MB). `reason` distinguishes cases such as "no Range support", "file too small", and "aria2 missing".
- `requestedUrl` is the **URL actually requested** (mirror prefix + original URL when a mirror is used); `mirrored` reports whether the mirror was applied.

## Mirror acceleration

When downloads from GitHub Releases and similar hosts are slow, pass a `mirror` prefix to `smart_download`; the plugin prepends it to the original URL:

```
smart_download(
  url: "https://github.com/owner/repo/releases/download/v1/a.zip",
  mirror: "https://gh-proxy.com/"
)
# actually requests: https://gh-proxy.com/https://github.com/owner/repo/releases/download/v1/a.zip
```

Details:

- It is a plain **prefix concatenation** with no path rewriting, so it works with most public mirrors of the "prefix + full original URL" shape.
- A **missing trailing slash is added automatically**, and a bare domain is accepted (`ghfast.top` becomes `https://ghfast.top/`).
- Non-`http(s)` URLs skip the mirror.
- The output filename is always derived from the **original** URL, so the mirror host never leaks into the filename.

Commonly used public mirrors (pick one; availability varies by network):

| Mirror prefix |
| --- |
| `https://gh-proxy.com/` |
| `https://ghfast.top/` |
| `https://ghproxy.net/` |

> Mirrors are **third-party services**: your request passes through them. Do not use a mirror for files containing sensitive data.

## Resumable downloads

If a download is interrupted, calling `smart_download` again with the same `url` and `output` resumes from where it stopped instead of starting over:

- **aria2 path**: `-c` is always enabled. Against a server without Range support aria2 simply re-downloads the whole file; it does not fail.
- **curl path**: `-C -` is added **only when the probe confirms the server supports Range**.

Why curl's resume is conditional (measured, do not make it unconditional):

> `curl -C -` **fails outright with exit code 33** when the server does **not** support Range and a partial file already exists — measured: a 1000-byte resource with an existing 400-byte partial → `exit 33`, file left intact at 400 bytes, while the **same scenario without** `-C -` re-downloads the full file successfully.
> With Range support, all three cases are measured correct: resuming a partial file, re-running after completion, and starting from scratch with no file present.

## Querying progress: download_status

`download_status` returns a read-only snapshot of this plugin's download tasks — use it to answer "how far along is that download?".

```
download_status()                      # list the 10 most recent tasks
download_status(limit: 3)              # list only the 3 most recent
download_status(taskId: "dl-xxx")      # look up one task
```

Example result:

```json
{
  "ok": true,
  "taskDir": "/path/.dsh-progress/default",
  "downloadDir": "/home/u/.dsh/downloads/tasks",
  "total": 1,
  "tasks": [
    {
      "id": "dl-mulfpr76-z47a",
      "name": "local-24MiB.bin",
      "pct": 100,
      "msg": "download finished",
      "status": "completed",
      "spd": "8.2MB/s",
      "eta": "",
      "updatedAt": 1759000000000
    }
  ]
}
```

Constraints and trade-offs:

- **Purely read-only**: it writes nothing and performs no network access. It reads exactly the two progress-track directories described in "Progress reporting".
- **Fault-tolerant first**: a missing directory, insufficient permissions, or corrupted file contents all degrade to "that task does not appear in the result" — the call still succeeds (just with a shorter list), so querying status never breaks a download.
- Tasks are ordered by `updatedAt` **descending**, newest first. `total` is the **untruncated** count; `tasks` is truncated by `limit`.
- `name` is the output file name (used for display in the panel and the list); it falls back to the task ID when unknown.
- `spd` / `eta` return an **empty string** when unavailable or unknown (the schema requires a string) — never `null` or `undefined`.

## Progress reporting

Progress is written through `ProgressReporter` on **two tracks**; if either track is unwritable it fails silently without affecting the download:

- Track 1 (dsh-task-progress format): `$DSH_PROGRESS_DIR/<taskId>.jsonl`, one JSON object per line, append-only.
- Track 2 (dsh-download-progress format): `$DSH_DOWNLOAD_PROGRESS_DIR/<taskId>.json`, defaulting to `~/.dsh/downloads/tasks/<taskId>.json`, overwritten as a whole.

Progress is de-duplicated by percentage; the terminal completed / failed state bypasses the de-duplication. aria2 output is parsed from the `--summary-interval=1` summary lines (including speed and ETA); curl is parsed from `--progress-bar` percentages.

## Progress panel in the UI (web profile)

On the `web` profile the plugin mounts a **live progress panel** in the bottom-right corner of the interface. It appears automatically while a download is running and shows the **output file name, percentage, transfer speed and ETA**; when the download completes it briefly shows a "finished" receipt and then disappears. When idle it renders nothing at all.

![progress panel](docs/progress-pill.png)

Implementation notes (useful for troubleshooting a panel that does not show up):

- **Host RPC**: the client polls the progress snapshot through `/api/smartdl.status`, registered via `connection.fetch.register`; it reads the same progress files as the `download_status` tool.
- **Slot**: it registers into `shell.overlay` (`kind: 'list'`, `order: 100`), so it never replaces the host's own UI, and renders `null` when there is nothing to show.
- **`react` only**: the client script is registered as a classic script through `window.__ModuleLoader__.load`; there is no bundler.
- **Stale tasks are ignored**: a `running` task that has not been updated for more than 10 minutes no longer counts toward the panel, so leftover files from old runs cannot pin it on screen forever.

> This panel is `web`-profile only. On other profiles the client registration is silently skipped and the tools and download behaviour are unaffected.

## Guarding against silent failures

Three **silent failures of the same kind** were found during development:

1. **aria2 summary format changed**: with readout disabled, the GID became hexadecimal, the `SIZE:` prefix disappeared, and the speed field changed from `SPD:` to `DL:`.
2. **curl `--silent` suppresses progress**: even though progress goes to stderr, `--silent` also suppresses `--progress-bar`.
3. **aria2 omits ETA near completion**: summary lines close to 100% omit the ETA field entirely.

None of these are logic errors — they are **wrong assumptions about how an external program actually behaves**. The logic was right, the tests were green, and the download succeeded; only one step quietly returned a default value ("unsupported" / `curl` / `null` / skip writing). The danger is that the exit code is still 0, so tests that only assert "does not throw" can never catch them.

**Contract**: every path in this plugin that "returns a default value" —

| Stage                | Silent failure form       | Positive signal that must be asserted                  |
| -------------------- | ------------------------- | ------------------------------------------------------ |
| `probeUrl`           | probe error → unsupported | a known-good URL must return `supportsMultiThread: true` |
| `decide`             | missing branch → curl     | a known large file must return `method: 'aria2'`        |
| `parseAria2Summary`  | not recognized → `null`   | real samples must parse out `pct/spd(/eta)`             |
| `parseCurlProgress`  | not recognized → `null`   | real samples must parse percentages rising to 100%      |
| `ProgressReporter`   | dir unwritable → skipped  | a writable dir must contain a file with growing content |
| `LineBuffer`         | bad split state           | chunk / `\r` / `\r\n` boundaries must split correctly   |
| `applyMirror`        | mis-concatenated URL      | the result must parse via `new URL()` and end with the original URL |
| `readDownloadStatus` | unreadable → empty list   | a dir containing valid task files must yield tasks with parsed fields |
| `buildCurlArgs`      | resume flag misplaced     | `-C -` must be present iff `resume`, and `-o` must stay adjacent to the path |

Every assertion is **positive**: it checks "did it actually produce output", not "did it avoid crashing". Real samples live in `test/fixtures/` (curl fixtures are `.bin` files preserving `\r`), and "the fixture must contain `\r`" is itself a forced assertion.

> If you ever find a default-returning path that is not covered by a positive signal assertion, **that is a bug, not a design**. Relaxing a positive assertion back to "as long as it does not throw" reopens the silent-failure door.

In addition, `test/meta-test-discovery.test.ts` enumerates every test file under `test/` and asserts that the `test` script (glob) actually covers them — so even "is CI really running these tests" is itself verified, preventing the guard rails from silently rotting inside CI.

## Supported platforms

| Platform | Arch       | Supported            | Binary subpackage                    |
| -------- | ---------- | -------------------- | ------------------------------------ |
| Windows  | x64        | ✅ Yes               | `@leisureyu/dsh-aria2-win32-x64`     |
| Windows  | arm64      | ✅ Yes               | `@leisureyu/dsh-aria2-win32-arm64`   |
| Linux    | x64        | ✅ Yes               | `@leisureyu/dsh-aria2-linux-x64`     |
| Linux    | arm64      | ✅ Yes               | `@leisureyu/dsh-aria2-linux-arm64`   |
| macOS    | x64 / arm64 | ❌ Not yet          | —                                    |

The binary subpackages declare `os` / `cpu` fields, so npm / pnpm skip installing them on non-matching platforms.

## Permissions

This plugin does exactly three things: **start downloads**, **write progress files** and **read them back**. Itemised below.

| Behaviour | Detail |
| --- | --- |
| Outbound network | Sends `HEAD` / `Range` probes to the target URL (`probeUrl`, 5s timeout) and performs the actual download (`aria2c` or system `curl`). It only contacts the URL passed by the caller (or the address produced by prefixing it with the caller-supplied `mirror`) — no other endpoints. With a `mirror`, the request goes to the **mirror-prefixed address** and the original host is no longer contacted directly. |
| Writing the downloaded file | Writes to the path given by the `output` argument; when omitted the filename is derived from the URL and lands in the current working directory. Parent directories are created as needed (`mkdir -p`). No existing file is ever deleted. With resume enabled, a file of the same name is **appended to (resumed)** rather than rewritten from scratch; `--allow-overwrite` is not enabled, so an already-completed file of the same name is never silently discarded. |
| Reading progress files | `download_status` only **reads** the two progress-track directories described in "Progress reporting". It writes nothing and performs no network access. |
| Writing progress files | Track 1: `$DSH_PROGRESS_DIR/<taskId>.jsonl` (skipped if that variable is unset). Track 2: `$DSH_DOWNLOAD_PROGRESS_DIR/<taskId>.json`, defaulting to `~/.dsh/downloads/tasks/<taskId>.json`. If a directory is unwritable it is skipped silently without affecting the download. |
| Child processes | Launches the bundled `aria2c` or the system `curl`, both with `windowsHide: true` (no console window) and honouring `AbortSignal` cancellation (SIGTERM first, force-killed on Windows if still alive after 1s). |
| Environment variables read | Only `DSH_PROGRESS_DIR`, `DSH_DOWNLOAD_PROGRESS_DIR`, `USERPROFILE` / `HOME`. |

What it **does not** need: it does not read your DSH session contents, does not touch credentials or keys, does not modify DSH configuration (the `cordis.patch.yml` is applied by DSH itself at install time), and ships no telemetry or network reporting.

## Compatibility

| Item | Requirement |
| --- | --- |
| Node.js | `>=22.0.0` (uses `AbortSignal.any` / `AbortSignal.timeout`) |
| `@deepseek-ai/cordis` | `^4.0.0` (peerDependency) |
| `@deepseek-ai/dsh-tools` | `>=0.1.7-rc.1 <0.1.8-0` or `>=0.2.0-rc.1 <0.3.0-0` (peerDependency; that package ships prereleases only, so the range declares them per-tuple) |
| Package manager | npm or pnpm; must honour `os` / `cpu` filtering of `optionalDependencies` |

macOS is absent from the platform table **not because of incompatibility but because there is no aria2 binary subpackage for it**. On macOS the plugin still installs and works: `getAria2Path()` returns `null` and every download falls back to single-threaded `curl` (with the reason stated in the result's `reason` field).

## FAQ

**Q: Windows Defender (or another antivirus) blocks the install or run?**
A: This is a common heuristic warning about an unsigned `aria2c.exe` inside `node_modules`. Add the project's `node_modules` directory to the Windows Defender exclusion list ("Virus & threat protection → Manage settings → Exclusions"). The `aria2c.exe` files are unmodified: the Windows x64 build comes from the official aria2 release, and the Windows arm64 build from a third-party ARM64 build (see "Third-party components" below).

**Q: The download is not faster.**
A: Usually the target server does **not support Range requests** (no chunking possible), or the file is small. The plugin falls back to `curl` single-threaded automatically; the `fellback` and `reason` fields in the result explain why.

**Q: It says aria2 is missing / always uses curl.**
A: Confirm your platform is one of the four rows above (Windows x64 / arm64, Linux x64 / arm64) and that the matching binary subpackage installed successfully (some registry mirrors may not have synced it — switch to the official npm registry and reinstall). The `reason` field in the result explains why. macOS is not supported yet and always falls back to curl.

**Q: On Linux it says `aria2c: Permission denied`.**
A: That means the binary lost its executable bit in the tarball. This project **packs on a Linux runner** in CI and asserts that `bin/aria2c` is `0755`, so a normal install is unaffected; if you repacked manually, `chmod 755` before packing.

**Q: Does a black console window pop up during download?**
A: No. All child processes are started with `windowsHide: true`.

**Q: How do I know the download percentage?**
A: Call `download_status`. It returns the percentage, speed and ETA of recent tasks; pass `taskId` to look up a single task. It is purely read-only and never disturbs a download in progress.

**Q: GitHub Release downloads are slow — can I use a mirror?**
A: Yes. Pass a `mirror` prefix to `smart_download`, e.g. `mirror: "https://gh-proxy.com/"`. Note that mirrors are **third-party services**: do not use one for files containing sensitive data.

**Q: Do I have to restart an interrupted download?**
A: No. Call `smart_download` again with the same `url` and `output`; against a server that supports Range it resumes from where it stopped.

## Development

Requirements: Node.js **22+**, pnpm **9+**.

```bash
# install dependencies
pnpm install

# build locally (output to dist/)
pnpm build

# run tests (node:test, no real network needed)
pnpm test

# typecheck only
pnpm typecheck
```

For local development the per-platform binaries must be placed manually (they are not committed). Download URLs and target paths:

| Platform | Download from | Place at |
| --- | --- | --- |
| Windows x64 | <https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip> | `packages/aria2-win32-x64/bin/aria2c.exe` |
| Windows arm64 | <https://github.com/minnyres/aria2-windows-arm64/releases/download/v1.37.0/aria2_1.37.0_arm64.zip> | `packages/aria2-win32-arm64/bin/aria2c.exe` |
| Linux x64 | <https://github.com/abcfy2/aria2-static-build/releases/download/1.37.0/aria2-x86_64-linux-musl_static.zip> | `packages/aria2-linux-x64/bin/aria2c` |
| Linux arm64 | <https://github.com/abcfy2/aria2-static-build/releases/download/1.37.0/aria2-aarch64-linux-musl_static.zip> | `packages/aria2-linux-arm64/bin/aria2c` |

Remember to `chmod 755` the Linux binaries after extraction, otherwise a local `npm pack` produces a tarball without the executable bit.

### Publishing

Pushing a `v*` tag triggers GitHub Actions (`.github/workflows/publish.yml`) with three jobs:

1. `binaries-windows` (windows runner): download the Windows x64 / arm64 binaries and verify SHA256.
2. `binaries-linux` (ubuntu runner): download the Linux x64 / arm64 static binaries, verify SHA256, `chmod 755`.
3. `publish` (ubuntu runner): restore the binaries → build → test → **publish all binary subpackages first, then the main package** (the main package depends on the subpackages; the order must not be reversed).

> Publishing must happen on Linux: npm records file mode bits when packing, and packing on Windows records `bin/aria2c` as `0644`, which makes the installed binary unrunnable. CI asserts this positively (the tarball must contain `-rwxr-xr-x` for `bin/aria2c`).

Authentication uses an "OIDC first, token second" strategy: each package first tries npm trusted publishing (OIDC, no long-lived token needed); on failure it falls back to the repository secret `NPM_TOKEN` — the **first** publish of a new package cannot be bootstrapped with OIDC ([npm/cli#8544](https://github.com/npm/cli/issues/8544) is still open) and needs a token; after that OIDC alone suffices.

> Enabling OIDC requires configuring a Trusted Publisher per package on the npm website (Organization or user `LeiSureYu`, Repository `dsh-smart-download`, Workflow `publish.yml`, with "allow direct npm publish" checked). Until configured, the pipeline falls back to the token automatically and does not fail.

> Note: this repository uses the npm scope `@leisureyu`. If you change the scope, update the main package's `optionalDependencies`, the subpackage `name`s, `ARIA2_PACKAGE` in `src/downloader.ts`, and the assertions in `test/downloader.test.ts` accordingly.

## Third-party components

The bundled `aria2c` comes from [aria2](https://aria2.github.io/) 1.37.0. aria2 is licensed under **GPL-2.0-or-later**, and each binary subpackage is declared as `GPL-2.0-or-later` accordingly.

aria2 officially ships **Windows x64** binaries and source only, so the other three platforms use third-party builds (distributed verbatim, unmodified):

| Platform | Source | Archive SHA256 |
| --- | --- | --- |
| Windows x64 | official aria2 release | `67d015301eef0b612191212d564c5bb0a14b5b9c4796b76454276a4d28d9b288` |
| Windows arm64 | [minnyres/aria2-windows-arm64](https://github.com/minnyres/aria2-windows-arm64) `v1.37.0` | `5694080902fff84c8636e561c48f7a65278e8d4f05efefe953637f60a397c81f` |
| Linux x64 | [abcfy2/aria2-static-build](https://github.com/abcfy2/aria2-static-build) `1.37.0` (musl static) | `e0a09b12ef67f35f8a8e4fdddbec851d235b7c31da549d0578bff459032b499a` |
| Linux arm64 | [abcfy2/aria2-static-build](https://github.com/abcfy2/aria2-static-build) `1.37.0` (musl static) | `0c681a89a40e0f82d1f5137608e86257eb0af201459c002941ea098f2b8c26b6` |

## Disclaimer

This is a **community-maintained third-party plugin** and an **unofficial project**. It is **not affiliated with, endorsed by, or sponsored by DeepSeek AI** or its affiliates. The "dsh" in the name refers to the DeepSeek Harness (DSH) platform this plugin runs on, and is used only to describe compatibility.

## License

- Plugin code: [MIT](./LICENSE)
- Bundled aria2 binaries: **GPL-2.0-or-later**
