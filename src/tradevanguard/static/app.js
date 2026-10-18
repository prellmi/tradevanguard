"use strict";

const form = document.getElementById("filters");
const scanButton = document.getElementById("scan-button");
const summary = document.getElementById("summary");
const table = document.getElementById("results");
const thead = table.querySelector("thead tr");
const tbody = table.querySelector("tbody");
const systemList = document.getElementById("system-list");
const autoRescan = document.getElementById("auto-rescan");
const freshness = document.getElementById("freshness");
const modeTabs = document.querySelectorAll(".modes button");

const STORAGE_KEY = "tradevanguard.filters";
const RESCAN_MS = 5 * 60 * 1000;
const ISK_SUFFIX = { k: 1e3, m: 1e6, b: 1e9 };
// In-game security colours, index = displayed security * 10.
const SEC_COLORS = ["#8d3264", "#722020", "#bc1117", "#ce440f", "#dc6d07", "#f3fd82",
                    "#71e554", "#60dba3", "#4ecef8", "#399aeb", "#2c75e1"];
// Sale prices this far above the regional average are highlighted as worth a second look.
const PREMIUM_WARNING = 0.25;

let mode = "haul";
let rescanTimer = null;

// ---------- formatting ----------

function parseIsk(text) {
  const t = String(text).trim().toLowerCase().replace(/[,_\s]/g, "");
  if (!t) return null;
  const factor = ISK_SUFFIX[t.at(-1)] ?? 1;
  const value = parseFloat(factor === 1 ? t : t.slice(0, -1)) * factor;
  return Number.isFinite(value) ? value : null;
}

function isk(value) {
  for (const [suffix, factor] of [["b", 1e9], ["m", 1e6], ["k", 1e3]]) {
    if (Math.abs(value) >= factor) return `${(value / factor).toFixed(2)}${suffix}`;
  }
  return value.toFixed(2);
}

const num = (value, digits = 0) =>
  value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });

const pct = (value, digits = 1) => `${(value * 100).toFixed(digits)}%`;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "style") node.style.cssText = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

function secBadge(security) {
  const color = SEC_COLORS[Math.max(0, Math.min(10, Math.round(security * 10)))];
  return el("span", { class: "sec", style: `color:${color}` }, security.toFixed(1));
}

function stationCell(station, jumps, jumpsLabel) {
  return el("td", { class: "text station", title: station.name },
    secBadge(station.security), station.system, " ",
    jumpsLabel === null ? null : el("span", { class: "jumps" }, `${jumps}j ${jumpsLabel}`));
}

function premiumCell(premium) {
  if (premium === null) return el("td", {}, "–");
  const text = `${premium >= 0 ? "+" : ""}${(premium * 100).toFixed(0)}%`;
  return el("td", premium > PREMIUM_WARNING ? { class: "warn", title: "Well above the regional average" } : {}, text);
}

const cell = (text, cls) => el("td", cls ? { class: cls } : {}, text);
const itemCell = (item) => el("td", { class: "text item", title: item.name }, item.name);
const orDash = (value, format) => (value === null || value === undefined ? "–" : format(value));

// ---------- modes ----------
// Each mode knows its endpoint, request parameters, table columns and detail view.

const MODES = {
  haul: {
    endpoint: "/api/scan",
    defaultSort: "profit",
    params(f) {
      const p = {
        jumps: f.jumps.value || "5",
        volume_check: String(f.volume_check.checked),
        all_routes: String(f.all_routes.checked),
        limit: "500",
      };
      if (f.cargo.value) p.cargo = f.cargo.value;
      if (f.volume_cap.value) p.volume_cap = f.volume_cap.value;
      if (parseIsk(f.isk.value)) p.isk = String(parseIsk(f.isk.value));
      return p;
    },
    rows: (body) => body.opportunities.map((o) => ({
      ...o, item_name: o.item.name, from: o.source.name, to: o.destination.name,
    })),
    summary: (body, rows) => `${body.total.toLocaleString()} opportunities` +
      (body.total > rows.length ? ` (showing ${rows.length})` : ""),
    columns: [
      { key: "item_name", label: "Item", text: true, cell: (o) => itemCell(o.item) },
      { key: "units", label: "Units", cell: (o) => cell(num(o.units)) },
      { key: "from", label: "Buy at", text: true, title: "Station where you buy from sell orders",
        cell: (o) => stationCell(o.source, o.source.jumps_from_origin, "from origin") },
      { key: "to", label: "Sell at", text: true, title: "Station where you sell to buy orders",
        cell: (o) => stationCell(o.destination, o.destination.jumps_from_source, "further") },
      { key: "total_jumps", label: "Jumps", cell: (o) => cell(String(o.total_jumps)) },
      { key: "profit", label: "Profit", cell: (o) => cell(isk(o.profit), "profit") },
      { key: "profit_per_jump", label: "ISK / jump", cell: (o) => cell(isk(o.profit_per_jump)) },
      { key: "roi", label: "ROI", cell: (o) => cell(pct(o.roi)) },
      { key: "cost", label: "Invest", cell: (o) => cell(isk(o.cost)) },
      { key: "volume_m3", label: "m³", cell: (o) => cell(num(o.volume_m3)) },
      { key: "daily_volume", label: "Sold / day", cell: (o) => cell(orDash(o.daily_volume, num)) },
      { key: "price_premium", label: "vs avg", title: "Average sale price compared with the regional 30-day average",
        cell: (o) => premiumCell(o.price_premium) },
    ],
    details: (o) => [
      ["Buy from sell orders at", `${o.source.name} (${o.source.region})`],
      ["Pay at most", `${num(o.max_buy_price, 2)} ISK per unit (the most expensive sell order you buy from)`],
      ["Sell to buy orders at", `${o.destination.name} (${o.destination.region})`],
      ["Accept at least", `${num(o.min_sell_price, 2)} ISK per unit (the lowest buy order you sell to)`],
      ["Quantity", `${num(o.units)} units · ${num(o.volume_m3, 1)} m³ (${o.item.volume} m³ each)`],
      ["Money", `invest ${isk(o.cost)} → revenue ${isk(o.revenue)} after tax → profit ${isk(o.profit)}`],
      ["Route", `${o.source.jumps_from_origin} jumps to pickup, ${o.destination.jumps_from_source} jumps to drop-off`],
      ["Market depth", o.daily_volume === null
        ? "volume check disabled"
        : `${num(o.daily_volume)} units traded per day in ${o.destination.region}`],
      ["Price check", o.average_price === null
        ? "price check unavailable (checks disabled)"
        : `selling at ${num(o.avg_sell_price, 2)} on average vs ${num(o.average_price, 2)} regional average` +
          (o.max_bid_price === null ? "" : ` · buy orders above ${num(o.max_bid_price, 2)} ignored`)],
    ],
  },

  station: {
    endpoint: "/api/station",
    defaultSort: "daily_profit",
    params(f) {
      const p = {
        jumps: f.station_jumps.value || "0",
        broker_fee: f.broker_fee.value || "0",
        min_margin: f.min_margin.value || "0",
        volume_share: f.volume_share.value || "10",
        limit: "1000",
      };
      if (parseIsk(f.station_isk.value)) p.isk = String(parseIsk(f.station_isk.value));
      return p;
    },
    rows: (body) => body.trades.map((t) => ({
      ...t, item_name: t.item.name, station_name: t.station.name,
      sell_premium: t.average_price ? t.sell_price / t.average_price - 1 : null,
    })),
    summary: (body, rows) => `${body.total.toLocaleString()} station trades` +
      (body.total > rows.length ? ` (showing ${rows.length})` : "") +
      ` from ${body.candidates.toLocaleString()} items with a wide spread`,
    columns: [
      { key: "item_name", label: "Item", text: true, cell: (t) => itemCell(t.item) },
      { key: "station_name", label: "Station", text: true,
        // Several stations can share a system, so show the station itself.
        cell: (t) => el("td", { class: "text station wide", title: t.station.name },
          secBadge(t.station.security), t.station.name,
          t.station.jumps_from_origin ? el("span", { class: "jumps" }, ` ${t.station.jumps_from_origin}j`) : null) },
      { key: "buy_price", label: "Your buy order", title: "Place a buy order at this price (just above the highest buy order)", cell: (t) => cell(num(t.buy_price, 2)) },
      { key: "sell_price", label: "Your sell order", title: "Place a sell order at this price (just below the lowest sell order)", cell: (t) => cell(num(t.sell_price, 2)) },
      { key: "margin", label: "Margin / unit", cell: (t) => cell(isk(t.margin)) },
      { key: "roi", label: "ROI", cell: (t) => cell(pct(t.roi)) },
      { key: "units_per_day", label: "Units / day", cell: (t) => cell(orDash(t.units_per_day, num)) },
      { key: "daily_profit", label: "Profit / day", cell: (t) => cell(orDash(t.daily_profit, isk), "profit") },
      { key: "capital", label: "Capital", cell: (t) => cell(orDash(t.capital, isk)) },
      { key: "daily_volume", label: "Traded / day", cell: (t) => cell(orDash(t.daily_volume, num)) },
      { key: "competition", label: "Orders", title: "Competing buy orders / sell orders at this station",
        cell: (t) => cell(`${t.bid_orders} / ${t.ask_orders}`) },
      { key: "sell_premium", label: "vs avg", title: "Your sell price compared with the regional 30-day average",
        cell: (t) => premiumCell(t.sell_premium) },
    ],
    details: (t) => [
      ["Station", `${t.station.name} (${t.station.region})`],
      ["Your buy order", `place at ${num(t.buy_price, 2)} ISK, just above the highest buy order (${num(t.best_bid, 2)}, ${t.bid_orders} buy orders)`],
      ["Your sell order", `place at ${num(t.sell_price, 2)} ISK, just below the lowest sell order (${num(t.best_ask, 2)}, ${t.ask_orders} sell orders)`],
      ["Per unit", `cost ${num(t.unit_cost, 2)} incl. broker fee → margin ${num(t.margin, 2)} after fees and tax (${pct(t.roi)})`],
      ["Per day", t.units_per_day === null ? "–"
        : `${num(t.units_per_day)} units → profit ${isk(t.daily_profit)}, capital ${isk(t.capital)}`],
      ["Market depth", t.daily_volume === null ? "–"
        : `${num(t.daily_volume)} units traded per day in ${t.station.region}`],
      ["Regional average", orDash(t.average_price, (v) => `${num(v, 2)} ISK`)],
    ],
  },
};

// Per-mode view state, so switching tabs keeps each mode's last results.
const views = Object.fromEntries(Object.entries(MODES).map(([name, m]) => [name, {
  rows: [], sortKey: m.defaultSort, sortAsc: false, openRow: null, summary: "", summaryClass: "muted",
}]));

function setMode(next) {
  mode = next;
  document.body.dataset.mode = mode;
  for (const tab of modeTabs) tab.setAttribute("aria-selected", String(tab.dataset.mode === mode));
  // Hidden fields must not block submission of the visible form.
  for (const input of form.querySelectorAll(".haul-only input, .station-only input")) {
    input.disabled = !input.closest(`.${mode}-only`);
  }
  summary.className = views[mode].summaryClass;
  summary.textContent = views[mode].summary;
  render();
}

for (const tab of modeTabs) {
  tab.addEventListener("click", () => {
    setMode(tab.dataset.mode);
    saveFilters();
  });
}

// ---------- form state ----------

function saveFilters() {
  const data = { mode };
  for (const input of form.elements) {
    if (!input.name) continue;
    data[input.name] = input.type === "checkbox" ? input.checked : input.value;
  }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch { /* storage unavailable */ }
}

function loadFilters() {
  let data;
  try { data = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); } catch { data = null; }
  if (!data) return;
  for (const [name, value] of Object.entries(data)) {
    const input = form.elements[name];
    if (!input) continue;
    if (input.type === "checkbox") input.checked = Boolean(value);
    else input.value = value;
  }
  if (data.mode in MODES) mode = data.mode;
}

function scanParams() {
  const f = form.elements;
  const params = new URLSearchParams({
    origin: f.origin.value.trim(),
    min_security: f.min_security.value,
    sales_tax: f.sales_tax.value || "0",
    min_profit: String(parseIsk(f.min_profit.value) ?? 0),
    price_check: String(f.price_check.checked),
    ...MODES[mode].params(f),
  });
  if (f.max_price_ratio.value) params.set("max_price_ratio", f.max_price_ratio.value);
  return params;
}

// ---------- system autocomplete ----------

let suggestTimer = null;
form.origin.addEventListener("input", () => {
  clearTimeout(suggestTimer);
  const q = form.origin.value.trim();
  if (!q) return;
  suggestTimer = setTimeout(async () => {
    try {
      const resp = await fetch(`/api/systems?${new URLSearchParams({ q, limit: "15" })}`);
      if (!resp.ok) return;
      systemList.replaceChildren(...(await resp.json()).map((s) =>
        el("option", { value: s.name }, `${s.security.toFixed(1)} · ${s.region}`)));
    } catch { /* ignore network hiccups while typing */ }
  }, 150);
});

// ---------- scanning ----------

function showSummary(view, text, cls) {
  view.summary = text;
  view.summaryClass = cls;
  if (view === views[mode]) {
    summary.textContent = text;
    summary.className = cls;
  }
}

async function scan() {
  if (!form.reportValidity()) return;
  saveFilters();
  const scanMode = mode;
  const view = views[scanMode];
  const config = MODES[scanMode];
  scanButton.disabled = true;
  const started = performance.now();
  const hint = scanMode === "station"
    ? "the first station scan of the day also downloads market history and can take a few minutes"
    : "the first scan of a region downloads all its orders and can take up to a minute";
  const ticker = setInterval(() => {
    showSummary(view, `Scanning… ${((performance.now() - started) / 1000).toFixed(0)}s (${hint})`, "muted");
  }, 250);

  try {
    const resp = await fetch(`${config.endpoint}?${scanParams()}`);
    const body = await resp.json();
    if (!resp.ok) throw new Error(typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail));
    view.rows = config.rows(body);
    view.openRow = null;
    clearInterval(ticker);
    showSummary(view,
      `${body.origin.name} (${body.origin.security.toFixed(1)}) · ${config.summary(body, view.rows)} · ` +
      `${body.order_count.toLocaleString()} orders in ${body.regions.join(", ")} · ${body.elapsed}s`, "muted");
    if (scanMode === mode) render();
    refreshFreshness();
  } catch (err) {
    clearInterval(ticker);
    showSummary(view, `Scan failed: ${err.message}`, "error");
  } finally {
    scanButton.disabled = false;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  scan();
});

autoRescan.addEventListener("change", () => {
  clearInterval(rescanTimer);
  if (autoRescan.checked) rescanTimer = setInterval(() => { if (!scanButton.disabled) scan(); }, RESCAN_MS);
});

// ---------- table ----------

function sortValue(row, key) {
  // Competition sorts by the total number of competing orders.
  return key === "competition" ? row.bid_orders + row.ask_orders : row[key];
}

function detailRow(row, columnCount) {
  const copy = el("button", { class: "small", type: "button" }, "Copy item name");
  copy.addEventListener("click", async (event) => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(row.item.name);
      copy.textContent = "Copied";
    } catch {
      copy.textContent = "Copy failed";
    }
    setTimeout(() => { copy.textContent = "Copy item name"; }, 1500);
  });
  const entries = MODES[mode].details(row).flatMap(([label, value]) => [el("dt", {}, label), el("dd", {}, value)]);
  return el("tr", { class: "detail" }, el("td", { colspan: String(columnCount) },
    el("dl", { class: "detail-grid" }, ...entries),
    el("div", { class: "detail-actions" }, copy)));
}

function render() {
  const view = views[mode];
  const { columns } = MODES[mode];
  table.hidden = view.rows.length === 0;

  thead.replaceChildren(...columns.map((col) => {
    const sorted = col.key === view.sortKey;
    const th = el("th", {
      class: [col.text ? "text" : "", sorted ? "sorted" : "", sorted && view.sortAsc ? "asc" : ""].join(" ").trim(),
      ...(col.title ? { title: col.title } : {}),
    }, col.label);
    th.addEventListener("click", () => {
      if (col.key === view.sortKey) view.sortAsc = !view.sortAsc;
      else {
        view.sortKey = col.key;
        view.sortAsc = Boolean(col.text);  // text columns start A-Z, numbers high-to-low
      }
      render();
    });
    return th;
  }));

  const sorted = [...view.rows].sort((a, b) => {
    const x = sortValue(a, view.sortKey) ?? -Infinity;
    const y = sortValue(b, view.sortKey) ?? -Infinity;
    const result = typeof x === "string" ? x.localeCompare(y) : x - y;
    return view.sortAsc ? result : -result;
  });
  const fragment = document.createDocumentFragment();
  for (const row of sorted) {
    const tr = el("tr", { class: `row${row === view.openRow ? " open" : ""}` }, ...columns.map((col) => col.cell(row)));
    tr.addEventListener("click", () => {
      view.openRow = view.openRow === row ? null : row;
      render();
    });
    fragment.append(tr);
    if (row === view.openRow) fragment.append(detailRow(row, columns.length));
  }
  tbody.replaceChildren(fragment);
}

// ---------- data freshness ----------

async function refreshFreshness() {
  try {
    const { regions } = await (await fetch("/api/status")).json();
    if (!regions.length) { freshness.textContent = "No market data loaded yet"; return; }
    const soonest = Math.min(...regions.map((r) => r.expires_in));
    const orders = regions.reduce((sum, r) => sum + r.orders, 0);
    freshness.textContent = `${orders.toLocaleString()} orders in memory · ` +
      (soonest > 0 ? `next ESI update in ${Math.ceil(soonest / 60)} min` : "refreshing…");
  } catch {
    freshness.textContent = "";
  }
}

loadFilters();
setMode(mode);
refreshFreshness();
setInterval(refreshFreshness, 30_000);
