# 聚位 APP — MVP：手機即時互看位置 + 點車私訊 + 即時語音

這是「聚位 APP」企劃書的**最小驗證版**，目前已長出三條主功能：

1. **即時 GPS 位置** — 兩三台手機裝上 APK，地圖上即時看到彼此的位置點在移動。
2. **點車私訊** — 在地圖上點某台車的標籤，傳一句文字訊息給它。
3. **即時語音（對講）** — 所有人進同一個語音房，開麥就能講話（Cloudflare RealtimeKit）。

另外電腦端有一個**瀏覽器監控台**，可同時看全場車輛位置並一起加入語音。

```
手機 A (APK) ┐                                    ┌─ 廣播所有人位置（Socket.IO）
             ├─→ Node 伺服器（你的電腦 + ngrok）─┤─ 轉送點對點私訊（DM）
手機 B (APK) ┘                                    └─ 簽發語音 token → Cloudflare RealtimeKit 房間
                          │
                電腦瀏覽器監控台 /voice（地圖 + 語音）
```

> 位置與訊息只存在**伺服器記憶體**，重開即清空；語音走 Cloudflare RealtimeKit 雲端，不經過你的伺服器轉流。

---

## 〇、需要先準備的東西

| 項目 | 用途 | 哪裡拿 |
|------|------|--------|
| Node.js 18+ | 跑伺服器（需支援 `--env-file`）、跑 Expo | https://nodejs.org |
| Expo 帳號 | 用 EAS 雲端打包 APK | https://expo.dev（免費註冊） |
| ngrok | 把電腦伺服器開到外網 | https://ngrok.com（免費註冊） |
| Cloudflare 帳號 + RealtimeKit App | 即時語音（對講）功能 | https://dash.cloudflare.com → Realtime |

> **地圖不用任何金鑰。** 本專案用開源的 **Leaflet + CartoDB 免費圖磚**，不需要 Mapbox/MapTiler token。
> **語音需要 Cloudflare RealtimeKit。** 若暫時不需要語音，App 仍可正常顯示位置與私訊，只是語音那條橫條會停在「token 取得失敗」。

---

## 一、設定伺服器密鑰（語音用）

語音功能要伺服器去跟 Cloudflare 換 token。在 `server/` 下建立 `.env`：

```bash
# server/.env
CF_ACCOUNT_ID=你的 Cloudflare Account ID
CF_RTK_APP_ID=你的 RealtimeKit App ID
CF_API_TOKEN=有 Realtime 權限的 API Token
RTK_PRESET_CAR=車友用的 preset 名稱（例如 group_call_participant）
RTK_PRESET_HOST=主辦用的 preset 名稱（例如 group_call_host）
```

> `.env` 已列入 `.gitignore`，不會被提交。`server/.env.example` 是舊的 LiveKit 範本，已不使用（語音改走 Cloudflare RealtimeKit，程式裡 LiveKit 相關碼已註解保留）。

---

## 二、啟動伺服器（電腦上）

```bash
cd server
npm install
npm start
```

看到 `聚位 GPS MVP 伺服器啟動於 http://localhost:3000` 就成功了。
（`npm start` 會用 `node --env-file=.env` 自動載入上面的密鑰。）

---

## 三、用 ngrok 開到外網（另開一個終端機）

```bash
ngrok http 3000
```

會看到一行 `Forwarding  https://xxxx.ngrok-free.app -> http://localhost:3000`。
**複製那個 `https://` 開頭的網址**，等下要填進 App。

> 用瀏覽器打開那個網址，若看到 `{"ok":true,...}`（含目前在線裝置）就代表外網連得到伺服器。

---

## 四、填入設定（ngrok 網址）

伺服器網址放在 `app/.env`（不會被提交到 git），第一次先複製範本：

```bash
cd app
cp .env.example .env      # Windows PowerShell：copy .env.example .env
```

打開 `app/.env`，把 ngrok 網址填進去（https 開頭、結尾不要斜線）：

```bash
EXPO_PUBLIC_SERVER_URL=https://xxxx.ngrok-free.app
```

> - 變數一定要以 `EXPO_PUBLIC_` 開頭，Expo 才會把它打包進 App。
> - 改完網址要重新打包 APK（見下一步）才會生效。
> - `app/.easignore` 已設定好，會在 EAS 打包時把 `.env` 一起帶上去——否則打包出來的 APK 讀不到網址、連不到伺服器。
> - 地圖免 token，`app.json` 不用動。`config.js` 不用改（它會自動讀 `.env`）。

---

## 五、打包 APK（EAS 雲端打包，不需要本機 Android 環境）

```bash
cd app
npm install
npm install -g eas-cli       # 第一次才需要
eas login                    # 用 Expo 帳號登入
eas build -p android --profile preview
```

> ⚠️ App 含原生模組（WebRTC 語音、定位），**不能用 Expo Go 跑**，必須是 EAS 打包的 dev/preview build。
> `eas.json` 已備好 `development`（含 dev client）與 `preview`（純 APK）兩種 profile。
> 第一次 `eas build` 會問要不要產生 Android keystore，選 **Yes** 讓它自動處理即可。

打包完成後，終端機會給一個下載連結（也可到 https://expo.dev 你的專案頁面下載），那個 `.apk` 就是要裝到手機的檔案。

---

## 六、裝到手機 + 測試

1. 把 APK 傳到 Android 手機（LINE 傳給自己 / Google Drive / USB 都行）
2. 手機點開安裝（要允許「安裝未知來源的應用程式」）
3. **兩台以上**手機都裝好、都打開
4. 依序允許**定位**與**麥克風**權限
5. 上方橫條顯示狀態與「在線 N 台」，地圖上應該看到：
   - **紅色點 = 自己**
   - **橙色點 = 其他手機**（標籤是伺服器分配的車號，如「車2」）
6. 拿一台手機走動，另一台手機上那個橙點會跟著移動 ✅
7. **點別人的橙點** → 跳出輸入框，可傳一句私訊給對方 ✅
8. 下方語音橫條顯示「語音已連線」後，**點一下開麥** → 兩台手機可直接對講 ✅

> 電腦端可開 `https://<你的ngrok網址>/voice` 當監控台：地圖看全場位置，按「加入語音」也能一起講話。

---

## 功能與架構對照

| 功能 | 怎麼運作 | 程式位置 |
|------|---------|---------|
| 即時位置 | App 用 `expo-location` 高精度追蹤，每秒/每移動 1m 回報，另有 5 秒心跳重送 | `app/App.js` |
| 精度過濾 | 超過 100m 的粗略定位點會被丟掉，避免亂飄 | `app/App.js`（`shouldAccept`） |
| 位置廣播 | Socket.IO `location` 進、`positions` 出，存記憶體 `Map` | `server/index.js` |
| 車號分配 | 依連線順序給最小可用號碼，斷線回收 | `server/index.js`（`takeNumber`） |
| 點車私訊 | 點標籤 → `dm` 事件由伺服器轉送給目標 socket | `server/index.js`、`app/App.js` |
| 即時語音 | 伺服器 `/rtk-token` 換 Cloudflare RealtimeKit token，App 用 `@cloudflare/realtimekit-react-native` 加入同一房間 | `server/index.js`、`app/App.js` |
| 地圖 | WebView 內嵌 Leaflet + CartoDB 圖磚 | `app/App.js`（`LEAFLET_HTML`） |
| 監控台 | 伺服器 `/voice` 直接吐一頁 Leaflet + RealtimeKit 的 HTML | `server/index.js` |
| 殭屍清除 | 超過 2 分鐘沒回報的裝置會被移除 | `server/index.js`（`setInterval`） |
| **定位權限修正** | **移除 WebRTC 對 `ACCESS_FINE_LOCATION` 的版本限制（見下方踩雷紀錄）** | `app/plugins/withFineLocationFix.js`（app.json plugins 已掛上） |

---

## 踩雷紀錄：`withFineLocationFix.js` 

**症狀**：Android 12+ 定位永遠 coarse（±2000m）、點不會動、設定沒有「精確位置」開關（Google 地圖卻準）。

**原因**：語音相依的 `@cloudflare/react-native-webrtc` 把 `ACCESS_FINE_LOCATION` 宣告成 `maxSdkVersion="30"`（只在 Android 11 以下有效），打包合併後把精確定位一起關掉。與 expo-location 無關，改 app.json / 重裝 / 手機設定都無效。

**解法**：`app/plugins/withFineLocationFix.js`（已掛在 app.json plugins）在打包時加 `tools:remove="android:maxSdkVersion"`，移除該限制。**升級語音套件後要保留它**，否則會被塞回來。

---

## 常見問題

| 狀況 | 原因 / 解法 |
|------|------|
| App 顯示「連不到伺服器」 | ngrok 網址填錯、或 server/ngrok 沒在跑。用瀏覽器測 ngrok 網址確認。 |
| 地圖是空白 / 灰色 | 多半是手機連不到網路、或圖磚一時載不出來。確認手機有網路後重開 App。 |
| 只看到自己、看不到別人 | 另一台手機的 App 沒開、沒給定位權限、或填的 ngrok 網址不一樣。 |
| 定位一直 ±100m 以上不準 | 手機定位模式只用網路。Android 會跳「開啟高精準度定位」對話框，請允許並到戶外。 |
| Android 12+ 定位永遠 ±2000m / coarse / 不會動 / 沒有精確位置開關 | WebRTC 套件把 `ACCESS_FINE_LOCATION` 限成 `maxSdkVersion=30`。**詳見上方「踩雷紀錄」**，需保留 `withFineLocationFix.js` 並重新打包。 |
| 語音橫條卡在「token 取得失敗」 | `server/.env` 的 Cloudflare 設定缺漏或 preset 名稱錯。不影響位置與私訊。 |
| 語音聽不到對方 | 確認雙方都點過開麥、都給了麥克風權限；用 `/voice` 監控台對照測試。 |
| ngrok 每次網址都變 | 免費版重開就換網址，換了要重填 `app/.env` 重新打包。測試期可接受。 |
| 想在戶外 4G 測 | ngrok 天生支援，手機用 4G 也連得到（這正是要驗證的真實情境）。 |

---

## 目前「還沒做」的事（之後才補）

- QR Code 掃碼報到、車號/格位綁定（企劃任務 6）— 現在車號是連線順序自動給的
- 排字羅盤導引、地理圍欄到位判定（任務 9、13）
- 背景定位前景服務、FCM 喚醒（任務 7 完整版、10）— 現在 App 要在前景開著才回報
- Deck.gl 全場 200 台渲染（任務 23）— 現在用 Leaflet，量大會吃力
- Redis / PostgreSQL 持久化（任務 3 完整版）— 現在位置/訊息只存伺服器記憶體，重開即清

主幹線（彼此看到位置 + 私訊 + 語音）已能在真實手機 + 戶外網路跑通，再逐步往企劃完整架構長。
