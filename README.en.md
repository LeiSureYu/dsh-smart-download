# dsh-smart-dl

[![npm version](https://img.shields.io/npm/v/@leisureyu/dsh-smart-dl.svg)](https://www.npmjs.com/package/@leisureyu/dsh-smart-dl)
[![npm downloads](https://img.shields.io/npm/dm/@leisureyu/dsh-smart-dl.svg)](https://www.npmjs.com/package/@leisureyu/dsh-smart-dl)
[![license](https://img.shields.io/npm/l/@leisureyu/dsh-smart-dl.svg)](https://www.npmjs.com/package/@leisureyu/dsh-smart-dl)
[![Publish](https://github.com/LeiSureYu/dsh-smart-download/actions/workflows/publish.yml/badge.svg)](https://github.com/LeiSureYu/dsh-smart-download/actions/workflows/publish.yml)
![platform](https://img.shields.io/badge/platform-windows%20%7C%20linux-0078D4)

[简体中文](./README.md) · **English**

> Multi-threaded downloader plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) with a bundled `aria2` — **zero configuration**: install it and it works, no separate aria2 install needed.

`dsh-smart-dl` registers a `smart_download` tool with DSH. When the model needs to download a file, the plugin first probes whether the target server supports multi-threading. If it does, it calls the bundled `aria2c` for accelerated multi-connection download; otherwise it automatically falls back to the system `curl` single-threaded download, so the download completes either way.

## Install

```bash
dsh plugin --profile web add @leisureyu/dsh-smart-dl
```

No further configuration is needed: the aria2 binaries are installed together with the plugin via npm `optionalDependencies`.

> **Use `0.2.1` or newer.** Since `0.2.0` the plugin supports **Windows arm64** and **Linux x64 / arm64** (before that, Windows x64 only). The earlier `0.1.1` / `0.1.3` / `0.1.4` releases had defects in the DSH plugin manifest or the tool schema that caused either a rejected install (`Cannot validate installed package ... dsh.bundle.patch`) or a failed activation (`did not activate` in the startup log). See the version badge above for the current release; to pin explicitly, use `@leisureyu/dsh-smart-dl@0.2.1`.
>
> `0.2.1` also fixes a hard install failure: the previous `peerDependencies` range (`^0.1.0` on `@deepseek-ai/dsh-tools`) resolved to **no published version at all**, because dsh-tools only ever ships prereleases. Installing it produced `npm error notarget No matching version found for @deepseek-ai/dsh-tools@^0.1.0`.

## How it works

The decision flow, in text:

```
call smart_download(url, output?)
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
   │ on failure
   ▼
 degrade to curl single-threaded
        │
        ▼
 return { success, path, method, size, fellback, reason? }
```

Key points:

- **Any probe anomaly** (timeout, network error, unknown file size) is safely treated as "multi-threading unsupported", so the download falls back to curl instead of failing outright.
- The connection count is chosen dynamically by file size (thresholds 1MB / 50MB). `reason` distinguishes cases such as "no Range support", "file too small", and "aria2 missing".

## Progress reporting

Progress is written through `ProgressReporter` on **two tracks**; if either track is unwritable it fails silently without affecting the download:

- Track 1 (dsh-task-progress format): `$DSH_PROGRESS_DIR/<taskId>.jsonl`, one JSON object per line, append-only.
- Track 2 (dsh-download-progress format): `$DSH_DOWNLOAD_PROGRESS_DIR/<taskId>.json`, defaulting to `~/.dsh/downloads/tasks/<taskId>.json`, overwritten as a whole.

Progress is de-duplicated by percentage; the terminal completed / failed state bypasses the de-duplication. aria2 output is parsed from the `--summary-interval=1` summary lines (including speed and ETA); curl is parsed from `--progress-bar` percentages.

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

## License

- Plugin code: [MIT](./LICENSE)
- Bundled aria2 binaries: **GPL-2.0-or-later**
