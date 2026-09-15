// 监测台前端：登录、配置、录入、告警复核、巡检、整改
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

let state = {
  token: localStorage.getItem("dm_token") || "",
  me: null, meta: null, points: [], devices: [], rooms: [],
};

function toast(msg, kind = "err") {
  const box = $("#toast");
  const d = document.createElement("div");
  d.className = kind;
  d.textContent = msg;
  box.appendChild(d);
  setTimeout(() => d.remove(), 4200);
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body) headers["Content-Type"] = "application/json";
  if (state.token) headers["Authorization"] = "Bearer " + state.token;
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) logout();
    const msg = {
      point_disabled: "该监测点已停用，禁止录入",
      duplicate_reading: "重复读数（同点同指标同时刻），已拒绝",
      reading_too_old: "超出 7 天补录窗口",
      reading_in_future: "测量时间不能晚于当前时间",
      metric_not_allowed_for_point: "该点不监测此指标（越点）",
      cal_expired: "校准失效",
      room_out_of_scope: "越权：无权操作该房间",
      forbidden: "权限不足",
      inspection_already_submitted: "巡检已提交，禁止重复提交",
      inspection_extra_points: "提交包含越点（不属于本巡检的监测点）",
      inspection_missing_points: "存在漏检点",
      inspection_not_started: "班次未开始，禁止越点提交",
      inspection_missed: "已过宽限期，按漏检处理",
      inspection_already_generated: "该班次巡检已生成",
      abnormal_requires_note: "异常项必须填写说明",
      alert_still_abnormal: "告警仍在异常中，恢复正常后才能复核关闭",
      rectification_blocks_rollback: "读数支撑着整改记录，禁止回滚",
    }[data.error] || data.detail || data.error || "请求失败";
    const err = new Error(msg);
    err.api = data;
    throw err;
  }
  return data;
}

function logout() {
  state.token = ""; state.me = null;
  localStorage.removeItem("dm_token");
  $("#appView").classList.add("tabhide");
  $("#loginView").classList.remove("tabhide");
}

async function login() {
  const username = $("#liUser").value.trim();
  const password = $("#liPw").value;
  const res = await fetch("/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  if (!res.ok) return toast("登录失败：用户名或密码错误");
  state.token = data.token; state.me = data.user;
  localStorage.setItem("dm_token", data.token);
  await boot();
}

function role(...roles) { return roles.includes(state.me?.role); }
function canSeeRoom(roomId) { return state.me.roomIds.includes("*") || state.me.roomIds.includes(roomId); }

async function boot() {
  if (!state.token) return;
  try {
    const me = await api("/api/me");
    state.me = me.user; state.meta = me;
    $("#loginView").classList.add("tabhide");
    $("#appView").classList.remove("tabhide");
    $("#who").textContent = `${me.user.name}（${{ admin: "管理员", safety: "安全员", technician: "技师" }[me.user.role]}）`;
    $$("nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === "entry"));
    $$("main section[data-pane]").forEach((s) => s.classList.toggle("tabhide", s.dataset.pane !== "entry"));
    // 角色可见性
    $$(".admin").forEach((el) => el.style.display = role("admin") ? "" : "none");
    $$(".safety").forEach((el) => { if (el.classList.contains("admin")) return; el.style.display = role("admin", "safety") ? "" : "none"; });
    await refreshAll();
  } catch { logout(); }
}

async function refreshAll() {
  await Promise.all([loadRooms(), loadPoints(), loadDevices(), loadStats()]);
  renderEntry(); renderConfig(); renderAlerts(); renderInspections(); renderRectifications();
  fillShifts();
}

async function loadRooms() { state.rooms = await api("/api/rooms"); }
async function loadPoints() { state.points = await api("/api/points"); }
async function loadDevices() { state.devices = await api("/api/devices"); }
async function loadStats() {
  const s = await api("/api/stats");
  $("#stats").innerHTML = [
    ["启用监测点", s.activePoints, ""],
    ["24h 读数", s.readings24h, ""],
    ["异常中告警", s.openAlerts, s.openAlerts ? "crit" : "ok"],
    ["其中严重", s.critical, s.critical ? "crit" : "ok"],
    ["待复核关闭", s.pendingReview, s.pendingReview ? "warn" : "ok"],
    ["漏检班次", s.missedInspections, s.missedInspections ? "crit" : "ok"],
    ["整改中", s.openRectifications, s.openRectifications ? "warn" : "ok"],
  ].map(([k, v, cls]) => `<div class="stat ${cls}"><b>${v}</b><span>${k}</span></div>`).join("");
}

// ---------------- 录入 ----------------
function localInputTime(d = new Date()) {
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}
function renderEntry() {
  $("#enTime").value = localInputTime();
  const pts = state.points.filter((p) => p.status === "active");
  $("#enPoint").innerHTML = pts.map((p) => `<option value="${p.id}">${p.roomName} · ${p.name}</option>`).join("");
  fillMetrics();
  fillDevices();
  loadRecent();
}
function currentPoint() { return state.points.find((p) => p.id === $("#enPoint").value); }
function fillMetrics() {
  const p = currentPoint();
  if (!p) return;
  $("#enMetrics").innerHTML = p.metrics.map((m) => {
    const meta = state.meta.metrics[m];
    const th = p.thresholds[m];
    const range = th ? `预警 ${th.warnLow ?? "−"}~${th.warnHigh ?? "−"} / 严重 ${th.critLow ?? "−"}~${th.critHigh ?? "−"}` : "";
    const last = p.latest?.[m];
    return `<div class="metric-input">
      <div>${meta.label}（${meta.unit}）<div class="muted small">${range}</div>${last ? `<div class="muted small">上次：${last.value}</div>` : ""}</div>
      <input data-metric="${m}" type="number" step="0.01" placeholder="${meta.label}读数">
    </div>`;
  }).join("");
}
function fillDevices() {
  const p = currentPoint();
  const devs = state.devices.filter((d) => d.pointIds?.includes(p?.id));
  $("#enDevice").innerHTML = `<option value="">不使用设备</option>` +
    devs.map((d) => `<option value="${d.id}" ${d.calibrationExpired ? "" : ""}>${d.name}${d.calibrationExpired ? "（校准已过期）" : ""}</option>`).join("");
  $("#enHint").textContent = devs.some((d) => d.calibrationExpired)
    ? "提示：标红设备校准已过期，用其录入会自动产生“校准失效”告警。" : "";
}
document.addEventListener("change", (e) => { if (e.target.id === "enPoint") { fillMetrics(); fillDevices(); } });

function collectReading() {
  const measuredAt = new Date($("#enTime").value).toISOString();
  const values = {};
  $$("#enMetrics input[data-metric]").forEach((inp) => {
    if (inp.value !== "") values[inp.dataset.metric] = Number(inp.value);
  });
  return { pointId: $("#enPoint").value, deviceId: $("#enDevice").value || null, measuredAt, values, note: $("#enNote").value };
}

async function submitReading() {
  const body = collectReading();
  if (!Object.keys(body.values).length) return toast("请至少填写一项读数");
  try {
    const r = await api("/api/readings", { method: "POST", body: JSON.stringify(body) });
    const abnormal = r.readings.filter((x) => x.abnormal);
    if (abnormal.length) toast(`已录入，${abnormal.length} 项异常并生成/更新告警`, "err");
    else toast("读数已录入，全部正常", "ok");
    $("#enNote").value = "";
    await Promise.all([loadPoints(), loadStats()]);
    fillMetrics(); loadRecent(); renderAlerts();
  } catch (e) { toast(e.message); }
}

async function concurrentDouble() {
  const body = collectReading();
  if (!Object.keys(body.values).length) return toast("请先填写读数");
  const key = "demo-" + Date.now();
  const headers = { "Content-Type": "application/json", Authorization: "Bearer " + state.token, "Idempotency-Key": key };
  try {
    const [a, b] = await Promise.all([
      fetch("/api/readings", { method: "POST", headers, body: JSON.stringify(body) }).then((r) => r.json()),
      fetch("/api/readings", { method: "POST", headers, body: JSON.stringify(body) }).then((r) => r.json()),
    ]);
    const dup = [a, b].filter((x) => x.repeated).length;
    toast(`并发双发完成：${dup} 个请求被识别为重复提交（accepted=${(a.accepted || 0) + (b.repeated ? 0 : (b.accepted || 0))}）`, dup ? "ok" : "err");
    await Promise.all([loadPoints(), loadStats()]); fillMetrics(); loadRecent();
  } catch (e) { toast(e.message); }
}

async function loadRecent() {
  const rows = await api("/api/readings?limit=30");
  $("#enRows").innerHTML = rows.map((r) => {
    const p = state.points.find((x) => x.id === r.pointId);
    const meta = state.meta.metrics[r.metric];
    return `<tr>
      <td>${r.measuredAt.replace("T", " ").slice(0, 16)}</td>
      <td>${p?.roomName || ""} · ${p?.name || ""}</td>
      <td>${meta.label}</td>
      <td><b>${r.value}</b> ${meta.unit}</td>
      <td>${r.deviceId ? (r.calExpired ? '<span class="pill warning">校准失效</span>' : `<span class="pill active">有效 ${r.calId || ""}</span>`) : '<span class="muted">—</span>'}</td>
      <td>${r.abnormal ? `<span class="pill ${r.severity}">${r.severity === "critical" ? "严重" : "预警"}</span>` : '<span class="pill active">正常</span>'}
        ${r.note ? `<div class="muted small">${r.note}</div>` : ""}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="6" class="muted">暂无读数</td></tr>`;
}

// ---------------- 告警 ----------------
const REASON_LABEL = {
  threshold_high: "超预警上限", threshold_low: "低于预警下限",
  threshold_high_crit: "超严重上限", threshold_low_crit: "低于严重下限",
  cal_expired: "设备校准失效/缺失",
};
async function renderAlerts() {
  const status = $("#alStatus").value, sev = $("#alSev").value;
  const list = await api(`/api/alerts?${new URLSearchParams({ status, severity: sev })}`);
  $("#alList").innerHTML = list.map((a) => `
    <div class="alert-card sev-${a.severity}">
      <div class="row" style="align-items:flex-start">
        <div style="flex:2">
          <span class="pill ${a.severity}">${a.severity === "critical" ? "严重" : "预警"}</span>
          <span class="pill ${a.status}">${{ open: "异常中", pending_review: "待复核", closed: "已关闭" }[a.status]}</span>
          <b style="margin-left:6px">${a.roomName} · ${a.pointName} · ${a.metricLabel}（${a.unit}）</b>
          <div class="muted small">异常开始 ${a.startedAt.replace("T", " ").slice(0, 16)}；最近 ${a.lastAt.replace("T", " ").slice(0, 16)}；连续异常 ${a.abnormalCount} 次${a.abnormalCount >= 3 ? "（达升级线）" : ""}</div>
          <div class="reasons">判定：${a.reasons.map((r) => REASON_LABEL[r] || r).join("、")}</div>
          ${a.status === "closed" ? `<div class="muted small">复核人：${a.reviewedByName || ""} ${(a.reviewedAt || "").replace("T", " ").slice(0, 16)} ${a.reviewNote ? "· " + a.reviewNote : ""}</div>` : ""}
          ${a.rectifications?.length ? `<div class="muted small">整改：${a.rectifications.map((r) => r.status === "closed" ? "已闭环" : "整改中").join("、")}</div>` : ""}
        </div>
        <div style="flex:1;min-width:220px">
          ${a.status === "pending_review" && role("admin", "safety") ? `
            <input placeholder="复核备注（可选）" id="closeNote-${a.id}">
            <button class="btn ok" onclick="closeAlert('${a.id}')">确认恢复，复核关闭</button>` : ""}
          ${a.status === "open" ? `<div class="muted small">仍有异常读数，需先恢复正常（再来一条正常读数后转“待复核”）。</div>` : ""}
        </div>
      </div>
    </div>`).join("") || `<div class="panel muted">没有匹配的告警</div>`;
}
window.closeAlert = async (id) => {
  const note = $(`#closeNote-${id}`)?.value || "";
  try {
    await api(`/api/alerts/${id}/close`, { method: "POST", body: JSON.stringify({ note }) });
    toast("告警已复核关闭", "ok");
    await Promise.all([renderAlerts(), loadStats(), renderRectifications()]);
  } catch (e) { toast(e.message); }
};

// ---------------- 巡检 ----------------
function fillShifts() {
  const sel = $("#inShift");
  if (sel.options.length) return;
  sel.innerHTML = state.meta.shifts.map((s) => `<option value="${s.code}">${s.name} ${s.start}-${s.end}</option>`).join("");
  $("#inDate").value = new Date().toISOString().slice(0, 10);
}
async function generateInspection() {
  try {
    const list = await api("/api/inspections/generate", {
      method: "POST", body: JSON.stringify({ date: $("#inDate").value, shiftCode: $("#inShift").value }),
    });
    toast(`已生成 ${list.length} 个房间的巡检单`, "ok");
    renderInspections();
  } catch (e) { toast(e.message); }
}
async function renderInspections() {
  const list = await api("/api/inspections");
  $("#inRows").innerHTML = list.map((x) => `
    <tr>
      <td>${x.date} ${x.shiftName}<div class="muted small">${x.windowStart.slice(11, 16)}–${x.windowEnd.slice(11, 16)}</div></td>
      <td>${x.roomName}</td>
      <td class="small">${x.windowStart.replace("T", " ").slice(0, 16)} ~<br>${x.windowEnd.replace("T", " ").slice(0, 16)}（+60 分钟宽限）</td>
      <td><span class="pill ${x.status}">${{ pending: "待检", submitted: "已提交", missed: "漏检", no_points: "无监测点" }[x.status]}</span>${x.status === "missed" ? '<div class="muted small">系统重启恢复时自动标记</div>' : ""}</td>
      <td>${inspectionActions(x)}</td>
    </tr>`).join("") || `<tr><td colspan="5" class="muted">暂无巡检</td></tr>`;
}
function inspectionActions(x) {
  const label = { pending: "待检", submitted: "已提交", missed: "漏检", no_points: "无监测点" }[x.status];
  if (x.status === "pending") {
    return `<details><summary>填写提交（${x.items.length} 点）</summary>
      ${x.items.map((it) => `<div class="metric-input"><div>${it.pointName}</div>
        <div class="row" style="gap:6px"><select data-st="${x.id}|${it.pointId}"><option value="ok">正常</option><option value="abnormal">异常</option></select>
        <input data-nt="${x.id}|${it.pointId}" placeholder="异常必填说明"></div></div>`).join("")}
      <button class="btn" onclick="submitInspection('${x.id}')">提交巡检</button></details>`;
  }
  if (x.status === "submitted") {
    const ab = x.items.filter((i) => i.status === "abnormal");
    return `<span class="small muted">提交人 ${x.items[0]?.submittedByName || ""}${ab.length ? `；异常 ${ab.length} 点：` + ab.map((i) => i.pointName).join("、") : "；全部正常"}</span>`;
  }
  return label;
}
window.submitInspection = async (id) => {
  const results = $$(`select[data-st^="${id}|"]`).map((sel) => {
    const key = sel.dataset.st;
    return { pointId: key.split("|")[1], status: sel.value, note: $(`input[data-nt="${CSS.escape(key)}"]`)?.value || "" };
  });
  try {
    await api(`/api/inspections/${id}/submit`, { method: "POST", body: JSON.stringify({ results }) });
    toast("巡检已提交", "ok");
    await Promise.all([renderInspections(), loadStats()]);
  } catch (e) {
    if (e.api?.detail?.missing) toast("漏检：缺少监测点 " + e.api.detail.missing.length + " 个");
    else if (e.api?.detail?.extra) toast("越点：包含非本巡检监测点");
    else toast(e.message);
  }
};

// ---------------- 整改 ----------------
async function renderRectifications() {
  const [list, openAlerts, pendingAlerts] = await Promise.all([
    api("/api/rectifications"), api("/api/alerts?status=open"), api("/api/alerts?status=pending_review"),
  ]);
  const rcAlerts = [...openAlerts, ...pendingAlerts];
  $("#rcAlert").innerHTML = rcAlerts.length
    ? rcAlerts.map((a) => `<option value="${a.id}">${a.roomName} · ${a.pointName} · ${a.metricLabel}（${{ critical: "严重", warning: "预警" }[a.severity]}）</option>`).join("")
    : `<option value="">暂无待整改告警</option>`;
  $("#rcRows").innerHTML = list.map((r) => `
    <tr>
      <td>${r.alert ? `${r.alert.pointName} · ${r.alert.metricLabel} <span class="pill ${r.alert.severity}">${r.alert.severity === "critical" ? "严重" : "预警"}</span>` : '<span class="muted">告警已重建</span>'}</td>
      <td>${r.action}${r.closeNote ? `<div class="muted small">闭环说明：${r.closeNote}</div>` : ""}</td>
      <td>${r.ownerName}</td>
      <td>${r.dueAt ? r.dueAt.slice(0, 10) : "—"}</td>
      <td><span class="pill ${r.status === "closed" ? "closed" : "pending_review"}">${r.status === "closed" ? "已闭环" : "整改中"}</span></td>
      <td>${r.status === "open" && role("admin", "safety") ? `<button class="btn ok" style="margin:0" onclick="closeRect('${r.id}')">整改完成闭环</button>` : ""}</td>
    </tr>`).join("") || `<tr><td colspan="6" class="muted">暂无整改记录</td></tr>`;
}
window.closeRect = async (id) => {
  const note = prompt("整改闭环说明（可选）") || "";
  try {
    await api(`/api/rectifications/${id}/close`, { method: "POST", body: JSON.stringify({ note }) });
    toast("整改已闭环", "ok");
    renderRectifications();
  } catch (e) { toast(e.message); }
};
async function createRect() {
  const alertId = $("#rcAlert").value;
  if (!alertId) return toast("请先选择一条告警（整改必须关联告警）");
  try {
    await api("/api/rectifications", {
      method: "POST",
      body: JSON.stringify({ alertId, action: $("#rcAction").value, ownerName: $("#rcOwner").value, dueAt: $("#rcDue").value ? new Date($("#rcDue").value).toISOString() : null }),
    });
    toast("整改已登记", "ok");
    $("#rcAction").value = ""; $("#rcOwner").value = "";
    renderRectifications(); loadStats();
  } catch (e) { toast(e.message); }
}

// ---------------- 配置 ----------------
function renderConfig() {
  $("#cfRScene").innerHTML = Object.entries(state.meta.scenes).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");
  $("#cfPRoom").innerHTML = state.rooms.map((r) => `<option value="${r.id}">${r.name}</option>`).join("");
  $("#cfgPoints").innerHTML = state.rooms.map((room) => `
    <details><summary><b>${room.name}</b>（${room.code} · ${state.meta.scenes[room.scene].label}）<span class="pill ${room.status}">${room.status === "active" ? "启用" : "停用"}</span></summary>
      <table><thead><tr><th>点</th><th>指标</th><th>状态</th><th>操作</th></tr></thead><tbody>
      ${state.points.filter((p) => p.roomId === room.id).map((p) => `<tr>
        <td>${p.name} <code>${p.code}</code></td>
        <td class="small">${p.metrics.map((m) => state.meta.metrics[m].label).join("、")}</td>
        <td><span class="pill ${p.status}">${p.status === "active" ? "启用" : "停用"}</span></td>
        <td>${p.status === "active"
          ? `<button class="btn sec" style="margin:0;padding:4px 10px" onclick="togglePoint('${p.id}','disabled')">停用</button>`
          : `<button class="btn ok" style="margin:0;padding:4px 10px" onclick="togglePoint('${p.id}','active')">重新启用</button>`}</td>
      </tr>`).join("")}
      </tbody></table></details>`).join("");

  $("#cfgDevices").innerHTML = state.devices.map((d) => `<tr>
    <td>${d.name} <code>${d.code}</code></td>
    <td class="small">${(d.pointIds || []).map((pid) => state.points.find((p) => p.id === pid)?.name).filter(Boolean).join("、")}</td>
    <td>${d.activeCalibration ? d.activeCalibration.validUntil.slice(0, 10) + "（" + d.activeCalibration.org + "）" : '<span class="pill warning">无有效校准</span>'}</td>
    <td>${d.status === "retired" ? '<span class="pill disabled">报废</span>' : '<span class="pill active">在用</span>'}</td></tr>`).join("");
  $("#cfCDev").innerHTML = state.devices.map((d) => `<option value="${d.id}">${d.name}</option>`).join("");

  $("#cfgThresholds").innerHTML = state.points.map((p) => `
    <details><summary><b>${p.roomName} · ${p.name}</b>（${p.metrics.map((m) => state.meta.metrics[m].label).join("、")}）</summary>
      <table><thead><tr><th>指标</th><th>预警下限</th><th>预警上限</th><th>严重下限</th><th>严重上限</th><th></th></tr></thead><tbody>
      ${p.metrics.map((m) => {
        const th = p.thresholds[m] || {};
        return `<tr>
          <td>${state.meta.metrics[m].label}</td>
          ${["warnLow", "warnHigh", "critLow", "critHigh"].map((k) => `<td><input style="width:90px" id="th-${p.id}-${m}-${k}" value="${th[k] ?? ""}" placeholder="不限"></td>`).join("")}
          <td><button class="btn sec" style="margin:0;padding:5px 10px" onclick="saveThreshold('${p.id}','${m}')">保存</button></td>
        </tr>`;
      }).join("")}
      </tbody></table></details>`).join("");
}
window.togglePoint = async (id, status) => {
  try {
    await api(`/api/points/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
    await loadPoints(); renderConfig(); renderEntry();
    toast(status === "disabled" ? "监测点已停用，录入将被拒绝" : "监测点已启用", "ok");
  } catch (e) { toast(e.message); }
};
window.saveThreshold = async (pointId, metric) => {
  const val = (k) => { const v = $(`#th-${pointId}-${metric}-${k}`).value; return v === "" ? null : Number(v); };
  const thresholds = { [metric]: { warnLow: val("warnLow"), warnHigh: val("warnHigh"), critLow: val("critLow"), critHigh: val("critHigh") } };
  try {
    await api(`/api/points/${pointId}`, { method: "PATCH", body: JSON.stringify({ thresholds }) });
    await loadPoints(); renderConfig();
    toast("阈值已更新（对之后录入生效）", "ok");
  } catch (e) { toast(e.message); }
};
async function addRoom() {
  try {
    await api("/api/rooms", { method: "POST", body: JSON.stringify({
      code: $("#cfRCode").value, name: $("#cfRName").value, scene: $("#cfRScene").value, location: $("#cfRLoc").value,
    }) });
    toast("房间已创建", "ok");
    await loadRooms(); renderConfig();
  } catch (e) { toast(e.message); }
}
async function addPoint() {
  try {
    await api("/api/points", { method: "POST", body: JSON.stringify({ roomId: $("#cfPRoom").value, code: $("#cfPCode").value, name: $("#cfPName").value }) });
    toast("监测点已创建", "ok");
    await loadPoints(); renderConfig(); renderEntry();
  } catch (e) { toast(e.message); }
}
async function addCalibration() {
  try {
    await api("/api/calibrations", { method: "POST", body: JSON.stringify({
      deviceId: $("#cfCDev").value, org: $("#cfCOrg").value, certificate: $("#cfCCert").value, result: $("#cfCResult").value,
      validFrom: new Date($("#cfCFrom").value).toISOString(), validUntil: new Date($("#cfCUntil").value).toISOString(),
    }) });
    toast("校准记录已登记", "ok");
    await loadDevices(); renderConfig();
  } catch (e) { toast(e.message); }
}

// ---------------- 事件绑定与导航 ----------------
$("#liBtn").onclick = login;
$("#liPw").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
$("#logoutBtn").onclick = () => { api("/api/auth/logout", { method: "POST" }).finally(logout); };
$("#enSubmit").onclick = submitReading;
$("#enBatch").onclick = concurrentDouble;
$("#enRefresh").onclick = () => { loadRecent(); loadPoints(); };
$("#alRefresh").onclick = renderAlerts;
$("#alStatus").onchange = renderAlerts; $("#alSev").onchange = renderAlerts;
$("#inGen").onclick = generateInspection;
$("#inSweep").onclick = async () => {
  try { const r = await api("/api/inspections/sweep", { method: "POST" }); toast(`扫描完成，新标漏检 ${r.missed} 个`, r.missed ? "err" : "ok"); renderInspections(); loadStats(); }
  catch (e) { toast(e.message); }
};
$("#rcCreate").onclick = createRect;
$("#cfRAdd").onclick = addRoom;
$("#cfPAdd").onclick = addPoint;
$("#cfCAdd").onclick = addCalibration;

$$("nav button").forEach((btn) => btn.onclick = () => {
  $$("nav button").forEach((b) => b.classList.toggle("active", b === btn));
  $$("main section[data-pane]").forEach((s) => s.classList.toggle("tabhide", s.dataset.pane !== btn.dataset.tab));
  if (btn.dataset.tab === "alerts") renderAlerts();
  if (btn.dataset.tab === "inspect") renderInspections();
  if (btn.dataset.tab === "rectify") renderRectifications();
  if (btn.dataset.tab === "config") renderConfig();
  if (btn.dataset.tab === "entry") loadRecent();
});

// 启动
if (state.token) boot();
