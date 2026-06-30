// 钉钉表格信令客户端（presence + 定向 signal）。
// 表结构每行 5 列：[kind, a, b, c, ts]
//   presence 行: [presence, 用户名, "", "", 最后心跳ts]   —— 每人固定占 1 行，心跳 update 覆盖
//   signal   行: [signal, from, to, base64(JSON{type,payload}), ts] —— append 追加
import { GATEWAY_URL, GATEWAY_TIMEOUT_MS, NODE_ID, SHEET_ID } from "./config.js";

let rpcId = 1;

// 串行队列：钉钉表格网关在并发 append 下会互相覆盖丢行（实测 5 并发只剩 1 行）。
// 所有网关调用必须排队串行执行，一个完成再发下一个。
let queue = Promise.resolve();
function mcpCall(name, args) {
  const run = () => mcpCallRaw(name, args);
  // 把本次调用接到队列尾部；无论上一个成功失败都继续，避免卡死队列。
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}

async function mcpCallRaw(name, args) {
  const body = {
    jsonrpc: "2.0",
    id: rpcId++,
    method: "tools/call",
    params: { name, arguments: args },
  };
  // 超时保护：串行队列里一个无超时的 fetch 卡住会冻结全部信令。
  // 用 AbortController 在 GATEWAY_TIMEOUT_MS 后中止，让本次失败、队列继续。
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GATEWAY_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error(`网关请求超时（${GATEWAY_TIMEOUT_MS}ms）`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`网关 HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`MCP 错误: ${JSON.stringify(json.error)}`);
  const result = json.result || {};
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.[0]?.text;
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }
  return result;
}

function b64encode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function b64decode(b64) {
  return decodeURIComponent(escape(atob(b64)));
}

// 读全表，返回结构化行：[{ kind, a, b, c, ts, rowNum }]
async function readAll() {
  const out = await mcpCall("get_range_as_csv", {
    nodeId: NODE_ID,
    sheetId: SHEET_ID,
    valueRenderOption: "raw_value",
  });
  const csv = out.csv || "";
  if (!csv.trim()) return [];
  const rows = [];
  for (const rawLine of csv.split("\n")) {
    const m = rawLine.match(/^\[row=(\d+)\]\s*/);
    const rowNum = m ? Number(m[1]) : null;
    const line = rawLine.replace(/^\[row=\d+\]\s*/, "").trim();
    if (!line) continue;
    const cols = line.split(",");
    if (cols.length < 5) continue;
    rows.push({
      kind: cols[0],
      a: cols[1],
      b: cols[2],
      c: cols[3],
      ts: Number(cols[4]) || 0,
      rowNum,
    });
  }
  return rows;
}

// ---------- Presence ----------

// 上线 / 心跳：若已有自己的 presence 行则 update 覆盖，否则 append。
export async function heartbeat(me) {
  const ts = Date.now();
  // 找自己的 presence 行（用户名唯一）
  let rowNum = null;
  try {
    const found = await mcpCall("find_cells", {
      nodeId: NODE_ID,
      sheetId: SHEET_ID,
      text: me,
      matchEntireCell: true,
    });
    const cell = (found.matchedCells || []).find((c) =>
      /^B\d+$/.test(c.a1Notation || "")
    );
    if (cell) rowNum = Number(cell.a1Notation.replace(/[^\d]/g, ""));
  } catch {
    /* 找不到就当新用户 append */
  }

  if (rowNum) {
    await mcpCall("update_range", {
      nodeId: NODE_ID,
      sheetId: SHEET_ID,
      rangeAddress: `A${rowNum}:E${rowNum}`,
      values: [["presence", me, "", "", String(ts)]],
    });
  } else {
    await mcpCall("append_rows", {
      nodeId: NODE_ID,
      sheetId: SHEET_ID,
      values: [["presence", me, "", "", String(ts)]],
    });
  }
}

// 下线：清空自己的 presence 行，让对方立即看到离线（否则要等 15s 心跳超时）。
export async function clearPresence(me) {
  try {
    const found = await mcpCall("find_cells", {
      nodeId: NODE_ID,
      sheetId: SHEET_ID,
      text: me,
      matchEntireCell: true,
    });
    const cell = (found.matchedCells || []).find((c) =>
      /^B\d+$/.test(c.a1Notation || "")
    );
    if (!cell) return;
    const rowNum = Number(cell.a1Notation.replace(/[^\d]/g, ""));
    await mcpCall("update_range", {
      nodeId: NODE_ID,
      sheetId: SHEET_ID,
      rangeAddress: `A${rowNum}:E${rowNum}`,
      values: [["", "", "", "", ""]],
    });
  } catch {
    /* 清理失败忽略：心跳超时后对方自然会判离线 */
  }
}

// 在线用户列表：最近 staleMs 内有心跳、且不是自己的 presence 行的用户名。
export async function listUsers(me, staleMs = 15000) {
  const rows = await readAll();
  const now = Date.now();
  const users = [];
  const seen = new Set();
  for (const r of rows) {
    if (r.kind !== "presence") continue;
    if (r.a === me) continue;
    if (now - r.ts > staleMs) continue;
    if (seen.has(r.a)) continue;
    seen.add(r.a);
    users.push(r.a);
  }
  return users;
}

// ---------- Signaling ----------

// 发一条定向信令。payload 是 SDP/ICE 的对象，整体 JSON+base64。
export async function sendSignal(from, to, type, payload) {
  const ts = Date.now();
  const data = b64encode(JSON.stringify({ type, payload }));
  await mcpCall("append_rows", {
    nodeId: NODE_ID,
    sheetId: SHEET_ID,
    values: [["signal", from, to, data, String(ts)]],
  });
}

// 读发给「我」的信令行。返回 [{ from, type, payload, ts, key }]
// since: 只返回 ts >= since 的行，忽略上线之前的历史脏数据。
export async function readMySignals(me, since = 0) {
  const rows = await readAll();
  const out = [];
  for (const r of rows) {
    if (r.kind !== "signal") continue;
    if (r.b !== me) continue; // to == 我
    if (r.ts < since) continue; // 忽略上线前的历史信令
    let parsed;
    try {
      parsed = JSON.parse(b64decode(r.c));
    } catch {
      continue;
    }
    out.push({
      from: r.a,
      type: parsed.type,
      payload: parsed.payload,
      ts: r.ts,
      // 内容指纹做去重 key：不能用行号——钉钉表格清空后行号会复用，
      // 残留的 processedSignals 会把落到旧行号的新信令误判为已处理。
      // from+to+原始 data 列(含 type/payload)+ts 唯一标识一条信令。
      key: `${r.a}:${r.b}:${r.ts}:${r.c}`,
    });
  }
  return out;
}

// 清掉与「我」相关的历史 signal 行（from==我 或 to==我），把这些行清空。
// 不动 presence 行。用于上线时清理脏数据，避免旧信令驱动握手。
export async function clearMySignals(me) {
  const rows = await readAll();
  const targets = rows.filter(
    (r) => r.kind === "signal" && (r.a === me || r.b === me) && r.rowNum
  );
  // 逐行清空（把整行 A:E 覆盖为空字符串）。行数通常很少。
  for (const r of targets) {
    try {
      await mcpCall("update_range", {
        nodeId: NODE_ID,
        sheetId: SHEET_ID,
        rangeAddress: `A${r.rowNum}:E${r.rowNum}`,
        values: [["", "", "", "", ""]],
      });
    } catch {
      /* 单行清理失败忽略 */
    }
  }
  return targets.length;
}

// 清空整表。
export async function clearAll() {
  await mcpCall("clear_range", {
    nodeId: NODE_ID,
    sheetId: SHEET_ID,
    range: "A1:Z1000",
  });
}
