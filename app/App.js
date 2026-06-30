// 聚位 APP — MVP：互看 GPS 位置 + 點車私訊 + Cloudflare RealtimeKit 即時語音
// 注意：含原生模組，必須用 dev build（不能在 Expo Go 跑）
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { WebView } from "react-native-webview";
import * as Location from "expo-location";
import { io } from "socket.io-client";
import { requestRecordingPermissionsAsync } from "expo-audio";
import { useRealtimeKitClient } from "@cloudflare/realtimekit-react-native";
import { SERVER_URL } from "./config";

const LEAFLET_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  html,body,#map{height:100%;margin:0;padding:0;}
  .dot{border:2px solid #fff;border-radius:12px;padding:2px 7px;color:#fff;
       font-size:12px;font-weight:700;white-space:nowrap;text-align:center;
       box-shadow:0 0 4px rgba(0,0,0,.4);}
  .me{background:#e53e3e;}
  .other{background:#dd6b20;}
</style>
</head>
<body>
<div id="map"></div>
<script>
  function post(o){ if(window.ReactNativeWebView){ window.ReactNativeWebView.postMessage(JSON.stringify(o)); } }
  var map = L.map('map', {attributionControl:false}).setView([23.7, 121], 7);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    {subdomains:'abcd', maxNativeZoom:20, maxZoom:22, detectRetina:true}).addTo(map);
  var markers = {};
  var zoomedOnce = false;
  var follow = true;            // 是否讓地圖跟著「我」移動
  // 使用者手動拖動地圖時暫停跟隨，避免一直被拉回去
  map.on('dragstart', function(){ follow = false; });
  window.updatePositions = function(list, myId){
    var seen = {};
    list.forEach(function(p){
      seen[p.id] = true;
      var isMe = p.id === myId;
      var icon = L.divIcon({
        html:'<div class="dot '+(isMe?'me':'other')+'">'+p.name+'</div>',
        className:'', iconSize:null
      });
      if(markers[p.id]){
        markers[p.id].setLatLng([p.lat,p.lng]).setIcon(icon);
      } else {
        var m = L.marker([p.lat,p.lng],{icon:icon}).addTo(map);
        m.on('click', (function(id){ return function(){ post({type:'tap', id:id}); }; })(p.id));
        markers[p.id] = m;
      }
      if(isMe){
        if(!zoomedOnce){ map.setView([p.lat,p.lng], 17); zoomedOnce = true; }  // 第一次設好縮放
        else if(follow){ map.panTo([p.lat,p.lng], {animate:true}); }            // 之後平滑跟隨
      }
    });
    Object.keys(markers).forEach(function(id){
      if(!seen[id]){ map.removeLayer(markers[id]); delete markers[id]; }
    });
  };
</script>
</body>
</html>`;

export default function App() {
  const [status, setStatus] = useState("啟動中…");
  const [count, setCount] = useState(0);
  const [target, setTarget] = useState(null); // 私訊對象 { id, name }
  const [text, setText] = useState("");
  const [voiceStatus, setVoiceStatus] = useState("語音連線中…");
  const [micOn, setMicOn] = useState(false);
  const [permsReady, setPermsReady] = useState(false); // 權限都要過後才啟動語音

  const [meeting, initMeeting] = useRealtimeKitClient();
  const webRef = useRef(null);
  const socketRef = useRef(null);
  const myIdRef = useRef(null);
  const latestRef = useRef([]);
  const lastLocRef = useRef(null); // 最後一次位置，用於心跳重送
  const bestAccRef = useRef(Infinity); // 目前為止取得過最好的精度（公尺），用於過濾爛訊號

  // 精度過濾門檻（公尺）：超過這個值的點視為「粗略網路定位」
  const ACC_THRESHOLD = 100;

  // 是否採用這個新點：精度夠好，或明顯比目前最佳更好（容許 GPS 正常飄移）
  function shouldAccept(newAcc) {
    if (newAcc == null) return true; // 沒有精度資訊就先收（保守）
    if (newAcc <= ACC_THRESHOLD) return true;
    if (newAcc <= bestAccRef.current * 1.5) return true; // 沒有更好的點時，至少維持顯示
    return false;
  }

  function pushToMap() {
    if (!webRef.current) return;
    webRef.current.injectJavaScript(
      "window.updatePositions && window.updatePositions(" +
        JSON.stringify(latestRef.current) +
        "," +
        JSON.stringify(myIdRef.current) +
        "); true;"
    );
  }

  function onMarkerTap(id) {
    if (id === myIdRef.current) return;
    const car = latestRef.current.find((p) => p.id === id);
    setTarget({ id, name: car ? car.name : "車" });
    setText("");
  }

  function sendMessage() {
    if (target && text.trim() && socketRef.current) {
      socketRef.current.emit("dm", { to: target.id, text: text.trim() });
    }
    setTarget(null);
    setText("");
  }

  function toggleMic() {
    if (!meeting) return;
    if (meeting.self.audioEnabled) meeting.self.disableAudio();
    else meeting.self.enableAudio();
  }

  // === 位置 / 私訊（核心，獨立執行）===
  useEffect(() => {
    let locSub = null;
    let heartbeat = null;
    const socket = io(SERVER_URL, { transports: ["websocket"] });
    socketRef.current = socket;
    socket.on("connect", () => {
      myIdRef.current = socket.id;
      setStatus("已連線，定位中…");
    });
    socket.on("disconnect", () => setStatus("連線中斷，重連中…"));
    socket.on("connect_error", (e) => setStatus("連不到伺服器：" + e.message));
    socket.on("positions", (list) => {
      latestRef.current = list;
      setCount(list.length);
      pushToMap();
    });
    socket.on("dm", (m) => Alert.alert("📩 來自 " + m.fromName, m.text));

    (async () => {
      // 先要定位權限（優先），再要麥克風 —— 依序，避免兩個權限視窗同時跳互相打架
      const permResp = await Location.requestForegroundPermissionsAsync();
      const perm = permResp.status;
      // Android：fine = 精確位置；coarse = 只給了大略位置（會變 ±幾千公尺網路定位）
      const androidAccuracy = permResp.android?.accuracy;
      console.log("[權限] status:", perm, "android.accuracy:", androidAccuracy);
      if (perm === "granted") {
        if (androidAccuracy === "coarse") {
          setStatus("只拿到『大略位置』權限（請重裝後授權精確位置）");
        }
        // 0) 確認定位服務開著；Android 主動請求切換到「高精準度」模式
        //    （手機定位模式只用網路 → 戶外也不準，這是最常見原因）
        try {
          const enabled = await Location.hasServicesEnabledAsync();
          if (!enabled) setStatus("請開啟手機定位服務");
        } catch (e) {}
        if (Platform.OS === "android") {
          try {
            await Location.enableNetworkProviderAsync(); // 跳系統「開啟高精準度定位」對話框
          } catch (e) {}
        }
        // 1) 用「上次已知位置」秒顯示（只當暫時開場點；夠新才送伺服器，避免送出過時座標）
        try {
          const last = await Location.getLastKnownPositionAsync();
          if (last) {
            const fresh = Date.now() - last.timestamp < 120000; // 2 分鐘內才算新
            const placeholder = {
              lat: last.coords.latitude,
              lng: last.coords.longitude,
              acc: last.coords.accuracy,
            };
            if (fresh) {
              lastLocRef.current = placeholder;
              if (last.coords.accuracy != null) bestAccRef.current = last.coords.accuracy;
              socket.emit("location", placeholder);
            }
          }
        } catch (e) {}
        // 2) 抓一次目前位置（用最高精度，不再用 Balanced 網路定位）
        try {
          const cur = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.BestForNavigation,
          });
          const acc = cur.coords.accuracy;
          if (shouldAccept(acc)) {
            if (acc != null && acc < bestAccRef.current) bestAccRef.current = acc;
            lastLocRef.current = {
              lat: cur.coords.latitude,
              lng: cur.coords.longitude,
              acc,
            };
            socket.emit("location", lastLocRef.current);
          }
        } catch (e) {}
        // 3) 持續 GPS 追蹤（戶外精準、隨移動更新；過濾掉精度太差的點）
        try {
          locSub = await Location.watchPositionAsync(
            {
              accuracy: Location.Accuracy.BestForNavigation,
              timeInterval: 1000,
              distanceInterval: 1,
              mayShowUserSettingsDialog: true,
            },
            (pos) => {
              const acc = pos.coords.accuracy;
              console.log("[GPS]", pos.coords.latitude, pos.coords.longitude, "精度m:", acc);
              const kind = acc != null && acc <= 30 ? "GPS" : "網路";
              setStatus(
                acc != null ? `定位中 ±${Math.round(acc)}m（${kind}）` : "定位中…"
              );
              if (!shouldAccept(acc)) return; // 爛訊號丟掉，不覆蓋已有的精準點
              if (acc != null && acc < bestAccRef.current) bestAccRef.current = acc;
              lastLocRef.current = {
                lat: pos.coords.latitude,
                lng: pos.coords.longitude,
                acc,
              };
              socket.emit("location", lastLocRef.current);
            }
          );
        } catch (e) {
          setStatus("定位追蹤失敗：" + (e?.message || String(e)));
        }
        // 4) 心跳：每 5 秒重送「最新」位置，靜止時也不會被清掉（會跟著 watch 更新）
        heartbeat = setInterval(() => {
          if (lastLocRef.current) socket.emit("location", lastLocRef.current);
        }, 5000);
      } else {
        setStatus("未取得定位權限，無法回報位置");
      }
      // 定位處理完才要麥克風，最後才放行語音
      try {
        await requestRecordingPermissionsAsync();
      } catch (e) {}
      setPermsReady(true);
    })();

    return () => {
      locSub && locSub.remove();
      heartbeat && clearInterval(heartbeat);
      socketRef.current && socketRef.current.disconnect();
    };
  }, []);

  // === 語音：權限都過後 → 跟伺服器要 RealtimeKit authToken → 初始化 ===
  useEffect(() => {
    if (!permsReady) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(SERVER_URL + "/rtk-token?role=car", {
          headers: { "ngrok-skip-browser-warning": "1" },
        });
        const j = await r.json();
        if (cancelled || !j.authToken) {
          setVoiceStatus("語音 token 取得失敗");
          return;
        }
        await initMeeting({
          authToken: j.authToken,
          defaults: { audio: false, video: false }, // 一進房間先靜音，使用者要講話再自己開麥
        });
      } catch (e) {
        setVoiceStatus("語音初始化失敗：" + (e?.message || String(e)));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [permsReady]);

  // === 語音：meeting 準備好後加入房間 + 監聽麥克風狀態 ===
  useEffect(() => {
    if (!meeting) return;
    meeting
      .joinRoom()
      .then(() => {
        setVoiceStatus("語音已連線");
        setMicOn(!!meeting.self.audioEnabled);
      })
      .catch((e) => setVoiceStatus("語音加入失敗：" + (e?.message || String(e))));

    const onAudio = () => setMicOn(!!meeting.self.audioEnabled);
    meeting.self.on("audioUpdate", onAudio);
    return () => {
      try {
        meeting.self.removeListener("audioUpdate", onAudio);
      } catch (e) {}
      try {
        meeting.leaveRoom();
      } catch (e) {}
    };
  }, [meeting]);

  return (
    <View style={styles.page}>
      <WebView
        ref={webRef}
        originWhitelist={["*"]}
        source={{ html: LEAFLET_HTML }}
        onLoadEnd={pushToMap}
        onMessage={(e) => {
          try {
            const m = JSON.parse(e.nativeEvent.data);
            if (m.type === "tap") onMarkerTap(m.id);
          } catch {}
        }}
        style={styles.map}
      />

      <View style={styles.banner}>
        <Text style={styles.bannerText}>{status}</Text>
        <Text style={styles.bannerSub}>在線 {count} 台</Text>
      </View>

      {/* 語音狀態 + 開麥/靜音 */}
      <Pressable
        onPress={toggleMic}
        style={[styles.voiceBar, micOn ? styles.micOn : styles.micOff]}
      >
        <Text style={styles.voiceText}>
          {voiceStatus !== "語音已連線"
            ? voiceStatus
            : micOn
            ? "🎙️ 語音開啟中（點擊靜音）"
            : "🔇 已靜音（點擊開麥）"}
        </Text>
      </Pressable>

      {/* 私訊輸入框 */}
      <Modal visible={!!target} transparent animationType="fade" onRequestClose={() => setTarget(null)}>
        <View style={styles.modalBg}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>傳訊息給 {target?.name}</Text>
            <TextInput
              style={styles.input}
              placeholder="輸入訊息…"
              value={text}
              onChangeText={setText}
              autoFocus
              multiline
            />
            <View style={styles.modalBtns}>
              <Pressable style={[styles.btn, styles.cancel]} onPress={() => setTarget(null)}>
                <Text style={styles.cancelText}>取消</Text>
              </Pressable>
              <Pressable style={[styles.btn, styles.send]} onPress={sendMessage}>
                <Text style={styles.sendText}>送出</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  map: { flex: 1 },
  banner: {
    position: "absolute",
    top: 50,
    left: 16,
    right: 16,
    backgroundColor: "rgba(0,0,0,0.7)",
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  bannerText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  bannerSub: { color: "#9ae6b4", fontSize: 13 },
  voiceBar: {
    position: "absolute",
    bottom: 36,
    alignSelf: "center",
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 30,
    elevation: 5,
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
  },
  micOn: { backgroundColor: "#2f855a" },
  micOff: { backgroundColor: "#718096" },
  voiceText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  modalBg: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "center",
    paddingHorizontal: 28,
  },
  modalCard: { backgroundColor: "#fff", borderRadius: 14, padding: 18 },
  modalTitle: { fontSize: 16, fontWeight: "700", marginBottom: 12 },
  input: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    padding: 10,
    minHeight: 60,
    fontSize: 15,
    textAlignVertical: "top",
  },
  modalBtns: { flexDirection: "row", justifyContent: "flex-end", marginTop: 14, gap: 10 },
  btn: { paddingVertical: 9, paddingHorizontal: 18, borderRadius: 8 },
  cancel: { backgroundColor: "#eee" },
  cancelText: { color: "#444", fontWeight: "600" },
  send: { backgroundColor: "#e53e3e" },
  sendText: { color: "#fff", fontWeight: "700" },
});
