const byId = (id) => document.getElementById(id);

const cwConfig = window.CWCOMM_CONFIG || {};
const API_BASE_URL = String(cwConfig.apiBaseUrl || "http://127.0.0.1:8080").replace(/\/+$/, "");
const WS_BASE_URL = String(cwConfig.wsBaseUrl || "ws://127.0.0.1:8080").replace(/\/+$/, "");

const refreshEventsBtn = byId("refresh-events");
const eventSelect = byId("event-select");
const listenLanguage = byId("listen-language");
const connectBtn = byId("connect-btn");
const disconnectBtn = byId("disconnect-btn");
const connStatus = byId("conn-status");
const ttsEnabled = byId("tts-enabled");
const floorAudioEnabled = byId("floor-audio-enabled");
const floorAudio = byId("floor-audio");
const subtitleOutput = byId("subtitle-output");

let listenerSocket = null;
let listenerPeer = null;
let producerId = null;
let ttsAudio = null;
const ttsQueue = [];

function wsUrl(path) {
  return `${WS_BASE_URL}${path}`;
}

async function api(path, options = {}) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return body;
}

function showError(error) {
  alert(error.message || String(error));
}

function selectedEventId() {
  return String(eventSelect.value || "").trim();
}

function renderSegment(seg, lang) {
  const div = document.createElement("div");
  div.className = "segment";
  const src = document.createElement("div");
  src.className = "src";
  src.textContent = `#${seg.seq} 原文: ${seg.source_text}`;
  const dst = document.createElement("div");
  dst.className = "dst";
  dst.textContent = `${lang}: ${seg.translated_text || "(无译文)"}`;
  div.appendChild(src);
  div.appendChild(dst);
  subtitleOutput.prepend(div);
}

function stopTtsPlayback() {
  ttsQueue.length = 0;
  if (!ttsAudio) {
    return;
  }
  ttsAudio.pause();
  ttsAudio.src = "";
  ttsAudio = null;
}

function playNextTtsFromQueue() {
  if (ttsAudio || !ttsEnabled.checked) {
    return;
  }
  const next = ttsQueue.shift();
  if (!next) {
    return;
  }
  const { audioBase64, mimeType } = next;
  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mimeType || "audio/mpeg" });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  ttsAudio = audio;
  const finalize = () => {
    URL.revokeObjectURL(url);
    ttsAudio = null;
    playNextTtsFromQueue();
  };
  audio.onended = finalize;
  audio.onerror = finalize;
  void audio.play();
}

function enqueueServerAudio(audioBase64, mimeType) {
  if (!ttsEnabled.checked) {
    return;
  }
  ttsQueue.push({ audioBase64, mimeType });
  playNextTtsFromQueue();
}

async function refreshEvents() {
  try {
    const { items } = await api("/api/events?status=LIVE");
    const current = selectedEventId();
    eventSelect.innerHTML = "";
    for (const item of items) {
      const opt = document.createElement("option");
      opt.value = item.id;
      opt.textContent = `${item.name} (${item.status})`;
      eventSelect.appendChild(opt);
    }
    const urlEventId = new URLSearchParams(window.location.search).get("eventId");
    if (urlEventId && items.some((it) => it.id === urlEventId)) {
      eventSelect.value = urlEventId;
    } else if (current) {
      eventSelect.value = current;
    }
  } catch (err) {
    showError(err);
  }
}

refreshEventsBtn.addEventListener("click", refreshEvents);

function closePeer() {
  if (listenerPeer) {
    listenerPeer.close();
    listenerPeer = null;
  }
  producerId = null;
  floorAudio.srcObject = null;
}

async function handleOffer(from, sdp) {
  if (!listenerPeer || producerId !== from) {
    closePeer();
    producerId = from;
    listenerPeer = new RTCPeerConnection({
      iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
    });

    listenerPeer.ontrack = (event) => {
      const [stream] = event.streams;
      if (stream) {
        floorAudio.srcObject = stream;
        if (floorAudioEnabled.checked) {
          void floorAudio.play();
        }
      }
    };

    listenerPeer.onicecandidate = (event) => {
      if (event.candidate && listenerSocket?.readyState === WebSocket.OPEN) {
        listenerSocket.send(JSON.stringify({ type: "webrtc.ice", to: producerId, candidate: event.candidate }));
      }
    };
  }

  await listenerPeer.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await listenerPeer.createAnswer();
  await listenerPeer.setLocalDescription(answer);
  listenerSocket.send(JSON.stringify({ type: "webrtc.answer", to: from, sdp: answer }));
}

connectBtn.addEventListener("click", async () => {
  const eventId = selectedEventId();
  const lang = String(listenLanguage.value || "en-US");
  if (!eventId) {
    showError(new Error("请先选择活动"));
    return;
  }

  if (listenerSocket) {
    listenerSocket.close();
  }
  stopTtsPlayback();
  closePeer();
  subtitleOutput.innerHTML = "";

  listenerSocket = new WebSocket(wsUrl("/ws/live"));

  listenerSocket.onopen = () => {
    listenerSocket.send(JSON.stringify({ type: "listen", eventId, language: lang }));
  };

  listenerSocket.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === "listen.ack") {
        connStatus.textContent = "连接状态：连接成功";
      }

      if (msg.type === "subtitle.delta") {
        renderSegment(
          {
            seq: msg.segment.seq,
            source_text: msg.segment.source_text,
            translated_text: msg.segment.translated_text,
          },
          lang,
        );
      }

      if (msg.type === "tts.audio") {
        enqueueServerAudio(msg.audio_base64, msg.mime_type);
      }

      if (msg.type === "webrtc.offer" && msg.from && msg.sdp) {
        await handleOffer(String(msg.from), msg.sdp);
      }

      if (msg.type === "webrtc.ice" && listenerPeer && msg.from === producerId && msg.candidate) {
        await listenerPeer.addIceCandidate(msg.candidate);
      }

      if (msg.type === "webrtc.producer_offline") {
        closePeer();
      }

      if (msg.type === "error") {
        connStatus.textContent = `连接状态：错误 (${msg.error})`;
      }
    } catch {
      // ignore malformed messages
    }
  };

  listenerSocket.onerror = () => {
    connStatus.textContent = "连接状态：连接异常";
  };

  listenerSocket.onclose = () => {
    connStatus.textContent = "连接状态：已断开";
    subtitleOutput.innerHTML = "";
    stopTtsPlayback();
    closePeer();
  };
});

disconnectBtn.addEventListener("click", () => {
  if (listenerSocket) {
    listenerSocket.close();
    listenerSocket = null;
  }
  subtitleOutput.innerHTML = "";
  stopTtsPlayback();
  closePeer();
  connStatus.textContent = "连接状态：已断开";
});

ttsEnabled.addEventListener("change", () => {
  if (!ttsEnabled.checked) {
    stopTtsPlayback();
    return;
  }
  playNextTtsFromQueue();
});

floorAudioEnabled.addEventListener("change", () => {
  if (!floorAudioEnabled.checked) {
    floorAudio.muted = true;
    floorAudio.pause();
    return;
  }
  floorAudio.muted = false;
  if (floorAudio.srcObject) {
    void floorAudio.play();
  }
});

floorAudio.muted = true;
if (!floorAudioEnabled.checked) {
  floorAudio.pause();
}

refreshEvents();
