import React, { useState, useEffect, useRef } from 'react';
import * as mediasoupClient from 'mediasoup-client';
import { useTranslation } from '../i18n';

// Access global window config
const WS_URL = (window as any).CWCOMM_CONFIG?.wsBaseUrl || "ws://127.0.0.1:8080";

export default function AdminPage() {
  const { t } = useTranslation();
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [status, setStatus] = useState(t('statusDisconnected'));
  const [eventId, setEventId] = useState('demo-event-1');
  const [stats, setStats] = useState({ listenerCount: 0, ttsMs: 0 });
  const [producing, setProducing] = useState(false);
  
  const deviceRef = useRef<mediasoupClient.Device | null>(null);
  const sendTransportRef = useRef<mediasoupClient.types.Transport | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    return () => {
      ws?.close();
      localStreamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, [ws]);

  const connectAdmin = () => {
    const socket = new WebSocket(`${WS_URL}/ws/live`);
    
    socket.onopen = () => {
      setStatus(t('statusConnected') + " (Monitor)");
      socket.send(JSON.stringify({ type: 'monitor', eventId }));
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "monitor.stats") {
          setStats(s => ({ ...s, listenerCount: msg.listenerCount || 0 }));
        }
        if (msg.type === "monitor.tts") {
          setStats(s => ({ ...s, ttsMs: msg.ttsMs || 0 }));
        }
        // Handle SFU capabilities here if we decide to Produce
        if (msg.type === "sfu.routerRtpCapabilities") {
          initDeviceAndProduce(socket, msg.rtpCapabilities);
        }
        if (msg.type === "sfu.transportCreated" && deviceRef.current) {
          const transport = deviceRef.current.createSendTransport({
            id: msg.id,
            iceParameters: msg.iceParameters,
            iceCandidates: msg.iceCandidates,
            dtlsParameters: msg.dtlsParameters
          });

          transport.on("connect", ({ dtlsParameters }, callback, errback) => {
            socket.send(JSON.stringify({ type: "sfu.connectTransport", dtlsParameters }));
            const handler = (e: MessageEvent) => {
              const res = JSON.parse(e.data);
              if (res.type === "sfu.transportConnected") {
                socket.removeEventListener("message", handler);
                callback();
              }
            };
            socket.addEventListener("message", handler);
          });

          transport.on("produce", async ({ kind, rtpParameters }, callback, errback) => {
            socket.send(JSON.stringify({ type: "sfu.produce", kind, rtpParameters }));
            const handler = (e: MessageEvent) => {
              const res = JSON.parse(e.data);
              if (res.type === "sfu.produced") {
                socket.removeEventListener("message", handler);
                callback({ id: res.id });
              }
            };
            socket.addEventListener("message", handler);
          });

          sendTransportRef.current = transport;

          if (localStreamRef.current) {
            const audioTrack = localStreamRef.current.getAudioTracks()[0];
            transport.produce({ track: audioTrack }).then(() => setProducing(true));
          }
        }
      } catch (e) { console.error(e); }
    };
    setWs(socket);
  };

  const startProduce = async () => {
    if (!ws) return alert("Connect monitor first");
    
    // 1. Get mic
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    localStreamRef.current = stream;

    // 2. Change role on server (simplified for demo)
    ws.send(JSON.stringify({ type: 'produce', eventId }));

    // 3. Ask for SFU router
    ws.send(JSON.stringify({ type: 'sfu.getRouterRtpCapabilities' }));
  };

  const initDeviceAndProduce = async (socket: WebSocket, routerRtpCapabilities: any) => {
    const device = new mediasoupClient.Device();
    await device.load({ routerRtpCapabilities });
    deviceRef.current = device;

    // 4. Create transport
    socket.send(JSON.stringify({ type: "sfu.createWebRtcTransport" }));
  };

  const stopProduce = () => {
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    setProducing(false);
  };

  return (
    <div className="glass-panel" style={{ maxWidth: '600px', margin: '0 auto' }}>
      <h2>{t('adminDashboard')}</h2>
      <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
        <input value={eventId} onChange={e => setEventId(e.target.value)} placeholder="Event ID" />
        <button className="btn" onClick={connectAdmin}>{t('connect')}</button>
      </div>

      <div style={{ marginTop: '20px' }}>
        <span className={`status-badge ${status.includes('Connected') ? '' : 'offline'}`}>{status}</span>
      </div>

      {status.includes('Connected') && (
        <div style={{ marginTop: '30px', padding: '20px', background: 'rgba(0,0,0,0.2)', borderRadius: '12px' }}>
          <h3 style={{ marginBottom: '16px' }}>SFU Audio Broadcast</h3>
          
          <div style={{ display: 'flex', gap: '10px' }}>
            {!producing ? (
               <button className="btn" onClick={startProduce}>{t('startProduce')}</button>
            ) : (
               <button className="btn btn-danger" onClick={stopProduce}>{t('stopProduce')}</button>
            )}
          </div>
          
          <div style={{ marginTop: '20px', color: 'var(--text-muted)' }}>
            <p>Live Listeners: {stats.listenerCount}</p>
            <p>Latest TTS MS: {stats.ttsMs}ms</p>
          </div>
        </div>
      )}
    </div>
  );
}
