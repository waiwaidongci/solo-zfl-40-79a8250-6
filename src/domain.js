// 领域规则：场景阈值、校准有效期、读数校验、告警状态机、班次窗口
import { httpError } from "./store.js";

export const METRICS = {
  temp: { label: "温度", unit: "°C" },
  humidity: { label: "相对湿度", unit: "%RH" },
  uv: { label: "紫外强度", unit: "μW/cm²" },
  airflow: { label: "通风风速", unit: "m/s" },
  ph: { label: "水洗酸碱度", unit: "pH" },
};

// 各场景的默认阈值；null 端表示不限。边界值等于阈值时算正常，超出才异常。
export const SCENES = {
  darkroom: {
    label: "暗房（涂布/晾干）",
    metrics: ["temp", "humidity", "uv", "airflow"],
    thresholds: {
      temp: { warnLow: 15, warnHigh: 24, critLow: 10, critHigh: 28 },
      humidity: { warnLow: 40, warnHigh: 60, critLow: 30, critHigh: 70 },
      uv: { warnLow: null, warnHigh: 0.2, critLow: null, critHigh: 1 },
      airflow: { warnLow: 0.3, warnHigh: null, critLow: 0.15, critHigh: null },
    },
  },
  exposure: {
    label: "曝光作业区",
    metrics: ["temp", "humidity", "uv"],
    thresholds: {
      temp: { warnLow: 15, warnHigh: 28, critLow: 10, critHigh: 32 },
      humidity: { warnLow: 35, warnHigh: 65, critLow: 25, critHigh: 75 },
      uv: { warnLow: null, warnHigh: 8000, critLow: null, critHigh: 10000 },
    },
  },
  wash: {
    label: "水洗区",
    metrics: ["temp", "airflow", "ph"],
    thresholds: {
      temp: { warnLow: 15, warnHigh: 26, critLow: 10, critHigh: 30 },
      airflow: { warnLow: 0.3, warnHigh: null, critLow: 0.15, critHigh: null },
      ph: { warnLow: 6.5, warnHigh: 8.0, critLow: 6.0, critHigh: 8.5 },
    },
  },
};

export const ESCALATE_RUN = 3; // 连续 3 次异常升级为严重
export const BACKFILL_WINDOW_MS = 7 * 24 * 3600 * 1000;
export const FUTURE_TOLERANCE_MS = 2 * 60 * 1000;
export const SUBMIT_GRACE_MS = 60 * 60 * 1000;

export const DEFAULT_SHIFTS = [
  { code: "M", name: "早班", start: "06:00", end: "14:00" },
  { code: "A", name: "中班", start: "14:00", end: "22:00" },
  { code: "N", name: "夜班", start: "22:00", end: "06:00" },
];

export function nowIso(now = new Date()) {
  return now.toISOString();
}

export function activeCalibration(db, deviceId, at) {
  const t = new Date(at).getTime();
  const list = db.calibrations
    .filter((c) => c.deviceId === deviceId && c.status === "valid")
    .filter((c) => new Date(c.validFrom).getTime() <= t && t <= new Date(c.validUntil).getTime())
    .sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt));
  return list[0] || null;
}

// 返回 { normal:boolean, severity:'normal'|'warning'|'critical', reasons:[] }
export function evaluateMetric(value, th) {
  const reasons = [];
  let critical = false;
  let warning = false;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { normal: false, severity: "critical", reasons: ["invalid_value"] };
  }
  if (th) {
    if (th.critLow != null && value < th.critLow) { critical = true; reasons.push("threshold_low_crit"); }
    else if (th.critHigh != null && value > th.critHigh) { critical = true; reasons.push("threshold_high_crit"); }
    else if (th.warnLow != null && value < th.warnLow) { warning = true; reasons.push("threshold_low"); }
    else if (th.warnHigh != null && value > th.warnHigh) { warning = true; reasons.push("threshold_high"); }
  }
  const severity = critical ? "critical" : warning ? "warning" : "normal";
  return { normal: severity === "normal", severity, reasons };
}

export function getPoint(db, pointId) {
  const p = db.points.find((x) => x.id === pointId);
  if (!p) throw httpError(404, "point_not_found");
  return p;
}

export function assertPointActive(db, pointId) {
  const p = getPoint(db, pointId);
  if (p.status !== "active") throw httpError(409, "point_disabled", "停用监测点禁止录入");
  return p;
}

// 展开一次读数提交为逐指标记录（不落库），完成阈值与校准判定
export function buildReadingRecords(db, input, { now = new Date() } = {}) {
  if (!input || typeof input !== "object") throw httpError(400, "invalid_body");
  const point = assertPointActive(db, input.pointId);
  if (!input.measuredAt || Number.isNaN(new Date(input.measuredAt).getTime())) {
    throw httpError(400, "invalid_measured_at");
  }
  const at = new Date(input.measuredAt).getTime();
  if (at > now.getTime() + FUTURE_TOLERANCE_MS) throw httpError(409, "reading_in_future");
  if (at < now.getTime() - BACKFILL_WINDOW_MS) throw httpError(409, "reading_too_old", "超出 7 天补录窗口");
  const values = input.values || {};
  const allowed = point.metrics;
  const keys = Object.keys(values).filter((k) => METRICS[k]);
  if (!keys.length) throw httpError(400, "no_metric_values");
  const deviceId = input.deviceId || null;
  if (deviceId && !db.devices.some((d) => d.id === deviceId)) throw httpError(400, "device_not_found");
  let cal = null;
  if (deviceId) {
    cal = activeCalibration(db, deviceId, input.measuredAt);
    if (!cal) {
      // 仍允许读数落库，但自动产生“校准失效”异常
    }
  }
  return keys.map((metric) => {
    if (!allowed.includes(metric)) {
      throw httpError(409, "metric_not_allowed_for_point", `${point.name} 不监测 ${METRICS[metric].label}`);
    }
    const value = Number(values[metric]);
    const th = point.thresholds?.[metric] || null;
    const ev = evaluateMetric(value, th);
    const calExpired = deviceId ? !cal : false;
    const reasons = [...ev.reasons];
    if (calExpired) reasons.push("cal_expired");
    const abnormal = !ev.normal || calExpired;
    let severity = ev.severity;
    if (calExpired && ev.severity === "normal") severity = "warning";
    return {
      pointId: point.id,
      metric,
      value,
      measuredAt: input.measuredAt,
      deviceId,
      calId: cal ? cal.id : null,
      calExpired,
      thresholdSnapshot: th,
      abnormal,
      severity: abnormal ? severity : "normal",
      reasons,
      note: input.note || "",
      recordedAt: nowIso(now),
    };
  });
}

// 重复提交：同一点、同一指标、同一测量时刻
export function assertNotDuplicate(db, rec) {
  const dup = db.readings.some(
    (r) => r.pointId === rec.pointId && r.metric === rec.metric && r.measuredAt === rec.measuredAt
  );
  if (dup) throw httpError(409, "duplicate_reading", `${rec.measuredAt} 已有 ${METRICS[rec.metric].label} 读数`);
}

// 按 (point, metric) 从全部历史读数重建当前告警（乱序补录、删除回滚后结果一致）
// 语义：人工“复核关闭”是事件边界；边界之后的异常（可被零星正常读数隔断）
// 同属一个事件：最后一条读数异常 → open（异常中），最后一条正常 → pending_review（待复核）。
function rebuildEpisodes(db, pointId, metric, genId) {
  const rows = db.readings
    .filter((r) => r.pointId === pointId && r.metric === metric)
    .sort((a, b) => new Date(a.measuredAt) - new Date(b.measuredAt) ||
      new Date(a.recordedAt) - new Date(b.recordedAt) || a.id.localeCompare(b.id));

  const rectAlertIds = new Set(db.rectifications.map((r) => r.alertId));
  const old = db.alerts
    .filter((a) => a.pointId === pointId && a.metric === metric)
    .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt) || a.id.localeCompare(b.id));

  // 最近一次人工关闭时刻作为边界
  let boundary = -Infinity;
  for (const c of old.filter((a) => a.status === "closed" && !a.supersede)) {
    boundary = Math.max(boundary, new Date(c.lastAt).getTime());
  }

  const result = old.filter((a) => a.status === "closed"); // 已复核关闭的历史事件原样保留
  const abnormal = rows.filter((r) => r.abnormal && new Date(r.measuredAt).getTime() > boundary);

  if (abnormal.length) {
    const lastRowAbnormal = rows[rows.length - 1].abnormal;
    const hasCrit = abnormal.some((r) => r.severity === "critical");
    const seg = {
      pointId,
      metric,
      startedAt: abnormal[0].measuredAt,
      lastAt: abnormal[abnormal.length - 1].measuredAt,
      readingIds: abnormal.map((r) => r.id),
      abnormalCount: abnormal.length,
      severity: hasCrit || abnormal.length >= ESCALATE_RUN ? "critical" : "warning",
      reasons: [...new Set(abnormal.flatMap((r) => r.reasons))],
      status: lastRowAbnormal ? "open" : "pending_review",
    };
    const prev = old.find((a) => a.status !== "closed");
    if (prev) result.push({ ...prev, ...seg, id: prev.id, createdAt: prev.createdAt });
    else result.push({ id: genId(), ...seg, createdAt: new Date().toISOString() });
  } else {
    // 异常读数全部消失（如回滚）：无整改引用的待办事件直接移除；有整改引用则保留为关闭，避免悬空
    for (const o of old.filter((a) => a.status !== "closed")) {
      if (rectAlertIds.has(o.id)) result.push({ ...o, status: "closed", supersede: true });
    }
  }
  return result;
}

export function rebuildAlerts(db, affected, genId) {
  const keys = new Set(affected.map((a) => a.pointId + "|" + a.metric));
  for (const key of keys) {
    const [pointId, metric] = key.split("|");
    const fresh = rebuildEpisodes(db, pointId, metric, genId);
    db.alerts = db.alerts.filter((a) => !(a.pointId === pointId && a.metric === metric));
    db.alerts.push(...fresh);
  }
}

// ---------- 巡检班次 ----------
export function shiftWindow(dateStr, shift) {
  const [sh, sm] = shift.start.split(":").map(Number);
  const [eh, em] = shift.end.split(":").map(Number);
  const start = new Date(`${dateStr}T${shift.start}:00`);
  let end = new Date(`${dateStr}T${shift.end}:00`);
  if (end <= start) end = new Date(end.getTime() + 24 * 3600 * 1000); // 夜班跨天
  return { start, end, sh, sm, eh, em };
}

export function getShift(db, code) {
  const s = (db.config.shifts || DEFAULT_SHIFTS).find((x) => x.code === code);
  if (!s) throw httpError(400, "unknown_shift");
  return s;
}

// 启动恢复：窗口（含宽限期）已过仍待检的巡检 → 漏检
export function sweepMissedInspections(db, { now = new Date() } = {}) {
  let n = 0;
  for (const ins of db.inspections) {
    if (ins.status !== "pending") continue;
    const end = new Date(ins.windowEnd).getTime() + SUBMIT_GRACE_MS;
    if (end < now.getTime()) {
      ins.status = "missed";
      ins.missedAt = nowIso(now);
      n++;
    }
  }
  return n;
}

export function roleAtOrAbove(role, ...allowed) {
  return allowed.includes(role);
}
