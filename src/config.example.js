// 配置模板。复制本文件为同目录下的 config.js，填入你自己的值后即可运行：
//   cp src/config.example.js src/config.js
//
// config.js 已被 .gitignore 忽略，不会被提交——请勿把含真实 key 的 config.js 推上仓库。

// 钉钉表格网关。当作信令白板用。
// 注意：此 URL 含 key，会随插件分发给所有使用者。聊天内容走 WebRTC 直连
// 不经此处，仅「信令行」（SDP/ICE 握手数据）会写到这张共享表里。
// 拿到本网关地址的人都能读写这张表，请用一张专门的、不放任何敏感数据的表。
export const GATEWAY_URL =
  "在此填入你的钉钉表格网关 URL（形如 https://mcp-gw.dingtalk.com/server/<id>?key=<key>）";

// 当作信令白板的钉钉表格标识。
export const NODE_ID = "在此填入表格 nodeId";
export const SHEET_ID = "在此填入 sheetId";

// 公共 STUN，无 TURN —— 部分严格 NAT 下可能连不上（MVP 已接受）。
// 需要更高连通率可自行补 TURN 服务器。
export const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

// 信令轮询周期（毫秒）。
export const POLL_INTERVAL_MS = 2000;

// 单次网关请求超时（毫秒）。所有网关调用走同一条串行队列，
// 一个卡住的 fetch 会冻结全部信令，必须有超时让它快速失败、队列继续。
export const GATEWAY_TIMEOUT_MS = 10000;
