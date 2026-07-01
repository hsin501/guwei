// Config plugin：移除 react-native-webrtc（語音相依）幫 ACCESS_FINE_LOCATION
// 加上的 android:maxSdkVersion="30"。沒移除的話，精確位置權限只在 Android 11 以下有效，
// Android 12+ 會被當成沒宣告 FINE → 定位只剩 coarse（±2000m、無精確開關）。
// 用 tools:remove 指示 manifest 合併器移除該屬性。
const { withAndroidManifest } = require("@expo/config-plugins");

module.exports = function withFineLocationFix(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest.$["xmlns:tools"] = "http://schemas.android.com/tools";
    manifest["uses-permission"] = manifest["uses-permission"] || [];
    let fine = manifest["uses-permission"].find(
      (p) => p.$ && p.$["android:name"] === "android.permission.ACCESS_FINE_LOCATION"
    );
    if (!fine) {
      fine = { $: { "android:name": "android.permission.ACCESS_FINE_LOCATION" } };
      manifest["uses-permission"].push(fine);
    }
    delete fine.$["android:maxSdkVersion"];
    fine.$["tools:remove"] = "android:maxSdkVersion";
    return cfg;
  });
};
