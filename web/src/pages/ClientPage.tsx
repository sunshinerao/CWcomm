import React, { useState, useEffect, useRef } from 'react';
import * as mediasoupClient from 'mediasoup-client';
import { useTranslation, Lang } from '../i18n';

const WS_URL = (window as any).CWCOMM_CONFIG?.wsBaseUrl || "ws://127.0.0.1:8080";

type SubtitleSegment = { seq: number, source_text: string, translated_text: string };

export default function ClientPage() {
  const { t } = useTranslation();
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [status, setStatus] = useState(t('statusDisconnected'));
  const [eventId, setEventId] = useState('demo-event-1');
  const [targetLang, setTargetLang] = useState<Lang>('en');
  const [subtitles, setSubtitles] = useState<SubtitleSegment[]>([]);
  const [ttsQueue, setTtsQueue] = useState<string[]>([]);
  const [enableTts, setEnableTts] = useState(true);
  const [enableFloor, setEnableFloor] = useState(false);
  
  const deviceRef = useRef<mediasoupClient.Device | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    return () => ws?.close();
  }, [ws]);

  const connectClient = () => {
    const socket = new WebSocket(`${WS_URL}/ws/live`);
    
    socket.onopen = () => {
      setStatus(t('statusConnected'));
      socket.send(JSON.stringify({ type: 'listen', eventId, language: targetLang }));
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        
        if (msg.type === "subtitle.delta") {
          setSubtitles(prev => {
            const filtered = prev.filter(p => p.seq !== msg.segment.seq);
            return [{ seq: msg.segment.seq, source_text: msg.segment.source_text, translated_text: msg.segment.translated_text }, ...filtered].slice(0, 20);
          });
        }
        
        if (msg.type === "tts.audio" && enableTts) {
          playTtsBase64(msg.audio_base64, msg.mime_type);
        }

        // SFU CONSUMER LOGIC
        if (msg.type === "sfu.producer_state" && msg.active) {
            // Producer is online, ask for router capabilities
            socket.send(JSON.stringify({ type: 'sfu.getRouterRtpCapabilities' }));
        }

        if (msg.type === "sfu.routerRtpCapabilities") {
          initDeviceAndConsume(socket, msg.rtpCapabilities);
        }

        if (msg.type === "sfu.transportCreated" && deviceRef.current) {
          const transport = deviceRef.current.createRecvTransport({
            id: msg.id, iceParameters: msg.iceParameters, iceCandidates: msg.iceCandidates, dtlsParameters: msg.dtlsParameters
          });

          transport.on("connect", ({ dtlsParameters }, callback, errback) => {
            socket.send(JSON.stringify({ type: "sfu.connectTransport", dtlsParameters }));
            const handler = (e: MessageEvent) => {
              const res = JSON.parse(e.data);
              if (res.type === "sfu.transportConnected") { socket.removeEventListener("message", handler); callback(); }
            };
            socket.addEventListener("message", handler);
          });

          // Request consume
          socket.send(JSON.stringify({ type: "sfu.consume", rtpCapabilities: deviceRef.current.rtpCapabilities }));

          const handler2 = async (e: MessageEvent) => {
            const res = JSON.parse(e.data);
            if (res.type === "sfu.consumed") {
               socket.removeEventListener("message", handler2);
               const consumer = await transport.consume({ id: res.id, producerId: res.producerId, kind: res.kind as "audio", rtpParameters: res.rtpParameters });
               
               const stream = new MediaStream();
               stream.addTrack(consumer.track);
               if (audioRef.current) {
                  audioRef.current.srcObject = stream;
                  audioRef.current.play().catch(console.error);
               }
            }
          };
          socket.addEventListener("message", handler2);
        }

      } catch (e) { console.error(e); }
    };

    socket.onclose = () => setStatus(t('statusDisconnected'));
    setWs(socket);
  };

  const initDeviceAndConsume = async (socket: WebSocket, routerRtpCapabilities: any) => {
    if (!deviceRef.current) {
      const device = new mediasoupClient.Device();
      await device.load({ routerRtpCapabilities });
      deviceRef.current = device;
    }
    socket.send(JSON.stringify({ type: "sfu.createWebRtcTransport" }));
  };

  const playTtsBase64 = (base64: string, mime: string) => {
     const binary = atob(base64);
     const bytes = new Uint8Array(binary.length);
     for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
     const blob = new Blob([bytes], { type: mime || "audio/mpeg" });
     const url = URL.createObjectURL(blob);
     
     if (ttsAudioRef.current) {
       // Simple immediate playback for demo. In prod, queue it.
       ttsAudioRef.current.src = url;
       ttsAudioRef.current.play();
     }
  };

  return (
    <div className="glass-panel" style={{ maxWidth: '800px', margin: '0 auto' }}>
      <h2>{t('audienceClient')}</h2>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: '10px', marginTop: '20px' }}>
        <input value={eventId} onChange={e => setEventId(e.target.value)} placeholder={t('eventSelect')} />
        <select value={targetLang} onChange={e => setTargetLang(e.target.value as Lang)}>
          <option value="en">English (翻译)</option>
          <option value="zh">中文 (Translation)</option>
        </select>
        <button className="btn" onClick={connectClient}>{t('connect')}</button>
      </div>

      <div style={{ marginTop: '20px', display: 'flex', gap: '20px', alignItems: 'center' }}>
        <span className={`status-badge ${status.includes('Connected') ? '' : 'offline'}`}>{status}</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
          <input type="checkbox" checked={enableTts} onChange={e => setEnableTts(e.target.checked)} />
          {t('ttsEnabled')}
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
          <input type="checkbox" checked={enableFloor} onChange={e => {
             setEnableFloor(e.target.checked);
             if (audioRef.current) audioRef.current.muted = !e.target.checked;
          }} />
          {t('listenOrigin')}
        </label>
      </div>

      <audio ref={audioRef} muted={!enableFloor} style={{ display: 'none' }} />
      <audio ref={ttsAudioRef} style={{ display: 'none' }} />

      <div className="subtitle-box">
        {subtitles.map(s => (
          <div key={s.seq} className="subtitle-item">
            <div className="source-text">#{s.seq} {s.source_text}</div>
            <div className="target-text">{s.translated_text || '...'}</div>
          </div>
        ))}
        {subtitles.length === 0 && <p style={{ color: 'var(--text-muted)' }}>Waiting for incoming speech...</p>}
      </div>
    </div>
  );
}
