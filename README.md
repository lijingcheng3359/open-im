# open-im

[![License: MIT](https://img.shields.io/badge/License-MIT-7c3aed.svg)](LICENSE)
![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-a78bfa.svg)
![No backend](https://img.shields.io/badge/server-none-34d399.svg)

无服务端 P2P 即时通讯 Chrome 扩展。聊天内容走 **WebRTC DataChannel** 浏览器间直连，**不经任何自建服务器**；WebRTC 建连必需的信令交换借一张**钉钉表格当公共白板**完成。

## 功能特性

- 🔗 **P2P 直连** —— 聊天消息走 WebRTC DataChannel，握手完成后不经任何服务器。
- 🪟 **独立可拖动窗口** —— 点图标弹出独立窗口，可拖动、可缩放、点别处不自动关（关窗即下线）。
- 👤 **记住昵称自动上线** —— 重开窗口自动用上次昵称上线，免重复登录；可主动「下线」并忘记昵称。
- 🔔 **未读角标提醒** —— 窗口未聚焦时收到消息，工具栏图标显示未读数；聚焦即清零。
- 📞 **来电接听 / 拒绝** —— 点在线用户发起呼叫，对方弹浮层选择接听或拒绝。

## 工作原理

```
浏览器A ──写 offer/ice──▶  钉钉表格（信令白板）  ◀──写 answer/ice── 浏览器B
   │                       （轮询读对方的行）                        │
   └──────────── 握手完成后 WebRTC 直连，消息不再经表 ──────────────┘
```

- 双方约定同一张信令表碰头，靠昵称字典序自动分配发起/应答角色（解决双方同时点击的 glare）。
- 表结构每行 5 列：`[kind, a, b, c, ts]`，其中 `presence` 行记录在线心跳、`signal` 行携带 base64 编码的 SDP/ICE。
- 建连后聊天走 DataChannel 直连，**钉钉表里不再出现新行**。

## 快速开始

> ⚠️ **必须先创建本地配置**，否则扩展无法工作。

```bash
git clone git@github.com:lijingcheng3359/open-im.git
cd open-im
cp src/config.example.js src/config.js   # 复制配置模板
# 然后编辑 src/config.js，填入你自己的钉钉表格网关信息（见下方「配置说明」）
```

加载扩展：

1. 打开 `chrome://extensions`
2. 右上角开启「开发者模式」
3. 点「加载已解压的扩展程序」，选择本项目根目录
4. 工具栏出现 open-im 图标，点击弹出窗口

> `src/config.js` 已被 `.gitignore` 忽略，不会被提交——请勿把含真实 key 的配置推上仓库。

## 配置说明

`src/config.js` 各字段：

| 字段 | 含义 | 怎么拿 |
|---|---|---|
| `GATEWAY_URL` | 钉钉表格 MCP 网关地址（含 key） | 在钉钉侧为目标表格生成 MCP 网关，复制其带 key 的 URL |
| `NODE_ID` | 信令表的 nodeId | 从钉钉表格标识中获取 |
| `SHEET_ID` | 信令表的 sheetId | 同上 |
| `ICE_SERVERS` | STUN/TURN 服务器 | 默认用公共 STUN；严格 NAT 下可自行补 TURN |
| `POLL_INTERVAL_MS` | 信令轮询周期（毫秒） | 默认 2000，可按需调整 |

建议用**一张专门的、不放任何敏感数据的表**当信令白板——拿到网关地址的人都能读写它。

## 使用

1. 两个浏览器实例（不同浏览器画像 / 两台机）各打开 open-im 窗口
2. 各自**输入昵称**点「上线」（之后重开会自动上线）
3. 进入**在线用户列表**，能看到对方（5s 心跳，15s 内有心跳算在线）
4. **点击列表里的某个人** → 向 ta 发起呼叫
5. 对方接听后几秒内显示「已连接 · 在线」，即可互发消息；点「‹ 返回」回到列表

> 同一台机用两个浏览器画像测试即可（本机互连不需要 NAT 穿透）。

## 已知限制（MVP）

- **双方必须同时在线**——无离线消息。
- **仅单聊**——不支持群聊。
- **无 TURN 中继**——严格 NAT / 部分企业网络下约 10–20% 连接可能失败。
- **网关 key 公开**——拿到插件的人都能读写信令表；聊天内容直连不泄露，但信令行共享。建议用一张专门的、不放任何敏感数据的表当信令白板。
- 信令未加密；无消息持久化、已读回执、输入中提示。

## 文件结构

| 文件 | 作用 |
|---|---|
| `manifest.json` | MV3 配置，`host_permissions` 放行钉钉网关（绕过 CORS） |
| `popup.html` / `popup.js` | 聊天 UI + 握手状态机 |
| `src/background.js` | service worker：点图标开独立窗口、维护未读角标 |
| `src/config.example.js` | 配置模板（复制为 `config.js` 使用） |
| `src/signaling.js` | 钉钉表格信令客户端（presence + 定向 signal） |
| `src/rtc.js` | WebRTC 封装（PeerConnection / DataChannel / ICE） |

## 调试

建连失败时打开窗口的 console（右键 →「检查」）：
- 报「信令写入/读取失败」→ 网关或网络问题
- 卡在「连接中」迟迟不 connected → 多半是 ICE 失败（无 TURN，换网络环境试）

改了 `src/background.js` 后，需在 `chrome://extensions` 点扩展的 **reload** 才生效。

## 参与贡献

欢迎提 issue 和 PR。

## 许可证

[MIT](LICENSE) © lijingcheng3359
