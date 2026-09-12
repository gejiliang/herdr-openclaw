// herdr socket API 的薄封装。走 CLI 而不是直连 socket ——
// 理由见 docs/findings-2026-08-12.md：CLI 已经把 report-agent 全套暴露出来，
// 自己拼 socket 帧只会多一份要跟着 protocol 版本走的负担。

import { spawnSync } from "node:child_process";

export const SOURCE_ID = "herdr-openclaw";
export const AGENT_LABEL = "openclaw";

/** OpenClaw TUI 进程的 argv0。实测 2026.7.1-2 固定为此值。 */
export const OPENCLAW_ARGV0 = "openclaw-tui";

function run(args, { json = true } = {}) {
  const res = spawnSync("herdr", args, {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) throw new Error(`herdr ${args[0]} 调用失败: ${res.error.message}`);

  // herdr 的错误信封走 stderr、结果走 stdout（实测）。
  // 只看 stdout 会把合法错误误判成"输出损坏"，所以两边都要读。
  const stdout = res.stdout ?? "";
  const stderr = (res.stderr ?? "").trim();
  if (res.status !== 0) {
    let detail = stderr || stdout.trim();
    try {
      const env = JSON.parse(stderr);
      if (env?.error) detail = `${env.error.code ?? "error"}: ${env.error.message ?? stderr}`;
    } catch {
      /* 不是 JSON 信封就用原文 */
    }
    throw new Error(`herdr ${args.join(" ")} 退出码 ${res.status}: ${detail}`);
  }
  if (!json) return stdout;
  // 写类命令（report-agent / report-agent-session / report-metadata / release-agent）
  // **成功时没有任何 stdout**（实测）。不特判的话它们会掉进下面的 JSON 解析失败分支，
  // tryRun 返回 null —— 于是"成功"和"失败"从调用方看完全一样，
  // 任何基于返回值的重试逻辑都会永远走失败分支。
  if (!stdout.trim()) return { ok: true };
  try {
    return JSON.parse(stdout).result;
  } catch {
    throw new Error(`herdr ${args[0]} 返回的不是 JSON: ${stdout.slice(0, 200)}`);
  }
}

/** 静默版：herdr 没跑、pane 没了都会抛，调用方通常只想跳过这一轮。 */
export function tryRun(args, opts) {
  try {
    return run(args, opts);
  } catch {
    return null;
  }
}

export function listPanes() {
  const r = tryRun(["pane", "list"]);
  return r?.panes ?? [];
}

export function processInfo(paneId) {
  const r = tryRun(["pane", "process-info", "--pane", paneId]);
  return r?.process_info ?? null;
}

/** 该 pane 前台是否跑着 OpenClaw TUI。 */
export function isOpenClawPane(paneId) {
  const info = processInfo(paneId);
  if (!info) return false;
  return (info.foreground_processes ?? []).some((p) => {
    const names = [
      p.argv0,
      p.name,
      p.cmdline,
      ...(Array.isArray(p.argv) ? p.argv : []),
    ].filter(Boolean);
    return names.includes(OPENCLAW_ARGV0) || names.some((n) => /(^|\/)openclaw$/.test(n));
  });
}

/** 读 pane 尾部。detection 源就是 herdr 自己喂检测规则的那一份。 */
export function readPane(paneId, lines = 40, source = "detection") {
  const out = tryRun(
    ["pane", "read", paneId, "--source", source, "--lines", String(lines), "--format", "text"],
    { json: false },
  );
  return out ?? "";
}

export function reportAgent(paneId, state, { message, seq, sessionId } = {}) {
  const args = [
    "pane",
    "report-agent",
    paneId,
    "--source",
    SOURCE_ID,
    "--agent",
    AGENT_LABEL,
    "--state",
    state,
  ];
  if (message) args.push("--message", message);
  if (seq != null) args.push("--seq", String(seq));
  if (sessionId) args.push("--agent-session-id", sessionId);
  return tryRun(args);
}

export function reportAgentSession(paneId, sessionId, { seq } = {}) {
  const args = [
    "pane",
    "report-agent-session",
    paneId,
    "--source",
    SOURCE_ID,
    "--agent",
    AGENT_LABEL,
    "--agent-session-id",
    sessionId,
    "--session-start-source",
    SOURCE_ID,
  ];
  if (seq != null) args.push("--seq", String(seq));
  return tryRun(args);
}

/**
 * 侧栏展示元数据。全部是 display-only，不影响 agent 状态机。
 * @param {object} opts
 * @param {string} [opts.displayAgent] 面板上显示的名字，默认让 herdr 用 agent label
 * @param {Record<string,string>} [opts.tokens] 侧栏 token 位，name=value
 * @param {Record<string,string>} [opts.stateLabels] 四态的自定义文案，如 { working: "streaming" }
 * @param {number} [opts.ttlMs] 过期时间；watcher 挂掉后陈旧数据会自动消失
 */
export function reportMetadata(paneId, opts = {}) {
  const args = ["pane", "report-metadata", paneId, "--source", SOURCE_ID, "--agent", AGENT_LABEL];
  if (opts.displayAgent) args.push("--display-agent", opts.displayAgent);
  for (const [name, value] of Object.entries(opts.tokens ?? {})) {
    if (value == null || value === "") args.push("--clear-token", name);
    else args.push("--token", `${name}=${value}`);
  }
  for (const [state, label] of Object.entries(opts.stateLabels ?? {})) {
    args.push("--state-label", `${state}=${label}`);
  }
  if (opts.ttlMs != null) args.push("--ttl-ms", String(opts.ttlMs));
  return tryRun(args);
}

export function getAgent(paneId) {
  const r = tryRun(["agent", "get", paneId]);
  return r?.agent ?? null;
}

export function sendText(paneId, text) {
  return tryRun(["pane", "send-text", paneId, text]);
}

export function sendKeys(paneId, ...keys) {
  return tryRun(["pane", "send-keys", paneId, ...keys]);
}

/**
 * 弹通知。投递方式、位置、延迟、限流全部由 herdr 按用户的 `[ui.toast]` 决定，
 * 我们只给内容和音效语义。
 * @returns {{shown:boolean, reason:string}|null} reason ∈
 *   shown / disabled / rate_limited / no_foreground_client / busy
 */
export function showNotification({ title, body, sound }) {
  const args = ["notification", "show", title];
  if (body) args.push("--body", body);
  if (sound) args.push("--sound", sound);
  const r = tryRun(args);
  return r ? { shown: Boolean(r.shown), reason: r.reason } : null;
}

export function releaseAgent(paneId, { seq } = {}) {
  const args = [
    "pane",
    "release-agent",
    paneId,
    "--source",
    SOURCE_ID,
    "--agent",
    AGENT_LABEL,
  ];
  if (seq != null) args.push("--seq", String(seq));
  return tryRun(args);
}
