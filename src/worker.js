// ============================================================
// MRD Proxy Worker — 團隊通行碼模式 + 雪隧選道 /vd 路由
// ============================================================
//
// 部署前設定的 secret（在 Cloudflare Dashboard > Settings > Variables
// 用「Encrypt」加密方式新增，不要用一般 Variable）：
//   ANTHROPIC_API_KEY   ← 原本就有,MRD 分析用
//   APP_TOKEN            ← 原本就有,團隊通行碼
//   TDX_CLIENT_ID         ← 新增,TDX 平台的 Client Id
//   TDX_CLIENT_SECRET     ← 新增,TDX 平台的 Client Secret
//
// 路由：
//   POST /            → 原本的 MRD AI 分析(不用帶路徑,維持原本呼叫方式)
//   GET  /vd?dir=S|N   → 新增,雪隧內外車道即時車速
// ============================================================

// ---------- 雪隧 /vd 路由相關 ----------

// CORS 收斂:只允許正式前端網域呼叫,避免被其他網站盜連消耗TDX點數額度。
// 如果之後要開發測試,暫時改回 '*' 即可,不用逐一改每個回應。
const ALLOWED_ORIGIN = 'https://xueshan-lane-advisor.vercel.app';

const TDX_TOKEN_URL = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const TDX_VD_URL = "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/VD/Freeway?%24filter=contains(VDID%2C%27N5%27)&%24format=JSON";

// ---------- 天氣:北上顯示台北、南下顯示宜蘭,用CWA(中央氣象署)開放資料平台,跟TDX是完全不同的系統 ----------
const CWA_WEATHER_URL = 'https://opendata.cwa.gov.tw/api/v1/rest/datastore/F-C0032-001';
let weatherCache = { data: null, fetchedAt: 0 };
const WEATHER_CACHE_TTL_MS = 600000; // 天氣預報不需要即時,10分鐘快取一次就夠,不用像VD那樣頻繁

// 用中文描述文字關鍵字比對emoji,不依賴天氣代碼表(官方代碼對照頁面是圖片,抓不到文字版)
function weatherEmoji(desc){
  if(!desc) return '🌥️';
  if(desc.includes('雷')) return '⛈️';
  if(desc.includes('雨')) return '🌧️';
  if(desc.includes('霧')) return '🌫️';
  if(desc.includes('晴') && desc.includes('雲')) return '🌤️';
  if(desc.includes('晴')) return '☀️';
  if(desc.includes('雲')) return '⛅';
  if(desc.includes('陰')) return '☁️';
  return '🌥️';
}

async function getWeatherData(env){
  const now = Date.now();
  if(weatherCache.data && now - weatherCache.fetchedAt < WEATHER_CACHE_TTL_MS) return weatherCache.data;

  const url = `${CWA_WEATHER_URL}?Authorization=${env.CWA_API_KEY}&format=JSON`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('CWA weather fetch failed: ' + res.status);

  const data = await res.json();
  weatherCache.data = data.records.location;
  weatherCache.fetchedAt = now;
  return weatherCache.data;
}

function extractCountyWeather(locations, countyName){
  const loc = locations.find(l => l.locationName === countyName);
  if(!loc) return null;

  const els = {};
  loc.weatherElement.forEach(e => { els[e.elementName] = e.time[0].parameter; });

  const desc = els.Wx ? els.Wx.parameterName : null;
  return {
    desc,
    emoji: weatherEmoji(desc),
    maxT: els.MaxT ? els.MaxT.parameterName : null,
    minT: els.MinT ? els.MinT.parameterName : null,
    pop: els.PoP ? els.PoP.parameterName : null
  };
}

async function handleWeatherRequest(request, env){
  try{
    if(!env.CWA_API_KEY){
      return new Response(JSON.stringify({ error: 'CWA_API_KEY 尚未綁定' }), {
        status: 500,
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': ALLOWED_ORIGIN }
      });
    }

    const url = new URL(request.url);
    const dir = url.searchParams.get('dir') === 'N' ? 'N' : 'S';
    const county = dir === 'N' ? '臺北市' : '宜蘭縣';
    const cityLabel = dir === 'N' ? '台北' : '宜蘭';

    const locations = await getWeatherData(env);
    const weather = extractCountyWeather(locations, county);

    return new Response(JSON.stringify({ dir, city: cityLabel, weather, updatedAt: new Date().toISOString() }), {
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': ALLOWED_ORIGIN, 'cache-control': 'no-store' }
    });
  }catch(e){
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': ALLOWED_ORIGIN }
    });
  }
}

let tokenCache = { token: null, expiresAt: 0 };
let vdCache = { data: null, fetchedAt: 0 };
const VD_CACHE_TTL_MS = 30000; // TDX 的 VD 資料本來約 1 分鐘才更新一次,30 秒快取足夠即時,又能把上游呼叫砍半

const TUNNELS = {
  xueshan: {
    name: '雪山隧道',
    // 隧道本體約15.5K~28.2K,依南下真實站點清單(20個站點)重新計算,
    // 找出跟「理想均分點」最接近的真實站點,比原本的分布更均勻(原本最後一段只有1.53K,明顯偏短)
    checkpoints: [15.478, 18.312, 20.413, 23.207, 26.013, 28.236],
    // 12段「詳細」版本,呼應1968官網「1KM」切法的精細度,同樣取自已驗證過的真實南下站點清單,
    // 從20個站點裡挑12個(索引0,2,3,5,6,8,9,11,13,15,17,19),間距約0.7~1.5K
    detailCheckpoints: [15.478, 16.902, 17.608, 19.013, 19.677, 21.063, 21.807, 23.207, 24.678, 26.013, 27.442, 28.236]
  },
  pengshan: {
    name: '彭山隧道',
    // 依高公局樁號資料換算約落在8.7K~11.9K,4個代表點(尚未像雪隧一樣完整驗證站點密度)
    // 尚未驗證到能支援12段的密度,「詳細」模式沿用同一組4點,不額外細分
    checkpoints: [8.686, 9.840, 10.845, 11.903],
    detailCheckpoints: [8.686, 9.840, 10.845, 11.903]
  }
};

function getTravelOrderCheckpoints(checkpoints, dir) {
  // 南下里程遞增前進,北上則是從高里程往低里程開,顯示順序要反過來
  return dir === 'S' ? checkpoints.slice() : checkpoints.slice().reverse();
}

async function getAccessToken(env) {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt) return tokenCache.token;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.TDX_CLIENT_ID,
    client_secret: env.TDX_CLIENT_SECRET
  }).toString();

  const res = await fetch(TDX_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) throw new Error('TDX auth failed: ' + res.status);

  const data = await res.json();
  tokenCache.token = data.access_token;
  tokenCache.expiresAt = now + (data.expires_in - 60) * 1000;
  return tokenCache.token;
}

async function getVDData(env) {
  const now = Date.now();
  if (vdCache.data && now - vdCache.fetchedAt < VD_CACHE_TTL_MS) return vdCache.data;

  const token = await getAccessToken(env);
  const res = await fetch(TDX_VD_URL, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (res.status === 401) {
    tokenCache.token = null;
    return getVDData(env);
  }
  if (!res.ok) throw new Error('TDX VD fetch failed: ' + res.status);

  const data = await res.json();
  vdCache.data = data.VDLives || [];
  vdCache.fetchedAt = now;
  return vdCache.data;
}

function pickNearestVD(vds, dir, targetMile) {
  const list = vds
    .map(vd => {
      const m = vd.VDID.match(/-(\d+\.\d+)-/);
      return {
        ...vd,
        extractedMile: m ? parseFloat(m[1]) : null,
        isCorrectDir: vd.VDID.includes(`-N5-${dir}-`)
      };
    })
    .filter(vd => vd.isCorrectDir && vd.extractedMile !== null && vd.LinkFlows && vd.LinkFlows.length);

  if (list.length === 0) return null;

  return list.sort(
    (a, b) => Math.abs(a.extractedMile - targetMile) - Math.abs(b.extractedMile - targetMile)
  )[0];
}

function extractLanes(vd) {
  if (!vd) return null;

  // Status是VD整顆感測器層級的官方狀態欄位,0=正常;非0代表這顆感測器本身異常,整組資料都不採用
  if (vd.Status !== 0) {
    return { vdid: vd.VDID, mile: vd.extractedMile, dataTime: vd.DataCollectTime, inner: null, outer: null };
  }

  const lanes = vd.LinkFlows[0].Lanes || [];
  const l0 = lanes.find(l => l.LaneID == 0);
  const l1 = lanes.find(l => l.LaneID == 1);

  function cleanLane(l) {
    if (!l) return null;
    // ErrorType是逐車道的官方診斷碼,diag0=正常;其他代碼代表這個車道的讀值不可信,先保守排除
    if (l.ErrorType && l.ErrorType !== 'diag0') return null;
    // 備援判斷:即使診斷碼顯示正常,車速與佔有率同時為0仍可能是沒偵測到車輛,一併排除
    if (l.Speed === 0 && l.Occupancy === 0) return null;

    const volume = (l.Vehicles || []).reduce((sum, v) => sum + (v.Volume || 0), 0);
    return { speed: l.Speed, occupancy: l.Occupancy, volume };
  }

  return {
    vdid: vd.VDID,
    mile: vd.extractedMile,
    dataTime: vd.DataCollectTime,
    inner: cleanLane(l0),
    outer: cleanLane(l1)
  };
}

// ---------- 除錯用:列出雪隧範圍內所有 VD 站點 ----------
async function handleVDListRequest(request, env) {
  try {
    const url = new URL(request.url);
    const dir = url.searchParams.get('dir') === 'N' ? 'N' : 'S';

    const vds = await getVDData(env);
    const list = vds
      .map(vd => {
        const m = vd.VDID.match(/-(\d+\.\d+)-/);
        return {
          vdid: vd.VDID,
          mile: m ? parseFloat(m[1]) : null,
          isCorrectDir: vd.VDID.includes(`-N5-${dir}-`),
          hasLanes: !!(vd.LinkFlows && vd.LinkFlows.length)
        };
      })
      .filter(vd => vd.isCorrectDir && vd.mile !== null)
      .sort((a, b) => a.mile - b.mile);

    return new Response(JSON.stringify({ dir, count: list.length, stations: list }, null, 2), {
      headers: {
        'content-type': 'application/json',
        'access-control-allow-origin': ALLOWED_ORIGIN
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': ALLOWED_ORIGIN }
    });
  }
}

function laneScore(lane){
  if(!lane) return null;
  return lane.speed * (1 - lane.occupancy/100);
}

function aggregateLaneScore(segments, laneKey){
  const scores = segments.map(s => laneScore(s[laneKey])).filter(v => v !== null);
  if(!scores.length) return null;

  const avg = scores.reduce((a,b) => a+b, 0) / scores.length;
  const min = Math.min(...scores);

  // 混合權重:平均分數跟最低段(瓶頸)各佔一半。
  // 純平均會把塞車的瓶頸段稀釋掉(比如90/90/60/80平均起來還是高分,但實際上會被60那段卡住);
  // 混合最低段之後,瓶頸段的影響會被適度放大,但又不會像「純粹只看最低段」那樣,
  // 一顆感測器異常就整個判斷跟著跑掉,兩者各退一步取得平衡。
  return avg * 0.5 + min * 0.5;
}

// ---------- 探索用:查詢省道等級(縣市分組)VD清單,評估蘇花改/南迴改是否可行 ----------
// 蘇花改、南迴改是公路局管轄的省道快速公路,不在高公局的Freeway API底下,
// 要透過縣市分組的VD API來查,路段代碼、資料細緻度都還未知,先探索用
async function handleVDCityListRequest(request, env) {
  try {
    const url = new URL(request.url);
    const city = url.searchParams.get('city');
    if (!city) {
      return new Response(JSON.stringify({
        error: 'city 參數必填,例如 ?city=宜蘭縣 或 ?city=花蓮縣 或 ?city=臺東縣'
      }), {
        status: 400,
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': ALLOWED_ORIGIN }
      });
    }
    const keyword = url.searchParams.get('keyword') || '';

    const token = await getAccessToken(env);
    const apiUrl = `https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/VD/City/${encodeURIComponent(city)}?%24format=JSON`;
    const res = await fetch(apiUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('TDX City VD fetch failed: ' + res.status);

    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.VDs || data.VDList || []);

    const filtered = keyword
      ? list.filter(v => JSON.stringify(v).includes(keyword))
      : list;

    // 只回傳精簡欄位方便閱讀,避免整包塞爆瀏覽器
    const sample = filtered.slice(0, 150).map(v => ({
      vdid: v.VDID,
      roadName: v.RoadName || v.RoadID || null,
      linkDesc: v.LinkDescription || null,
      lon: v.PositionLon, lat: v.PositionLat,
      laneCount: (v.DetectionLinks && v.DetectionLinks[0] && v.DetectionLinks[0].LaneNum) || null
    }));

    return new Response(JSON.stringify({
      city, keyword,
      totalInCity: list.length,
      matched: filtered.length,
      sample
    }, null, 2), {
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': ALLOWED_ORIGIN }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': ALLOWED_ORIGIN }
    });
  }
}

// ---------- 除錯用:直接吐出單一站點的完整原始資料,不篩選任何欄位 ----------
// 用來確認 TDX 實際回傳裡有沒有 Volume / Status / DataCollectTime 這些我們還沒用過的欄位
// ---------- 使用查詢次數:用KV累加,只有前端「真正打開頁面」時才呼叫,不是每次60秒自動更新都算 ----------
async function handleCountRequest(request, env) {
  try {
    if (!env.USAGE_KV) {
      return new Response(JSON.stringify({ error: 'USAGE_KV 尚未綁定' }), {
        status: 500,
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': ALLOWED_ORIGIN }
      });
    }

    const current = await env.USAGE_KV.get('usage_count');
    const next = (parseInt(current || '0', 10) || 0) + 1;
    await env.USAGE_KV.put('usage_count', String(next));

    return new Response(JSON.stringify({ count: next }), {
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': ALLOWED_ORIGIN, 'cache-control': 'no-store' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': ALLOWED_ORIGIN }
    });
  }
}

async function handleVDRawRequest(request, env) {
  try {
    const url = new URL(request.url);
    const dir = url.searchParams.get('dir') === 'N' ? 'N' : 'S';
    const mile = parseFloat(url.searchParams.get('mile') || '17.608');

    const vds = await getVDData(env);
    const vd = pickNearestVD(vds, dir, mile);

    if (!vd) {
      return new Response(JSON.stringify({ error: '找不到符合的站點' }), {
        status: 404,
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': ALLOWED_ORIGIN }
      });
    }

    return new Response(JSON.stringify(vd, null, 2), {
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': ALLOWED_ORIGIN }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': ALLOWED_ORIGIN }
    });
  }
}

async function handleVDRequest(request, env) {
  try {
    const url = new URL(request.url);
    const dir = url.searchParams.get('dir') === 'N' ? 'N' : 'S';
    const tunnelId = TUNNELS[url.searchParams.get('tunnel')] ? url.searchParams.get('tunnel') : 'xueshan';
    const tunnel = TUNNELS[tunnelId];

    const vds = await getVDData(env);

    function buildSegments(checkpoints){
      const order = getTravelOrderCheckpoints(checkpoints, dir);
      return order.map((targetMile, idx) => {
        const vd = pickNearestVD(vds, dir, targetMile);
        const lanes = extractLanes(vd);
        return {
          seq: idx + 1,
          target: targetMile,
          vdid: lanes ? lanes.vdid : null,
          mile: lanes ? lanes.mile : null,
          inner: lanes ? lanes.inner : null,
          outer: lanes ? lanes.outer : null
        };
      });
    }

    const segments = buildSegments(tunnel.checkpoints);             // 預設6段,畫面精簡
    const segmentsDetail = buildSegments(tunnel.detailCheckpoints);  // 詳細12段,點「詳細」才顯示

    // 建議車道的決策,一律用「詳細」那組更精細的資料計算,兩種顯示模式呈現同一個建議結果,
    // 不會因為使用者切換6段/12段檢視,就看到建議車道自己反覆橫跳
    const innerAvg = aggregateLaneScore(segmentsDetail, 'inner');
    const outerAvgRaw = aggregateLaneScore(segmentsDetail, 'outer');
    // 外側微幅懲罰,同單點版邏輯,避免兩者平均分數太接近時建議一直來回跳動
    const outerAvg = outerAvgRaw !== null ? outerAvgRaw - 3 : null;

    let recommendation = null;
    if(innerAvg !== null && outerAvg !== null){
      recommendation = innerAvg >= outerAvg ? 'inner' : 'outer';
    }

    const payload = {
      tunnel: tunnelId,
      tunnelName: tunnel.name,
      dir,
      segments,                // 預設6段,依實際行車方向排序
      segmentsDetail,          // 詳細12段,同上排序
      innerAvg, outerAvg: outerAvgRaw,
      recommendation,          // 'inner' | 'outer' | null,依全程(詳細版)平均分數決定
      updatedAt: new Date().toISOString()
    };

    return new Response(JSON.stringify(payload), {
      headers: {
        'content-type': 'application/json',
        'access-control-allow-origin': ALLOWED_ORIGIN,
        'cache-control': 'no-store'
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: {
        'content-type': 'application/json',
        'access-control-allow-origin': ALLOWED_ORIGIN
      }
    });
  }
}

// ---------- 原本的 MRD Proxy 相關 ----------

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ---- 新增:雪隧選道路由,GET 請求,獨立於下面的 MRD 邏輯之外 ----
    if (url.pathname === '/vd') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
      return handleVDRequest(request, env);
    }
    if (url.pathname === '/vd-list') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
      return handleVDListRequest(request, env);
    }
    if (url.pathname === '/vd-city-list') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
      return handleVDCityListRequest(request, env);
    }
    if (url.pathname === '/vd-raw') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
      return handleVDRawRequest(request, env);
    }
    if (url.pathname === '/count') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
      return handleCountRequest(request, env);
    }
    if (url.pathname === '/weather') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
      return handleWeatherRequest(request, env);
    }

    // ---- 以下維持原本的 MRD Proxy 邏輯,完全沒有更動 ----
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    try {
      const { prompt, apiKey, appToken } = await request.json();
      if (!prompt) return json({ error: { message: 'Missing prompt' } }, 400);

      let useKey = null;
      if (apiKey && apiKey.startsWith('sk-ant-')) {
        useKey = apiKey;
      } else if (appToken && env.APP_TOKEN && appToken === env.APP_TOKEN) {
        useKey = env.ANTHROPIC_API_KEY;
      }
      if (!useKey) {
        return json({ error: { message: '通行碼錯誤或未提供憑證（AUTH_REQUIRED）', code: 'AUTH_REQUIRED' } }, 401);
      }

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': useKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 4000,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      const data = await response.json();
      return json(data, response.status);
    } catch (err) {
      return json({ error: { message: err.message } }, 500);
    }
  },
};
