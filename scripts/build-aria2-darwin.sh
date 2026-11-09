#!/usr/bin/env bash
#
# 在 macOS runner 上从官方源码构建 aria2 1.37.0，产出 darwin-x64 / darwin-arm64
# 子包的二进制。
#
# 为什么是「自己构建」而不是像 win32/linux 那样取第三方二进制（1.7.0，改动前务必读）：
# aria2 官方只发布 Windows x64 与源码包；macOS 唯一带哈希的第三方候选
# （FerroDownload/aria2-static-builds）在发布方可信度、构建证明、可复现性三条上
# 全不满足（PLAN-P2-PLATFORM.md §A.2⑤，2026-10-12 核对）。本脚本把信任模型从
# 「相信某个第三方发布者」换成「相信本仓库的 CI」：
#   - aria2 与 OpenSSL 源码都 pin 官方 release tarball 的 SHA256（下方
#     ARIA2_TARBALL_SHA256 / OPENSSL_TARBALL_SHA256，均为官方 release 取回自算）；
#   - 产物做三层正向断言：`otool -L` 只允许系统库（链接进 /opt/homebrew 的
#     二进制在用户机器上跑不起来）；`--version` 与一次真实的 HTTPS 下载都必须
#     成功；且在 OpenSSL 模块目录不可达时也必须能干净启动（legacy provider
#     必须内建，见下方「为什么不用 brew 的 openssl@3」）；
#   - workflow 侧（spike-darwin.yml / publish.yml）配 SLSA provenance。
#
# 用法：scripts/build-aria2-darwin.sh <packages/aria2-darwin-x64|...-arm64 的输出目录>
# 架构由当前机器决定（uname -m），与 runner 的标签必须一致
# （macos-15 = arm64，macos-15-intel = x64）。
set -euo pipefail

VERSION="1.37.0"
# 官方 release tarball（https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0.tar.bz2）
# 的 SHA256。2026-10-31 下载自算；CI 在构建前核对，任何不匹配立即失败。
ARIA2_TARBALL_SHA256="a75c8534902ff1a64a23d7a47c033032329002553634251a89d53a9cb8b20efa"

OUT_DIR="${1:?用法: build-aria2-darwin.sh <输出目录，如 packages/aria2-darwin-arm64>}"

# 把落盘目录**现在**就规范化成绝对路径（实测教训，spike #3，勿改回去）：
# 步骤 4 会 cd 进 $WORK 做构建，而构建结束时
# 有 `trap 'rm -rf "$WORK"'`。若末尾的 mkdir/cp 用相对路径，产物会落进
# $WORK 里、脚本自己的验证也照常通过（全绿），然后随 $WORK 一起被删除
# —— 下一个步骤拿到的就是「构建绿但产物消失」。
OUT_DIR="$(mkdir -p "$OUT_DIR" && cd "$OUT_DIR" && pwd)"

ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  SUBPKG_ARCH="arm64" ;;
  x86_64) SUBPKG_ARCH="x64" ;;
  *) echo "::error::无法识别的架构：$ARCH（期望 arm64 / x86_64）"; exit 1 ;;
esac
echo "=== building aria2 $VERSION for darwin-$SUBPKG_ARCH ==="

# 与目标子包声明一致（packages/aria2-darwin-*/package.json 的 os/cpu）；
# 不一致说明 runner 标签选错了（比如在 macos-15-intel 上产出 arm64）。
# 用 readFileSync 而不是 require('./…')：OUT_DIR 在上方已规范化成绝对路径，
# require 的 './…' 前缀会把它当相对路径拼成 './/Users/…' 直接炸（spike #5 实测）。
DECLARED_CPU="$(node -p "JSON.parse(require('fs').readFileSync('$OUT_DIR/package.json','utf8')).cpu[0]")"
if [ "$DECLARED_CPU" != "$SUBPKG_ARCH" ]; then
  echo "::error::runner 架构（$SUBPKG_ARCH）与子包声明（$DECLARED_CPU）不一致 —— 检查 workflow 的 runs-on 标签"
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---------- 1. 依赖：pkg-config ----------
# runner 镜像自带 brew；本脚本只负责编译，不承担包管理职责。
if ! command -v brew >/dev/null 2>&1; then
  echo "::error::未找到 brew —— 本脚本只设计给 GitHub 的 macOS runner"
  exit 1
fi
brew list --versions pkg-config >/dev/null 2>&1 || brew install pkg-config

# ---------- 2. 下载 aria2 源码并核对 SHA256 ----------
TARBALL="$WORK/aria2-$VERSION.tar.bz2"
ok=0
for i in 1 2 3 4 5 6; do
  # github.com 偶发超时/断连；--retry 覆盖瞬时故障，外层重试覆盖整体失败
  if curl -fsSL --retry 3 --retry-delay 5 --connect-timeout 20 --max-time 300 \
      "https://github.com/aria2/aria2/releases/download/release-$VERSION/aria2-$VERSION.tar.bz2" \
      -o "$TARBALL"; then ok=1; break; fi
  echo "attempt $i failed, retrying in 5s…"; sleep 5
done
[ "$ok" = "1" ] || { echo "::error::下载 aria2 源码失败"; exit 1; }
echo "$ARIA2_TARBALL_SHA256  $TARBALL" | shasum -a 256 -c -

# ---------- 3. 构建静态 OpenSSL（legacy provider 内建，Issue #17 缺陷②） ----------
# 为什么不用 brew 的 openssl@3 静态归档（1.9.2 前的老做法，改动前务必读）：
# OpenSSL 3 把 legacy provider（RC4/MD4 等 legacy 算法，aria2 的 BT MSE 加密
# 握手要用）做成独立的 DSO 模块 —— providers/build.info 里 `$disabled{module}`
# 为假时 legacyprov.c 走 MODULES 构建成 ossl-modules/legacy.dylib，**不在**
# libcrypto 里。brew 的 libcrypto.a 烘焙了 brew 安装前缀的模块搜索路径，
# CI runner 上恰好装着 brew 所以冒烟能过；用户机器上解析不到该路径，
# aria2 启动时 Platform::setUp 的 `OSSL_PROVIDER_load(nullptr, "legacy")`
# 返回 null 直接 throw（aria2 1.37.0 Platform.cc:123-125，致命）——
# Issue #17 实报的「补上执行位后 OSSL_PROVIDER_load 'legacy' failed」。
# 解决：从 pin 过的官方源码自建 OpenSSL，`no-modules` 使 legacyprov.c 直接
# 编进 libcrypto（providers/build.info 的 $disabled{module} 分支），
# `no-shared` 只产出静态归档 —— 二进制对 ossl-modules 零依赖，任何机器可跑。
# 信任模型与 aria2 一致：官方 release tarball + SHA256 pin + 信任本仓库 CI。
OPENSSL_VERSION="3.5.4"
# https://github.com/openssl/openssl/releases/download/openssl-3.5.4/openssl-3.5.4.tar.gz
# 的 SHA256，2026-11-10 下载自算。
OPENSSL_TARBALL_SHA256="967311f84955316969bdb1d8d4b983718ef42338639c621ec4c34fddef355e99"
OSL_INSTALL="$WORK/openssl-install"

OSL_TARBALL="$WORK/openssl-$OPENSSL_VERSION.tar.gz"
ok=0
for i in 1 2 3; do
  if curl -fsSL --retry 3 --retry-delay 5 --connect-timeout 20 --max-time 600 \
      "https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VERSION/openssl-$OPENSSL_VERSION.tar.gz" \
      -o "$OSL_TARBALL"; then ok=1; break; fi
  echo "openssl attempt $i failed, retrying in 5s…"; sleep 5
done
[ "$ok" = "1" ] || { echo "::error::下载 OpenSSL 源码失败"; exit 1; }
echo "$OPENSSL_TARBALL_SHA256  $OSL_TARBALL" | shasum -a 256 -c -

tar xzf "$OSL_TARBALL" -C "$WORK"
cd "$WORK/openssl-$OPENSSL_VERSION"
case "$SUBPKG_ARCH" in
  arm64) OSL_TARGET="darwin64-arm64-cc" ;;
  x64)   OSL_TARGET="darwin64-x86_64-cc" ;;
esac
./Configure "$OSL_TARGET" no-shared no-modules no-docs no-tests \
  --prefix="$OSL_INSTALL" --openssldir="$OSL_INSTALL/ssl" \
  > "$WORK/openssl-configure.log" 2>&1 || { tail -50 "$WORK/openssl-configure.log"; exit 1; }
# 正向断言：legacy provider 必须被编进 libcrypto（而不是 DSO 模块）。
# no-modules 生效时 Makefile 不含 ossl-modules 目标；若该开关被上游改名/失效，
# 在这里就失败，而不是等到用户机器上才炸。
if grep -qE 'ossl-modules|legacy\.dylib' Makefile 2>/dev/null; then
  echo "::error::OpenSSL 构建仍包含 ossl-modules 目标 —— no-modules 未生效，legacy provider 会是 DSO"
  exit 1
fi
make -j"$(sysctl -n hw.ncpu)" > "$WORK/openssl-make.log" 2>&1 || { tail -50 "$WORK/openssl-make.log"; exit 1; }
make install_sw > "$WORK/openssl-install.log" 2>&1 || { tail -50 "$WORK/openssl-install.log"; exit 1; }
for lib in libssl.a libcrypto.a; do
  if [ ! -f "$OSL_INSTALL/lib/$lib" ]; then
    echo "::error::$OSL_INSTALL/lib/$lib 不存在 —— OpenSSL 构建不完整"; exit 1
  fi
done

# ---------- 4. 构建 aria2 ----------
tar xjf "$TARBALL" -C "$WORK"
cd "$WORK/aria2-$VERSION"

# 依赖策略：只保留「HTTP(S) 下载」这一条路需要的东西。
#   - TLS：openssl（上方自建的静态归档，与 win/linux 平台的 aria2 行为一致）；
#     显式 --without-gnutls / --without-appletls，不让 configure 的 check 顺序
#     决定后端 —— 后端不同，行为就可能不同。
#   - 关掉 metalink（libxml2/libexpat）、SFTP（libssh2）、异步 DNS（libcares）、
#     SQLite、NLS：本插件不支持 BitTorrent/Metalink/SFTP，全都不用；
#     依赖面越小，静态链与审计越容易。
#   - libz 一并关掉：macOS 的 zlib 在 libSystem 里，aria2 用它做 gzip 下载解压，
#     而本插件的探测强制 accept-encoding: identity、下载端也不请求压缩。
#   - --enable-static --disable-shared：依赖以 .a 链入；系统库
#     （libSystem/libc++）无法静态，由下方 otool 断言兜底。
export OPENSSL_CFLAGS="-I$OSL_INSTALL/include"
# 直接指到 .a 文件：linker 默认偏好 .dylib，指目录会让它链上动态库
export OPENSSL_LIBS="$OSL_INSTALL/lib/libssl.a $OSL_INSTALL/lib/libcrypto.a"
# aria2 在 __APPLE__ 下无条件使用 Security.framework 的 SecRandomCopyBytes
# （SimpleRandomizer.cc，源码级 #if 分支，configure 的探测覆盖不到它）。
# 实测（spike #1，2026-10-31）：不挂框架时链接期报
# "Undefined symbols: _SecRandomCopyBytes / _kSecRandomDefault"。
# automake 把 $(LIBS) 放在链接命令最末（对象之后），-framework 的位置正好正确。
export LIBS="-framework Security"

./configure \
  --enable-static --disable-shared \
  --without-gnutls --without-appletls \
  --without-libxml2 --without-libexpat --without-libz \
  --without-sqlite3 --without-libssh2 --without-libcares \
  --disable-nls \
  > "$WORK/configure.log" 2>&1 || { tail -50 "$WORK/configure.log"; exit 1; }
# 正向断言：确认 openssl 后端真的被启用（而不是静默落到「无 TLS 后端」——
# 那种二进制能编过、能 --version，HTTPS 下载时才失败）
grep -q "#define HAVE_OPENSSL 1" config.h || { echo "::error::configure 未启用 openssl 后端"; tail -50 "$WORK/configure.log"; exit 1; }

make -j"$(sysctl -n hw.ncpu)" > "$WORK/make.log" 2>&1 || { tail -50 "$WORK/make.log"; exit 1; }

BIN="$WORK/aria2-$VERSION/src/aria2c"
[ -f "$BIN" ] || { echo "::error::make 完成但找不到 src/aria2c"; exit 1; }

# ---------- 5. strip + 重新 ad-hoc 签名 ----------
# arm64 上内核拒绝运行无签名二进制；clang 链接时自动打的 ad-hoc 签名会被
# strip 破坏，因此 strip 之后必须重签（ad-hoc 签名 = 本机可运行，不做发布分发
# 意义上的签名——npm 安装路径不经过 Gatekeeper，没有公证需求）。
strip "$BIN"
codesign --force --sign - "$BIN"
codesign --verify "$BIN"

# ---------- 6. 正向断言 ①：动态库只有系统 ----------
# 链进了 /opt/homebrew / /usr/local 的库 = 在没有 brew 的用户机器上直接崩。
# 系统路径有两处：/usr/lib/（libSystem 等）与 /System/Library/（各系统
# framework，包括 aria2 必需的 Security.framework）—— 两处都在每一台 macOS 上
# 存在，除此之外一律不允许。实测（spike #2，2026-10-31）：第一版名单漏了
# /System/Library/，把系统自带的 Security.framework 误杀。
BAD_LIBS="$(otool -L "$BIN" | awk 'NR>1 {print $1}' | grep -vE '^/usr/lib/|^/System/Library/' || true)"
if [ -n "$BAD_LIBS" ]; then
  echo "::error::二进制链进了非系统库（用户机器上会加载失败）："
  echo "$BAD_LIBS"
  exit 1
fi
echo "--- otool -L（应全部是系统库：/usr/lib/ 与 /System/Library/）---"
otool -L "$BIN"

# ---------- 7. 正向断言 ②③：能运行 + 无模块目录也能启动 + 真的能 HTTPS 下载 ----------
"$BIN" --version | head -2

# 正向断言 ③（Issue #17 缺陷②的回归门）：把 OpenSSL 模块目录指到不存在的
# 路径再启动。legacy provider 若仍是 DSO 模块（缺陷②形态），Platform::setUp
# 会 throw、退出码非零 —— CI runner 上装着 brew，普通 --version 冒烟测不出
# 用户机器的故障，必须显式断言「零 DSO 依赖」。
VER_LOG="$WORK/version-modules-missing.log"
if ! OPENSSL_MODULES=/nonexistent-ossl-modules "$BIN" --version > "$VER_LOG" 2>&1 \
   || grep -q "OSSL_PROVIDER_load" "$VER_LOG"; then
  echo "::error::二进制在 OpenSSL 模块目录不可达时无法干净启动（legacy provider 未内建？）"
  cat "$VER_LOG"
  exit 1
fi
echo "--- OPENSSL_MODULES=/nonexistent --version OK（legacy provider 内建，零 DSO 依赖）---"

SMOKE="$WORK/smoke-npm.json"
SMOKE_URL="https://registry.npmjs.org/dsh-task-progress"
ok=0
for i in 1 2 3; do
  # 真实 HTTPS GET：验证静态 openssl 的握手、验证与传输整条链路
  if "$BIN" --allow-overwrite=true --summary-interval=0 -m 3 --retry-wait=2 \
      -d "$WORK" -o smoke-npm.json "$SMOKE_URL" > "$WORK/smoke.log" 2>&1; then
    ok=1; break
  fi
  echo "smoke attempt $i failed:"; tail -5 "$WORK/smoke.log"; sleep 3
done
[ "$ok" = "1" ] || { echo "::error::HTTPS 下载冒烟失败（$SMOKE_URL）"; exit 1; }
[ -s "$SMOKE" ] || { echo "::error::冒烟下载产物为空"; exit 1; }
echo "--- smoke download OK ($(wc -c < "$SMOKE") bytes from $SMOKE_URL) ---"

# ---------- 8. 落位 ----------
mkdir -p "$OUT_DIR/bin"
cp "$BIN" "$OUT_DIR/bin/aria2c"
chmod 755 "$OUT_DIR/bin/aria2c"
"$OUT_DIR/bin/aria2c" --version >/dev/null   # 落位后再跑一次：断言的是最终产物
echo "=== darwin-$SUBPKG_ARCH aria2c SHA256 ==="
shasum -a 256 "$OUT_DIR/bin/aria2c"
ls -l "$OUT_DIR/bin/aria2c"
