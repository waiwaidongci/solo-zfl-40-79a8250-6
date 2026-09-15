// API/集成测试：越权、并发录入、乱序补录、回滚、告警升级复核、巡检校验、重启恢复
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { JsonStore } from "../src/store.js";
import { buildSeed } from "../src/seed.js";
import { createApp } from "../src/routes.js";
import { sweepMissedInspections } from "../src/domain.js";

function tmpFile(tag) {
  return `/tmp/dm-test-${tag}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`;
}

async function makeHarness(tag) {
  const file = tmpFile(tag);
  const store = new JsonStore(file, () => buildSeed({ now: new Date("2026-09-15T10:00:00Z") }));
  await store.load();
  const app = createApp(store);

  async function call(method, path, body, { token = null, idem = null, now = "2026-09-15T10:00:00Z" } = {}) {
    const headers = new Map([["x-now", now]]);
    if (token) headers.set("authorization", "Bearer " + token);
    if (idem) headers.set("idempotency-key", idem);
    let payload = null;
    if (body !== undefined) {
      headers.set("content-type", "application/json");
      payload = Buffer.from(JSON.stringify(body));
    }
    const req = {
      method,
      url: path,
      headers: Object.fromEntries(headers),
      async *[Symbol.asyncIterator]() { if (payload) yield payload; },
    };
    const captured = { chunks: [] };
    const res = {
      writeHead(s, h) { captured.status = s; captured.headers = h || {}; },
      end(c) { captured.body = c; },
    };
    await app(req, res);
    let json = null;
    try { json = JSON.parse(captured.body); } catch {}
    return { status: captured.status, json };
  }

  async function login(username, password) {
    const r = await call("POST", "/api/auth/login", { username, password });
    assert.equal(r.status, 200, `login ${username}: ${JSON.stringify(r.json)}`);
    return r.json.token;
  }

  const admin = await login("admin", "admin123");
  const safety = await login("safety", "safe123");
  const tech1 = await login("tech1", "tech123");
  const tech2 = await login("tech2", "tech123");

  return {
    file, store, call, tokens: { admin, safety, tech1, tech2 },
    cleanup() { rmSync(file, { force: true }); },
  };
}

// 读数快捷构造
function reading(pointId, metric, value, measuredAt, deviceId = null, extra = {}) {
  return { pointId, deviceId, measuredAt, values: { [metric]: value }, ...extra };
}
const T = "2026-09-15T08:%M:00Z";
const at = (h, m = 0) => `2026-09-15T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;

// ---------------- 阈值边界 ----------------
test("阈值边界：等于阈值正常，越过才告警；连续异常升级到严重", async () => {
  const h = await makeHarness("edge");
  try {
    const { call, tokens } = h;
    // P1 暗房 uv warnHigh=0.2 critHigh=1
    let r = await call("POST", "/api/readings", reading("P1", "uv", 0.2, at(7, 1)), { token: tokens.admin });
    assert.equal(r.status, 201); assert.equal(r.json.readings[0].abnormal, false);
    r = await call("POST", "/api/readings", reading("P1", "uv", 0.21, at(7, 2)), { token: tokens.admin });
    assert.equal(r.json.readings[0].severity, "warning");
    let alerts = r.json.alerts.filter((a) => a.metric === "uv");
    assert.equal(alerts[0].severity, "warning");
    assert.equal(alerts[0].status, "open");
    assert.equal(alerts[0].abnormalCount, 1);
    // 第二次连续异常 → 仍预警
    r = await call("POST", "/api/readings", reading("P1", "uv", 0.3, at(7, 3)), { token: tokens.admin });
    alerts = r.json.alerts.filter((a) => a.metric === "uv");
    assert.equal(alerts[0].abnormalCount, 2);
    assert.equal(alerts[0].severity, "warning");
    // 第三次连续异常 → 升级严重
    r = await call("POST", "/api/readings", reading("P1", "uv", 0.35, at(7, 4)), { token: tokens.admin });
    alerts = r.json.alerts.filter((a) => a.metric === "uv");
    assert.equal(alerts[0].abnormalCount, 3);
    assert.equal(alerts[0].severity, "critical");
    // 一次越过严重阈值立即严重
    r = await call("POST", "/api/readings", reading("P1", "temp", 30, at(7, 5)), { token: tokens.admin });
    const aT = r.json.alerts.find((a) => a.metric === "temp");
    assert.equal(aT.severity, "critical");
    // 下限边界
    r = await call("POST", "/api/readings", reading("P3", "ph", 6.5, at(7, 6)), { token: tokens.admin });
    assert.equal(r.json.readings.find((x) => x.metric === "ph").abnormal, false);
    r = await call("POST", "/api/readings", reading("P3", "ph", 6.49, at(7, 7)), { token: tokens.admin });
    assert.equal(r.json.readings.find((x) => x.metric === "ph").severity, "warning");
  } finally { h.cleanup(); }
});

// ---------------- 校准失效 ----------------
test("校准失效：过期校准的设备读数入库但产生 cal_expired 告警；有效设备不报", async () => {
  const h = await makeHarness("cal");
  try {
    const { call, tokens } = h;
    // D6（pH-02）校准已于 -35 天过期；P3 水洗槽 pH 正常 7.0
    let r = await call("POST", "/api/readings", reading("P3", "ph", 7.0, at(8, 1), "D6"), { token: tokens.admin });
    assert.equal(r.status, 201);
    const rec = r.json.readings.find((x) => x.metric === "ph");
    assert.equal(rec.calExpired, true);
    assert.equal(rec.abnormal, true);
    assert.ok(rec.reasons.includes("cal_expired"));
    // D4 校准有效
    r = await call("POST", "/api/readings", reading("P3", "ph", 7.1, at(8, 2), "D4"), { token: tokens.admin });
    // 第一次读数会让 D6 异常段恢复 → 待复核；D4 读数本身正常
    assert.equal(r.json.readings[0].calExpired, false);
    const uv = r.json.alerts.find((a) => a.metric === "ph");
    assert.equal(uv.status, "pending_review");
    // 未登记设备
    r = await call("POST", "/api/readings", reading("P3", "ph", 7.2, at(8, 3), "D999"), { token: tokens.admin });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "device_not_found");
  } finally { h.cleanup(); }
});

// ---------------- 停用监测点 ----------------
test("停用监测点：录入被拒绝；重新启用后可录", async () => {
  const h = await makeHarness("disabled");
  try {
    const { call, tokens } = h;
    let r = await call("POST", "/api/readings", reading("P4", "temp", 20, at(8, 1)), { token: tokens.admin });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, "point_disabled");
    r = await call("PATCH", "/api/points/P4", { status: "active" }, { token: tokens.admin });
    assert.equal(r.status, 200);
    r = await call("POST", "/api/readings", reading("P4", "temp", 20, at(8, 2)), { token: tokens.admin });
    assert.equal(r.status, 201);
  } finally { h.cleanup(); }
});

// ---------------- 恢复→待复核→关闭 ----------------
test("恢复转待复核，open 不能关闭，复核关闭后再次异常重开", async () => {
  const h = await makeHarness("review");
  try {
    const { call, tokens } = h;
    await call("POST", "/api/readings", reading("P1", "humidity", 61, at(8, 1)), { token: tokens.admin });
    let r = await call("POST", "/api/readings", reading("P1", "humidity", 50, at(8, 2)), { token: tokens.admin });
    let a = r.json.alerts.find((x) => x.metric === "humidity");
    assert.equal(a.status, "pending_review");
    const aid = a.id;
    // 技师不能复核
    r = await call("POST", `/api/alerts/${aid}/close`, { note: "" }, { token: tokens.tech1 });
    assert.equal(r.status, 403);
    // 再来异常 → 重开
    r = await call("POST", "/api/readings", reading("P1", "humidity", 62, at(8, 3)), { token: tokens.admin });
    a = r.json.alerts.find((x) => x.id === aid);
    assert.equal(a.status, "open");
    // open 不能关闭
    r = await call("POST", `/api/alerts/${aid}/close`, {}, { token: tokens.admin });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, "alert_still_abnormal");
    // 正常 → 待复核 → 安全员关闭
    await call("POST", "/api/readings", reading("P1", "humidity", 50, at(8, 4)), { token: tokens.admin });
    r = await call("POST", `/api/alerts/${aid}/close`, { note: "空调已修复" }, { token: tokens.safety });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, "closed");
    assert.equal(r.json.reviewedByName, "安全员");
  } finally { h.cleanup(); }
});

// ---------------- 越权 ----------------
test("越权：垂直（技师改配置）与水平（暗房技师录入水洗间）都拒绝", async () => {
  const h = await makeHarness("authz");
  try {
    const { call, tokens } = h;
    let r = await call("POST", "/api/rooms", { code: "X", name: "x", scene: "wash" }, { token: tokens.tech1 });
    assert.equal(r.status, 403);
    // 水平越权：tech1 只属于 R1，P3 属于 R3
    r = await call("POST", "/api/readings", reading("P3", "ph", 7.0, at(8, 1)), { token: tokens.tech1 });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, "room_out_of_scope");
    // 自己房间可以
    r = await call("POST", "/api/readings", reading("P1", "temp", 20, at(8, 1)), { token: tokens.tech1 });
    assert.equal(r.status, 201);
    // tech2 看不到 R1 的读数
    r = await call("GET", "/api/readings?pointId=P1", undefined, { token: tokens.tech2 });
    assert.equal(r.json.length, 0);
    // 无 token
    r = await call("GET", "/api/alerts");
    assert.equal(r.status, 401);
  } finally { h.cleanup(); }
});

// ---------------- 重复 / 并发 ----------------
test("并发录入：同点同指标同时刻串行后第二个拒绝；幂等键并发只生效一次", async () => {
  const h = await makeHarness("conc");
  try {
    const { call, tokens } = h;
    const payload = reading("P1", "temp", 20, at(8, 1));
    const [r1, r2] = await Promise.all([
      call("POST", "/api/readings", payload, { token: tokens.admin }),
      call("POST", "/api/readings", payload, { token: tokens.admin }),
    ]);
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 409);
    assert.equal(r2.json.error, "duplicate_reading");

    // 幂等键：两个并发请求都返回同一结果，只入库一次
    const payload2 = reading("P1", "temp", 21, at(8, 2));
    const [a, b] = await Promise.all([
      call("POST", "/api/readings", payload2, { token: tokens.admin, idem: "key-1" }),
      call("POST", "/api/readings", payload2, { token: tokens.admin, idem: "key-1" }),
    ]);
    assert.equal(a.status, 201);
    assert.equal(b.json.repeated, true);
    const list = await call("GET", "/api/readings?pointId=P1&metric=temp", undefined, { token: tokens.admin });
    assert.equal(list.json.length, 2);
  } finally { h.cleanup(); }
});

// ---------------- 乱序补录 ----------------
test("乱序补录：后补的历史读数按测量时刻重建告警段，连续计数正确", async () => {
  const h = await makeHarness("backfill");
  try {
    const { call, tokens } = h;
    // 先提交两条“当前”正常
    await call("POST", "/api/readings", reading("P1", "humidity", 50, at(9, 0)), { token: tokens.admin });
    await call("POST", "/api/readings", reading("P1", "humidity", 50, at(9, 5)), { token: tokens.admin });
    // 乱序补录 8:00 三次异常（连续，第三升级）
    for (const m of [0, 1, 2]) {
      const r = await call("POST", "/api/readings", reading("P1", "humidity", 61, at(8, m)), { token: tokens.admin });
      const a = r.json.alerts.find((x) => x.metric === "humidity");
      if (m < 2) assert.equal(a.severity, "warning");
      else assert.equal(a.severity, "critical");
    }
    // 再补一条更早的正常读数：异常事件仍为 8:00-8:02 连续 3 次（人工未关闭前不分裂）
    const r = await call("POST", "/api/readings", reading("P1", "humidity", 48, at(7, 55)), { token: tokens.admin });
    const alerts = r.json.alerts.filter((x) => x.metric === "humidity");
    assert.equal(alerts.length, 1);
    const episode = alerts[0];
    assert.equal(episode.abnormalCount, 3);
    assert.equal(episode.severity, "critical");
    assert.equal(episode.startedAt, at(8, 0));
    assert.equal(episode.status, "pending_review"); // 最新一条读数（9:05）正常
    // 补录超出 7 天窗口拒绝
    const old = await call("POST", "/api/readings", reading("P1", "humidity", 50, "2026-09-01T00:00:00Z"), { token: tokens.admin });
    assert.equal(old.status, 409);
    assert.equal(old.json.error, "reading_too_old");
    // 未来时间拒绝
    const future = await call("POST", "/api/readings", reading("P1", "humidity", 50, "2026-09-15T12:00:00Z"), { token: tokens.admin });
    assert.equal(future.status, 409);
  } finally { h.cleanup(); }
});

// ---------------- 批量事务与回滚 ----------------
test("批量：任一项非法全部回滚；rollback 删除并重建告警，关联整改时拒绝", async () => {
  const h = await makeHarness("rollback");
  try {
    const { call, tokens } = h;
    // 第二项越指标（P3 水洗间不监测 uv）→ 整批 409，无读数落库
    let r = await call("POST", "/api/readings/batch", {
      items: [
        reading("P3", "ph", 7.1, at(8, 1)),
        reading("P3", "uv", 100, at(8, 2)),
      ],
    }, { token: tokens.admin });
    assert.equal(r.status, 409);
    const list = await call("GET", "/api/readings?pointId=P3", undefined, { token: tokens.admin });
    assert.equal(list.json.length, 0);
    // 批内重复也回滚
    r = await call("POST", "/api/readings/batch", {
      items: [
        reading("P1", "temp", 20, at(8, 1)),
        reading("P1", "temp", 21, at(8, 1)),
      ],
    }, { token: tokens.admin });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, "duplicate_reading_in_batch");

    // 正常批量 + 回滚
    await call("POST", "/api/readings/batch", {
      items: [
        reading("P1", "humidity", 62, at(8, 1)),
        reading("P1", "humidity", 63, at(8, 2)),
        reading("P1", "humidity", 64, at(8, 3)),
      ],
    }, { token: tokens.admin });
    let alerts = await call("GET", "/api/alerts?pointId=P1", undefined, { token: tokens.admin });
    let ep = alerts.json.find((a) => a.metric === "humidity");
    assert.equal(ep.severity, "critical");
    assert.equal(ep.abnormalCount, 3);
    // 回滚其中两条 → 剩 1 次异常，级别回落到 warning
    const rows = (await call("GET", "/api/readings?pointId=P1&metric=humidity", undefined, { token: tokens.admin })).json;
    const del = rows.filter((x) => [at(8, 2), at(8, 3)].includes(x.measuredAt)).map((x) => x.id);
    r = await call("POST", "/api/readings/rollback", { ids: del }, { token: tokens.admin });
    assert.equal(r.status, 200);
    assert.equal(r.json.rolledBack, 2);
    alerts = await call("GET", "/api/alerts?pointId=P1", undefined, { token: tokens.admin });
    ep = alerts.json.find((a) => a.metric === "humidity");
    assert.equal(ep.abnormalCount, 1);
    assert.equal(ep.severity, "warning");

    // 关联整改后阻止回滚
    await call("POST", "/api/rectifications", { alertId: ep.id, action: "除湿" }, { token: tokens.admin });
    r = await call("POST", "/api/readings/rollback", {
      pointId: "P1", metric: "humidity", from: at(8, 0), to: at(8, 59),
    }, { token: tokens.admin });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, "rectification_blocks_rollback");
    // 技师无权回滚
    r = await call("POST", "/api/readings/rollback", { ids: [] }, { token: tokens.tech1 });
    assert.equal(r.status, 403);
  } finally { h.cleanup(); }
});

// ---------------- 巡检：生成/越点/重复/漏检 ----------------
test("巡检：按班生成、越点与漏检拒绝、重复提交拒绝、逾期漏检恢复", async () => {
  const h = await makeHarness("inspect");
  try {
    const { call, tokens, file, store } = h;
    const date = "2026-09-15";
    // 技师不能生成
    let r = await call("POST", "/api/inspections/generate", { date, shiftCode: "M" }, { token: tokens.tech1 });
    assert.equal(r.status, 403);
    // 早班 06:00-14:00
    r = await call("POST", "/api/inspections/generate", { date, shiftCode: "M" }, { token: tokens.safety, now: at(7) });
    assert.equal(r.status, 201);
    assert.equal(r.json.length, 3); // 三个启用房间
    const inR1 = r.json.find((x) => x.roomName === "一号暗房");
    assert.equal(inR1.items.length, 1); // P1（P4 停用）
    // 重复生成拒绝
    r = await call("POST", "/api/inspections/generate", { date, shiftCode: "M" }, { token: tokens.safety, now: at(7) });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, "inspection_already_generated");

    const submit = (id, results, now = at(8)) => call("POST", `/api/inspections/${id}/submit`, { results }, { token: tokens.tech1, now });

    // 班次开始前 → 越点拒绝
    r = await submit(inR1.id, [{ pointId: "P1", status: "ok" }], at(5));
    assert.equal(r.status, 409);
    assert.equal(r.json.error, "inspection_not_started");
    // 越点（提交了 P3）
    r = await submit(inR1.id, [{ pointId: "P1", status: "ok" }, { pointId: "P3", status: "ok" }]);
    assert.equal(r.status, 409);
    assert.equal(r.json.error, "inspection_extra_points");
    assert.deepEqual(r.json.detail.extra, ["P3"]);
    // 漏检（不交任何点）
    r = await submit(inR1.id, []);
    assert.equal(r.status, 409);
    assert.equal(r.json.error, "inspection_missing_points");
    // 异常无说明 → 422
    r = await submit(inR1.id, [{ pointId: "P1", status: "abnormal", note: "" }]);
    assert.equal(r.status, 422);
    assert.equal(r.json.error, "abnormal_requires_note");
    // 正常提交
    r = await submit(inR1.id, [{ pointId: "P1", status: "abnormal", note: "排风异响" }]);
    assert.equal(r.status, 200);
    assert.equal(r.json.status, "submitted");
    // 重复提交拒绝
    r = await submit(inR1.id, [{ pointId: "P1", status: "ok" }]);
    assert.equal(r.status, 409);
    assert.equal(r.json.error, "inspection_already_submitted");

    // 中班生成但不交，到宽限期后 sweep → 漏检（重启恢复）
    r = await call("POST", "/api/inspections/generate", { date, shiftCode: "A" }, { token: tokens.admin, now: at(14) });
    assert.equal(r.status, 201);
    // 重启：新建 store 从同一文件加载并执行启动恢复
    const store2 = new JsonStore(file, () => buildSeed());
    await store2.load();
    const missed = store2.read((d) => sweepMissedInspections(d, { now: new Date("2026-09-15T23:30:00Z") }));
    assert.ok(missed >= 3);
    await store2.mutate(() => {}); // 持久化漏检结果
    const insp = store2.read((d) => d.inspections.find((x) => x.shiftCode === "A" && x.roomId === "R1"));
    assert.equal(insp.status, "missed");

    // 宽限期后提交 → 409 且自动标漏检
    const evening = await call("POST", "/api/inspections/generate", { date: "2026-09-16", shiftCode: "M" }, { token: tokens.admin, now: "2026-09-16T07:00:00Z" });
    const some = evening.json[0];
    r = await call("POST", `/api/inspections/${some.id}/submit`,
      { results: some.items.map((i) => ({ pointId: i.pointId, status: "ok" })) },
      { token: tokens.admin, now: "2026-09-16T15:30:00Z" });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, "inspection_missed");
  } finally { h.cleanup(); }
});

// ---------------- 整改关联 ----------------
test("整改必须关联存在的告警；闭环", async () => {
  const h = await makeHarness("rectify");
  try {
    const { call, tokens } = h;
    let r = await call("POST", "/api/rectifications", { alertId: "AL-nope", action: "x" }, { token: tokens.safety });
    assert.equal(r.status, 404);
    await call("POST", "/api/readings", reading("P1", "airflow", 0.1, at(8, 1)), { token: tokens.admin });
    const alerts = (await call("GET", "/api/alerts?pointId=P1", undefined, { token: tokens.admin })).json;
    const aid = alerts.find((a) => a.metric === "airflow").id;
    r = await call("POST", "/api/rectifications", { alertId: aid, action: "" }, { token: tokens.safety });
    assert.equal(r.status, 400);
    r = await call("POST", "/api/rectifications", { alertId: aid, action: "清洗风管" }, { token: tokens.tech1 });
    assert.equal(r.status, 403);
    r = await call("POST", "/api/rectifications", { alertId: aid, action: "清洗风管", ownerName: "甲" }, { token: tokens.safety });
    assert.equal(r.status, 201);
    assert.equal(r.json.alert.pointName, "暗房中央");
    r = await call("POST", `/api/rectifications/${r.json.id}/close`, { note: "复测达标" }, { token: tokens.safety });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, "closed");
  } finally { h.cleanup(); }
});

// ---------------- 重启恢复：数据持久化 ----------------
test("重启恢复：读数/告警/会话落盘，重新加载后状态一致", async () => {
  const h = await makeHarness("restart");
  try {
    const { call, tokens, file } = h;
    await call("POST", "/api/readings", reading("P1", "temp", 9, at(8, 1)), { token: tokens.admin });
    await call("POST", "/api/readings", reading("P1", "temp", 20, at(8, 2)), { token: tokens.admin });
    const alerts = (await call("GET", "/api/alerts?pointId=P1", undefined, { token: tokens.admin })).json;
    const a = alerts.find((x) => x.metric === "temp");
    assert.equal(a.status, "pending_review");
    const aid = a.id;

    const store2 = new JsonStore(file, () => buildSeed());
    await store2.load();
    assert.equal(store2.data.readings.length, 2);
    const a2 = store2.data.alerts.find((x) => x.id === aid);
    assert.equal(a2.status, "pending_review");
    assert.equal(a2.abnormalCount, 1);
    // 旧 token 仍有效
    const r = await call("GET", "/api/me", undefined, { token: tokens.admin });
    assert.equal(r.status, 200);
  } finally { h.cleanup(); }
});
