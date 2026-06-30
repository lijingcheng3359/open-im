# AGENTS.md

This file provides guidance to the AI agent when working with code in this repository.

## Project shape

- `open-im` is a serverless P2P Chrome extension (Manifest V3). No build, no bundler, no tests, no package.json. Plain ES modules loaded by `popup.html`.
- The extension opens an independent popup window (not the default action popup) via `chrome.windows.create` in `src/background.js`, because the default popup closes on blur.
- Runtime: load the project root as an unpacked extension in `chrome://extensions` (Developer mode → Load unpacked). Debug by right-clicking the popup → Inspect.

## Required local setup

- Copy `src/config.example.js` to `src/config.js` and fill in the DingTalk gateway URL, `NODE_ID`, and `SHEET_ID`. `src/config.js` is gitignored and must not be committed.
- After editing `src/background.js`, reload the extension on `chrome://extensions`; service worker changes do not auto-apply.

## Hard constraints (easy to regress)

- **Serial gateway calls only.** `signaling.js` queues every DingTalk sheet gateway call through a single promise chain. Concurrent `append_rows` calls drop rows (observed: 5 concurrent appends → 1 row survives). Do not parallelize gateway operations.
- **Dedup signals by content fingerprint, never by row number.** `readMySignals` uses `key = from:to:ts:dataColumn`. Row numbers are reused after rows are cleared, so row-number-based deduplication would wrongly skip new signals.
- **Session isolation is by timestamp, not row.** `resetSession()` advances `sessionStart = Date.now()`; only signals with `ts >= sessionStart` are processed, for the same reason.
- **WebRTC descriptions must be returned as plain objects.** `createOffer` and `acceptOfferCreateAnswer` in `src/rtc.js` return `{type, sdp}` explicitly. `RTCSessionDescription` has getters; `JSON.stringify` on the object drops fields.
- **Reentrancy guards (`offering`, `answering`, `connected`) are load-bearing.** A single poll can deliver duplicate offers; removing these guards lets concurrent handlers close each other's `RTCPeerConnection` mid-handshake.

## Accepted scope (do not "fix" casually)

- No offline messages, no group chat, no TURN relay, no signaling encryption, no message persistence. These are intentional MVP limitations.

## Style / etiquette

- Keep the codebase dependency-free and build-free.
- Commit messages are typically in Chinese with a short descriptive prefix (e.g., `feat: ...`, `fix: ...`).
