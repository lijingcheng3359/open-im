// 后台 service worker：点扩展图标时打开一个独立窗口（而非吊在图标下的 popup）。
// 独立窗口点别处不会自动关、可拖动、可调大小、能一直开着——关掉窗口即下线。
//
// 之所以不用 manifest 的 default_popup：popup 失焦即销毁，无法满足「不自动关 + 可拖动」。
// 改为监听 action 点击，自己 chrome.windows.create 一个 popup 型窗口。

const WIN_W = 380;
const WIN_H = 560;
const POPUP_URL = chrome.runtime.getURL("popup.html");

let winId = null; // 记住已打开的窗口，避免重复开
// 同步守卫：onClicked 是 async，winId 要等 create 完成才赋值，中间隔着 await。
// 双击/连点会让两次回调都在 winId 还是 null 时通过判断，各开一个窗口（第二个还会
// 覆盖 winId 让第一个变孤儿）。creating 在第一个 await 之前同步置位，挡住并发点击。
let creating = false;

// 找回已存在的本扩展窗口。winId 是 service worker 的内存变量，MV3 下 SW 空闲会被
// 回收 → winId 丢失重置为 null，此时若窗口其实还开着，仅靠 winId 会误判为「没有窗口」
// 而再开一个。所以新建前用 getAll 以实际窗口为准兜底。
// 用 tabs 权限读 tab.url 精确匹配 popup.html，不受窗口缩放/平台尺寸微调影响。
async function findExistingWindow() {
  try {
    const wins = await chrome.windows.getAll({
      windowTypes: ["popup"],
      populate: true,
    });
    const hit = wins.find((w) =>
      (w.tabs || []).some((t) => t.url === POPUP_URL)
    );
    return hit ? hit.id : null;
  } catch {
    return null;
  }
}

chrome.action.onClicked.addListener(async () => {
  if (creating) return; // 正在创建中，忽略并发点击

  // 已有窗口则聚焦，不再新开。winId 失效（被关/SW 回收）时回退到 getAll 兜底。
  let targetId = winId;
  if (targetId === null) targetId = await findExistingWindow();
  if (targetId !== null) {
    try {
      await chrome.windows.update(targetId, { focused: true });
      winId = targetId; // 兜底找回后回填，后续直接命中
      return;
    } catch {
      // 窗口已被关掉，失效，往下走新建
      winId = null;
    }
  }

  creating = true;
  try {
    // 进入创建临界区后再查一次：拦住「并发点击中前一个已建好窗口」的竞态，
    // 避免守卫之外的极端时序重复开窗。
    const existing = await findExistingWindow();
    if (existing !== null) {
      winId = existing;
      await chrome.windows.update(existing, { focused: true });
      return;
    }
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL("popup.html"),
      type: "popup", // 无地址栏/标签栏的精简窗口，但可拖动、可缩放
      width: WIN_W,
      height: WIN_H,
    });
    winId = win.id;
  } catch (e) {
    // 创建失败（如瞬时 API 错误）：保持 winId=null，下次点击可重试。
    console.warn("[bg] 打开窗口失败:", e);
  } finally {
    creating = false;
  }
});

// 窗口关闭时清掉记录，下次点击重新开。
chrome.windows.onRemoved.addListener((closedId) => {
  if (closedId === winId) {
    winId = null;
    setBadge(0); // 窗口关了，未读角标也清掉
  }
});

// ---------- 未读角标 ----------
// 页面（popup.js）无法直接设角标，必须经 background。约定两种消息：
//   {type:"incoming"} 未读 +1    {type:"seen"} 清零
//
// 注意：MV3 service worker 空闲会被回收，内存里的计数会丢。所以不缓存计数，
// 每次从徽章文本本身读当前值再 +1——徽章文本由 Chrome 持久保存，不受 SW 回收影响。
function setBadge(n) {
  chrome.action.setBadgeText({ text: n > 0 ? String(n) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#7c3aed" }); // 与主题紫一致
}

async function bumpBadge() {
  const text = await chrome.action.getBadgeText({});
  const cur = parseInt(text, 10) || 0;
  setBadge(cur + 1);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg.type !== "string") return;
  if (msg.type === "incoming") bumpBadge();
  else if (msg.type === "seen") setBadge(0);
});
