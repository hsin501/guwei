// ⚙️ 設定值改放在 app/.env（不會被提交到 git）。這支檔案只負責讀出來用。

// 1) ngrok 對外網址：請在 app/.env 設定 EXPO_PUBLIC_SERVER_URL
//    （複製 app/.env.example 成 app/.env 再填，https 開頭、結尾不要斜線）
//    EXPO_PUBLIC_ 前綴是 Expo 規定：有這個前綴才會被打包進 App。
export const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL ?? "";

// 2) 你在這台手機上顯示的名字（目前車號由伺服器自動分配，此值暫未使用）
export const MY_NAME = "車A";
