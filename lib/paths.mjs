// state 目录解析。herdr 调插件时会注入 HERDR_PLUGIN_STATE_DIR，但人从 shell 里
// 直接跑 bin/status.mjs 时没有 —— 那时必须落到 herdr 的约定路径上，否则会去看
// 一个空的 ./.state 然后报 "watcher 没在跑"，而实际上它跑得好好的。

import { homedir } from "node:os";
import { join } from "node:path";

export const PLUGIN_ID = "herdr-openclaw";

/** herdr 0.8.0 注入 HERDR_PLUGIN_STATE_DIR 时用的约定路径（实测取到的值）。 */
function conventionalStateDir() {
  const xdgState = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(xdgState, "herdr", "plugins", PLUGIN_ID);
}

export function stateDir() {
  return process.env.HERDR_PLUGIN_STATE_DIR || conventionalStateDir();
}

export function pidFile() {
  return join(stateDir(), "watch.pid");
}

export function logFile() {
  return join(stateDir(), "watch.log");
}

// ── env hygiene ─────────────────────────────────────────────────────────────
// 背景 watcher 用 detached:true 常驻到服务器退出，期间的 env 全是从 herdr 服务器
// 继承来的 —— 可能混着 *_API_KEY、SSH_AUTH_SOCK、token 之类。给它传白名单而不是
// 复制整个环境：进程只该看到它真正会读的东西。ps/sleep 这类探测子进程同理，它们
// 只需要 PATH 就能被找到。
//
// 白名单按"代码实际会读什么"穷举出来的：
//   PATH                —— spawnSync("herdr"/"ps"/"sleep") 按名字找可执行文件
//   HOME / XDG_*        —— paths.mjs / plugin-config.mjs 的 XDG 回退路径
//   HERDR_*              —— 服务器如何定位 socket（CLI 调用）与配置目录
//   HERDR_OPENCLAW_*     —— watcher 的文档化调参旋钮（POLL/DISCOVERY/VERBOSE）
// 刻意**不**带 HERDR_WORKSPACE_ID/TAB_ID/PANE_ID：常驻 watcher 不属于触发 startup
// 的那块面板，watch.mjs 也从不读它们 —— 带上只会把别人的上下文当自己的。
// 白名单里没有的键（含各类 *_API_KEY）一律丢。
const WATCHER_ENV_KEYS = [
  "PATH",
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "HERDR_CONFIG_PATH",
  "HERDR_SESSION",
  "HERDR_SOCKET_PATH",
  "HERDR_BIN_PATH",
  "HERDR_ENV",
  "HERDR_PLUGIN_ID",
  "HERDR_PLUGIN_ROOT",
  "HERDR_PLUGIN_CONFIG_DIR",
  "HERDR_PLUGIN_STATE_DIR",
  "HERDR_OPENCLAW_POLL_MS",
  "HERDR_OPENCLAW_DISCOVERY_MS",
  "HERDR_OPENCLAW_VERBOSE",
];

/** watcher 子进程的环境：只保留白名单键（存在才传）。 */
export function watcherEnv() {
  const out = {};
  for (const key of WATCHER_ENV_KEYS) {
    if (process.env[key] !== undefined) out[key] = process.env[key];
  }
  return out;
}

/** ps/sleep 探测子进程的环境：只要 PATH，够被找到就行。 */
export function probeEnv() {
  return process.env.PATH !== undefined ? { PATH: process.env.PATH } : {};
}
