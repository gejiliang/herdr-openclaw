#!/usr/bin/env node
// 插件 action：watcher 活着吗、现在接管了哪些 pane。

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { listPanes } from "../lib/herdr.mjs";
import { pidFile, probeEnv, stateDir } from "../lib/paths.mjs";

const PID_FILE = pidFile();

let pid = null;
let running = false;
if (existsSync(PID_FILE)) {
  pid = Number(readFileSync(PID_FILE, "utf8").trim());
  try {
    process.kill(pid, 0);
    // 活着还不够：watcher 异常死亡后 pid 会被回收给无关进程，
    // 只判活会把"别人的进程"报成"watcher 在跑"。校验命令行。
    const ps = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      env: probeEnv(),
    });
    running = ps.status === 0 && /watch\.mjs/.test(ps.stdout ?? "");
  } catch {
    running = false;
  }
}

const claimed = listPanes()
  .filter((p) => p.agent === "openclaw")
  .map((p) => ({ pane_id: p.pane_id, status: p.agent_status, cwd: p.cwd }));

console.log(
  JSON.stringify({ watcher_pid: pid, running, state_dir: stateDir(), claimed }, null, 2),
);
