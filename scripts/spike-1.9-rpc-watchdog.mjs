/**
 * SPIKE 1.9 的 watchdog 子进程：
 *   宿主 → watchdog（stdin 为宿主持有的管道） → daemon
 * 宿主死亡 → stdin EOF → watchdog 杀掉 daemon 后退出（无孤儿）。
 *
 * 用法：node spike-1.9-rpc-watchdog.mjs <aria2c路径> <rpc端口> <secret> <dir>
 * stdout 上报 daemon 的 pid（一行数字）。
 */
import { spawn, execSync } from 'node:child_process'

const [a2c, port, secret, dir] = process.argv.slice(2)
const daemon = spawn(
  a2c,
  [
    '--enable-rpc=true',
    '--rpc-listen-port=' + port,
    '--rpc-secret=' + secret,
    '--dir=' + dir,
    '--file-allocation=none',
    '--console-log-level=warn',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
)

process.stdout.write(String(daemon.pid))
let daemonErr = ''
daemon.stderr.on('data', (c) => { daemonErr += c })
daemon.on('exit', (code) => { process.stdout.write('DAEMON_EXIT:' + code + ':' + daemonErr.slice(-200)); kill() })

const kill = () => {
  try {
    execSync('taskkill /PID ' + daemon.pid + ' /F', { stdio: 'ignore' })
  } catch {
    /* already dead */
  }
  process.exit(0)
}
process.stdin.on('end', kill)
process.stdin.on('close', kill)
process.stdin.resume()
setInterval(() => {}, 1000) // 常驻：唯一出口是 stdin EOF
