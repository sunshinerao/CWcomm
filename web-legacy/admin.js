const byId = (id) => document.getElementById(id);

const cwConfig = window.CWCOMM_CONFIG || {};
const API_BASE_URL = String(cwConfig.apiBaseUrl || "http://127.0.0.1:8080").replace(/\/+$/, "");
const WS_BASE_URL = String(cwConfig.wsBaseUrl || "ws://127.0.0.1:8080").replace(/\/+$/, "");

const eventSelect = byId("event-select");
const refreshEventsBtn = byId("refresh-events");
const createEventForm = byId("create-event-form");
const eventNameInput = byId("event-name");
const clientEntryUrlInput = byId("client-entry-url");
const joinLinkText = byId("join-link-text");
const joinQr = byId("join-qr");
const chZhEn = byId("ch-zh-en");
const chEnZh = byId("ch-en-zh");
const pushHelloBtn = byId("push-hello");
const refreshMicsBtn = byId("refresh-mics");
const micSelect = byId("mic-select");
const micStatus = byId("mic-status");
const startSessionBtn = byId("start-session");
const stopSessionBtn = byId("stop-session");
const runStatus = byId("run-status");
const monitorLanguage = byId("monitor-language");
const monitorConnectBtn = byId("monitor-connect");
const monitorDisconnectBtn = byId("monitor-disconnect");
const monitorStatus = byId("monitor-status");
const monitorOutput = byId("monitor-output");
const metricAsr = byId("metric-asr");
const metricTranslation = byId("metric-translation");
const metricTts = byId("metric-tts");
const metricE2e = byId("metric-e2e");
const metricClients = byId("metric-clients");
const trendAsr = byId("trend-asr");
const trendTranslation = byId("trend-translation");
const trendTts = byId("trend-tts");
const trendE2e = byId("trend-e2e");
const trendClients = byId("trend-clients");

let producerSocket = null;
let mediaRecorder = null;
let micStream = null;
let pendingStream = null;
const producerPeers = new Map();
const ASR_TARGET_SAMPLE_RATE = 16000;
const ASR_FLUSH_MS = 1400;
const ASR_MIN_SAMPLES = 3200;
const VAD_RMS_THRESHOLD = 0.015;
const VAD_HANGOVER_MS = 1200;
const VAD_POLL_MS = 120;
let micAudioContext = null;
let micAnalyser = null;
let micVadTimer = null;
let micVadBuffer = null;
let speechLikely = false;
let lastVoiceAtMs = 0;
let asrAudioContext = null;
let asrSourceNode = null;
let asrProcessorNode = null;
let asrFlushTimer = null;
const asrPcmChunks = [];
let asrInputSampleRate = 48000;

let monitorSocket = null;

const TREND_WINDOW_MS = 60_000;
const trends = {
  asr: [],
  translation: [],
  tts: [],
  e2e: [],
  clients: [],
};

function pushTrend(key, value) {
  const now = Date.now();
  const arr = trends[key];
  arr.push({ t: now, v: Number(value) });
  const cutoff = now - TREND_WINDOW_MS;
  while (arr.length && arr[0].t < cutoff) {
    arr.shift();
  }
}

function drawTrend(canvas, key, color) {
  if (!canvas) {
    return;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);

  const arr = trends[key];
  if (!arr.length) {
    ctx.strokeStyle = "#d9e1ed";
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    return;
  }

  const minT = arr[0].t;
  const maxT = Math.max(arr[arr.length - 1].t, minT + 1);
  const maxV = Math.max(...arr.map((p) => p.v), 1);

  ctx.beginPath();
  arr.forEach((p, idx) => {
    const x = ((p.t - minT) / (maxT - minT)) * (w - 8) + 4;
    const y = h - 4 - (p.v / maxV) * (h - 8);
    if (idx === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.strokeStyle = "#e6edf5";
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
}

function paintAllTrends() {
  drawTrend(trendAsr, "asr", "#147d37");
  drawTrend(trendTranslation, "translation", "#1e6db7");
  drawTrend(trendTts, "tts", "#9a6d00");
  drawTrend(trendE2e, "e2e", "#bb2525");
  drawTrend(trendClients, "clients", "#4d5d79");
}

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

function selectedChannels() {
  const channels = [];
  if (chZhEn.checked) {
    channels.push({ source: "zh-CN", target: "en-US" });
  }
  if (chEnZh.checked) {
    channels.push({ source: "en-US", target: "zh-CN" });
  }
  return channels;
}

function produceProfileFromChannels() {
  const channels = selectedChannels();
  if (channels.length === 0) {
    throw new Error("请至少勾选一个频道");
  }
  if (channels.length === 2) {
    return {
      sourceLanguage: "auto",
      targetLanguages: ["zh-CN", "en-US"],
    };
  }
  return {
    sourceLanguage: channels[0].source,
    targetLanguages: [channels[0].target],
  };
}

function resolveClientEntryBaseUrl() {
  return String(cwConfig.clientBaseUrl || `${window.location.origin}/client.html`);
}

function updateJoinLinkAndQr() {
  const eventId = selectedEventId();
  const base = String(clientEntryUrlInput.value || "").trim() || resolveClientEntryBaseUrl();

  if (!eventId || !base) {
    joinLinkText.textContent = "请选择活动后生成入会链接";
    joinQr.removeAttribute("src");
    return;
  }

  let joinUrl = "";
  try {
    const u = new URL(base);
    u.searchParams.set("eventId", eventId);
    joinUrl = u.toString();
  } catch {
    joinUrl = `${base}${base.includes("?") ? "&" : "?"}eventId=${encodeURIComponent(eventId)}`;
  }

  joinLinkText.textContent = joinUrl;
  const qrApi = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(joinUrl)}`;
  joinQr.src = qrApi;
}

function appendMonitorLine(text) {
  const div = document.createElement("div");
  div.className = "segment";
  const t = new Date();
  div.textContent = `[${t.toLocaleTimeString()}] ${text}`;
  monitorOutput.prepend(div);
}

function metricLevel(metric, value) {
  const v = Number(value);
  if (Number.isNaN(v)) {
    return "metric-warn";
  }
  if (metric === "asr") {
    if (v <= 1200) return "metric-good";
    if (v <= 2500) return "metric-warn";
    return "metric-bad";
  }
  if (metric === "translation") {
    if (v <= 900) return "metric-good";
    if (v <= 1800) return "metric-warn";
    return "metric-bad";
  }
  if (metric === "tts") {
    if (v <= 1000) return "metric-good";
    if (v <= 2200) return "metric-warn";
    return "metric-bad";
  }
  if (metric === "e2e") {
    if (v <= 3000) return "metric-good";
    if (v <= 6000) return "metric-warn";
    return "metric-bad";
  }
  return "metric-good";
}

function setMetric(el, metric, value, unit = "ms") {
  if (!el) {
    return;
  }
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    el.textContent = "-";
    el.classList.remove("metric-good", "metric-warn", "metric-bad");
    return;
  }
  el.classList.remove("metric-good", "metric-warn", "metric-bad");
  el.classList.add(metricLevel(metric, value));
  if (unit) {
    el.textContent = `${Number(value).toFixed(0)} ${unit}`;
  } else {
    el.textContent = String(Number(value).toFixed(0));
  }
}

async function refreshEvents() {
  try {
    const { items } = await api("/api/events");
    const current = selectedEventId();
    eventSelect.innerHTML = "";
    for (const item of items) {
      const opt = document.createElement("option");
      opt.value = item.id;
      opt.textContent = `${item.name} (${item.status})`;
      eventSelect.appendChild(opt);
    }
    if (current) {
      eventSelect.value = current;
    }
    updateJoinLinkAndQr();
  } catch (err) {
    showError(err);
  }
}

createEventForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = eventNameInput.value.trim();
  try {
    const { item } = await api("/api/events", {
      method: "POST",
      body: JSON.stringify({
        name,
        source_language: "zh-CN",
        target_languages: ["en-US"],
      }),
    });
    await refreshEvents();
    eventSelect.value = item.id;
    updateJoinLinkAndQr();
  } catch (err) {
    showError(err);
  }
});

refreshEventsBtn.addEventListener("click", refreshEvents);
eventSelect.addEventListener("change", updateJoinLinkAndQr);
clientEntryUrlInput.addEventListener("input", updateJoinLinkAndQr);

async function openMicWithSelectedDevice() {
  ensureMicCaptureSupported();

  if (pendingStream) {
    pendingStream.getTracks().forEach((t) => t.stop());
    pendingStream = null;
  }

  const selectedDeviceId = String(micSelect.value || "").trim();
  const constraints = selectedDeviceId
    ? { audio: { deviceId: { exact: selectedDeviceId } } }
    : { audio: true };

  pendingStream = await navigator.mediaDevices.getUserMedia(constraints);
  micStatus.textContent = "MIC 状态：设备已打开";
}

function ensureMicCaptureSupported() {
  if (navigator.mediaDevices?.getUserMedia) {
    return;
  }
  const host = String(window.location.hostname || "");
  const localHost = host === "localhost" || host === "127.0.0.1";
  if (!window.isSecureContext && !localHost) {
    throw new Error(
      "当前页面不是安全上下文，浏览器已禁用麦克风。请使用 HTTPS 打开管理端，或在采集机本地使用 http://localhost 访问。"
    );
  }
  throw new Error("当前浏览器不支持麦克风采集");
}

async function refreshMics() {
  try {
    ensureMicCaptureSupported();
    await openMicWithSelectedDevice().catch(() => navigator.mediaDevices.getUserMedia({ audio: true }));
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === "audioinput");

    micSelect.innerHTML = "";
    for (const mic of mics) {
      const opt = document.createElement("option");
      opt.value = mic.deviceId;
      opt.textContent = mic.label || `麦克风 ${mic.deviceId.slice(0, 6)}`;
      micSelect.appendChild(opt);
    }

    if (pendingStream) {
      pendingStream.getTracks().forEach((t) => t.stop());
      pendingStream = null;
    }

    micStatus.textContent = mics.length ? "MIC 状态：设备列表已刷新" : "MIC 状态：未发现设备";
  } catch (err) {
    micStatus.textContent = "MIC 状态：设备访问失败";
    showError(err);
  }
}

refreshMicsBtn.addEventListener("click", refreshMics);

pushHelloBtn.addEventListener("click", async () => {
  const eventId = selectedEventId();
  if (!eventId) {
    showError(new Error("请先选择活动"));
    return;
  }

  try {
    await api(`/api/events/${eventId}/subtitles`, {
      method: "POST",
      body: JSON.stringify({
        source_text: "Hello",
        translations: {
          "en-US": "Hello",
          "zh-CN": "你好",
        },
        is_final: true,
      }),
    });
    runStatus.textContent = "运行状态：已推送 Hello";
  } catch (err) {
    showError(err);
  }
});

function closeProducerRuntime() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  mediaRecorder = null;

  if (producerSocket) {
    producerSocket.close();
    producerSocket = null;
  }

  for (const pc of producerPeers.values()) {
    pc.close();
  }
  producerPeers.clear();
  asrPcmChunks.length = 0;
  speechLikely = false;
  lastVoiceAtMs = 0;
  if (micVadTimer) {
    clearInterval(micVadTimer);
    micVadTimer = null;
  }
  if (micAudioContext) {
    micAudioContext.close().catch(() => {});
    micAudioContext = null;
  }
  micAnalyser = null;
  micVadBuffer = null;
  if (asrFlushTimer) {
    clearInterval(asrFlushTimer);
    asrFlushTimer = null;
  }
  if (asrProcessorNode) {
    asrProcessorNode.disconnect();
    asrProcessorNode.onaudioprocess = null;
    asrProcessorNode = null;
  }
  if (asrSourceNode) {
    asrSourceNode.disconnect();
    asrSourceNode = null;
  }
  if (asrAudioContext) {
    asrAudioContext.close().catch(() => {});
    asrAudioContext = null;
  }

  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
}

function closeMonitor() {
  if (monitorSocket) {
    monitorSocket.close();
    monitorSocket = null;
  }
  monitorStatus.textContent = "监视状态：未连接";
}

monitorConnectBtn.addEventListener("click", async () => {
  const eventId = selectedEventId();
  if (!eventId) {
    showError(new Error("请先选择活动"));
    return;
  }

  closeMonitor();
  const lang = String(monitorLanguage.value || "zh-CN");
  trends.asr.length = 0;
  trends.translation.length = 0;
  trends.tts.length = 0;
  trends.e2e.length = 0;
  trends.clients.length = 0;
  setMetric(metricAsr, "asr", null);
  setMetric(metricTranslation, "translation", null);
  setMetric(metricTts, "tts", null);
  setMetric(metricE2e, "e2e", null);
  setMetric(metricClients, "clients", 0, "");
  paintAllTrends();

  try {
    const { items } = await api(`/api/events/${eventId}/subtitles?lang=${encodeURIComponent(lang)}`);
    monitorOutput.innerHTML = "";
    for (const item of items.slice(-10)) {
      appendMonitorLine(`历史字幕 #${item.seq}: ${item.translated_text || item.source_text}`);
    }
  } catch (err) {
    showError(err);
    return;
  }

  monitorSocket = new WebSocket(wsUrl("/ws/live"));
  monitorSocket.onopen = () => {
    monitorStatus.textContent = "监视状态：已连接";
    monitorSocket.send(JSON.stringify({ type: "monitor", eventId, language: lang }));
  };
  monitorSocket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "monitor.subtitle") {
        appendMonitorLine(`字幕 #${msg.seq}: ${msg.sourceText}`);
      }
      if (msg.type === "monitor.tts") {
        setMetric(metricTts, "tts", msg.ttsMs, "ms");
        pushTrend("tts", msg.ttsMs);
        paintAllTrends();
        appendMonitorLine(`TTS #${msg.seq} (${msg.language}) 耗时 ${msg.ttsMs}ms`);
      }
      if (msg.type === "monitor.metrics") {
        setMetric(metricAsr, "asr", msg.asrMs, "ms");
        setMetric(metricTranslation, "translation", msg.translationMs, "ms");
        setMetric(metricE2e, "e2e", msg.endToEndMs, "ms");
        pushTrend("asr", msg.asrMs);
        pushTrend("translation", msg.translationMs);
        pushTrend("e2e", msg.endToEndMs);
        paintAllTrends();
        appendMonitorLine(
          `指标 #${msg.seq}: ASR ${msg.asrMs}ms, 翻译 ${msg.translationMs}ms, DB ${msg.dbMs}ms, 端到端 ${msg.endToEndMs}ms, cacheHit=${msg.cacheHit}`,
        );
      }
      if (msg.type === "monitor.stats") {
        setMetric(metricClients, "clients", msg.listenerCount ?? 0, "");
        pushTrend("clients", msg.listenerCount ?? 0);
        paintAllTrends();
        appendMonitorLine(
          `连接统计: listener=${msg.listenerCount ?? 0}, monitor=${msg.monitorCount ?? 0}, producerOnline=${Boolean(msg.producerOnline)}`,
        );
      }
      if (msg.type === "monitor.error") {
        appendMonitorLine(`监视错误(${msg.stage || "unknown"}): ${msg.error || "-"}`);
      }
      if (msg.type === "error") {
        appendMonitorLine(`错误: ${msg.error}`);
      }
    } catch {
      // ignore malformed messages
    }
  };
  monitorSocket.onerror = () => {
    monitorStatus.textContent = "监视状态：连接异常";
  };
  monitorSocket.onclose = () => {
    monitorStatus.textContent = "监视状态：已断开";
  };
});

monitorDisconnectBtn.addEventListener("click", closeMonitor);

async function blobToBase64(blob) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("音频编码失败"));
    reader.onload = () => {
      const result = String(reader.result || "");
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

function pcm16ToWavBuffer(int16, sampleRate) {
  const blockAlign = 2;
  const byteRate = sampleRate * blockAlign;
  const dataSize = int16.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  let offset = 0;
  const writeStr = (s) => {
    for (let i = 0; i < s.length; i += 1) {
      view.setUint8(offset, s.charCodeAt(i));
      offset += 1;
    }
  };
  writeStr("RIFF");
  view.setUint32(offset, 36 + dataSize, true);
  offset += 4;
  writeStr("WAVE");
  writeStr("fmt ");
  view.setUint32(offset, 16, true);
  offset += 4;
  view.setUint16(offset, 1, true);
  offset += 2;
  view.setUint16(offset, 1, true);
  offset += 2;
  view.setUint32(offset, sampleRate, true);
  offset += 4;
  view.setUint32(offset, byteRate, true);
  offset += 4;
  view.setUint16(offset, blockAlign, true);
  offset += 2;
  view.setUint16(offset, 16, true);
  offset += 2;
  writeStr("data");
  view.setUint32(offset, dataSize, true);
  offset += 4;

  for (let i = 0; i < int16.length; i += 1) {
    view.setInt16(offset, int16[i], true);
    offset += 2;
  }
  return buffer;
}

function downsampleTo16k(float32, inputSampleRate) {
  if (inputSampleRate === ASR_TARGET_SAMPLE_RATE) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i += 1) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }
  const ratio = inputSampleRate / ASR_TARGET_SAMPLE_RATE;
  const newLen = Math.max(1, Math.floor(float32.length / ratio));
  const out = new Int16Array(newLen);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < out.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < float32.length; i += 1) {
      accum += float32[i];
      count += 1;
    }
    const sample = count > 0 ? accum / count : 0;
    const s = Math.max(-1, Math.min(1, sample));
    out[offsetResult] = s < 0 ? s * 0x8000 : s * 0x7fff;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }
  return out;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function flushAsrPcmPacket() {
  if (!producerSocket || producerSocket.readyState !== WebSocket.OPEN) {
    return;
  }
  if (!speechLikely) {
    asrPcmChunks.length = 0;
    return;
  }
  if (!asrPcmChunks.length) {
    return;
  }
  const total = asrPcmChunks.reduce((sum, arr) => sum + arr.length, 0);
  const merged = new Float32Array(total);
  let cursor = 0;
  for (const chunk of asrPcmChunks) {
    merged.set(chunk, cursor);
    cursor += chunk.length;
  }
  const int16 = downsampleTo16k(merged, asrInputSampleRate);
  if (int16.length < ASR_MIN_SAMPLES) {
    return;
  }
  asrPcmChunks.length = 0;
  const wav = pcm16ToWavBuffer(int16, ASR_TARGET_SAMPLE_RATE);
  producerSocket.send(
    JSON.stringify({
      type: "asr.chunk",
      mimeType: "audio/wav",
      audioBase64: arrayBufferToBase64(wav),
    }),
  );
}

function startAsrPcmCapture(stream) {
  if (!window.AudioContext) {
    return;
  }
  if (asrFlushTimer) {
    clearInterval(asrFlushTimer);
    asrFlushTimer = null;
  }
  if (asrAudioContext) {
    asrAudioContext.close().catch(() => {});
    asrAudioContext = null;
  }
  asrPcmChunks.length = 0;
  asrAudioContext = new AudioContext();
  asrInputSampleRate = asrAudioContext.sampleRate || 48000;
  asrSourceNode = asrAudioContext.createMediaStreamSource(stream);
  asrProcessorNode = asrAudioContext.createScriptProcessor(4096, 1, 1);
  asrProcessorNode.onaudioprocess = (event) => {
    if (!speechLikely) {
      return;
    }
    const input = event.inputBuffer.getChannelData(0);
    asrPcmChunks.push(new Float32Array(input));
  };
  asrSourceNode.connect(asrProcessorNode);
  asrProcessorNode.connect(asrAudioContext.destination);
  asrFlushTimer = setInterval(flushAsrPcmPacket, ASR_FLUSH_MS);
}

function startMicVad(stream) {
  if (!window.AudioContext) {
    // If AudioContext is unavailable, fallback to always sending.
    speechLikely = true;
    return;
  }
  if (micVadTimer) {
    clearInterval(micVadTimer);
    micVadTimer = null;
  }
  if (micAudioContext) {
    micAudioContext.close().catch(() => {});
    micAudioContext = null;
  }

  micAudioContext = new AudioContext();
  const source = micAudioContext.createMediaStreamSource(stream);
  micAnalyser = micAudioContext.createAnalyser();
  micAnalyser.fftSize = 2048;
  source.connect(micAnalyser);
  micVadBuffer = new Float32Array(micAnalyser.fftSize);
  speechLikely = false;
  lastVoiceAtMs = 0;

  micVadTimer = setInterval(() => {
    if (!micAnalyser || !micVadBuffer) {
      return;
    }
    micAnalyser.getFloatTimeDomainData(micVadBuffer);
    let sum = 0;
    for (const v of micVadBuffer) {
      sum += v * v;
    }
    const rms = Math.sqrt(sum / micVadBuffer.length);
    const now = Date.now();
    if (rms >= VAD_RMS_THRESHOLD) {
      lastVoiceAtMs = now;
    }
    speechLikely = now - lastVoiceAtMs <= VAD_HANGOVER_MS;
  }, VAD_POLL_MS);
}

async function ensureProducerOffer(listenerId) {
  if (!producerSocket || producerSocket.readyState !== WebSocket.OPEN || !micStream) {
    return;
  }
  if (producerPeers.has(listenerId)) {
    return;
  }

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
  });
  producerPeers.set(listenerId, pc);

  for (const track of micStream.getTracks()) {
    pc.addTrack(track, micStream);
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      producerSocket.send(JSON.stringify({ type: "webrtc.ice", to: listenerId, candidate: event.candidate }));
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  producerSocket.send(JSON.stringify({ type: "webrtc.offer", to: listenerId, sdp: offer }));
}

startSessionBtn.addEventListener("click", async () => {
  const eventId = selectedEventId();
  if (!eventId) {
    showError(new Error("请先选择活动"));
    return;
  }

  const profile = produceProfileFromChannels();

  try {
    await api(`/api/events/${eventId}/transition`, {
      method: "POST",
      body: JSON.stringify({ target_status: "READY" }),
    }).catch(() => {});
    await api(`/api/events/${eventId}/transition`, {
      method: "POST",
      body: JSON.stringify({ target_status: "LIVE" }),
    }).catch(() => {});

    closeProducerRuntime();
    await openMicWithSelectedDevice();
    micStream = pendingStream;
    pendingStream = null;
    startMicVad(micStream);

    producerSocket = new WebSocket(wsUrl("/ws/live"));

    producerSocket.onopen = () => {
      producerSocket.send(
        JSON.stringify({
          type: "produce",
          eventId,
          sourceLanguage: profile.sourceLanguage,
          targetLanguages: profile.targetLanguages,
        }),
      );
      startAsrPcmCapture(micStream);
      runStatus.textContent = "运行状态：已启动";
      micStatus.textContent = "MIC 状态：采集中";
    };

    producerSocket.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "webrtc.listener_joined" && msg.listenerId) {
          await ensureProducerOffer(String(msg.listenerId));
          return;
        }
        if (msg.type === "webrtc.answer" && msg.from && msg.sdp) {
          const pc = producerPeers.get(String(msg.from));
          if (pc) {
            await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          }
          return;
        }
        if (msg.type === "webrtc.ice" && msg.from && msg.candidate) {
          const pc = producerPeers.get(String(msg.from));
          if (pc) {
            await pc.addIceCandidate(msg.candidate);
          }
          return;
        }
      } catch {
        // ignore malformed message
      }
    };

    producerSocket.onerror = () => {
      runStatus.textContent = "运行状态：WS 异常";
    };

    producerSocket.onclose = () => {
      runStatus.textContent = "运行状态：已停止";
    };
  } catch (err) {
    showError(err);
  }
});

stopSessionBtn.addEventListener("click", () => {
  closeProducerRuntime();
  runStatus.textContent = "运行状态：已停止";
  micStatus.textContent = "MIC 状态：已停止";
});

clientEntryUrlInput.value = resolveClientEntryBaseUrl();
setMetric(metricAsr, "asr", null);
setMetric(metricTranslation, "translation", null);
setMetric(metricTts, "tts", null);
setMetric(metricE2e, "e2e", null);
setMetric(metricClients, "clients", 0, "");
paintAllTrends();
refreshEvents();
refreshMics();
