import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ACTIVITY_STATES,
  buildStateLabels,
  buildTokens,
  parseOpenClawStatus,
} from "../lib/detect.mjs";
import { matchesOpenClawProcess } from "../lib/herdr.mjs";

// 真机采样：openclaw 2026.7.1-2，`herdr pane read --source detection`，2026-08-12。
const REAL_IDLE = `
 gateway connected | idle
 agent main | session tui-4f2a91c7-0b3e-4d15-8a6f-2c9e7b148d03 | claude-cli/claude-opus-5 | think medium | tokens 144k/1.0m (14%)
──────────────────────────────────────────────────────────────────────────

──────────────────────────────────────────────────────────────────────────
`;

// 真机采样二：窄面板。TUI 自己把 "gateway " 前缀省了，info 行也硬折成两行
// （`--source recent-unwrapped` 同样折，说明不是终端 wrap）。2026-08-12 实测。
const REAL_NARROW = `
 run error: CLI produced no output for 180s and was terminated.
 connected | error
 agent main | session tui-4f2a91c7-0b3e-4d15-8a6f-2c9e7b148d03 |
 claude-cli/claude-opus-5 | think high | tokens 144k/1.0m (14%)
─────────────────────────────────────────────────────────────────────────

─────────────────────────────────────────────────────────────────────────
`;

// 真机采样三：多 agent 配置下的 her。两处新形态——agent 名带括号显示名
// `agent side (side)`，以及 token 计数可以是 `?`（还没算出来）且没有百分比。
const REAL_NAMED_AGENT = `
 connected | idle
 agent side (side) | session tui-9e51b3d4-77c2-4a08-b9e1-5d3f0a62c8b7 | example-proxy/fast-model-v1 |
 think high | tokens ?/1.0m
────────────────────────────────────────────────────────────────────────
看一下
────────────────────────────────────────────────────────────────────────
`;

// 真机采样四：run 进行中。这是最坑的一份——同一个槽位换成了**结构相反**的一行：
// 活动在前、连接态在后，中间夹耗时，前面还有 Loader 的 spinner。
// dist 原始拼装（updateBusyStatusMessage）：
//   waiting  -> `${俏皮词}… • ${elapsed} | ${connectionStatus}`
//   其余     -> `${activityStatus} • ${elapsed} | ${connectionStatus}`
const REAL_BUSY = `
从1数到30，每个数字单独占一行


 ⠧ noodling… • 2s | gateway connected
 agent main | session herdr-probe | claude-cli/claude-sonnet-5 | think high | tokens ?/1.0m
────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────
`;

const withActivity = (a) => REAL_IDLE.replace("| idle", `| ${a}`);

test("解析真机 idle 采样", () => {
  const s = parseOpenClawStatus(REAL_IDLE);
  assert.equal(s.matched, true);
  assert.equal(s.state, "idle");
  assert.equal(s.activity, "idle");
  assert.equal(s.conn, "connected");
  assert.equal(s.agentName, "main");
  assert.equal(s.sessionId, "tui-4f2a91c7-0b3e-4d15-8a6f-2c9e7b148d03");
  assert.equal(s.model, "claude-cli/claude-opus-5");
  assert.equal(s.think, "medium");
  assert.equal(s.tokens, "144k/1.0m");
  assert.equal(s.tokenPct, 14);
});

test("窄面板：缺 gateway 前缀 + info 行折断，仍要全解出来", () => {
  const s = parseOpenClawStatus(REAL_NARROW);
  assert.equal(s.matched, true);
  assert.equal(s.conn, "connected");
  assert.equal(s.activity, "error");
  assert.equal(s.state, "unknown");
  assert.equal(s.sessionId, "tui-4f2a91c7-0b3e-4d15-8a6f-2c9e7b148d03");
  // 折到第二行的这三个字段是这条用例的重点 —— 之前全丢了。
  assert.equal(s.model, "claude-cli/claude-opus-5");
  assert.equal(s.think, "high");
  assert.equal(s.tokens, "144k/1.0m");
  assert.equal(s.tokenPct, 14);
});

test("agent 名带括号显示名时，整条 info 行仍要解出来", () => {
  const s = parseOpenClawStatus(REAL_NAMED_AGENT);
  assert.equal(s.matched, true);
  assert.equal(s.state, "idle");
  // 之前 `agent side (side)` 会让整条 info 行不匹配，session/model/tokens 全丢。
  assert.equal(s.agentName, "side");
  assert.equal(s.sessionId, "tui-9e51b3d4-77c2-4a08-b9e1-5d3f0a62c8b7");
  assert.equal(s.model, "example-proxy/fast-model-v1");
  assert.equal(s.think, "high");
  assert.equal(s.tokens, "?/1.0m");
  assert.equal(s.tokenPct, null);
});

test("token 计数为 ? 时侧栏照常显示，不显示百分比", () => {
  assert.deepEqual(buildTokens(parseOpenClawStatus(REAL_NAMED_AGENT)), {
    run: "",
    model: "fast-model-v1",
    ctx: "?/1.0m",
    think: "high",
  });
});

test("run 进行中：真机 busy 行必须报 working", () => {
  const s = parseOpenClawStatus(REAL_BUSY);
  assert.equal(s.matched, true);
  assert.equal(s.state, "working");
  assert.equal(s.busy, true);
  assert.equal(s.activity, "noodling"); // 尾部的 … 剥掉
  assert.equal(s.elapsed, "2s");
  assert.equal(s.conn, "connected");
  // busy 行下面的 info 行照常要解出来
  assert.equal(s.sessionId, "herdr-probe");
  assert.equal(s.model, "claude-cli/claude-sonnet-5");
});

test("俏皮词是可配置的，任何词都不能影响判定", () => {
  for (const w of [
    "flibbertigibbeting",
    "kerfuffling",
    "twiddling thumbs", // 带空格
    "某个中文词",
    "brand-new-phrase",
  ]) {
    const s = parseOpenClawStatus(REAL_BUSY.replace("noodling…", `${w}…`));
    assert.equal(s.state, "working", w);
    assert.equal(s.activity, w, w);
  }
});

test("非 waiting 的 busy 行（活动词直出、无省略号）同样是 working", () => {
  for (const a of ["streaming", "sending", "running"]) {
    const s = parseOpenClawStatus(REAL_BUSY.replace("⠧ noodling…", a));
    assert.equal(s.state, "working", a);
    assert.equal(s.activity, a, a);
    assert.equal(s.busy, true, a);
  }
});

test("busy 行里的 auth 要升级成 blocked，不能报 working", () => {
  const s = parseOpenClawStatus(REAL_BUSY.replace("⠧ noodling…", "auth"));
  assert.equal(s.state, "blocked");
});

test("elapsed 超过一分钟带空格，不能截断", () => {
  const s = parseOpenClawStatus(REAL_BUSY.replace("• 2s |", "• 1m 5s |"));
  assert.equal(s.state, "working");
  assert.equal(s.elapsed, "1m 5s");
});

test("没有 spinner 前缀时也要认（Loader 未渲染的那一帧）", () => {
  const s = parseOpenClawStatus(REAL_BUSY.replace("⠧ noodling…", "noodling…"));
  assert.equal(s.state, "working");
  assert.equal(s.activity, "noodling");
});

test("run 计时只在进行中占侧栏格子，空闲时清掉", () => {
  assert.equal(buildTokens(parseOpenClawStatus(REAL_BUSY)).run, "2s");
  assert.equal(buildTokens(parseOpenClawStatus(REAL_IDLE)).run, "");
});

test("正文里带 • 的句子不会被误判成 busy 行", () => {
  const prose = REAL_IDLE.replace(
    " gateway connected | idle",
    "备选项 A • B | connected 的说明见上\n gateway connected | idle",
  );
  const s = parseOpenClawStatus(prose);
  assert.equal(s.state, "idle");
  assert.equal(s.busy, false);
});

test("正文里的 'x | y' 不会被当成状态行", () => {
  const prose = REAL_IDLE.replace(
    " gateway connected | idle",
    "对比表：openclaw | hermes\n 前端 | 后端\n gateway connected | idle",
  );
  const s = parseOpenClawStatus(prose);
  assert.equal(s.activity, "idle");
  assert.equal(s.conn, "connected");
});

test("忙碌类 activity 一律映射到 working", () => {
  for (const a of ["sending", "running", "streaming", "waiting"]) {
    assert.equal(parseOpenClawStatus(withActivity(a)).state, "working", a);
  }
});

test("auth 映射到 blocked，断连/报错映射到 unknown", () => {
  assert.equal(parseOpenClawStatus(withActivity("auth")).state, "blocked");
  assert.equal(parseOpenClawStatus(withActivity("error")).state, "unknown");
  assert.equal(parseOpenClawStatus(withActivity("disconnected")).state, "unknown");
});

test("aborted 是终止不是忙碌", () => {
  assert.equal(parseOpenClawStatus(withActivity("aborted")).state, "idle");
});

test("自由文案不当忙碌处理", () => {
  const s = parseOpenClawStatus(withActivity("press ctrl+c again to exit"));
  assert.equal(s.state, "idle");
  assert.equal(s.matched, true);
});

test("未知 activity 兜底为 unknown 而不是崩", () => {
  assert.equal(parseOpenClawStatus(withActivity("brand-new-state")).state, "unknown");
});

test("审批 UI 覆盖 activity —— 底部还是 waiting 也要报 blocked", () => {
  const approval = withActivity("waiting").replace(
    "──────────────────────────────────────────────────────────────────────────\n",
    "  Allow once\n  Deny\n  ↑/↓ select · enter confirm\n",
  );
  assert.equal(parseOpenClawStatus(approval).state, "blocked");
});

test("正文里同时出现 allow once 和 enter/deny，仍不能误判成 blocked", () => {
  // 评审指出的洞：早期 BLOCKER_CONFIRM 收了光秃秃的 /\benter\b/ 和 /\bdeny\b/，
  // 于是"讨论审批界面"的正常回话会被判成在等人，编排白等一个永远不来的人。
  const prose = REAL_IDLE.replace(
    " gateway connected | idle",
    "审批界面上你可以 choose Allow once and hit enter，也可以 deny。\n gateway connected | idle",
  );
  assert.equal(parseOpenClawStatus(prose).state, "idle");
});

test("真的审批控件（带序号选项 + 方向键提示）照样要判 blocked", () => {
  const ui = REAL_IDLE.replace(
    " gateway connected | idle",
    "  1. Allow once\n  2. Deny\n  ↑/↓ select\n gateway connected | idle",
  );
  assert.equal(parseOpenClawStatus(ui).state, "blocked");
});

test("正文里提到 allow once 但没有选择器提示，不误判", () => {
  const prose = REAL_IDLE.replace(
    " gateway connected | idle",
    "我刚才解释了 allow once 这个选项的含义。\n gateway connected | idle",
  );
  assert.equal(parseOpenClawStatus(prose).state, "idle");
});

test("状态行未画出来时 matched=false", () => {
  assert.equal(parseOpenClawStatus("user@host:~$ ").matched, false);
  assert.equal(parseOpenClawStatus("").matched, false);
  assert.equal(parseOpenClawStatus(null).matched, false);
});

test("取最后一次出现的状态行 —— 历史正文里的同形字符串不干扰", () => {
  const stale = `${withActivity("streaming")}\n${REAL_IDLE}`;
  assert.equal(parseOpenClawStatus(stale).state, "idle");
});

test("info 行缺右半段也不崩", () => {
  const bare = " gateway connected | idle\n agent main | session tui-abc\n";
  const s = parseOpenClawStatus(bare);
  assert.equal(s.sessionId, "tui-abc");
  assert.equal(s.model, null);
  assert.equal(s.tokens, null);
});

test("buildTokens 产出侧栏各格，空值用空串表示清除", () => {
  const s = parseOpenClawStatus(REAL_IDLE);
  assert.deepEqual(buildTokens(s), {
    run: "",
    model: "claude-opus-5",
    ctx: "144k/1.0m 14%",
    think: "medium",
  });
  const bare = parseOpenClawStatus(" gateway connected | idle\n");
  assert.deepEqual(buildTokens(bare), { run: "", model: "", ctx: "", think: "" });
});

test("state label 只在 activity 比四态更细时才加", () => {
  assert.deepEqual(buildStateLabels(parseOpenClawStatus(REAL_IDLE)), {});
  assert.deepEqual(buildStateLabels(parseOpenClawStatus(withActivity("streaming"))), {
    working: "streaming",
  });
  // unknown 态不贴标签：那时候我们本来就不知道发生了什么，别给人错觉。
  assert.deepEqual(buildStateLabels(parseOpenClawStatus(withActivity("error"))), {});
});

test("穷举出来的 activity 词表每个都有确定归属", () => {
  for (const a of ACTIVITY_STATES) {
    const s = parseOpenClawStatus(withActivity(a));
    assert.ok(["idle", "working", "blocked", "unknown"].includes(s.state), a);
  }
});

// ---------------------------------------------------------------------------
// process-info 形状回归。herdr 0.8.0 -> 0.9.0 把 argv0 换成了 name/argv[]，
// 只认 argv0 会让 isOpenClawPane 永远返回 false，插件静默不工作。
// ---------------------------------------------------------------------------
test("herdr 0.9.0 的 process-info 形状（name/argv，无 argv0）要认出来", () => {
  // 真机采样：herdr 0.9.0 `pane process-info --pane w1:p3`，2026-09-14。
  const procs = [
    { argv: ["openclaw-tui"], cmdline: "openclaw-tui", cwd: "/home/ubuntu", name: "openclaw-tui", pid: 1580545 },
  ];
  assert.equal(matchesOpenClawProcess(procs), true);
});

test("herdr 0.8.0 的 argv0 形状要继续认", () => {
  assert.equal(matchesOpenClawProcess([{ argv0: "openclaw-tui" }]), true);
  assert.equal(matchesOpenClawProcess([{ argv0: "/usr/local/bin/openclaw" }]), true);
});

test("不是 OpenClaw 的前台进程不能误判", () => {
  assert.equal(matchesOpenClawProcess([{ name: "bash", argv: ["bash"] }]), false);
  // cmdline 里出现 openclaw 不算数：`vim openclaw` 不是 TUI。
  assert.equal(matchesOpenClawProcess([{ name: "vim", argv: ["vim", "openclaw"], cmdline: "vim openclaw" }]), false);
  assert.equal(matchesOpenClawProcess([]), false);
  assert.equal(matchesOpenClawProcess(undefined), false);
});
