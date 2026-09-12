// OpenClaw TUI 状态解析。纯函数，不碰 IO —— 所有 herdr 调用在 lib/herdr.mjs。
//
// 契约来源：2026-08-12 对 openclaw 2026.7.1-2 的实测 + dist/tui-*.js 反查，
// 见 docs/findings-2026-08-12.md。TUI 底部固定两行：
//
//    gateway connected | idle
//    agent main | session tui-<uuid> | claude-cli/claude-opus-5 | think medium | tokens 144k/1.0m (14%)
//
// 第一行第二段是 TUI 内部的 activityStatus，取值由 setActivityStatus() 调用点穷举得到。

/** setActivityStatus() 的全部固定取值（dist/tui-*.js 穷举）。 */
export const ACTIVITY_STATES = [
  "idle",
  "sending",
  "running",
  "streaming",
  "waiting",
  "auth",
  "error",
  "disconnected",
  "aborted",
];

/** activityStatus -> herdr 四态。未列出的（含自由文案）走 unknown 兜底。 */
const ACTIVITY_TO_HERDR = {
  idle: "idle",
  sending: "working",
  running: "working",
  streaming: "working",
  waiting: "working",
  auth: "blocked",
  error: "unknown",
  disconnected: "unknown",
  aborted: "idle",
};

// activityStatus 字段也会被塞进自由文案，例如 "press ctrl+c again to exit"。
// 那是提示不是忙碌，按 idle 处理。
const IDLE_FREEFORM = [/press ctrl\+c again to exit/i, /cleared input/i];

// 审批/确认 UI。优先级高于 activityStatus —— 弹审批时底部可能仍是 waiting，
// 但对编排来说这是"需要人"，必须报 blocked。
const BLOCKER_PATTERNS = [
  /\ballow once\b/i,
  /\bapprove this change\b/i,
  /\bapprove matching future changes\b/i,
  /\bopenclaw devices approve\b/i,
  /\bexec approval\b/i,
];
// 仅当同时出现**选择器形状**时才算真在等人。
// 这里刻意不收 `enter` / `deny` 这类光秃秃的常用词：正文里讨论审批界面
// （"choose Allow once and hit enter"）就会两词同现，把一个正在正常回话的
// 面板误判成 blocked —— 编排会因此白等一个永远不会来的人。
// 选择器形状（方向键提示、y/n 括号、带序号的选项行）几乎只出现在真的交互控件里。
const BLOCKER_CONFIRM = [
  /↑\/↓/,
  /\[y\/n\]/i,
  /\(y\/n\)/i,
  /\benter to (?:confirm|select|continue)\b/i,
  /\besc to cancel\b/i,
  /^\s*[▸>»]?\s*\d\.\s+\S/m, // "1. Allow once" 这种带序号的选项行
];

// 窄面板下 TUI 会把 "gateway " 前缀省掉，只剩 "connected | idle"（实测 2026-08-12）。
// 所以前缀可选，但连接态词必须在已知词表里 —— 否则 "foo | bar" 这种正文会被当状态行。
const CONN_STATES = ["connected", "connecting", "disconnected"];
const STATUS_LINE = new RegExp(
  String.raw`^\s*(?:gateway\s+)?(${CONN_STATES.join("|")})\s*\|\s*(.+?)\s*$`,
  "i",
);

// run 进行中，同一个槽位换成完全不同的一行 —— 顺序反过来，活动在前、连接态在后，
// 中间夹一个耗时。dist/tui-*.js 的原始拼装（updateBusyStatusMessage）：
//
//   activityStatus === "waiting"
//     ? `${phrase}… • ${elapsed} | ${connectionStatus}`   // phrase 是随机俏皮词
//     : `${activityStatus} • ${elapsed} | ${connectionStatus}`
//
// 外面还套着 Loader 的 spinner 前缀。实测长这样：
//   ⠧ noodling… • 2s | gateway connected
//
// 不能按词表认：俏皮词列表（noodling / kerfuffling / …）是 buildWaitingStatusMessage
// 的可配置入参。按形状认 —— "• 耗时 | 连接态" 结尾就是 busy。
// elapsed 形如 `2s` 或 `1m 5s`（含空格），所以耗时段不能用 \S+。
const BUSY_LINE = new RegExp(
  String.raw`^\s*(?:[⠀-⣿]\s*)?(.+?)\s*•\s*([^|]+?)\s*\|\s*(?:gateway\s+)?(${CONN_STATES.join("|")})\s*$`,
  "i",
);
// agent 段不能用 \S+ ——多 agent 配置下实测长这样：`agent side (side) | session …`，
// 括号里是显示名。取到第一个 | 为止，再把括号部分剥掉。
const INFO_LINE = /^\s*agent\s+([^|]+?)\s*\|\s*session\s+(\S+?)\s*(?:\|\s*(.*))?$/;
const AGENT_DISPLAY_SUFFIX = /\s*\([^)]*\)\s*$/;
/** 分隔线 / 空行 —— info 块的下界。 */
const INFO_BLOCK_END = /^\s*(?:[─—-]{3,}\s*)?$/;

/** 从 info 行右半段抽 model / think / tokens。字段顺序不保证，逐段匹配。 */
function parseInfoRest(rest) {
  const out = { model: null, think: null, tokens: null, tokenPct: null };
  if (!rest) return out;
  for (const seg of rest.split("|").map((s) => s.trim())) {
    if (!seg) continue;
    let m = seg.match(/^think\s+(.+)$/i);
    if (m) {
      out.think = m[1].trim();
      continue;
    }
    m = seg.match(/^tokens\s+(\S+)(?:\s*\((\d+)%\))?/i);
    if (m) {
      out.tokens = m[1];
      out.tokenPct = m[2] ? Number(m[2]) : null;
      continue;
    }
    // 第一个既非 think 也非 tokens 的段，当作 provider/model。
    // 老格式带 provider 前缀（claude-cli/claude-opus-5）；2026.9.x 只剩裸模型名
    // （gpt-5.6-sol），没有 / 也认 —— 但冒号段（deliver:off 这类控制位）不行。
    if (!out.model && (seg.includes("/") || !seg.includes(":"))) out.model = seg;
  }
  return out;
}

/**
 * 把 info 行及其续行拼成一段。
 * @param {string[]} lines 全部行
 * @param {number} start   info 行下标
 * @param {string|undefined} firstRest info 行 session 之后的残段
 */
function joinInfoBlock(lines, start, firstRest) {
  const parts = firstRest ? [firstRest] : [];
  for (let j = start + 1; j < lines.length; j++) {
    const next = lines[j];
    if (INFO_BLOCK_END.test(next)) break;
    // 撞上下一个状态行/info 行说明已经越界了，停。
    if (STATUS_LINE.test(next) || INFO_LINE.test(next)) break;
    parts.push(next.trim());
  }
  return parts.join(" | ");
}

function looksBlocked(tail) {
  if (!BLOCKER_PATTERNS.some((re) => re.test(tail))) return false;
  return BLOCKER_CONFIRM.some((re) => re.test(tail));
}

/**
 * 解析 pane 尾部文本。
 * @param {string} text `herdr pane read --source detection` 的输出（已去 ANSI）
 */
export function parseOpenClawStatus(text) {
  const empty = {
    state: "unknown",
    activity: null,
    elapsed: null,
    busy: false,
    conn: null,
    agentName: null,
    sessionId: null,
    model: null,
    think: null,
    tokens: null,
    tokenPct: null,
    matched: false,
  };
  if (typeof text !== "string" || !text.trim()) return empty;

  const lines = text.split("\n");
  let conn = null;
  let activity = null;
  let elapsed = null;
  let busy = false;
  let agentName = null;
  let sessionId = null;
  let info = { model: null, think: null, tokens: null, tokenPct: null };

  // 从后往前找 —— 状态行永远在最下面，历史正文里可能出现同形字符串。
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (activity === null) {
      // busy 行先试：它和空闲行占同一个槽位，二者互斥。
      const b = line.match(BUSY_LINE);
      if (b) {
        activity = b[1].replace(/…\s*$/, "").trim();
        elapsed = b[2];
        conn = b[3];
        busy = true;
        continue;
      }
      const m = line.match(STATUS_LINE);
      if (m) {
        conn = m[1];
        activity = m[2];
        continue;
      }
    }
    if (sessionId === null) {
      const m = line.match(INFO_LINE);
      if (m) {
        agentName = m[1].replace(AGENT_DISPLAY_SUFFIX, "").trim();
        sessionId = m[2];
        // info 行在窄面板下会被 TUI 硬折成多行（不是终端 wrap，recent-unwrapped
        // 也一样折）。往下续读到分隔线为止，否则 model/tokens 全丢。
        info = parseInfoRest(joinInfoBlock(lines, i, m[3]));
      }
    }
    if (activity !== null && sessionId !== null) break;
  }

  if (activity === null) return empty;

  const tail = lines.slice(-20).join("\n");
  const mapped = ACTIVITY_TO_HERDR[activity.toLowerCase()];
  let state;
  if (looksBlocked(tail)) {
    state = "blocked";
  } else if (busy) {
    // busy 行只在 run 活跃期间渲染，所以它出现本身就等于 working —— 不必也不能
    // 靠活动词判断（waiting 态那半是随机俏皮词，永远查不到表）。
    // 只有查到表且明确是 blocked 的（auth）才升级，其余一律 working。
    state = mapped === "blocked" ? "blocked" : "working";
  } else if (IDLE_FREEFORM.some((re) => re.test(activity))) {
    state = "idle";
  } else {
    state = mapped ?? "unknown";
  }

  return {
    state,
    activity,
    elapsed,
    busy,
    conn,
    agentName,
    sessionId,
    model: info.model,
    think: info.think,
    tokens: info.tokens,
    tokenPct: info.tokenPct,
    matched: true,
  };
}

/**
 * 侧栏 token 位。herdr 的 --token NAME=VALUE 一格一个值，短一点别把边栏撑爆。
 * 值为空串表示清掉该格 —— 换了会话但新会话还没读到 tokens 时用得上。
 */
export function buildTokens(status) {
  return {
    // 只在 run 进行中才有耗时；空闲时给空串把这格清掉，否则会留一个
    // 永远停在最后读数的假计时器。
    run: status.busy && status.elapsed ? status.elapsed : "",
    model: status.model ? status.model.split("/").pop() : "",
    ctx:
      status.tokens == null
        ? ""
        : status.tokenPct == null
          ? status.tokens
          : `${status.tokens} ${status.tokenPct}%`,
    think: status.think && status.think !== "off" ? status.think : "",
  };
}

/**
 * 把 activityStatus 透出到状态标签上 —— herdr 只有四态，
 * 但 streaming / waiting / sending 的区别对盯任务的人有用。
 */
export function buildStateLabels(status) {
  if (!status.activity || status.activity === status.state) return {};
  if (status.state === "unknown") return {};
  return { [status.state]: status.activity };
}
