#!/usr/bin/env node
// 插件 [[startup]] 入口。必须**立刻返回** —— herdr 会等 startup 命令退出并记录
// exit_code/stdout/stderr（见 docs/findings-2026-08-12.md §9），把长驻循环直接
// 挂在这里会拖住插件启动。所以这里只做两件事：对账、把 watcher 甩到后台。

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { listPanes, isOpenClawPane, releaseAgent } from "../lib/herdr.mjs";
import { logFile, pidFile, probeEnv, stateDir, watcherEnv } from "../lib/paths.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STATE_DIR = stateDir();
const PID_FILE = pidFile();
const LOG_FILE = logFile();

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 这个 pid 真的是我们的 watcher 吗。
 * watcher 异常死亡后 pid 会被系统回收再分配给无关进程，只凭 `kill(pid,0)` 判活
 * 就会把那个无辜进程 SIGTERM 掉。校验命令行里有没有 watch.mjs。
 */
function isOurWatcher(pid) {
  const r = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    env: probeEnv(),
  });
  if (r.status !== 0) return false;
  return /watch\.mjs/.test(r.stdout ?? "");
}

/** 等进程真的消失。SIGTERM 是异步的，不等就 spawn 会撞上它的 shutdown。 */
function waitForExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    spawnSync("sleep", ["0.1"], { env: probeEnv() });
  }
  return !alive(pid);
}

/**
 * herdr 重启只恢复布局、不恢复运行时，`agent list` 里会留下幽灵记录
 * （pane 侧是权威，agent 侧不是；见 docs/findings-2026-08-12.md §9）。
 * 我们只对自己 source 报过的 pane 负责：pane 没了或不再跑 OpenClaw 就交还 authority。
 */
function reconcile() {
  let released = 0;
  for (const pane of listPanes()) {
    const paneId = pane.pane_id;
    if (!paneId || pane.agent !== "openclaw") continue;
    if (isOpenClawPane(paneId)) continue;
    releaseAgent(paneId);
    released += 1;
  }
  return released;
}

function stopStaleWatcher() {
  if (!existsSync(PID_FILE)) return { stopped: false };
  const pid = Number(readFileSync(PID_FILE, "utf8").trim());
  let stopped = false;
  let note = null;

  if (Number.isFinite(pid) && alive(pid)) {
    if (!isOurWatcher(pid)) {
      // pid 被复用了，绝不能杀。
      note = `pid ${pid} 已被无关进程占用，跳过 kill`;
    } else {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* 竞态：刚好自己退了 */
      }
      // **必须等它退干净再起新的。** 旧 watcher 的 shutdown 会 release 它
      // tracked 的所有 pane；不等的话新 watcher 可能刚接管完就被旧的 release 掉，
      // 而新 watcher 的 tracked 已记下状态、不会重报 —— 该 pane 就此丢失归属。
      stopped = waitForExit(pid);
      if (!stopped) note = `旧 watcher(pid ${pid}) 未在超时内退出`;
    }
  }

  try {
    unlinkSync(PID_FILE);
  } catch {
    /* 没有就算了 */
  }
  return { stopped, note };
}

mkdirSync(STATE_DIR, { recursive: true });
const stop = stopStaleWatcher();
const released = reconcile();

const logFd = openSync(LOG_FILE, "a");
const child = spawn(process.execPath, [join(ROOT, "bin", "watch.mjs"), "--verbose"], {
  cwd: ROOT,
  detached: true,
  stdio: ["ignore", "ignore", logFd],
  env: watcherEnv(),
});
child.unref();
writeFileSync(PID_FILE, String(child.pid));

console.log(
  JSON.stringify({
    ok: true,
    watcher_pid: child.pid,
    released,
    state_dir: STATE_DIR,
    ...(stop.note ? { warning: stop.note } : {}),
  }),
);
