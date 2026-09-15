// 种子数据：房间 / 监测点 / 设备 / 校准 / 用户 / 班次
import { createHash } from "node:crypto";
import { SCENES, DEFAULT_SHIFTS } from "./domain.js";

export function hashPw(pw) {
  return createHash("sha256").update("darkroom:" + pw).digest("hex");
}

function cloneThresholds(scene) {
  return JSON.parse(JSON.stringify(SCENES[scene].thresholds));
}

export function buildSeed({ now = new Date() } = {}) {
  const iso = now.toISOString();
  const day = 86400000;
  const t = now.getTime();
  const inDays = (d) => new Date(t + d * day).toISOString();

  const rooms = [
    { id: "R1", code: "DR-01", name: "一号暗房", scene: "darkroom", location: "主楼 B1-101", status: "active", note: "涂布与晾干，避光", createdAt: iso },
    { id: "R2", code: "DR-02", name: "二号曝光区", scene: "exposure", location: "主楼 B1-102", status: "active", note: "日光/紫外曝光作业", createdAt: iso },
    { id: "R3", code: "WM-01", name: "水洗间", scene: "wash", location: "主楼 B1-103", status: "active", note: "显影后水洗、pH 管控", createdAt: iso },
  ];

  const points = [
    { id: "P1", roomId: "R1", code: "P1", name: "暗房中央", scene: "darkroom", status: "active",
      metrics: ["temp", "humidity", "uv", "airflow"], thresholds: cloneThresholds("darkroom"), createdAt: iso },
    { id: "P2", roomId: "R2", code: "P2", name: "曝光台", scene: "exposure", status: "active",
      metrics: ["temp", "humidity", "uv"], thresholds: cloneThresholds("exposure"), createdAt: iso },
    { id: "P3", roomId: "R3", code: "P3", name: "水洗槽", scene: "wash", status: "active",
      metrics: ["temp", "airflow", "ph"], thresholds: cloneThresholds("wash"), createdAt: iso },
    { id: "P4", roomId: "R1", code: "P4", name: "晾干架角（停用）", scene: "darkroom", status: "disabled",
      metrics: ["temp", "humidity"], thresholds: cloneThresholds("darkroom"), createdAt: iso, disabledAt: iso },
  ];

  const devices = [
    { id: "D1", code: "TH-01", name: "温湿度记录仪 01", metric: "temperature", status: "active", pointIds: ["P1"], createdAt: iso },
    { id: "D2", code: "UV-01", name: "紫外照度计 01", metric: "uv", status: "active", pointIds: ["P1", "P2"], createdAt: iso },
    { id: "D3", code: "AF-01", name: "热线风速仪 01", metric: "airflow", status: "active", pointIds: ["P1", "P3"], createdAt: iso },
    { id: "D4", code: "PH-01", name: "pH 计 01", metric: "ph", status: "active", pointIds: ["P3"], createdAt: iso },
    { id: "D5", code: "TH-02", name: "温湿度记录仪 02", metric: "temperature", status: "active", pointIds: ["P2"], createdAt: iso },
    { id: "D6", code: "PH-02", name: "pH 计 02（校准过期）", metric: "ph", status: "active", pointIds: ["P3"], createdAt: iso },
  ];

  const calibrations = [
    { id: "C1", deviceId: "D1", standard: "JJF 1076 温湿度校准", org: "市计量院", result: "pass",
      validFrom: inDays(-120), validUntil: inDays(60), recordedAt: inDays(-120), recordedBy: "u-admin", status: "valid", certificate: "CAL-2026-001" },
    { id: "C2", deviceId: "D2", standard: "紫外辐射照度校准规范", org: "市计量院", result: "pass",
      validFrom: inDays(-40), validUntil: inDays(200), recordedAt: inDays(-40), recordedBy: "u-admin", status: "valid", certificate: "CAL-2026-002" },
    { id: "C3", deviceId: "D3", standard: "热式风速仪检定规程", org: "厂方服务", result: "pass",
      validFrom: inDays(-200), validUntil: inDays(10), recordedAt: inDays(-200), recordedBy: "u-admin", status: "valid", certificate: "CAL-2025-088" },
    { id: "C4", deviceId: "D4", standard: "实验室 pH 计检定规程", org: "市计量院", result: "pass",
      validFrom: inDays(-30), validUntil: inDays(335), recordedAt: inDays(-30), recordedBy: "u-admin", status: "valid", certificate: "CAL-2026-009" },
    { id: "C5", deviceId: "D5", standard: "JJF 1076 温湿度校准", org: "市计量院", result: "pass",
      validFrom: inDays(-90), validUntil: inDays(90), recordedAt: inDays(-90), recordedBy: "u-admin", status: "valid", certificate: "CAL-2026-015" },
    { id: "C6", deviceId: "D6", standard: "实验室 pH 计检定规程", org: "市计量院", result: "fail",
      validFrom: inDays(-400), validUntil: inDays(-35), recordedAt: inDays(-400), recordedBy: "u-admin", status: "valid", certificate: "CAL-2025-003" },
  ];

  const users = [
    { id: "u-admin", username: "admin", passwordHash: hashPw("admin123"), name: "管理员", role: "admin", roomIds: ["*"] },
    { id: "u-safe", username: "safety", passwordHash: hashPw("safe123"), name: "安全员", role: "safety", roomIds: ["*"] },
    { id: "u-tech1", username: "tech1", passwordHash: hashPw("tech123"), name: "暗房技师甲", role: "technician", roomIds: ["R1"] },
    { id: "u-tech2", username: "tech2", passwordHash: hashPw("tech123"), name: "水洗技师乙", role: "technician", roomIds: ["R3"] },
  ];

  return {
    version: 1,
    createdAt: iso,
    users,
    tokens: {},
    rooms,
    points,
    devices,
    calibrations,
    readings: [],
    alerts: [],
    inspections: [],
    rectifications: [],
    idem: {},
    config: { shifts: DEFAULT_SHIFTS, backfillDays: 7, escalateRun: 3 },
  };
}
