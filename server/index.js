// 聚位 APP — MVP 即時 GPS 位置廣播伺服器
// 對應企劃書任務 3（Redis Pub/Sub + WebSocket）的最小版本：
// 先用記憶體存位置就好，不接 Redis / PostgreSQL，目標只驗證「手機彼此看到位置」。

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { AccessToken } from "livekit-server-sdk";

// LiveKit 密鑰從環境變數讀取（見 server/.env，用 npm start 會自動載入）
// const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;

// Cloudflare RealtimeKit 設定
const {
  CF_ACCOUNT_ID,
  CF_RTK_APP_ID,
  CF_API_TOKEN,
  RTK_PRESET_CAR,
  RTK_PRESET_HOST,
} = process.env;
const CF_BASE = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/realtime/kit/${CF_RTK_APP_ID}`;

// 共用一個 meeting（大家進同一個語音房），建立一次後快取 id
let rtkMeetingId = null;
async function ensureMeeting() {
  if (rtkMeetingId) return rtkMeetingId;
  const r = await fetch(`${CF_BASE}/meetings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CF_API_TOKEN}`,
    },
    body: JSON.stringify({ title: "juwei-voice" }),
  });
  const data = await r.json();
  if (!data.success)
    throw new Error("建立 meeting 失敗: " + JSON.stringify(data.error || data));
  rtkMeetingId = data.data.id;
  console.log("[RealtimeKit] meeting 建立:", rtkMeetingId);
  return rtkMeetingId;
}

const PORT = process.env.PORT || 3000;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" }, // 測試用全開，正式版要鎖網域
  maxHttpBufferSize: 1e7, // 10MB，容納對講機語音片段
  pingTimeout: 60000, // 容忍 60 秒沒回應才判斷線（避免語音卡到 JS 時誤斷）
  pingInterval: 25000,
});

// 記憶體儲存：每台裝置最新位置。key = socket.id
// value = { id, name, lat, lng, ts }
const positions = new Map();

// 依連線順序分配最小可用編號（車1、車2、車3…），斷線後回收號碼
const usedNumbers = new Set();
function takeNumber() {
  let n = 1;
  while (usedNumbers.has(n)) n++;
  usedNumbers.add(n);
  return n;
}

// 健康檢查端點（瀏覽器打開 ngrok 網址會看到這個，代表 server 活著）
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "juwei-gps-mvp",
    online: positions.size,
    devices: [...positions.values()].map((p) => ({ name: p.name, lat: p.lat, lng: p.lng, acc: p.acc, ts: p.ts })),
  });
});

// LiveKit：發給手機加入語音房間的臨時 token
// app.get("/token", async (req, res) => {
//   try {
//     const room = String(req.query.room || "juwei");
//     const identity = String(req.query.identity || "u-" + Date.now());
//     const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
//       identity,
//     });
//     at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
//     const token = await at.toJwt();
//     res.json({ url: LIVEKIT_URL, token });
//   } catch (e) {
//     res.status(500).json({ error: String(e) });
//   }
// });

// RealtimeKit：發給裝置加入語音的 authToken
app.get("/rtk-token", async (req, res) => {
  try {
    const role = req.query.role === "host" ? "host" : "car";
    const preset = role === "host" ? RTK_PRESET_HOST : RTK_PRESET_CAR;
    const name = String(req.query.name || (role === "host" ? "主辦" : "車"));
    const meetingId = await ensureMeeting();
    const r = await fetch(`${CF_BASE}/meetings/${meetingId}/participants`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CF_API_TOKEN}`,
      },
      body: JSON.stringify({
        name,
        preset_name: preset,
        custom_participant_id: "u-" + Date.now(),
      }),
    });
    const data = await r.json();
    if (!data.success) {
      return res.status(500).json({ error: data.error || data });
    }
    const authToken = data.data?.token;
    if (!authToken) return res.json({ debug: data.data }); // 找不到欄位時回傳原始結構供除錯
    res.json({ authToken });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// 電腦瀏覽器監控台：地圖 + 所有車即時位置 + RealtimeKit 語音（開 https://<ngrok>/voice）
app.get("/voice", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>聚位監控台</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://cdn.jsdelivr.net/npm/socket.io-client@4/dist/socket.io.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@cloudflare/realtimekit@latest/dist/browser.js"></script>
<script type="module">
  import { defineCustomElements } from 'https://cdn.jsdelivr.net/npm/@cloudflare/realtimekit-ui@latest/loader/index.es2017.js';
  defineCustomElements();
</script>
<style>
  html,body,#map{height:100%;margin:0;padding:0;}
  .dot{border:2px solid #fff;border-radius:12px;padding:2px 7px;color:#fff;font-size:13px;font-weight:700;background:#dd6b20;white-space:nowrap;text-align:center;box-shadow:0 0 4px rgba(0,0,0,.4);}
  #bar{position:absolute;top:12px;left:12px;right:12px;z-index:1000;display:flex;gap:10px;align-items:center;background:rgba(0,0,0,.7);color:#fff;padding:10px 14px;border-radius:10px;font-family:sans-serif}
  #join,#mute{font-size:15px;padding:8px 16px;border:0;border-radius:8px;background:#2f855a;color:#fff;font-weight:700;cursor:pointer}
  #log{font-size:14px}
  #rtkaudio{display:none}
</style>
</head><body>
<div id="map"></div>
<div id="bar">
  <button id="join">🎤 加入語音</button>
  <button id="mute" style="display:none">🎙️ 靜音</button>
  <span id="log">監控中（位置即時顯示）｜點加入語音開麥</span>
  <span id="people" style="margin-left:auto"></span>
</div>
<rtk-participants-audio id="rtkaudio"></rtk-participants-audio>
<script>
  // ----- 地圖 + 即時位置 -----
  var map = L.map('map', {attributionControl:false}).setView([23.7,121], 7);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    {subdomains:'abcd', maxNativeZoom:20, maxZoom:22, detectRetina:true}).addTo(map);
  var markers = {}, fitted = false;
  var socket = io({ transports:['websocket'] });
  socket.on('positions', function(list){
    var seen = {};
    list.forEach(function(p){
      seen[p.id] = true;
      var icon = L.divIcon({html:'<div class="dot">'+p.name+'</div>', className:'', iconSize:null});
      if(markers[p.id]) markers[p.id].setLatLng([p.lat,p.lng]).setIcon(icon);
      else markers[p.id] = L.marker([p.lat,p.lng],{icon:icon}).addTo(map);
    });
    Object.keys(markers).forEach(function(id){ if(!seen[id]){ map.removeLayer(markers[id]); delete markers[id]; } });
    if(!fitted && list.length){ map.setView([list[0].lat, list[0].lng], 16); fitted = true; }
  });

  // ----- 語音（RealtimeKit 核心 + 隱藏音訊元件播放）-----
  var meeting = null, joined = false;
  var btn = document.getElementById('join');
  var muteBtn = document.getElementById('mute');
  function renderPeople(){
    try { document.getElementById('people').textContent = '語音房 ' + (1 + meeting.participants.joined.toArray().length) + ' 人'; } catch(e){}
  }
  btn.onclick = async function(){
    if(joined){
      try{ await meeting.leaveRoom(); }catch(e){}
      joined = false; meeting = null;
      btn.textContent = '🎤 加入語音'; muteBtn.style.display='none';
      document.getElementById('log').textContent='已離開語音'; document.getElementById('people').textContent='';
      return;
    }
    try{
      document.getElementById('log').textContent = '語音連線中…';
      var res = await fetch('/rtk-token?role=host', { headers:{'ngrok-skip-browser-warning':'1'} });
      var data = await res.json();
      if(!data.authToken){ document.getElementById('log').textContent='語音 token 失敗'; return; }
      meeting = await RealtimeKitClient.init({ authToken: data.authToken, defaults:{ audio:true, video:false } });
      await customElements.whenDefined('rtk-participants-audio');
      document.getElementById('rtkaudio').meeting = meeting; // 負責播放對方聲音
      try {
        meeting.participants.joined.on('participantJoined', renderPeople);
        meeting.participants.joined.on('participantLeft', renderPeople);
      } catch(e){}
      // 加入房間（web/RN 版方法名可能不同，自動嘗試）
      if (typeof meeting.joinRoom === 'function') await meeting.joinRoom();
      else if (typeof meeting.join === 'function') await meeting.join();
      else {
        var fns = [];
        var o = meeting;
        while (o) { Object.getOwnPropertyNames(o).forEach(function(n){ try{ if(typeof meeting[n]==='function' && fns.indexOf(n)<0) fns.push(n); }catch(e){} }); o = Object.getPrototypeOf(o); }
        document.getElementById('log').textContent = 'meeting 可用方法: ' + fns.join(', ');
        return;
      }
      joined = true;
      btn.textContent = '🔴 離開語音';
      muteBtn.style.display=''; muteBtn.textContent='🎙️ 靜音'; muteBtn.style.background='#2f855a';
      document.getElementById('log').textContent='✅ 已加入 — 直接講話';
      renderPeople();
    }catch(e){ document.getElementById('log').textContent='語音錯誤：'+e.message; }
  };
  muteBtn.onclick = function(){
    if(!meeting) return;
    if(meeting.self.audioEnabled){ meeting.self.disableAudio(); muteBtn.textContent='🔇 已靜音（點開麥）'; muteBtn.style.background='#718096'; }
    else { meeting.self.enableAudio(); muteBtn.textContent='🎙️ 靜音'; muteBtn.style.background='#2f855a'; }
  };
</script>
</body></html>`);
});

io.on("connection", (socket) => {
  const num = takeNumber();
  socket.deviceNum = num;
  console.log(`[連線] 車${num} ${socket.id}（在線 ${io.engine.clientsCount}）`);

  // 一連上就把目前所有人的位置先送給它
  socket.emit("positions", [...positions.values()]);

  // 裝置回報自己的位置（App 每 2 秒送一次，只送座標，名字由伺服器分配）
  socket.on("location", (data) => {
    const lat = Number(data?.lat);
    const lng = Number(data?.lng);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return;
    positions.set(socket.id, {
      id: socket.id,
      name: `車${num}`,
      lat,
      lng,
      acc: data?.acc,
      ts: Date.now(),
    });
    io.emit("positions", [...positions.values()]);
  });

  // 私訊：把訊息轉送給指定的車（to = 對方的 socket id）
  socket.on("dm", ({ to, text }) => {
    const msg = String(text || "").slice(0, 200);
    if (!to || !msg) return;
    io.to(to).emit("dm", { fromName: `車${num}`, text: msg });
  });

  // 對講機：把語音片段轉發給其他所有車（不含自己）
  socket.on("voice", (payload) => {
    if (!payload?.data) return;
    socket.broadcast.emit("voice", {
      fromName: `車${num}`,
      data: payload.data,
      ext: payload.ext || "m4a",
    });
  });

  socket.on("disconnect", () => {
    positions.delete(socket.id);
    usedNumbers.delete(num);
    console.log(`[斷線] 車${num}（剩 ${io.engine.clientsCount}）`);
    io.emit("positions", [...positions.values()]);
  });
});

// 清掉超過 30 秒沒回報的殭屍裝置
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, p] of positions) {
    if (now - p.ts > 120_000) {
      // 2 分鐘沒回報才清（真 GPS 會每 2 秒更新，不會被清；真正關掉由 socket 斷線移除）
      positions.delete(id);
      changed = true;
    }
  }
  if (changed) io.emit("positions", [...positions.values()]);
}, 5_000);

httpServer.listen(PORT, () => {
  console.log(`聚位 GPS MVP 伺服器啟動於 http://localhost:${PORT}`);
});
