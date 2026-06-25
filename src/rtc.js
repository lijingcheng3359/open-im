// WebRTC 封装。聊天消息走 DataChannel 直连，不经任何服务器。
// 角色由「谁发起」决定：isCaller=true 主动建 DataChannel 并写 offer；否则被动接收。
import { ICE_SERVERS } from "./config.js";

export class RtcPeer {
  constructor(isCaller, { onMessage, onStateChange, onIceCandidate }) {
    this.isCaller = isCaller;
    this.onMessage = onMessage || (() => {});
    this.onStateChange = onStateChange || (() => {});
    this.onIceCandidate = onIceCandidate || (() => {});

    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.channel = null;

    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.onIceCandidate(e.candidate);
    };
    this.pc.onconnectionstatechange = () => {
      console.log("[rtc] connectionState →", this.pc.connectionState);
      this.onStateChange(this.pc.connectionState);
    };
    this.pc.oniceconnectionstatechange = () => {
      console.log("[rtc] iceConnectionState →", this.pc.iceConnectionState);
    };
    this.pc.onicegatheringstatechange = () => {
      console.log("[rtc] iceGatheringState →", this.pc.iceGatheringState);
    };
    this.pc.onsignalingstatechange = () => {
      console.log("[rtc] signalingState →", this.pc.signalingState);
    };

    if (isCaller) {
      this._setupChannel(this.pc.createDataChannel("chat"));
    } else {
      this.pc.ondatachannel = (e) => this._setupChannel(e.channel);
    }
  }

  _setupChannel(ch) {
    this.channel = ch;
    ch.onopen = () => this.onStateChange("connected");
    ch.onclose = () => this.onStateChange("disconnected");
    ch.onmessage = (e) => this.onMessage(e.data);
    // DataChannel 出错时此前静默无感知；上报为 failed 让上层提示。
    ch.onerror = (e) => {
      console.warn("[rtc] DataChannel error:", e && e.error);
      this.onStateChange("failed");
    };
  }

  async createOffer() {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    // 返回纯对象：localDescription 可能是带 getter 的 RTCSessionDescription，
    // 直接 JSON.stringify 会丢字段，必须显式取 type/sdp。
    const d = this.pc.localDescription;
    return { type: d.type, sdp: d.sdp };
  }

  async acceptOfferCreateAnswer(offer) {
    await this.pc.setRemoteDescription(offer);
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    const d = this.pc.localDescription;
    return { type: d.type, sdp: d.sdp };
  }

  async acceptAnswer(answer) {
    await this.pc.setRemoteDescription(answer);
  }

  async addIce(candidate) {
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (e) {
      console.warn("addIceCandidate 失败:", e);
    }
  }

  send(text) {
    if (this.channel && this.channel.readyState === "open") {
      this.channel.send(text);
      return true;
    }
    return false;
  }

  close() {
    if (this.channel) this.channel.close();
    this.pc.close();
  }
}
