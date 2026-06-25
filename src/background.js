// 后台 service worker：点扩展图标时打开一个独立窗口（而非吊在图标下的 popup）。
// 独立窗口点别处不会自动关、可拖动、可调大小、能一直开着——关掉窗口即下线。
//
// 之所以不用 manifest 的 default_popup：popup 失焦即销毁，无法满足「不自动关 + 可拖动」。
// 改为监听 action 点击，自己 chrome.windows.create 一个 popup 型窗口。

let winId = null; // 记住已打开的窗口，避免重复开

chrome.action.onClicked.addListener(async () => {
  // 已有窗口则聚焦，不再新开
  if (winId !== null) {
    try {
      const win = await chrome.windows.get(winId);
      if (win) {
        await chrome.windows.update(winId, { focused: true });
        return;
      }
    } catch {
      // 窗口已被关掉，winId 失效，往下走新建
      winId = null;
    }
  }

  const win = await chrome.windows.create({
    url: chrome.runtime.getURL("popup.html"),
    type: "popup", // 无地址栏/标签栏的精简窗口，但可拖动、可缩放
    width: 380,
    height: 560,
  });
  winId = win.id;
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
