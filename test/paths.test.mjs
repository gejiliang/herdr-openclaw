import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pidFile, probeEnv, stateDir, watcherEnv } from "../lib/paths.mjs";

const ENV_KEYS = ["HERDR_PLUGIN_STATE_DIR", "XDG_STATE_HOME"];

// paths.mjs 在**调用时**读环境变量（不是 import 时），所以求值必须发生在
// 环境还没被还原的窗口里 —— 早期这条测试就是栽在提前还原上。
function withEnv(env, fn) {
  const saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("herdr 注入 HERDR_PLUGIN_STATE_DIR 时以它为准", () => {
  withEnv({ HERDR_PLUGIN_STATE_DIR: "/tmp/injected" }, () => {
    assert.equal(stateDir(), "/tmp/injected");
    assert.equal(pidFile(), "/tmp/injected/watch.pid");
  });
});

test("从 shell 直接跑（没有注入）时落到 herdr 约定路径，而不是 ./.state", () => {
  withEnv({ HERDR_PLUGIN_STATE_DIR: undefined, XDG_STATE_HOME: undefined }, () => {
    const want = join(homedir(), ".local", "state", "herdr", "plugins", "herdr-openclaw");
    assert.equal(stateDir(), want);
  });
});

test("尊重 XDG_STATE_HOME", () => {
  withEnv({ HERDR_PLUGIN_STATE_DIR: undefined, XDG_STATE_HOME: "/tmp/xdg" }, () => {
    assert.equal(stateDir(), "/tmp/xdg/herdr/plugins/herdr-openclaw");
  });
});

// ── env hygiene ─────────────────────────────────────────────────────────────
// watcherEnv 遍历固定白名单键，所以 测试必须管理**白名单里所有键**，包括没有
// 在 overrides 里出现的 —— 否则测试机的真实 env 会泄漏进来，assert 指向
// 不知道该不该出现的值。
const WATCHER_KEYS = [
  "PATH", "HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME",
  "HERDR_CONFIG_PATH", "HERDR_SESSION", "HERDR_SOCKET_PATH", "HERDR_BIN_PATH",
  "HERDR_ENV", "HERDR_PLUGIN_ID", "HERDR_PLUGIN_ROOT",
  "HERDR_PLUGIN_CONFIG_DIR", "HERDR_PLUGIN_STATE_DIR",
  "HERDR_OPENCLAW_POLL_MS", "HERDR_OPENCLAW_DISCOVERY_MS",
  "HERDR_OPENCLAW_VERBOSE",
];
const WATCHER_NON_KEYS = ["HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"];

function withCleanWatcher(overrides, fn) {
  const allKeys = [...WATCHER_KEYS, ...WATCHER_NON_KEYS];
  const saved = {};
  for (const k of allKeys) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try { return fn(); }
  finally {
    for (const k of allKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("watcherEnv 只放行白名单键（含白名单键不存在时的 undefined → 不进结果）", () => {
  withCleanWatcher(
    {
      PATH: "/usr/bin",
      HOME: "/home/u",
      XDG_CONFIG_HOME: "/cfg",
      XDG_STATE_HOME: "/state",
      HERDR_PLUGIN_ID: "herdr-openclaw",
      HERDR_SOCKET_PATH: "/sock.s",
      HERDR_OPENCLAW_POLL_MS: "800",
    },
    () => {
      assert.deepEqual(watcherEnv(), {
        PATH: "/usr/bin",
        HOME: "/home/u",
        XDG_CONFIG_HOME: "/cfg",
        XDG_STATE_HOME: "/state",
        HERDR_PLUGIN_ID: "herdr-openclaw",
        HERDR_SOCKET_PATH: "/sock.s",
        HERDR_OPENCLAW_POLL_MS: "800",
      });
    },
  );
});

test("watcherEnv 不带 per-pane 归属（WORKSPACE/TAB/PANE id 即使被设也丢掉）", () => {
  withCleanWatcher(
    {
      HERDR_PANE_ID: "w6:p7",
      HERDR_TAB_ID: "w6:t6",
      HERDR_WORKSPACE_ID: "w6",
      HERDR_PLUGIN_ID: "herdr-openclaw",
    },
    () => {
      const env = watcherEnv();
      assert.equal(env.HERDR_PANE_ID, undefined);
      assert.equal(env.HERDR_TAB_ID, undefined);
      assert.equal(env.HERDR_WORKSPACE_ID, undefined);
      assert.equal(env.HERDR_PLUGIN_ID, "herdr-openclaw");
    },
  );
});

test("非白名单键不进入 watcherEnv（含 NODE_OPTIONS / OPENAI_API_KEY 等）", () => {
  withCleanWatcher({ PATH: "/usr/bin", HOME: "/home/u" }, () => {
    const env = watcherEnv();
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.HOME, "/home/u");
  });
});

test("probeEnv 只要 PATH", () => {
  withCleanWatcher({ PATH: "/usr/bin", HOME: "/home/u" }, () => {
    assert.deepEqual(probeEnv(), { PATH: "/usr/bin" });
  });
});

test("probeEnv 没有 PATH 时返回空对象", () => {
  withCleanWatcher({ PATH: undefined }, () => {
    assert.deepEqual(probeEnv(), {});
  });
});
