import { useState, useEffect } from 'react';

const dict = {
  en: {
    title: "CWcomm Live Interpretation",
    adminDashboard: "Producer Dashboard",
    audienceClient: "Audience Receiver",
    eventSelect: "Select Event",
    language: "Target Language",
    connect: "Connect",
    disconnect: "Disconnect",
    listenOrigin: "Listen Original Audio",
    ttsEnabled: "Enable AI Voice (TTS)",
    statusConnected: "Connected",
    statusDisconnected: "Disconnected",
    producing: "Broadcasting Audio...",
    startProduce: "Start Broadcast",
    stopProduce: "Stop Broadcast"
  },
  zh: {
    title: "CWcomm 实时同传",
    adminDashboard: "推流与导播台",
    audienceClient: "听众接收端",
    eventSelect: "选择活动",
    language: "目标收听语言",
    connect: "开始收听",
    disconnect: "断开连接",
    listenOrigin: "收听会场原音",
    ttsEnabled: "开启 AI 语音播放",
    statusConnected: "已连接",
    statusDisconnected: "未连接",
    producing: "正在广播原音...",
    startProduce: "开始广播",
    stopProduce: "停止广播"
  }
};

export type Lang = 'en' | 'zh';

let currentLang: Lang = (localStorage.getItem('lang') as Lang) || 'zh';
const listeners = new Set<(lang: Lang) => void>();

export function setLang(lang: Lang) {
  currentLang = lang;
  localStorage.setItem('lang', lang);
  listeners.forEach(fn => fn(lang));
}

export function useTranslation() {
  const [lang, setLocalLang] = useState<Lang>(currentLang);

  useEffect(() => {
    listeners.add(setLocalLang);
    return () => { listeners.delete(setLocalLang); };
  }, []);

  return {
    t: (key: keyof typeof dict['en']) => dict[lang][key] || key,
    lang,
    setLang
  };
}
