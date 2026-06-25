// 主流程：上线 → 在线列表 → 点击发起 → WebRTC 直连聊天。
import { POLL_INTERVAL_MS } from "./src/config.js";
import {
  heartbeat,
  listUsers,
  sendSignal,
  readMySignals,
  clearMySignals,
  clearPresence,
} from "./src/signaling.js";

// 列表刷新与拒绝后跳转的延时（毫秒）。集中放此处便于调整。
const LIST_REFRESH_MS = 3000;
const REJECT_BACK_MS = 1200;

// 信令表是公共白板，任何人可写任意行。喂给 WebRTC 前做基本结构校验，
// 避免畸形 / 恶意 payload 让 setRemoteDescription / addIceCandidate 抛错打断握手。
function isValidSdp(p) {
  return p && typeof p === "object" && typeof p.sdp === "string" && typeof p.type === "string";
}
function isValidIce(p) {
  // ICE candidate 至少要有 candidate 字段（字符串）。
  return p && typeof p === "object" && typeof p.candidate === "string";
}
import { RtcPeer } from "./src/rtc.js";

const $ = (id) => document.getElementById(id);
const HEARTBEAT_MS = 5000;
const NICK_KEY = "open-im:nick"; // chrome.storage 里保存昵称的键，用于重开 popup 自动上线

// 带时间戳和身份的日志，便于两个 popup 对照排查握手。
function log(...args) {
  const t = new Date().toISOString().slice(11, 23);
  console.log(`[open-im ${t}] [${me || "?"}]`, ...args);
}

let me = "";
let peer = null; // 当前 RtcPeer
let peerName = ""; // 当前对话对方昵称
let remoteDescSet = false;
let sessionStart = 0; // 本次上线时间；只处理此后产生的信令，忽略表里历史脏数据
const pendingIce = [];
const processedSignals = new Set(); // 已处理信令行 key

let heartbeatTimer = null;
let listTimer = null;
let signalTimer = null;

let pendingInviteFrom = null; // 收到来电邀请、尚未接听/拒绝的对方
let callTimeout = null; // A 侧呼叫超时计时器
const CALL_TIMEOUT_MS = 30000;

// ---------- 视图切换 ----------
function show(view) {
  for (const v of ["loginView", "listView", "chatView"]) {
    $(v).classList.toggle("active", v === view);
  }
}

// ---------- 登录 ----------
$("loginBtn").addEventListener("click", login);
$("nick").addEventListener("keydown", (e) => {
  if (e.key === "Enter") login();
});

async function login() {
  const nick = $("nick").value.trim();
  if (!nick) return;
  // auto=true 时（自动上线）失败不弹 alert、不清掉已存昵称，避免一打开就被打断。
  await doLogin(nick, false);
}

async function doLogin(nick, auto) {
  me = nick;
  $("loginBtn").disabled = true;
  resetSession(); // 重置所有残留状态，并把 sessionStart 推进到此刻
  try {
    // 清掉本人相关的历史信令行（to==我 / from==我），避免旧脏数据上来就驱动握手。
    await clearMySignals(me);
    await heartbeat(me);
  } catch (e) {
    if (!auto) alert("上线失败：" + e.message);
    else log("自动上线失败，停留在登录页:", e.message);
    $("loginBtn").disabled = false;
    return;
  }
  // 上线成功才持久化昵称：下次重开 popup 自动上线。
  chrome.storage.local.set({ [NICK_KEY]: me });
  log("已上线，sessionStart=", sessionStart, "已清理本人历史信令");
  $("meLabel").textContent = "我：" + me;
  show("listView");

  // 启动三个循环：心跳、刷新列表、轮询发给我的信令
  heartbeatTimer = setInterval(() => heartbeat(me).catch(() => {}), HEARTBEAT_MS);
  listTimer = setInterval(refreshList, LIST_REFRESH_MS);
  signalTimer = setInterval(pollSignals, POLL_INTERVAL_MS);
  refreshList();
  pollSignals();
}

// ---------- 在线列表 ----------
async function refreshList() {
  let users;
  try {
    users = await listUsers(me);
  } catch {
    return;
  }
  const box = $("userList");
  box.innerHTML = "";
  if (!users.length) {
    box.innerHTML = '<div class="empty">暂无其他在线用户<br>让对方也上线试试</div>';
    return;
  }
  for (const u of users) {
    const div = document.createElement("div");
    div.className = "user";
    // 头像取昵称首字符；textContent 赋值避免 XSS（昵称来自表格，不可信）。
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = [...u][0] || "?";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = u;
    const dot = document.createElement("span");
    dot.className = "dot";
    div.append(avatar, name, dot);
    div.addEventListener("click", () => startCall(u));
    box.appendChild(div);
  }
}

// 礼让规则：解决双方同时点击发起（glare）。
// 昵称字典序「小」的一方固定当 caller（写 offer），另一方当 callee（应答）。
// 这样无论谁先点、谁后点，角色都唯一确定，不会出现双 caller。
function iAmCaller(target) {
  return me < target;
}

// ---------- 点击某人发起对话：只发呼叫邀请，等对方接听 ----------
async function startCall(target) {
  log(`startCall → ${target}（发呼叫邀请，等待接听）`);
  openChat(target, "正在呼叫…");
  addMsg(`正在呼叫 ${target}，等待接听…`, "sys", "calling");
  try {
    await sendSignal(me, target, "call", {});
    log("已发呼叫邀请 →", target);
  } catch (e) {
    log("呼叫失败:", e);
    setChatStatus("呼叫失败：" + e.message);
    return;
  }
  // 30s 无应答自动取消
  clearTimeout(callTimeout);
  callTimeout = setTimeout(() => {
    log("呼叫超时，对方未接听");
    setChatStatus("对方未接听");
    addMsg(`${target} 未接听`, "sys");
    resetSession();
    show("listView");
    refreshList();
  }, CALL_TIMEOUT_MS);
}

// ---------- 接听后由 offerer（字典序小者）发起 WebRTC 握手 ----------
let offering = false;
async function startHandshakeAsOfferer(to) {
  if (offering) {
    log("正在发 offer 中，忽略重入");
    return;
  }
  offering = true;
  try {
    openChat(to, "连接中…");
    startPeer(true);
    let offer;
    try {
      offer = await peer.createOffer();
      log("已创建 offer，sdp 长度=", offer && offer.sdp && offer.sdp.length);
    } catch (e) {
      log("createOffer 抛错:", e);
      reportError(to, "createOffer: " + e.message);
      return;
    }
    if (!offer || !offer.sdp) {
      reportError(to, "offer 为空");
      return;
    }
    try {
      await sendSignal(me, to, "offer", offer);
      log("offer 已写入 →", to);
    } catch (e) {
      log("sendSignal(offer) 抛错:", e);
      reportError(to, "sendSignal(offer): " + e.message);
    }
  } finally {
    offering = false;
  }
}

// 把错误写到表里，方便从 dump 直接看到（绕过 console）。
async function reportError(to, msg) {
  try {
    await sendSignal(me, to, "error", { msg: String(msg).slice(0, 200) });
  } catch {
    /* 忽略 */
  }
}

// ---------- 收到 offer：我（callee）应答 ----------
let answering = false; // 防止同一批轮询里两个 offer 并发重入，互相关闭 peer 导致抛错
async function answerCall(from, offer) {
  if (answering) {
    log("正在应答中，忽略重复 offer from", from);
    return;
  }
  answering = true;
  log(`收到 ${from} 的 offer，作为 callee 应答`);
  openChat(from, "连接中…");
  startPeer(false); // 我是 callee
  try {
    const answer = await peer.acceptOfferCreateAnswer(offer);
    remoteDescSet = true;
    log("已 setRemoteDescription(offer) 并创建 answer，flush 缓冲 ICE:", pendingIce.length);
    await flushPendingIce();
    await sendSignal(me, from, "answer", answer);
    log("answer 已写入 →", from);
    addMsg(`已接通 ${from}`, "sys");
  } catch (e) {
    log("应答失败:", e);
    setChatStatus("应答失败：" + e.message);
    reportError(from, "answerCall: " + e.message); // 把失败原因写进表，便于排查
  } finally {
    answering = false;
  }
}

function startPeer(isCaller) {
  log(`startPeer isCaller=${isCaller}, peerName=${peerName}`);
  if (peer) peer.close();
  remoteDescSet = false;
  pendingIce.length = 0;
  peer = new RtcPeer(isCaller, {
    onMessage: (text) => {
      addMsg(text, "peer");
      // 窗口没聚焦（被遮挡/最小化/切走了）才累加工具栏未读角标；正看着就不打扰。
      if (!document.hasFocus()) notifyUnread();
    },
    onStateChange: onRtcState,
    onIceCandidate: (cand) => {
      log("本地 ICE candidate，发往", peerName);
      sendSignal(me, peerName, "ice", cand).catch((e) => log("写 ICE 失败", e));
    },
  });
}

let connected = false;
function onRtcState(state) {
  log("RTC 状态 →", state);
  if (state === "connected") {
    setChatStatus("已连接 · 在线");
    enableChat(true);
    if (!connected) {
      connected = true;
      removeCallingMsg(); // 清掉"正在呼叫/正在连接"提示
      addMsg("已接通，可以开始聊天", "sys");
    }
  } else if (state === "failed" || state === "closed") {
    setChatStatus("已断开");
    enableChat(false);
  } else {
    setChatStatus("连接中…（" + state + "）");
  }
}

// ---------- 信令轮询 ----------
async function pollSignals() {
  let sigs;
  try {
    sigs = await readMySignals(me, sessionStart);
  } catch {
    return;
  }
  const fresh = sigs
    .filter((s) => !processedSignals.has(s.key))
    .sort((a, b) => a.ts - b.ts);

  if (sigs.length && !fresh.length) {
    log(`轮询: ${sigs.length} 条信令全部已处理过(已跳过)`);
  }
  for (const s of fresh) {
    processedSignals.add(s.key);
    try {
      await handleSignal(s);
    } catch (e) {
      console.warn("处理信令失败:", s.type, e);
    }
  }
}

async function handleSignal(s) {
  log("处理信令:", s.type, "from", s.from);
  if (s.type === "call") {
    // 收到来电邀请 → 弹全局浮层让我选接听/拒绝
    showInvite(s.from);
  } else if (s.type === "accept") {
    // 对方接听了我的呼叫（或我接听后对方收到我的 accept）
    clearTimeout(callTimeout);
    removeCallingMsg();
    if (iAmCaller(s.from)) {
      log(s.from, "已接听，我是 offerer，发起握手");
      await startHandshakeAsOfferer(s.from);
    } else {
      log(s.from, "已接听，我是 answerer，等待对方 offer");
      openChat(s.from, "连接中…");
    }
  } else if (s.type === "reject") {
    clearTimeout(callTimeout);
    log(s.from, "拒绝了呼叫");
    setChatStatus("对方已拒绝");
    addMsg(`${s.from} 拒绝了你的呼叫`, "sys");
    if (peer) {
      peer.close();
      peer = null;
    }
    setTimeout(() => {
      show("listView");
      refreshList();
    }, REJECT_BACK_MS);
  } else if (s.type === "offer") {
    // 收到 offer：作为 callee 应答。
    // 即使已有 peer（可能是上一次残留），只要是同一个人发来的新 offer，
    // 就重建 peer 重新应答——这能修复「对方退出重进后连不上」。
    if (peer && peerName && peerName !== s.from) {
      log("忙于和", peerName, "对话，忽略", s.from, "的 offer");
      return;
    }
    if (!isValidSdp(s.payload)) {
      log("收到非法 offer payload，忽略 from", s.from);
      return;
    }
    if (peer) log("已有 peer，收到", s.from, "新 offer，将重建应答");
    await answerCall(s.from, s.payload);
  } else if (s.type === "answer") {
    if (!peer) {
      log("收到 answer 但本地无 peer，忽略");
      return;
    }
    if (!isValidSdp(s.payload)) {
      log("收到非法 answer payload，忽略");
      return;
    }
    await peer.acceptAnswer(s.payload);
    remoteDescSet = true;
    log("已 setRemoteDescription(answer)，flush 缓冲 ICE:", pendingIce.length);
    await flushPendingIce();
  } else if (s.type === "ice") {
    if (!peer) {
      log("收到 ICE 但无 peer，忽略");
      return;
    }
    if (!isValidIce(s.payload)) {
      log("收到非法 ICE payload，忽略");
      return;
    }
    if (remoteDescSet) {
      log("addIce");
      await peer.addIce(s.payload);
    } else {
      log("remoteDesc 未就绪，缓冲 ICE");
      pendingIce.push(s.payload);
    }
  } else if (s.type === "error") {
    // 对方握手出错时会回报 error 信令；记日志并提示，便于排查（此前被静默忽略）。
    const msg = (s.payload && s.payload.msg) || "未知错误";
    log("对方报告握手错误:", msg);
    setChatStatus("对方连接出错：" + msg);
  }
}

async function flushPendingIce() {
  while (pendingIce.length) {
    await peer.addIce(pendingIce.shift());
  }
}

// ---------- 聊天视图 ----------
function openChat(name, status) {
  peerName = name;
  connected = false; // 新会话重置连接标志
  $("peerName").textContent = name;
  $("messages").innerHTML = "";
  setChatStatus(status);
  enableChat(false);
  show("chatView");
}

// 移除"正在呼叫/正在连接"的临时系统提示。
function removeCallingMsg() {
  $("messages")
    .querySelectorAll(".msg.calling")
    .forEach((el) => el.remove());
}

function setChatStatus(text) {
  $("chatStatus").textContent = text;
}

function enableChat(on) {
  $("input").disabled = !on;
  $("sendBtn").disabled = !on;
  if (on) $("input").focus();
}

function addMsg(text, kind, extraClass = "") {
  const div = document.createElement("div");
  div.className = "msg " + kind + (extraClass ? " " + extraClass : "");
  div.textContent = text;
  $("messages").appendChild(div);
  $("messages").scrollTop = $("messages").scrollHeight;
}

$("sendBtn").addEventListener("click", sendMessage);
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendMessage();
});
function sendMessage() {
  const text = $("input").value.trim();
  if (!text || !peer) return;
  if (peer.send(text)) {
    addMsg(text, "me");
    $("input").value = "";
  } else {
    setChatStatus("未连接，无法发送");
  }
}

$("backBtn").addEventListener("click", () => {
  resetSession();
  show("listView");
  refreshList();
});

// ---------- 来电邀请浮层 ----------
function showInvite(from) {
  // 已在和别人对话/已有别的来电时，简单起见忽略新来电（MVP）
  if (pendingInviteFrom && pendingInviteFrom !== from) {
    log("已有来电浮层，忽略", from);
    return;
  }
  pendingInviteFrom = from;
  // 昵称来自表格不可信，用 textContent 拼接避免 XSS。
  const b = document.createElement("b");
  b.textContent = from;
  const t = $("inviteText");
  t.textContent = "";
  t.append(b, " 邀请你聊天");
  $("inviteOverlay").classList.add("show");
}

function hideInvite() {
  $("inviteOverlay").classList.remove("show");
  pendingInviteFrom = null;
}

$("acceptBtn").addEventListener("click", async () => {
  const from = pendingInviteFrom;
  hideInvite();
  if (!from) return;
  log("接听", from);
  openChat(from, "连接中…");
  try {
    await sendSignal(me, from, "accept", {});
  } catch (e) {
    log("发 accept 失败:", e);
  }
  // 接听后：若我是 offerer 立即发起握手，否则等对方 offer
  if (iAmCaller(from)) {
    await startHandshakeAsOfferer(from);
  }
});

$("rejectBtn").addEventListener("click", async () => {
  const from = pendingInviteFrom;
  hideInvite();
  if (!from) return;
  log("拒绝", from);
  try {
    await sendSignal(me, from, "reject", {});
  } catch (e) {
    log("发 reject 失败:", e);
  }
});

// 彻底重置一次会话的所有状态，避免残留 peer / 已处理标记 / 缓冲 ICE
// 污染下一次握手（退出到列表、或重新上线时调用）。
function resetSession() {
  if (peer) {
    try {
      peer.close();
    } catch {
      /* 忽略 */
    }
    peer = null;
  }
  peerName = "";
  remoteDescSet = false;
  connected = false;
  pendingIce.length = 0;
  processedSignals.clear();
  clearTimeout(callTimeout);
  hideInvite();
  // 清掉表里自己相关的信令行（offer/answer/ice/call/error），防止信令表无限增长。
  // fire-and-forget：不阻塞重置；失败忽略，下次上线时还会再清一次。
  // 仅在已上线（me 非空）时清，避免下线后误调用。
  if (me) clearMySignals(me).catch(() => {});
  // 推进时间基线：下一次握手只认此刻之后的信令，彻底忽略上一轮的残留行
  //（钉钉表格行号会复用，必须靠时间戳而非行号来隔离不同会话）。
  sessionStart = Date.now();
}

// ---------- 下线：停掉所有循环、忘记昵称、回到登录页 ----------
$("logoutBtn").addEventListener("click", () => {
  log("主动下线");
  clearInterval(heartbeatTimer);
  clearInterval(listTimer);
  clearInterval(signalTimer);
  heartbeatTimer = listTimer = signalTimer = null;
  // 清空自己的 presence 行，让对方立即看到离线（先于把 me 清空）。
  clearPresence(me).catch(() => {});
  resetSession();
  me = "";
  chrome.storage.local.remove(NICK_KEY); // 忘记昵称：下次打开不再自动上线
  $("nick").value = "";
  $("loginBtn").disabled = false;
  show("loginView");
});

// ---------- 启动：若已存过昵称，自动上线，免去每次重新登录 ----------
(async function autoLogin() {
  try {
    const saved = await chrome.storage.local.get(NICK_KEY);
    const nick = (saved[NICK_KEY] || "").trim();
    if (nick) {
      $("nick").value = nick;
      await doLogin(nick, true);
    }
  } catch (e) {
    log("autoLogin 读取昵称失败:", e);
  }
})();

// ---------- 工具栏未读角标 ----------
// 角标只能由 background 设置，页面通过 runtime 消息通知它累加 / 清零。
function notifyUnread() {
  try {
    chrome.runtime.sendMessage({ type: "incoming" });
  } catch (e) {
    log("通知未读失败:", e);
  }
}
function clearUnread() {
  try {
    chrome.runtime.sendMessage({ type: "seen" });
  } catch {
    /* 忽略 */
  }
}

// 窗口获得焦点即视为已读，清零角标。
window.addEventListener("focus", clearUnread);
// 打开时若当前就有焦点，先清一次旧角标。
if (document.hasFocus()) clearUnread();

// ---------- 轮询调速：失焦时拉长信令轮询，省请求；聚焦时恢复灵敏 ----------
// 信令表是共享公共白板，频繁轮询既费网关又放大表增长；窗口没在看时不必那么勤。
const POLL_BLUR_MS = 8000;
function setPollInterval(ms) {
  if (!signalTimer) return; // 未上线时无定时器，跳过
  clearInterval(signalTimer);
  signalTimer = setInterval(pollSignals, ms);
}
window.addEventListener("focus", () => setPollInterval(POLL_INTERVAL_MS));
window.addEventListener("blur", () => setPollInterval(POLL_BLUR_MS));
