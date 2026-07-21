(() => {
"use strict";

const STORAGE_KEY = "pbt_sessions_v1";
const AUTH_KEY = "pbt_auth_token";
const API_URL = "/api/sessions";
const VB_W = 300, VB_H = 150;
const PAD = { l: 8, r: 8, t: 14, b: 10 };

let sessions = loadSessions();
let activeTab = "overview";
let editingId = null;
let lastDeleted = null;
let toastTimer = null;
let chartsDurationMetric = "profit";
let trendsRange = "max";
let trendsVisible = { cash: true, tourn: true, total: true };

// ---------- storage ----------
function loadSessions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}
function saveSessions() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  syncToServer();
}
function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2));
}

// ---------- cross-device sync ----------
function getAuthToken() {
  let t = localStorage.getItem(AUTH_KEY);
  if (!t) {
    t = prompt("请输入写入密码(同步到其他设备需要):") || "";
    if (t) localStorage.setItem(AUTH_KEY, t);
  }
  return t;
}
let syncInFlight = null;
function syncToServer() {
  const token = getAuthToken();
  if (!token) return;
  const payload = JSON.stringify(sessions);
  syncInFlight = fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: payload,
  }).then(res => {
    if (res.status === 401) {
      localStorage.removeItem(AUTH_KEY);
      showToast("密码错误,数据仅保存在本机,请重新保存以同步");
      return false;
    }
    if (!res.ok) { showToast("同步失败,数据已保存在本机"); return false; }
    return true;
  }).catch(() => {
    showToast("网络异常,数据已保存在本机");
    return false;
  });
  return syncInFlight;
}
async function syncFromServer() {
  try {
    const res = await fetch(API_URL);
    if (!res.ok) return;
    const serverData = await res.json();
    if (!Array.isArray(serverData)) return;
    if (serverData.length > 0) {
      sessions = serverData.map(s => ({
        id: s.id, date: s.date, gameType: s.gameType, game: s.game || "", stakes: s.stakes, location: s.location,
        startTime: s.startTime, endTime: s.endTime, buyIn: s.buyIn, rebuy: s.rebuy,
        cashOut: s.cashOut, expenses: s.expenses, notes: s.notes,
        bigBlind: s.bigBlind || 0, place: s.place || 0, bounties: s.bounties || 0, players: s.players || 0,
      }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
      renderView();
    } else if (sessions.length > 0) {
      syncToServer();
    }
  } catch (e) { /* offline: keep local cache */ }
}

// ---------- domain math ----------
function toDate(dateStr, timeStr) {
  return new Date(dateStr + "T" + (timeStr || "00:00") + ":00");
}
function computeMetrics(s) {
  const buyIn = +s.buyIn || 0, rebuy = +s.rebuy || 0, cashOut = +s.cashOut || 0;
  const profit = cashOut - buyIn - rebuy;
  const atRisk = buyIn + rebuy;
  const roi = atRisk > 0 ? (profit / atRisk) * 100 : null;
  let durationMin = 0;
  if (s.startTime && s.endTime) {
    const start = toDate(s.date, s.startTime);
    let end = toDate(s.date, s.endTime);
    if (end <= start) end = new Date(end.getTime() + 24 * 3600 * 1000);
    durationMin = (end - start) / 60000;
  }
  const durationHr = durationMin / 60;
  const hourly = durationHr > 0 ? profit / durationHr : null;
  return { profit, atRisk, roi, durationMin, durationHr, hourly };
}
function sortKey(s) { return s.date + "T" + (s.startTime || "00:00"); }
function sortedAsc() { return [...sessions].sort((a, b) => sortKey(a) < sortKey(b) ? -1 : 1); }
function sortedDesc() { return [...sessions].sort((a, b) => sortKey(a) > sortKey(b) ? -1 : 1); }

function aggregate(list) {
  list = list || sessions;
  if (!list.length) return null;
  let totalProfit = 0, totalAtRisk = 0, totalHr = 0, wins = 0;
  list.forEach(s => {
    const m = computeMetrics(s);
    totalProfit += m.profit;
    totalAtRisk += m.atRisk;
    totalHr += m.durationHr;
    if (m.profit > 0) wins++;
  });
  return {
    totalProfit,
    count: list.length,
    totalHr,
    avgHourly: totalHr > 0 ? totalProfit / totalHr : null,
    roi: totalAtRisk > 0 ? (totalProfit / totalAtRisk) * 100 : null,
    winRate: (wins / list.length) * 100,
  };
}

function monthKey(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); }

function computeMonthCompare() {
  const now = new Date();
  const thisMonth = monthKey(now);
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonth = monthKey(lastMonthDate);
  const thisList = sessions.filter(s => s.date && s.date.startsWith(thisMonth));
  const lastList = sessions.filter(s => s.date && s.date.startsWith(lastMonth));
  if (!thisList.length && !lastList.length) return null;
  return { thisAgg: aggregate(thisList), lastAgg: aggregate(lastList) };
}

function computeTrendWindow(days) {
  const now = new Date();
  const start = new Date(now.getTime() - days * 24 * 3600 * 1000);
  const startStr = start.getFullYear() + "-" + String(start.getMonth() + 1).padStart(2, "0") + "-" + String(start.getDate()).padStart(2, "0");
  const list = sessions.filter(s => s.date && s.date >= startStr).sort((a, b) => sortKey(a) < sortKey(b) ? -1 : 1);
  if (!list.length) return null;
  return { list, agg: aggregate(list) };
}

const TREND_RANGES = [
  { key: "1w", label: "1周" },
  { key: "1m", label: "1月" },
  { key: "3m", label: "3月" },
  { key: "ytd", label: "YTD" },
  { key: "1y", label: "1年" },
  { key: "3y", label: "3年" },
  { key: "max", label: "最大" },
];
const TREND_SERIES_META = [
  { key: "cash", label: "现金游戏", color: "var(--series-1)" },
  { key: "tourn", label: "锦标赛", color: "var(--series-4)" },
  { key: "total", label: "总计", color: "var(--text-primary)" },
];

function computeTrendSeries(range) {
  const list = sortedAsc();
  if (!list.length) return null;
  let totalCum = 0, cashCum = 0, tournCum = 0;
  const points = list.map(s => {
    const m = computeMetrics(s);
    if (isTournamentType(s.gameType)) tournCum += m.profit; else cashCum += m.profit;
    totalCum += m.profit;
    return { date: s.date, label: s.date, total: totalCum, cash: cashCum, tourn: tournCum };
  });
  const first = points[0];
  const full = [{ date: first.date, label: first.label, total: 0, cash: 0, tourn: 0 }, ...points];

  let cutoff = null;
  const now = new Date();
  if (range === "1w") cutoff = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  else if (range === "1m") cutoff = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  else if (range === "3m") cutoff = new Date(now.getTime() - 90 * 24 * 3600 * 1000);
  else if (range === "ytd") cutoff = new Date(now.getFullYear(), 0, 1);
  else if (range === "1y") cutoff = new Date(now.getTime() - 365 * 24 * 3600 * 1000);
  else if (range === "3y") cutoff = new Date(now.getTime() - 3 * 365 * 24 * 3600 * 1000);

  if (!cutoff) return full;
  const cutoffStr = cutoff.getFullYear() + "-" + String(cutoff.getMonth() + 1).padStart(2, "0") + "-" + String(cutoff.getDate()).padStart(2, "0");
  let idx = full.findIndex(p => p.date >= cutoffStr);
  if (idx === -1) idx = full.length - 1;
  const sliced = full.slice(Math.max(0, idx - 1));
  return sliced.length >= 2 ? sliced : full.slice(-2);
}

function isTournamentType(gameType) { return /锦标|tournament|mtt|sng|sit.?n.?go/i.test(gameType || ""); }

function summarizeGroup(list) {
  let buyIn = 0, rebuy = 0, cashOutRaw = 0, profit = 0, hours = 0, wins = 0;
  let bbProfitSum = 0, bbHours = 0;
  list.forEach(s => {
    const m = computeMetrics(s);
    buyIn += +s.buyIn || 0;
    rebuy += +s.rebuy || 0;
    cashOutRaw += (+s.cashOut || 0);
    profit += m.profit;
    hours += m.durationHr;
    if (m.profit > 0) wins++;
    if (+s.bigBlind > 0) { bbProfitSum += m.profit / (+s.bigBlind); bbHours += m.durationHr; }
  });
  const count = list.length;
  const totalBuyIn = buyIn + rebuy;
  return {
    count, hours, totalBuyIn, cashOutRaw, profit, rebuy,
    hourly: hours > 0 ? profit / hours : null,
    bbHourly: bbHours > 0 ? bbProfitSum / bbHours : null,
    roi: totalBuyIn > 0 ? (profit / totalBuyIn) * 100 : null,
    winRate: count > 0 ? (wins / count) * 100 : 0,
    avgBuyIn: count > 0 ? totalBuyIn / count : 0,
    avgProfit: count > 0 ? profit / count : 0,
    avgRebuy: count > 0 ? rebuy / count : 0,
  };
}

function computeTypeBreakdown() {
  const cashList = [], tournList = [];
  sessions.forEach(s => (isTournamentType(s.gameType) ? tournList : cashList).push(s));
  return { cash: summarizeGroup(cashList), tournament: summarizeGroup(tournList), total: summarizeGroup(sessions) };
}

function computeTournamentDetail() {
  const list = sessions.filter(s => isTournamentType(s.gameType));
  if (!list.length) return null;
  let bounties = 0, itm = 0, runnerUp = 0, wins = 0, finalTable = 0;
  list.forEach(s => {
    bounties += +s.bounties || 0;
    const rawCashout = (+s.cashOut || 0) - (+s.bounties || 0);
    if (rawCashout > 0) itm++;
    if (+s.place === 2) runnerUp++;
    if (+s.place === 1) wins++;
    if (+s.place > 0 && +s.place <= 9 && +s.players > 9) finalTable++;
  });
  const count = list.length;
  return {
    count, bounties,
    itm, itmPct: (itm / count) * 100,
    finalTable, finalTablePct: (finalTable / count) * 100,
    runnerUp, runnerUpPct: (runnerUp / count) * 100,
    wins, winsPct: (wins / count) * 100,
  };
}

function computeGameBreakdown() {
  const map = new Map();
  sessions.forEach(s => {
    const key = (s.stakes || s.gameType || "未分类").trim() || "未分类";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(s);
  });
  const rows = [...map.entries()].map(([name, list]) => ({ name, ...summarizeGroup(list) }));
  rows.sort((a, b) => b.hours - a.hours);
  return rows;
}

function extractVenueType(list) {
  for (const s of list) {
    const m = /场地类型:\s*(\S+)/.exec(s.notes || "");
    if (m) return m[1];
  }
  return "";
}

const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
function computeWeekdayBreakdown() {
  const buckets = Array.from({ length: 7 }, () => []);
  sessions.forEach(s => {
    const jsDay = new Date(s.date + "T00:00:00").getDay();
    const idx = (jsDay + 6) % 7;
    buckets[idx].push(s);
  });
  return WEEKDAY_LABELS.map((label, i) => ({ label, ...summarizeGroup(buckets[i]) }));
}

const MONTH_LABELS = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];
function computeMonthBreakdown() {
  const buckets = Array.from({ length: 12 }, () => []);
  sessions.forEach(s => {
    const idx = parseInt(s.date.slice(5, 7), 10) - 1;
    if (idx >= 0 && idx < 12) buckets[idx].push(s);
  });
  return MONTH_LABELS.map((label, i) => ({ label, ...summarizeGroup(buckets[i]) }));
}

function computeYearBreakdown() {
  const map = new Map();
  sessions.forEach(s => {
    const year = s.date.slice(0, 4);
    if (!map.has(year)) map.set(year, []);
    map.get(year).push(s);
  });
  return [...map.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([label, list]) => ({ label, ...summarizeGroup(list) }));
}

function computeDurationBuckets(list) {
  const buckets = new Map();
  list.forEach(s => {
    const m = computeMetrics(s);
    if (!s.startTime || !s.endTime) return;
    let idx = Math.floor(m.durationHr);
    if (idx > 10) idx = 10;
    if (idx < 0) idx = 0;
    if (!buckets.has(idx)) buckets.set(idx, []);
    buckets.get(idx).push(s);
  });
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([idx, list]) => ({
    label: idx === 10 ? "10h+" : `${idx}-${idx + 1}h`,
    ...summarizeGroup(list),
  }));
}

function computeLocationBreakdown() {
  const map = new Map();
  sessions.forEach(s => {
    const key = (s.location || "未知地点").trim() || "未知地点";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(s);
  });
  const rows = [...map.entries()].map(([name, list]) => ({ name, venueType: extractVenueType(list), ...summarizeGroup(list) }));
  rows.sort((a, b) => b.profit - a.profit);
  return rows;
}

// ---------- formatting ----------
function money(v) {
  const sign = v < 0 ? "-" : "";
  return sign + "$" + Math.round(Math.abs(v)).toLocaleString("zh-CN");
}
function moneySigned(v) { return (v > 0 ? "+" : "") + money(v); }
function pct(v) { if (v == null) return "--"; return (v > 0 ? "+" : "") + v.toFixed(1) + "%"; }
function fmtHours(hr) {
  if (hr == null || !isFinite(hr)) return "--";
  const h = Math.floor(hr);
  const m = Math.round((hr - h) * 60);
  return h + "h" + (m ? m + "m" : "");
}
function fmtDate(d) {
  const [y, m, day] = d.split("-");
  return `${m}/${day}`;
}
function fmtDateFull(d) {
  const [y, m, day] = d.split("-");
  return `${y}年${m}月${day}日`;
}
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
function fmtDateWeekday(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return `${WEEKDAYS[d.getDay()]}, ${d.getMonth() + 1}月${d.getDate()}, ${d.getFullYear()}`;
}

function buildDonutSVG(segments, bigText, smallText) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  const r = 40, circ = 2 * Math.PI * r;
  let offset = 0;
  const arcs = segments.map(seg => {
    const len = (seg.value / total) * circ;
    const arc = `<circle cx="50" cy="50" r="${r}" fill="none" stroke="${seg.color}" stroke-width="14" stroke-dasharray="${len.toFixed(2)} ${circ.toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 50 50)"/>`;
    offset += len;
    return arc;
  }).join("");
  return `<svg viewBox="0 0 100 100" width="128" height="128">
    <circle cx="50" cy="50" r="${r}" fill="none" stroke="var(--grid)" stroke-width="14"/>
    ${arcs}
    <text x="50" y="47" text-anchor="middle" font-size="19" font-weight="700" fill="var(--text-primary)">${bigText}</text>
    <text x="50" y="61" text-anchor="middle" font-size="9" fill="var(--text-muted)">${smallText}</text>
  </svg>`;
}

function buildGroupBarHTML(items, metric) {
  metric = metric || "profit";
  const W = 300, H = 190, padSide = 6, padTop = 24, padBottom = 24;
  const innerW = W - padSide * 2, innerH = H - padTop - padBottom;
  const values = items.map(it => metricValue(it, metric));
  const maxAbs = Math.max(...values.map(v => Math.abs(v)), 1);
  const zeroY = padTop + innerH / 2;
  const halfH = innerH / 2;
  const n = items.length;
  const slot = innerW / n;
  const barW = Math.min(slot * 0.62, 34);

  let bars = `<line x1="${padSide}" y1="${zeroY.toFixed(2)}" x2="${W - padSide}" y2="${zeroY.toFixed(2)}" stroke="var(--baseline)" stroke-width="1"/>`;
  items.forEach((it, i) => {
    const v = values[i];
    const cx = padSide + slot * i + slot / 2;
    const x = cx - barW / 2;
    const h = Math.max((Math.abs(v) / maxAbs) * halfH, 2);
    const positive = v >= 0;
    const y = positive ? zeroY - h : zeroY;
    const color = positive ? "var(--good)" : "var(--critical)";
    const r = Math.min(4, barW / 2, h / 2);
    bars += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(2)}" height="${h.toFixed(2)}" rx="${r.toFixed(2)}" fill="${color}"/>`;
    const labelY = positive ? y - 6 : y + h + 6;
    bars += `<text x="${cx.toFixed(2)}" y="${labelY.toFixed(2)}" font-size="9" font-weight="600" fill="var(--text-primary)" text-anchor="middle" transform="rotate(-90 ${cx.toFixed(2)} ${labelY.toFixed(2)})">${metricFormat(v, metric)}</text>`;
  });

  return `
    <svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}</svg>
    <div style="display:flex;font-size:11px;color:var(--text-muted);padding:2px 4px 0">
      ${items.map(it => `<span style="flex:1;text-align:center">${it.label}</span>`).join("")}
    </div>`;
}

const METRIC_OPTIONS = [
  { key: "profit", label: "利润", icon: "$" },
  { key: "hourly", label: "HOURLY", icon: "⏱" },
  { key: "roi", label: "ROI", icon: "%" },
];
function metricValue(row, metric) {
  if (metric === "hourly") return row.hourly ?? 0;
  if (metric === "roi") return row.roi ?? 0;
  if (metric === "count") return row.count;
  return row.profit;
}
function metricFormat(v, metric) {
  if (metric === "count") return String(v);
  if (metric === "roi") return pct(v);
  if (metric === "hourly") return moneySigned(v) + "/h";
  return moneySigned(v);
}
function renderMetricToggleHTML() {
  return `
    <div class="metric-toggle">
      ${METRIC_OPTIONS.map(o => `<button class="metric-toggle-btn${chartsDurationMetric === o.key ? " active" : ""}" data-metric="${o.key}">${o.icon} ${o.label}</button>`).join("")}
    </div>`;
}
function renderDurationSectionHTML(title, rows, metric) {
  if (!rows.length) return "";
  const maxAbs = Math.max(...rows.map(r => Math.abs(metricValue(r, metric))), 1);
  return `
    <div class="chart-card">
      <h3 style="text-align:center">${title}</h3>
      ${rows.map(r => {
        const v = metricValue(r, metric);
        const pctW = Math.min(100, (Math.abs(v) / maxAbs) * 100);
        const isCount = metric === "count";
        const barColor = isCount ? "var(--series-1)" : (v >= 0 ? "var(--good)" : "var(--critical)");
        const valColor = isCount ? "var(--text-primary)" : (v >= 0 ? "var(--good-text)" : "var(--critical)");
        return `
          <div class="dur-row">
            <div class="dur-top">
              <span class="dur-label">${r.label} · ${r.count}对局</span>
              <span class="dur-value" style="color:${valColor}">${metricFormat(v, metric)}</span>
            </div>
            <div class="dur-track"><div class="dur-fill" style="width:${pctW.toFixed(1)}%;background:${barColor}"></div></div>
          </div>`;
      }).join("")}
    </div>`;
}

function renderCharts() {
  if (!sessions.length) {
    view.innerHTML = `
      <div class="empty-state">
        <div class="big">🃏</div>
        <p>还没有任何记录</p>
        <p>点右下角 + 记一局吧</p>
      </div>`;
    return;
  }
  const cashList = sessions.filter(s => !isTournamentType(s.gameType));
  const tournList = sessions.filter(s => isTournamentType(s.gameType));
  view.innerHTML = `
    <div class="chart-card">
      <h3 style="text-align:center">工作日</h3>
      ${buildGroupBarHTML(computeWeekdayBreakdown(), chartsDurationMetric)}
    </div>
    <div class="chart-card">
      <h3 style="text-align:center">月份</h3>
      ${buildGroupBarHTML(computeMonthBreakdown(), chartsDurationMetric)}
    </div>
    <div class="chart-card">
      <h3 style="text-align:center">年份</h3>
      ${buildGroupBarHTML(computeYearBreakdown(), chartsDurationMetric)}
    </div>
    ${renderDurationSectionHTML("CG 会话时长", computeDurationBuckets(cashList), chartsDurationMetric)}
    ${renderDurationSectionHTML("锦标赛 会话时长", computeDurationBuckets(tournList), chartsDurationMetric)}
    ${renderMetricToggleHTML()}
  `;
  view.querySelectorAll(".metric-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => { chartsDurationMetric = btn.dataset.metric; renderCharts(); });
  });
}

function renderTrends() {
  if (!sessions.length) {
    view.innerHTML = `
      <div class="empty-state">
        <div class="big">🃏</div>
        <p>还没有任何记录</p>
        <p>点右下角 + 记一局吧</p>
      </div>`;
    return;
  }
  const points = computeTrendSeries(trendsRange);
  const series = TREND_SERIES_META.map(sr => ({ ...sr, visible: trendsVisible[sr.key] }));
  view.innerHTML = `
    <div class="chart-card">
      <div id="trendChartWrap"></div>
      <div class="metric-toggle" style="margin-top:12px">
        ${TREND_RANGES.map(r => `<button class="metric-toggle-btn${trendsRange === r.key ? " active" : ""}" data-range="${r.key}">${r.label}</button>`).join("")}
      </div>
      <div class="trend-legend">
        ${TREND_SERIES_META.map(sr => `
          <button class="trend-legend-btn${trendsVisible[sr.key] ? "" : " off"}" data-series="${sr.key}">
            <span class="legend-dot" style="background:${trendsVisible[sr.key] ? sr.color : "var(--text-muted)"}"></span>${sr.label}
          </button>`).join("")}
      </div>
    </div>
  `;
  drawMultiLineChart(document.getElementById("trendChartWrap"), points, series);
  view.querySelectorAll("[data-range]").forEach(btn => {
    btn.addEventListener("click", () => { trendsRange = btn.dataset.range; renderTrends(); });
  });
  view.querySelectorAll("[data-series]").forEach(btn => {
    btn.addEventListener("click", () => {
      trendsVisible[btn.dataset.series] = !trendsVisible[btn.dataset.series];
      renderTrends();
    });
  });
}

// ---------- charts ----------
function niceRange(values) {
  let min = Math.min(...values, 0), max = Math.max(...values, 0);
  if (min === max) { min -= 1; max += 1; }
  const padAmt = (max - min) * 0.12 || 1;
  return [min - padAmt, max + padAmt];
}

function moneyCompactSigned(v) {
  const sign = v < 0 ? "-" : v > 0 ? "+" : "";
  const abs = Math.abs(v);
  const body = abs >= 1000 ? (abs / 1000).toFixed(1) + "k" : String(Math.round(abs));
  return sign + "$" + body;
}

function drawLineChart(wrap, points) {
  wrap.innerHTML = "";
  if (points.length < 2) {
    wrap.innerHTML = '<div class="empty-state" style="padding:24px"><p>数据不足,再记一局看曲线</p></div>';
    return;
  }
  const [min, max] = niceRange(points.map(p => p.value));
  const P = { l: 38, r: PAD.r, t: PAD.t, b: PAD.b };
  const innerW = VB_W - P.l - P.r, innerH = VB_H - P.t - P.b;
  const xAt = i => P.l + (i / (points.length - 1)) * innerW;
  const yAt = v => P.t + innerH - ((v - min) / (max - min)) * innerH;

  let grid = "";
  let axisLabels = "";
  [0, 0.5, 1].forEach(f => {
    const y = P.t + innerH * f;
    grid += `<line x1="${P.l}" y1="${y}" x2="${VB_W - P.r}" y2="${y}" stroke="var(--grid)" stroke-width="1"/>`;
    const value = max - (max - min) * f;
    axisLabels += `<text x="${P.l - 4}" y="${y.toFixed(2)}" font-size="9" fill="var(--text-muted)" text-anchor="end" dominant-baseline="middle">${moneyCompactSigned(value)}</text>`;
  });
  if (min < 0 && max > 0) {
    const y0 = yAt(0);
    grid += `<line x1="${P.l}" y1="${y0.toFixed(2)}" x2="${VB_W - P.r}" y2="${y0.toFixed(2)}" stroke="var(--baseline)" stroke-width="1"/>`;
  }

  const d = points.map((p, i) => (i === 0 ? "M" : "L") + xAt(i).toFixed(2) + "," + yAt(p.value).toFixed(2)).join(" ");
  const lastX = xAt(points.length - 1), lastY = yAt(points[points.length - 1].value);

  wrap.innerHTML = `
    <svg class="chart" viewBox="0 0 ${VB_W} ${VB_H}" preserveAspectRatio="none">
      ${grid}
      <path d="${d}" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${lastX.toFixed(2)}" cy="${lastY.toFixed(2)}" r="4" fill="var(--series-1)" stroke="var(--surface)" stroke-width="2"/>
      <line class="hover-line" x1="0" y1="${P.t}" x2="0" y2="${VB_H - P.b}" stroke="var(--text-muted)" stroke-width="1" opacity="0"/>
      <circle class="hover-dot" r="4.5" fill="var(--series-1)" stroke="var(--surface)" stroke-width="2" opacity="0"/>
      ${axisLabels}
    </svg>
    <div class="chart-axis-labels" style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);padding:2px 4px 0;margin-left:${((P.l / VB_W) * 100).toFixed(1)}%">
      <span>${points[0].label}</span><span>${points[points.length - 1].label}</span>
    </div>
  `;
  const tooltip = document.createElement("div");
  tooltip.className = "chart-tooltip";
  wrap.appendChild(tooltip);

  const svgEl = wrap.querySelector("svg");
  const hoverLine = svgEl.querySelector(".hover-line");
  const hoverDot = svgEl.querySelector(".hover-dot");

  function handleMove(evt) {
    const rect = svgEl.getBoundingClientRect();
    const clientX = evt.touches ? evt.touches[0].clientX : evt.clientX;
    const relX = ((clientX - rect.left) / rect.width) * VB_W;
    let idx = Math.round(((relX - P.l) / innerW) * (points.length - 1));
    idx = Math.max(0, Math.min(points.length - 1, idx));
    const px = xAt(idx), py = yAt(points[idx].value);
    hoverLine.setAttribute("x1", px); hoverLine.setAttribute("x2", px); hoverLine.setAttribute("opacity", 1);
    hoverDot.setAttribute("cx", px); hoverDot.setAttribute("cy", py); hoverDot.setAttribute("opacity", 1);
    tooltip.style.left = (px / VB_W) * 100 + "%";
    tooltip.style.top = (py / VB_H) * 100 + "%";
    tooltip.textContent = `${points[idx].fullLabel}  ${moneySigned(points[idx].value)}`;
    tooltip.classList.add("show");
  }
  function handleLeave() {
    hoverLine.setAttribute("opacity", 0);
    hoverDot.setAttribute("opacity", 0);
    tooltip.classList.remove("show");
  }
  svgEl.addEventListener("pointermove", handleMove);
  svgEl.addEventListener("pointerdown", handleMove);
  svgEl.addEventListener("pointerleave", handleLeave);
}

function drawMultiLineChart(wrap, points, series) {
  wrap.innerHTML = "";
  if (!points || points.length < 2) {
    wrap.innerHTML = '<div class="empty-state" style="padding:24px"><p>数据不足,再记一局看曲线</p></div>';
    return;
  }
  const shown = series.filter(sr => sr.visible);
  const activeSeries = shown.length ? shown : series;
  const allValues = points.flatMap(p => activeSeries.map(sr => p[sr.key]));
  const [min, max] = niceRange(allValues);
  const P = { l: 42, r: PAD.r, t: PAD.t, b: PAD.b };
  const innerW = VB_W - P.l - P.r, innerH = VB_H - P.t - P.b;
  const xAt = i => P.l + (i / (points.length - 1)) * innerW;
  const yAt = v => P.t + innerH - ((v - min) / (max - min)) * innerH;

  let grid = "";
  let axisLabels = "";
  [0, 0.5, 1].forEach(f => {
    const y = P.t + innerH * f;
    grid += `<line x1="${P.l}" y1="${y}" x2="${VB_W - P.r}" y2="${y}" stroke="var(--grid)" stroke-width="1"/>`;
    const value = max - (max - min) * f;
    axisLabels += `<text x="${P.l - 4}" y="${y.toFixed(2)}" font-size="9" fill="var(--text-muted)" text-anchor="end" dominant-baseline="middle">${moneyCompactSigned(value)}</text>`;
  });
  if (min < 0 && max > 0) {
    const y0 = yAt(0);
    grid += `<line x1="${P.l}" y1="${y0.toFixed(2)}" x2="${VB_W - P.r}" y2="${y0.toFixed(2)}" stroke="var(--baseline)" stroke-width="1"/>`;
  }

  let paths = "";
  series.forEach(sr => {
    if (!sr.visible) return;
    const d = points.map((p, i) => (i === 0 ? "M" : "L") + xAt(i).toFixed(2) + "," + yAt(p[sr.key]).toFixed(2)).join(" ");
    const lastX = xAt(points.length - 1), lastY = yAt(points[points.length - 1][sr.key]);
    paths += `<path d="${d}" fill="none" stroke="${sr.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
    paths += `<circle cx="${lastX.toFixed(2)}" cy="${lastY.toFixed(2)}" r="3.5" fill="${sr.color}" stroke="var(--surface)" stroke-width="2"/>`;
  });

  wrap.innerHTML = `
    <svg class="chart" viewBox="0 0 ${VB_W} ${VB_H}" preserveAspectRatio="none">
      ${grid}
      ${paths}
      ${axisLabels}
    </svg>
    <div class="chart-axis-labels" style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);padding:2px 4px 0;margin-left:${((P.l / VB_W) * 100).toFixed(1)}%">
      <span>${points[0].label}</span><span>${points[points.length - 1].label}</span>
    </div>
  `;
}

function drawBarChart(wrap, points) {
  wrap.innerHTML = "";
  if (!points.length) {
    wrap.innerHTML = '<div class="empty-state" style="padding:24px"><p>还没有记录</p></div>';
    return;
  }
  const [min, max] = niceRange(points.map(p => p.value));
  const innerW = VB_W - PAD.l - PAD.r, innerH = VB_H - PAD.t - PAD.b;
  const yAt = v => PAD.t + innerH - ((v - min) / (max - min)) * innerH;
  const y0 = yAt(0);
  const n = points.length;
  const slot = innerW / n;
  const barW = Math.max(3, Math.min(20, slot * 0.6));

  let bars = "";
  const barColors = [];
  points.forEach((p, i) => {
    const cx = PAD.l + slot * i + slot / 2;
    const x = cx - barW / 2;
    const yv = yAt(p.value);
    const positive = p.value >= 0;
    const top = Math.min(yv, y0), bottom = Math.max(yv, y0);
    const h = Math.max(bottom - top, 1.5);
    const r = Math.min(3, barW / 2, h / 2);
    const color = positive ? "var(--good)" : "var(--critical)";
    barColors.push(color);
    let d;
    if (positive) {
      d = `M ${x},${bottom} L ${x},${(top + r).toFixed(2)} Q ${x},${top} ${(x + r).toFixed(2)},${top} L ${(x + barW - r).toFixed(2)},${top} Q ${(x + barW).toFixed(2)},${top} ${(x + barW).toFixed(2)},${(top + r).toFixed(2)} L ${(x + barW).toFixed(2)},${bottom} Z`;
    } else {
      d = `M ${x},${top} L ${x},${(bottom - r).toFixed(2)} Q ${x},${bottom} ${(x + r).toFixed(2)},${bottom} L ${(x + barW - r).toFixed(2)},${bottom} Q ${(x + barW).toFixed(2)},${bottom} ${(x + barW).toFixed(2)},${(bottom - r).toFixed(2)} L ${(x + barW).toFixed(2)},${top} Z`;
    }
    bars += `<path data-idx="${i}" data-cx="${cx.toFixed(2)}" d="${d}" fill="${color}"/>`;
  });

  wrap.innerHTML = `
    <svg class="chart" viewBox="0 0 ${VB_W} ${VB_H}" preserveAspectRatio="none">
      <line x1="${PAD.l}" y1="${y0.toFixed(2)}" x2="${VB_W - PAD.r}" y2="${y0.toFixed(2)}" stroke="var(--baseline)" stroke-width="1"/>
      ${bars}
    </svg>
    <div class="chart-axis-labels" style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);padding:2px 4px 0">
      <span>${points[0].label}</span><span>${points[points.length - 1].label}</span>
    </div>
    <div class="chart-selected-info" id="barSelectedInfo">点击柱状图查看单局详情</div>
  `;
  const svgEl = wrap.querySelector("svg");
  const infoEl = wrap.querySelector("#barSelectedInfo");
  const centers = points.map((p, i) => PAD.l + slot * i + slot / 2);
  const barEls = [...svgEl.querySelectorAll("path[data-idx]")];
  let selectedIdx = null;

  function nearestIdx(clientX) {
    const rect = svgEl.getBoundingClientRect();
    const relX = ((clientX - rect.left) / rect.width) * VB_W;
    let best = 0, bestD = Infinity;
    centers.forEach((cx, i) => { const dist = Math.abs(cx - relX); if (dist < bestD) { bestD = dist; best = i; } });
    return best;
  }
  function showInfoFor(idx) {
    const p = points[idx];
    infoEl.innerHTML = `${p.fullLabel} <span class="${p.value >= 0 ? "good" : "bad"}">${moneySigned(p.value)}</span>`;
  }
  function handleTap(evt) {
    const clientX = evt.changedTouches ? evt.changedTouches[0].clientX : evt.clientX;
    const idx = nearestIdx(clientX);
    if (selectedIdx != null && barEls[selectedIdx]) barEls[selectedIdx].setAttribute("fill", barColors[selectedIdx]);
    selectedIdx = idx;
    barEls[idx].setAttribute("fill", "var(--text-primary)");
    showInfoFor(idx);
  }
  svgEl.addEventListener("click", handleTap);
}

// ---------- views ----------
const view = document.getElementById("view");

function renderOverview() {
  const agg = aggregate();
  if (!agg) {
    view.innerHTML = `
      <div class="empty-state">
        <div class="big">🃏</div>
        <p>还没有任何记录</p>
        <p>点右下角 + 记一局吧</p>
      </div>`;
    return;
  }
  const asc = sortedAsc();
  let cum = 0;
  const linePoints = [{ value: 0, label: fmtDate(asc[0].date), fullLabel: "起点" }];
  asc.forEach(s => {
    cum += computeMetrics(s).profit;
    linePoints.push({ value: cum, label: fmtDate(s.date), fullLabel: fmtDateFull(s.date) });
  });
  const barPoints = asc.map(s => ({ value: computeMetrics(s).profit, label: fmtDate(s.date), fullLabel: fmtDateFull(s.date) }));

  const trendWindow = computeTrendWindow(90);
  let trendPoints = null;
  if (trendWindow) {
    let tCum = 0;
    trendPoints = [{ value: 0, label: fmtDate(trendWindow.list[0].date), fullLabel: "起点" }];
    trendWindow.list.forEach(s => {
      tCum += computeMetrics(s).profit;
      trendPoints.push({ value: tCum, label: fmtDate(s.date), fullLabel: fmtDateFull(s.date) });
    });
  }

  view.innerHTML = `
    <div class="stat-grid">
      <div class="stat-tile"><div class="label">总盈亏</div><div class="value ${agg.totalProfit >= 0 ? "good" : "bad"}">${moneySigned(agg.totalProfit)}</div></div>
      <div class="stat-tile"><div class="label">总局数</div><div class="value">${agg.count}</div></div>
      <div class="stat-tile"><div class="label">总时长</div><div class="value">${fmtHours(agg.totalHr)}</div></div>
      <div class="stat-tile"><div class="label">平均时薪</div><div class="value ${agg.avgHourly >= 0 ? "good" : "bad"}">${agg.avgHourly == null ? "--" : moneySigned(agg.avgHourly) + "/h"}</div></div>
      <div class="stat-tile"><div class="label">ROI</div><div class="value ${(agg.roi ?? 0) >= 0 ? "good" : "bad"}">${pct(agg.roi)}</div></div>
      <div class="stat-tile"><div class="label">胜率</div><div class="value">${agg.winRate.toFixed(0)}%</div></div>
    </div>

    <div class="chart-card">
      <h3>资金曲线</h3>
      <p class="chart-sub">按时间累计盈亏</p>
      <div class="chart-wrap" id="lineChartWrap"></div>
    </div>

    <div class="chart-card">
      <h3>单局盈亏</h3>
      <p class="chart-sub">绿色赢局 · 红色输局</p>
      <div class="chart-wrap" id="barChartWrap"></div>
    </div>

    ${renderTypeSummaryHTML(computeTypeBreakdown())}
    ${renderSessionStatsHTML(computeTypeBreakdown())}
    ${renderGameBreakdownHTML(computeGameBreakdown())}
    ${renderTournamentDetailHTML(computeTournamentDetail())}
    ${renderMonthCompareHTML(computeMonthCompare())}
    ${renderTrendHTML(trendWindow)}
  `;
  drawLineChart(document.getElementById("lineChartWrap"), linePoints);
  drawBarChart(document.getElementById("barChartWrap"), barPoints);
  if (trendPoints) drawLineChart(document.getElementById("trendChartWrap"), trendPoints);
}

function renderMonthCompareHTML(mc) {
  if (!mc) return "";
  const { thisAgg, lastAgg } = mc;
  const plainPair = (a, b) => `${a == null ? "--" : a}<span class="compare-sep">/</span>${b == null ? "--" : b}`;
  const moneyPair = (a, b) => {
    const fa = a == null ? '<span class="muted">--</span>' : `<span class="${a >= 0 ? "good" : "bad"}">${moneySigned(a)}</span>`;
    const fb = b == null ? '<span class="muted">--</span>' : `<span class="${b >= 0 ? "good" : "bad"}">${moneySigned(b)}</span>`;
    return `${fa}<span class="compare-sep">/</span>${fb}`;
  };
  const hourlyPair = (a, b) => {
    const fa = a == null ? '<span class="muted">--</span>' : `<span class="${a >= 0 ? "good" : "bad"}">${moneySigned(a)}</span>`;
    const fb = b == null ? '<span class="muted">--</span>' : `<span class="${b >= 0 ? "good" : "bad"}">${moneySigned(b)}</span>`;
    return `${fa}<span class="compare-sep">/</span>${fb}`;
  };
  const pctPair = (a, b) => {
    const fa = a == null ? '<span class="muted">--</span>' : `<span class="${a >= 0 ? "good" : "bad"}">${pct(a)}</span>`;
    const fb = b == null ? '<span class="muted">--</span>' : `<span class="${b >= 0 ? "good" : "bad"}">${pct(b)}</span>`;
    return `${fa}<span class="compare-sep">/</span>${fb}`;
  };
  return `
    <div class="chart-card">
      <h3 style="text-align:center">本月 / 上月</h3>
      <div class="compare-grid">
        <div class="compare-cell">
          <div class="compare-value">${plainPair(thisAgg ? thisAgg.count : 0, lastAgg ? lastAgg.count : 0)}</div>
          <div class="compare-label">对局</div>
        </div>
        <div class="compare-cell">
          <div class="compare-value">${plainPair(thisAgg ? Math.round(thisAgg.totalHr) : 0, lastAgg ? Math.round(lastAgg.totalHr) : 0)}</div>
          <div class="compare-label">小时</div>
        </div>
        <div class="compare-cell">
          <div class="compare-value">${moneyPair(thisAgg ? thisAgg.totalProfit : null, lastAgg ? lastAgg.totalProfit : null)}</div>
          <div class="compare-label">净利润</div>
        </div>
        <div class="compare-cell">
          <div class="compare-value">${hourlyPair(thisAgg ? thisAgg.avgHourly : null, lastAgg ? lastAgg.avgHourly : null)}</div>
          <div class="compare-label">HOURLY</div>
        </div>
      </div>
      <div class="compare-roi">
        <div class="compare-value">${pctPair(thisAgg ? thisAgg.roi : null, lastAgg ? lastAgg.roi : null)}</div>
        <div class="compare-label">ROI</div>
      </div>
    </div>`;
}

function renderTrendHTML(tw) {
  if (!tw) return "";
  const agg = tw.agg;
  return `
    <div class="chart-card">
      <h3 style="text-align:center">三个月趋势</h3>
      <div class="chart-wrap" id="trendChartWrap"></div>
      <div class="stat-grid" style="margin-top:12px">
        <div class="stat-tile"><div class="label">小时</div><div class="value">${Math.round(agg.totalHr)}</div></div>
        <div class="stat-tile"><div class="label">HOURLY</div><div class="value ${(agg.avgHourly ?? 0) >= 0 ? "good" : "bad"}">${agg.avgHourly == null ? "--" : moneySigned(agg.avgHourly) + "/h"}</div></div>
        <div class="stat-tile"><div class="label">ROI</div><div class="value ${(agg.roi ?? 0) >= 0 ? "good" : "bad"}">${pct(agg.roi)}</div></div>
        <div class="stat-tile"><div class="label">净利润</div><div class="value ${agg.totalProfit >= 0 ? "good" : "bad"}">${moneySigned(agg.totalProfit)}</div></div>
      </div>
    </div>`;
}

function fmtCell(value, kind) {
  if (kind === "money") return `<div class="dt-val">${money(value)}</div>`;
  if (kind === "signedMoney") return `<div class="dt-val ${value >= 0 ? "good" : "bad"}">${moneySigned(value)}</div>`;
  if (kind === "count") return `<div class="dt-val">${value}</div>`;
  if (kind === "hours") return `<div class="dt-val">${fmtHours(value)}</div>`;
  if (kind === "pct") return `<div class="dt-val ${(value ?? 0) >= 0 ? "good" : "bad"}">${pct(value)}</div>`;
  if (kind === "winrate") return `<div class="dt-val">${value.toFixed(0)}%</div>`;
  if (kind === "hourly") return `<div class="dt-val ${value == null ? "" : value >= 0 ? "good" : "bad"}">${value == null ? "--" : moneySigned(value) + "/h"}</div>`;
  if (kind === "bb") return `<div class="dt-val ${value == null ? "" : value >= 0 ? "good" : "bad"}">${value == null ? "--" : (value > 0 ? "+" : "") + value.toFixed(2)}</div>`;
  return `<div class="dt-val">${value}</div>`;
}
function dtRow(label, values, kind) {
  return `<div class="dt-row"><div class="dt-label">${label}</div>${values.map(v => fmtCell(v, kind)).join("")}</div>`;
}
const DT_HEAD = `<div class="dt-row dt-head"><div class="dt-label"></div><div class="dt-val">现金局</div><div class="dt-val">锦标赛</div><div class="dt-val">总计</div></div>`;

function renderTypeSummaryHTML(b) {
  const cols = [b.cash, b.tournament, b.total];
  return `
    <div class="chart-card">
      <h3>摘要</h3>
      ${DT_HEAD}
      ${dtRow("买入", cols.map(c => c.totalBuyIn), "money")}
      ${dtRow("提现", cols.map(c => c.cashOutRaw), "money")}
      ${dtRow("净利润", cols.map(c => c.profit), "signedMoney")}
    </div>`;
}

function renderSessionStatsHTML(b) {
  const cols = [b.cash, b.tournament, b.total];
  return `
    <div class="chart-card">
      <h3>对局</h3>
      ${DT_HEAD}
      ${dtRow("对局", cols.map(c => c.count), "count")}
      ${dtRow("小时", cols.map(c => c.hours), "hours")}
      ${dtRow("$/小时", cols.map(c => c.hourly), "hourly")}
      ${dtRow("BB/小时", [b.cash.bbHourly, null, null], "bb")}
      ${dtRow("ROI", cols.map(c => c.roi), "pct")}
      ${dtRow("获胜", cols.map(c => c.winRate), "winrate")}
      ${dtRow("平均买入", cols.map(c => c.avgBuyIn), "money")}
      ${dtRow("平均利润", cols.map(c => c.avgProfit), "signedMoney")}
      ${dtRow("平均补充买入", cols.map(c => c.avgRebuy), "money")}
    </div>`;
}

function renderTournamentDetailHTML(d) {
  if (!d) return "";
  return `
    <div class="chart-card">
      <h3>锦标赛详情</h3>
      <div class="dt-row"><div class="dt-label">赏金奖金</div><div class="dt-val" style="grid-column: 2 / span 3">${money(d.bounties)}</div></div>
      <div class="dt-row"><div class="dt-label">对局</div><div class="dt-val" style="grid-column: 2 / span 3">${d.count}</div></div>
      <div class="dt-row"><div class="dt-label">ITM</div><div class="dt-val" style="grid-column: 2 / span 3">${d.itm} (${d.itmPct.toFixed(1)}%)</div></div>
      <div class="dt-row"><div class="dt-label">Final Table</div><div class="dt-val" style="grid-column: 2 / span 3">${d.finalTable} (${d.finalTablePct.toFixed(1)}%)</div></div>
      <div class="dt-row"><div class="dt-label">亚军</div><div class="dt-val" style="grid-column: 2 / span 3">${d.runnerUp} (${d.runnerUpPct.toFixed(1)}%)</div></div>
      <div class="dt-row"><div class="dt-label">胜利</div><div class="dt-val" style="grid-column: 2 / span 3">${d.wins} (${d.winsPct.toFixed(1)}%)</div></div>
    </div>`;
}

function renderGameBreakdownHTML(rows) {
  if (!rows.length) return "";
  return `
    <div class="chart-card">
      <h3>游戏分类</h3>
      <p class="chart-sub">按小时数排序</p>
      ${rows.map(r => `
        <div class="game-row">
          <div style="min-width:0">
            <div class="game-name">${escapeHtml(r.name)}</div>
            <div class="game-meta">${fmtHours(r.hours)} · ${r.count}局</div>
          </div>
          <div class="game-side">
            <div class="game-total ${r.profit >= 0 ? "good" : "bad"}">${moneySigned(r.profit)}</div>
            <div class="game-meta">${r.hourly == null ? "--" : moneySigned(r.hourly) + "/h"}</div>
          </div>
        </div>`).join("")}
    </div>`;
}

function renderLocations() {
  const rows = computeLocationBreakdown();
  if (!rows.length) {
    view.innerHTML = `
      <div class="empty-state">
        <div class="big">🃏</div>
        <p>还没有任何记录</p>
        <p>点右下角 + 记一局吧</p>
      </div>`;
    return;
  }
  view.innerHTML = rows.map(r => `
    <div class="loc-card" data-name="${escapeHtml(r.name)}">
      <div class="loc-top">
        <div style="min-width:0">
          <div class="loc-name">${escapeHtml(r.name)}</div>
          ${r.venueType ? `<div class="loc-sub">${escapeHtml(r.venueType)}</div>` : ""}
        </div>
        <div class="loc-total ${r.profit >= 0 ? "good" : "bad"}">${moneySigned(r.profit)}</div>
      </div>
      <div class="loc-detail">${r.count}局 · ${fmtHours(r.hours)} · ${r.hourly == null ? "--" : moneySigned(r.hourly) + "/h"} · <span class="${r.winRate >= 50 ? "good" : ""}">${r.winRate.toFixed(0)}% 获胜</span></div>
    </div>`).join("");
  view.querySelectorAll(".loc-card").forEach(card => {
    card.addEventListener("click", () => openLocationDetail(card.dataset.name));
  });
}

function computeLocationDetail(name) {
  const list = sessions.filter(s => ((s.location || "未知地点").trim() || "未知地点") === name);
  const venueType = extractVenueType(list);
  const cashList = list.filter(s => !isTournamentType(s.gameType));
  const tournList = list.filter(s => isTournamentType(s.gameType));
  const wins = list.filter(s => computeMetrics(s).profit > 0).length;
  const losses = list.length - wins;

  const asc = [...list].sort((a, b) => sortKey(a) < sortKey(b) ? -1 : 1);
  let cum = 0;
  const curvePoints = [{ value: 0, label: fmtDate(asc[0].date), fullLabel: "起点" }];
  asc.forEach(s => {
    cum += computeMetrics(s).profit;
    curvePoints.push({ value: cum, label: fmtDate(s.date), fullLabel: fmtDateFull(s.date) });
  });

  function bestOf(list) {
    if (!list.length) return null;
    let best = list[0], bestProfit = -Infinity;
    list.forEach(s => { const p = computeMetrics(s).profit; if (p > bestProfit) { bestProfit = p; best = s; } });
    return best;
  }
  const bestCash = bestOf(cashList);
  const bestTourn = bestOf(tournList);

  const desc = [...list].sort((a, b) => sortKey(a) > sortKey(b) ? -1 : 1);
  const byYear = new Map();
  desc.forEach(s => {
    const y = s.date.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(s);
  });

  return {
    name, venueType, count: list.length,
    cashCount: cashList.length, tournCount: tournList.length,
    wins, losses, winRate: list.length ? (wins / list.length) * 100 : 0,
    cashSummary: summarizeGroup(cashList), tournSummary: summarizeGroup(tournList), totalSummary: summarizeGroup(list),
    curvePoints, bestCash, bestTourn, byYear,
  };
}

function sessionIconHTML(s) {
  const isTourn = isTournamentType(s.gameType);
  const color = isTourn ? "var(--series-4)" : "var(--series-1)";
  const symbol = isTourn
    ? `<circle cx="12" cy="12" r="7" stroke="#fff" stroke-width="1.6" fill="none"/><path d="M12 9v3l2 1.4" stroke="#fff" stroke-width="1.6" stroke-linecap="round" fill="none"/>`
    : `<text x="12" y="16.5" text-anchor="middle" font-size="13" font-weight="700" fill="#fff">$</text>`;
  return `<span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:${color};flex:none;margin-right:6px"><svg width="16" height="16" viewBox="0 0 24 24">${symbol}</svg></span>`;
}

function renderLocSessionRow(s) {
  const m = computeMetrics(s);
  const title = [s.gameType, s.game, s.stakes].filter(Boolean).join(" · ") || "未命名场次";
  return `
    <div class="session-row" data-loc-session-id="${s.id}">
      <div class="session-main">
        <div class="title" style="display:flex;align-items:center">${sessionIconHTML(s)}${escapeHtml(title)}</div>
        <div class="meta">${escapeHtml(s.location || "")}</div>
      </div>
      <div class="session-side">
        <div class="profit ${m.profit >= 0 ? "good" : "bad"}">${moneySigned(m.profit)}</div>
        <div class="hourly">${fmtDateWeekday(s.date)}</div>
      </div>
    </div>`;
}

function renderProfitDistHTML(d) {
  const cashAbs = Math.abs(d.cashSummary.profit);
  const tournAbs = Math.abs(d.tournSummary.profit);
  const total = cashAbs + tournAbs;
  if (total <= 0) return "";
  const segs = [];
  if (cashAbs > 0) segs.push({ pct: (cashAbs / total) * 100, color: "var(--series-1)" });
  if (tournAbs > 0) segs.push({ pct: (tournAbs / total) * 100, color: "var(--series-4)" });
  return `
    <p class="chart-sub" style="text-align:center">您的波动占比分布:</p>
    <div style="display:flex;height:38px;border-radius:8px;overflow:hidden;margin-bottom:20px">
      ${segs.map(s => `<div style="width:${s.pct.toFixed(1)}%;background:${s.color};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;color:#0b0b0b">${s.pct.toFixed(0)}%</div>`).join("")}
    </div>`;
}

function openLocationDetail(name) {
  const d = computeLocationDetail(name);
  const typeRows = [];
  if (d.cashCount > 0) typeRows.push({ label: "现金游戏", ...d.cashSummary });
  if (d.tournCount > 0) typeRows.push({ label: "锦标赛", ...d.tournSummary });

  sheetEl.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <h2 style="margin:0">位置信息</h2>
      <button id="btn-close-loc" style="background:none;border:none;font-size:24px;color:var(--series-1);line-height:1;padding:4px">&times;</button>
    </div>
    <div style="text-align:center;margin-bottom:16px">
      <div style="font-size:21px;font-weight:700">${escapeHtml(d.name)}</div>
      ${d.venueType ? `<div style="font-size:13px;color:var(--text-muted);margin-top:2px">${escapeHtml(d.venueType)}</div>` : ""}
    </div>
    <div class="chart-wrap" id="locChartWrap" style="margin-bottom:20px"></div>
    <div style="display:flex;gap:12px;justify-content:center;margin-bottom:20px;flex-wrap:wrap">
      <div style="text-align:center">
        ${buildDonutSVG([{ value: d.cashCount, color: "var(--series-1)" }, { value: d.tournCount, color: "var(--series-4)" }], String(d.count), "局")}
        <div style="font-size:12px;margin-top:8px;text-align:left">
          <div><span class="legend-dot" style="background:var(--series-1)"></span>现金游戏 (${d.cashCount})</div>
          <div><span class="legend-dot" style="background:var(--series-4)"></span>锦标赛 (${d.tournCount})</div>
        </div>
      </div>
      <div style="text-align:center">
        ${buildDonutSVG([{ value: d.wins, color: "var(--good)" }, { value: d.losses, color: "var(--critical)" }], d.winRate.toFixed(0) + "%", "获胜")}
        <div style="font-size:12px;margin-top:8px;text-align:left">
          <div><span class="legend-dot" style="background:var(--good)"></span>获胜 (${d.wins})</div>
          <div><span class="legend-dot" style="background:var(--critical)"></span>失去 (${d.losses})</div>
        </div>
      </div>
    </div>
    <div class="chart-card" style="margin-bottom:18px">
      <div class="dt-row dt-head" style="grid-template-columns:1.3fr 1fr 1fr"><div class="dt-label">类型</div><div class="dt-val">ROI</div><div class="dt-val">利润</div></div>
      ${typeRows.map(r => `
        <div class="dt-row" style="grid-template-columns:1.3fr 1fr 1fr">
          <div class="dt-label">${r.label}</div>
          <div class="dt-val ${(r.roi ?? 0) >= 0 ? "good" : "bad"}">${pct(r.roi)}</div>
          <div class="dt-val ${r.profit >= 0 ? "good" : "bad"}">${moneySigned(r.profit)}</div>
        </div>`).join("")}
      <div class="dt-row" style="grid-template-columns:1.3fr 1fr 1fr">
        <div class="dt-label">总计</div><div class="dt-val"></div>
        <div class="dt-val ${d.totalSummary.profit >= 0 ? "good" : "bad"}">${moneySigned(d.totalSummary.profit)}</div>
      </div>
    </div>
    ${renderProfitDistHTML(d)}
    <div class="section-title" style="text-align:center">最佳对局</div>
    ${d.bestCash ? renderLocSessionRow(d.bestCash) : ""}
    ${d.bestTourn ? renderLocSessionRow(d.bestTourn) : ""}
    ${[...d.byYear.entries()].map(([year, list]) => `
      <div class="section-title" style="text-align:center;margin-top:18px">${year}</div>
      ${list.map(s => renderLocSessionRow(s)).join("")}
    `).join("")}
  `;
  showOverlay();
  drawLineChart(document.getElementById("locChartWrap"), d.curvePoints);
  document.getElementById("btn-close-loc").addEventListener("click", closeSheet);
  sheetEl.querySelectorAll("[data-loc-session-id]").forEach(row => {
    row.addEventListener("click", () => openSessionDetail(row.dataset.locSessionId));
  });
}

function renderSessions() {
  if (!sessions.length) {
    view.innerHTML = `
      <div class="empty-state">
        <div class="big">🃏</div>
        <p>还没有任何记录</p>
        <p>点右下角 + 记一局吧</p>
      </div>`;
    return;
  }
  const list = sortedDesc();
  view.innerHTML = `<div class="section-title">全部记录</div>` + list.map(s => {
    const m = computeMetrics(s);
    const title = [s.gameType, s.game, s.stakes].filter(Boolean).join(" · ") || "未命名场次";
    const meta = [fmtDateFull(s.date), s.location].filter(Boolean).join(" · ");
    return `
      <div class="session-row" data-id="${s.id}">
        <div class="session-main">
          <div class="title">${escapeHtml(title)}</div>
          <div class="meta">${escapeHtml(meta)}${m.durationHr ? " · " + fmtHours(m.durationHr) : ""}</div>
        </div>
        <div class="session-side">
          <div class="profit ${m.profit >= 0 ? "good" : "bad"}">${moneySigned(m.profit)}</div>
          <div class="hourly">${m.hourly == null ? "" : moneySigned(m.hourly) + "/h"}</div>
        </div>
      </div>`;
  }).join("");
  view.querySelectorAll(".session-row").forEach(row => {
    row.addEventListener("click", () => openSessionDetail(row.dataset.id));
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderView() {
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === activeTab));
  if (activeTab === "overview") renderOverview();
  else if (activeTab === "locations") renderLocations();
  else if (activeTab === "charts") renderCharts();
  else if (activeTab === "trends") renderTrends();
  else renderSessions();
}

// ---------- tabs & fab ----------
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => { activeTab = btn.dataset.tab; renderView(); });
});
document.getElementById("fab").addEventListener("click", () => openSheet(null));

// ---------- add/edit sheet ----------
const overlay = document.getElementById("overlay");
const sheetEl = document.getElementById("sheet");

const TYPE_OPTIONS = ["现金游戏", "锦标赛", "SNG", "Casino", "Home Game", "Online", "其他"];
const GAME_OPTIONS = ["No Limit Texas Hold'em", "Pot Limit Omaha", "短牌 Short Deck", "其他"];

function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function timeSelectHTML(idPrefix, value) {
  const [h, m] = (value || "").split(":");
  const hourOpts = ['<option value="">--</option>'].concat(
    Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"))
      .map(hh => `<option value="${hh}"${hh === h ? " selected" : ""}>${hh}</option>`)
  ).join("");
  const minOpts = ['<option value="">--</option>'].concat(
    Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"))
      .map(mm => `<option value="${mm}"${mm === m ? " selected" : ""}>${mm}</option>`)
  ).join("");
  return `
    <div class="time-select-row">
      <select id="${idPrefix}-h">${hourOpts}</select>
      <span class="time-colon">:</span>
      <select id="${idPrefix}-m">${minOpts}</select>
    </div>`;
}

function openSessionDetail(id) {
  const s = sessions.find(x => x.id === id);
  if (!s) return;
  const m = computeMetrics(s);
  const title = [s.gameType, s.game, s.stakes].filter(Boolean).join(" · ") || "未命名场次";
  const cashOutRaw = +s.cashOut || 0;

  sheetEl.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <h2 style="margin:0">场次详情</h2>
      <button id="btn-close-detail" style="background:none;border:none;font-size:24px;color:var(--series-1);line-height:1;padding:4px">&times;</button>
    </div>
    <div style="text-align:center;margin-bottom:6px">
      <div style="display:flex;align-items:center;justify-content:center;gap:2px;font-size:17px;font-weight:700">${sessionIconHTML(s)}${escapeHtml(title)}</div>
      <div style="font-size:13px;color:var(--text-muted);margin-top:2px">${escapeHtml(s.location || "")}</div>
    </div>
    <div style="text-align:center;margin:16px 0">
      <div style="font-size:30px;font-weight:700;color:${m.profit >= 0 ? "var(--good-text)" : "var(--critical)"}">${moneySigned(m.profit)}</div>
      <div style="font-size:13px;color:var(--text-muted);margin-top:2px">${fmtDateWeekday(s.date)}</div>
    </div>
    <div class="computed-preview" style="margin-bottom:16px">
      <div><div class="k">买入</div><div class="v">${money(s.buyIn)}</div></div>
      <div><div class="k">提现</div><div class="v">${money(cashOutRaw)}</div></div>
      <div><div class="k">时薪</div><div class="v ${(m.hourly ?? 0) >= 0 ? "good" : "bad"}">${m.hourly == null ? "--" : moneySigned(m.hourly) + "/h"}</div></div>
      <div><div class="k">补充买入</div><div class="v">${money(s.rebuy)}</div></div>
      <div><div class="k">其他支出</div><div class="v">${money(s.expenses)}</div></div>
      <div><div class="k">ROI</div><div class="v ${(m.roi ?? 0) >= 0 ? "good" : "bad"}">${pct(m.roi)}</div></div>
      <div><div class="k">开始</div><div class="v">${s.startTime || "--"}</div></div>
      <div><div class="k">结束</div><div class="v">${s.endTime || "--"}</div></div>
      <div><div class="k">持续时间</div><div class="v">${fmtHours(m.durationHr)}</div></div>
    </div>
    ${s.notes ? `<div class="field"><label>备注</label><div style="padding:10px 12px;background:var(--surface);border:1px solid var(--border);border-radius:10px;white-space:pre-wrap;font-size:14px">${escapeHtml(s.notes)}</div></div>` : ""}
    <div class="btn-row">
      <button class="btn btn-secondary" id="btn-close-detail2">关闭</button>
      <button class="btn btn-primary" id="btn-edit-detail">编辑</button>
    </div>
  `;
  showOverlay();
  document.getElementById("btn-close-detail").addEventListener("click", closeSheet);
  document.getElementById("btn-close-detail2").addEventListener("click", closeSheet);
  document.getElementById("btn-edit-detail").addEventListener("click", () => openSheet(id));
}

function openSheet(id) {
  editingId = id;
  const s = id ? sessions.find(x => x.id === id) : {
    id: uid(), date: todayStr(), gameType: "现金游戏", game: "No Limit Texas Hold'em", stakes: "", location: "",
    startTime: "", endTime: "", buyIn: "", rebuy: "", cashOut: "", expenses: "", notes: "",
  };
  sheetEl.innerHTML = `
    <h2>${id ? "编辑场次" : "记一局"}</h2>
    <div class="field">
      <label>日期</label>
      <input type="text" inputmode="numeric" id="f-date" value="${s.date}" placeholder="YYYY-MM-DD" />
    </div>
    <div class="row3">
      <div class="field">
        <label>类型</label>
        <input list="typeList" id="f-gameType" value="${escapeHtml(s.gameType || "")}" placeholder="现金游戏" />
        <datalist id="typeList">${TYPE_OPTIONS.map(g => `<option value="${g}">`).join("")}</datalist>
      </div>
      <div class="field">
        <label>游戏</label>
        <input list="gameList" id="f-game" value="${escapeHtml(s.game || "")}" placeholder="No Limit Hold'em" />
        <datalist id="gameList">${GAME_OPTIONS.map(g => `<option value="${g}">`).join("")}</datalist>
      </div>
      <div class="field">
        <label>盲注</label>
        <input type="text" id="f-stakes" value="${escapeHtml(s.stakes || "")}" placeholder="0.5/1" />
      </div>
    </div>
    <div class="field">
      <label>地点</label>
      <input type="text" id="f-location" value="${escapeHtml(s.location || "")}" placeholder="俱乐部 / 地址" />
    </div>
    <div class="row2">
      <div class="field">
        <label>开始时间</label>
        ${timeSelectHTML("f-start", s.startTime)}
      </div>
      <div class="field">
        <label>结束时间</label>
        ${timeSelectHTML("f-end", s.endTime)}
      </div>
    </div>
    <div class="row3">
      <div class="field">
        <label>买入</label>
        <input type="number" inputmode="decimal" id="f-buyIn" value="${s.buyIn}" placeholder="0" />
      </div>
      <div class="field">
        <label>补充买入</label>
        <input type="number" inputmode="decimal" id="f-rebuy" value="${s.rebuy}" placeholder="0" />
      </div>
      <div class="field">
        <label>兑现</label>
        <input type="number" inputmode="decimal" id="f-cashOut" value="${s.cashOut}" placeholder="0" />
      </div>
    </div>
    <div class="field">
      <label>其他支出(交通/小费等)</label>
      <input type="number" inputmode="decimal" id="f-expenses" value="${s.expenses}" placeholder="0" />
    </div>
    <div class="field">
      <label>备注</label>
      <textarea id="f-notes" rows="2" placeholder="选填">${escapeHtml(s.notes || "")}</textarea>
    </div>

    <div class="computed-preview">
      <div><div class="k">盈亏</div><div class="v" id="p-profit">--</div></div>
      <div><div class="k">时薪</div><div class="v" id="p-hourly">--</div></div>
      <div><div class="k">ROI</div><div class="v" id="p-roi">--</div></div>
    </div>

    <div class="btn-row">
      <button class="btn btn-secondary" id="btn-cancel">取消</button>
      <button class="btn btn-primary" id="btn-save">保存</button>
    </div>
    ${id ? '<div class="btn-row"><button class="btn btn-danger" id="btn-delete">删除这条记录</button></div>' : ""}
  `;
  showOverlay();

  function combineTime(prefix) {
    const h = document.getElementById(prefix + "-h").value;
    const m = document.getElementById(prefix + "-m").value;
    return (h && m) ? h + ":" + m : "";
  }
  function readForm() {
    return {
      id: s.id,
      date: document.getElementById("f-date").value || todayStr(),
      gameType: document.getElementById("f-gameType").value.trim(),
      game: document.getElementById("f-game").value.trim(),
      stakes: document.getElementById("f-stakes").value.trim(),
      location: document.getElementById("f-location").value.trim(),
      startTime: combineTime("f-start"),
      endTime: combineTime("f-end"),
      buyIn: document.getElementById("f-buyIn").value,
      rebuy: document.getElementById("f-rebuy").value,
      cashOut: document.getElementById("f-cashOut").value,
      expenses: document.getElementById("f-expenses").value,
      notes: document.getElementById("f-notes").value.trim(),
    };
  }
  function updatePreview() {
    const m = computeMetrics(readForm());
    const pf = document.getElementById("p-profit"), ph = document.getElementById("p-hourly"), pr = document.getElementById("p-roi");
    pf.textContent = moneySigned(m.profit); pf.className = "v " + (m.profit >= 0 ? "good" : "bad");
    ph.textContent = m.hourly == null ? "--" : moneySigned(m.hourly) + "/h"; ph.className = "v " + (m.hourly >= 0 ? "good" : "bad");
    pr.textContent = pct(m.roi); pr.className = "v " + ((m.roi ?? 0) >= 0 ? "good" : "bad");
  }
  ["f-buyIn", "f-rebuy", "f-cashOut", "f-expenses", "f-start-h", "f-start-m", "f-end-h", "f-end-m", "f-date"].forEach(id => {
    document.getElementById(id).addEventListener("input", updatePreview);
    document.getElementById(id).addEventListener("change", updatePreview);
  });
  updatePreview();

  document.getElementById("btn-cancel").addEventListener("click", closeSheet);
  document.getElementById("btn-save").addEventListener("click", () => {
    const data = readForm();
    const idx = sessions.findIndex(x => x.id === data.id);
    if (idx >= 0) sessions[idx] = data; else sessions.push(data);
    saveSessions();
    closeSheet();
    renderView();
  });
  const delBtn = document.getElementById("btn-delete");
  if (delBtn) delBtn.addEventListener("click", () => {
    const idx = sessions.findIndex(x => x.id === s.id);
    if (idx >= 0) {
      lastDeleted = { data: sessions[idx], idx };
      sessions.splice(idx, 1);
      saveSessions();
      closeSheet();
      renderView();
      showUndoToast("已删除该记录");
    }
  });
}
function showOverlay() {
  overlay.classList.remove("hidden");
  document.body.classList.add("modal-open");
}
function closeSheet() {
  overlay.classList.add("hidden");
  sheetEl.innerHTML = "";
  editingId = null;
  document.body.classList.remove("modal-open");
}
overlay.addEventListener("click", e => { if (e.target === overlay) closeSheet(); });

// ---------- toast ----------
const toastEl = document.getElementById("toast");
function showUndoToast(message) {
  clearTimeout(toastTimer);
  toastEl.innerHTML = `<span>${message}</span> <button id="undoBtn" style="margin-left:10px;background:none;border:none;color:var(--series-1);font-weight:600;font-size:13px;">撤销</button>`;
  toastEl.classList.remove("hidden");
  document.getElementById("undoBtn").addEventListener("click", () => {
    if (lastDeleted) {
      sessions.splice(lastDeleted.idx, 0, lastDeleted.data);
      saveSessions();
      renderView();
      lastDeleted = null;
    }
    hideToast();
  });
  toastTimer = setTimeout(hideToast, 5000);
}
function hideToast() { toastEl.classList.add("hidden"); }
function showToast(message) {
  clearTimeout(toastTimer);
  toastEl.innerHTML = `<span>${message}</span>`;
  toastEl.classList.remove("hidden");
  toastTimer = setTimeout(hideToast, 3000);
}

// ---------- CSV import (Poker Bankroll Tracker export format) ----------
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && next === "\n") i++;
        row.push(field); field = "";
        rows.push(row); row = [];
      } else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1);
}

const PBT_TYPE_LABEL = { Casino: "赌场", "Home Game": "家庭局", Online: "线上" };

function pbtRowsToSessions(rows) {
  const header = rows[0];
  const idx = {};
  header.forEach((h, i) => (idx[h.trim()] = i));
  const get = (r, name) => { const v = r[idx[name]]; return v == null ? "" : v; };
  const num = (r, name) => { const v = get(r, name); return v === "" ? 0 : parseFloat(v) || 0; };

  return rows.slice(1).filter(r => r.length > 1 && get(r, "starttime")).map(r => {
    const startRaw = get(r, "starttime");
    const date = startRaw.slice(0, 10);
    const startTime = startRaw.slice(11, 16);
    const startDate = new Date(startRaw.replace(" ", "T"));
    const playingMin = num(r, "playingminutes");
    const endDate = new Date(startDate.getTime() + playingMin * 60000);
    const endTime = String(endDate.getHours()).padStart(2, "0") + ":" + String(endDate.getMinutes()).padStart(2, "0");

    const variant = get(r, "variant");
    const isTourn = variant === "Tournament";
    const gameType = isTourn ? "锦标赛" : "现金局";

    const sb = num(r, "smallblind"), bb = num(r, "bigblind"), third = num(r, "3rdblind"), ante = num(r, "ante");
    const gameRaw = get(r, "game").trim();
    let stakes;
    if (isTourn) stakes = "";
    else if (sb > 0 || bb > 0) stakes = sb + "/" + bb + (third > 0 ? "/" + third : "") + (ante > 0 ? " ante" + ante : "");
    else stakes = gameRaw;

    const buyIn = num(r, "buyin");
    const rebuy = num(r, "rebuycosts") + num(r, "addoncosts") + num(r, "bountycosts");
    const expenses = num(r, "expenses");
    const bounties = num(r, "bounties");
    const cashOut = num(r, "cashout") + bounties;
    const bigBlind = bb;
    const place = num(r, "place");
    const players = num(r, "player");

    const notesParts = [];
    const sessionNote = get(r, "sessionnote").trim();
    if (sessionNote) notesParts.push(sessionNote);
    const rawNotes = get(r, "notes").trim();
    if (rawNotes) {
      try {
        const arr = JSON.parse(rawNotes);
        if (Array.isArray(arr)) arr.forEach(item => { if (item && item.n) notesParts.push(item.n); });
        else notesParts.push(rawNotes);
      } catch (e) { notesParts.push(rawNotes); }
    }
    const typeField = get(r, "type");
    if (typeField) notesParts.push("场地类型: " + (PBT_TYPE_LABEL[typeField] || typeField));
    if (isTourn) {
      const bits = [];
      if (players > 0) bits.push(players + "人参赛");
      if (place > 0) bits.push("第" + place + "名");
      if (bits.length) notesParts.push(bits.join(" · "));
    }

    return {
      id: "pbt-" + get(r, "id"),
      date, gameType, game: gameRaw, stakes,
      location: get(r, "location").trim(),
      startTime, endTime,
      buyIn, rebuy, cashOut, expenses,
      bigBlind, place, bounties, players,
      notes: notesParts.join("\n"),
    };
  });
}

const importBtn = document.getElementById("importBtn");
const importFile = document.getElementById("importFile");
importBtn.addEventListener("click", () => importFile.click());
importFile.addEventListener("change", () => {
  const file = importFile.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let imported;
    try {
      const rows = parseCSV(String(reader.result));
      imported = pbtRowsToSessions(rows);
    } catch (e) {
      showToast("CSV 解析失败,请检查文件格式");
      return;
    }
    if (!imported.length) { showToast("没有找到可导入的记录"); return; }
    confirmImport(imported);
  };
  reader.readAsText(file, "utf-8");
  importFile.value = "";
});

function confirmImport(imported) {
  sheetEl.innerHTML = `
    <h2>导入数据</h2>
    <p style="color:var(--text-secondary);font-size:14px;line-height:1.6">
      检测到 <strong>${imported.length}</strong> 条记录。<br/>
      导入将<strong style="color:var(--critical)">清空当前全部 ${sessions.length} 条记录</strong>并替换为这些数据,此操作不可撤销。
    </p>
    <div class="btn-row">
      <button class="btn btn-secondary" id="btn-import-cancel">取消</button>
      <button class="btn btn-primary" id="btn-import-confirm">确认替换</button>
    </div>
  `;
  showOverlay();
  document.getElementById("btn-import-cancel").addEventListener("click", closeSheet);
  document.getElementById("btn-import-confirm").addEventListener("click", () => {
    sessions = imported;
    saveSessions();
    closeSheet();
    activeTab = "sessions";
    renderView();
    showToast(`已导入 ${imported.length} 条记录`);
  });
}

// ---------- init ----------
renderView();
syncFromServer();
})();
