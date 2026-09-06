# mrd-proxy-worker

共用的 Cloudflare Worker，一個 worker 掛多個應用：

| 路由 | 方法 | 用途 | 上游 |
|---|---|---|---|
| `/` | POST | MRD AI 分析 proxy（帶通行碼或自備 API key）| Anthropic API |
| `/vd?dir=S\|N&tunnel=xueshan\|pengshan` | GET | 雪隧 / 彭山隧道內外車道即時車速、建議車道 | TDX Freeway VD |
| `/weather?dir=S\|N` | GET | 南下宜蘭 / 北上台北天氣 | CWA 開放資料 |
| `/count` | GET | 累計查詢次數（KV 累加）| — |
| `/vd-list`, `/vd-raw`, `/vd-city-list` | GET | 除錯用 | TDX |

部署在 `mrd-proxy.jjqwekimo.workers.dev`。

前端使用者：[xueshan-lane-advisor](https://github.com/ADSung903/xueshan-lane-advisor)、schedule-viewer。

## 快取策略

- `getAccessToken` — TDX token 存記憶體，到期前 60 秒重取
- `getVDData` — VD 資料記憶體快取 **30 秒**（`VD_CACHE_TTL_MS`）。TDX 的 VD 本來約 1 分鐘才更新，30 秒足夠即時
- `getWeatherData` — 天氣記憶體快取 10 分鐘
- 記憶體快取是「每個 isolate 各一份、不跨資料中心」。目前用量很小，夠用；真的成長再考慮 KV / 掛到自訂網域用 Cache API

## 本機開發

```bash
npm install
cp .dev.vars.example .dev.vars   # 填入真實值
npm run dev
```

## 部署

```bash
npm install
wrangler login

# 首次:設定 secrets（值不進 git）
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put APP_TOKEN
wrangler secret put TDX_CLIENT_ID
wrangler secret put TDX_CLIENT_SECRET
wrangler secret put CWA_API_KEY

# 首次:把 wrangler.toml 裡的 USAGE_KV namespace id 填好
wrangler kv namespace list        # 找 binding=USAGE_KV 那筆的 id

wrangler deploy
```

> ⚠️ `name = "mrd-proxy"` 對應現有線上 worker。第一次從這個 repo 部署前，先確認 secrets 和 KV id 都設好，否則會覆蓋成缺設定的版本。

## Secrets 說明

| 名稱 | 用途 | 來源 |
|---|---|---|
| `ANTHROPIC_API_KEY` | MRD 分析 | console.anthropic.com |
| `APP_TOKEN` | 團隊通行碼 | 自訂 |
| `TDX_CLIENT_ID` / `TDX_CLIENT_SECRET` | TDX API 認證 | tdx.transportdata.tw 會員中心 |
| `CWA_API_KEY` | 氣象資料授權碼 | opendata.cwa.gov.tw |
