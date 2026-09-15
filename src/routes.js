// HTTP 路由：鉴权 / 配置 / 录入 / 告警 / 巡检 / 整改
import { randomUUID } from "node:crypto";
import {
  METRICS, SCENES,
  buildReadingRecords, assertNotDuplicate, rebuildAlerts, activeCalibration,
  getShift, shiftWindow, sweepMissedInspections, nowIso, getTimeZone,
  toLocalString, localDateLabel, isValidTimeZone, DEFAULT_TIMEZONE,
} from "./domain.js";
import { httpError } from "./store.js";
import { hashPw } from "./seed.js";

const id = (p) => p + "-" + randomUUID().slice(0, 10);

const ROLE_LABEL = { admin: "管理员", safety: "安全员", technician: "技师" };

export function createApp(store) {
  const json = (res, status, data) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  };

  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw httpError(400, "invalid_json"); }
  }

  const getNow = (req) => {
    const h = req.headers["x-now"];
    if (h && !Number.isNaN(new Date(h).getTime())) return new Date(h);
    return new Date();
  };

  function authenticate(db, req) {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : null;
    const session = token && db.tokens[token];
    if (!session) throw httpError(401, "unauthorized");
    const user = db.users.find((u) => u.id === session.userId);
    if (!user) throw httpError(401, "unauthorized");
    return user;
  }

  const requireRole = (user, ...roles) => {
    if (!roles.includes(user.role)) throw httpError(403, "forbidden", `需要 ${roles.map((r) => ROLE_LABEL[r]).join("/")} 权限`);
  };
  const roomOfPoint = (db, pointId) => {
    const p = db.points.find((x) => x.id === pointId);
    if (!p) throw httpError(404, "point_not_found");
    return p.roomId;
  };
  const scopeRoom = (user, roomId) => {
    if (!user.roomIds.includes("*") && !user.roomIds.includes(roomId)) {
      throw httpError(403, "room_out_of_scope", "无权操作其他房间");
    }
  };
  const scopePoint = (user, db, pointId) => scopeRoom(user, roomOfPoint(db, pointId));

  // 读时仍须取最新快照（写操作之间可能已持久化）
  const D = () => store.data;

  async function handle(req, res, pathname) {
    const db = D();
    const user = pathname === "/api/auth/login" ? null : authenticate(db, req);
    const now = getNow(req);
    const body = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) ? await readBody(req) : {};

    // ---------- 认证 ----------
    if (pathname === "/api/auth/login" && req.method === "POST") {
      const u = db.users.find((x) => x.username === body.username);
      if (!u || u.passwordHash !== hashPw(body.password || "")) throw httpError(401, "bad_credentials");
      const token = randomUUID();
      await store.mutate((d) => { d.tokens[token] = { userId: u.id, loginAt: nowIso(now) }; });
      return json(res, 200, { token, user: sanitizeUser(u) });
    }
    if (pathname === "/api/me" && req.method === "GET") {
      return json(res, 200, {
        user: sanitizeUser(user), metrics: METRICS, scenes: sceneView(),
        shifts: db.config.shifts, timeZone: getTimeZone(db),
      });
    }
    if (pathname === "/api/auth/logout" && req.method === "POST") {
      const token = req.headers.authorization.slice(7);
      await store.mutate((d) => { delete d.tokens[token]; });
      return json(res, 200, { ok: true });
    }

    // ---------- 房间 ----------
    if (pathname === "/api/rooms" && req.method === "GET") {
      return json(res, 200, scopedRooms(db, user).map(roomView(db)));
    }
    if (pathname === "/api/rooms" && req.method === "POST") {
      requireRole(user, "admin");
      const r = {
        id: id("R"), code: reqStr(body.code), name: reqStr(body.name),
        scene: reqScene(body.scene), location: body.location || "", note: body.note || "",
        status: "active", createdAt: nowIso(now),
      };
      const out = await store.mutate((d) => {
        if (d.rooms.some((x) => x.code === r.code)) throw httpError(409, "room_code_exists");
        d.rooms.push(r); return r;
      });
      return json(res, 201, out.body);
    }
    const roomPatch = pathname.match(/^\/api\/rooms\/([^/]+)$/);
    if (roomPatch && req.method === "PATCH") {
      requireRole(user, "admin");
      const out = await store.mutate((d) => {
        const r = d.rooms.find((x) => x.id === roomPatch[1]);
        if (!r) throw httpError(404, "room_not_found");
        for (const k of ["name", "location", "note"]) if (body[k] !== undefined) r[k] = body[k];
        if (body.status && ["active", "disabled"].includes(body.status)) r.status = body.status;
        return r;
      });
      return json(res, 200, out.body);
    }

    // ---------- 监测点 ----------
    if (pathname === "/api/points" && req.method === "GET") {
      const list = db.points.filter((p) => scopedRooms(db, user).some((r) => r.id === p.roomId));
      return json(res, 200, list.map(pointView(db)));
    }
    if (pathname === "/api/points" && req.method === "POST") {
      requireRole(user, "admin");
      const room = db.rooms.find((r) => r.id === body.roomId);
      if (!room) throw httpError(404, "room_not_found");
      const metrics = Array.isArray(body.metrics) && body.metrics.length
        ? body.metrics.filter((m) => METRICS[m] && SCENES[room.scene].metrics.includes(m))
        : SCENES[room.scene].metrics.slice();
      if (!metrics.length) throw httpError(400, "no_metrics");
      const p = {
        id: id("P"), roomId: room.id, code: reqStr(body.code), name: reqStr(body.name),
        scene: room.scene, status: "active", metrics,
        thresholds: mergeThresholds(room.scene, body.thresholds), createdAt: nowIso(now),
      };
      const out = await store.mutate((d) => {
        if (d.points.some((x) => x.roomId === p.roomId && x.code === p.code)) throw httpError(409, "point_code_exists");
        d.points.push(p); return p;
      });
      return json(res, 201, out.body);
    }
    const pointPatch = pathname.match(/^\/api\/points\/([^/]+)$/);
    if (pointPatch && req.method === "PATCH") {
      requireRole(user, "admin");
      const out = await store.mutate((d) => {
        const p = d.points.find((x) => x.id === pointPatch[1]);
        if (!p) throw httpError(404, "point_not_found");
        if (body.name !== undefined) p.name = body.name;
        if (body.status && ["active", "disabled"].includes(body.status)) {
          p.status = body.status;
          if (body.status === "disabled") p.disabledAt = nowIso(now);
        }
        if (body.thresholds && typeof body.thresholds === "object") {
          for (const m of Object.keys(body.thresholds)) {
            if (!p.metrics.includes(m)) continue;
            p.thresholds[m] = { ...(p.thresholds[m] || {}), ...sanitizeThreshold(body.thresholds[m]) };
          }
        }
        return p;
      });
      return json(res, 200, pointView(db)(out.body));
    }

    // ---------- 设备 ----------
    if (pathname === "/api/devices" && req.method === "GET") {
      const rooms = scopedRooms(db, user).map((r) => r.id);
      const list = db.devices.filter((d) => !d.pointIds || d.pointIds.some((p) => rooms.includes(roomOfPointSafe(db, p))));
      return json(res, 200, list.map(deviceView(db, now)));
    }
    if (pathname === "/api/devices" && req.method === "POST") {
      requireRole(user, "admin");
      const pointIds = body.pointIds || [];
      pointIds.forEach((pid) => scopePoint(user, db, pid));
      const d = {
        id: id("D"), code: reqStr(body.code), name: reqStr(body.name),
        metric: body.metric && METRICS[body.metric] ? body.metric : "temperature",
        status: "active", pointIds, createdAt: nowIso(now),
      };
      const out = await store.mutate((dd) => {
        if (dd.devices.some((x) => x.code === d.code)) throw httpError(409, "device_code_exists");
        dd.devices.push(d); return d;
      });
      return json(res, 201, out.body);
    }
    const devPatch = pathname.match(/^\/api\/devices\/([^/]+)$/);
    if (devPatch && req.method === "PATCH") {
      requireRole(user, "admin");
      const out = await store.mutate((d) => {
        const dev = d.devices.find((x) => x.id === devPatch[1]);
        if (!dev) throw httpError(404, "device_not_found");
        if (Array.isArray(body.pointIds)) dev.pointIds = body.pointIds;
        if (body.name) dev.name = body.name;
        if (body.status && ["active", "retired"].includes(body.status)) dev.status = body.status;
        return dev;
      });
      return json(res, 200, out.body);
    }

    // ---------- 校准 ----------
    if (pathname === "/api/calibrations" && req.method === "GET") {
      return json(res, 200, db.calibrations.map(calibrationView(db, now)));
    }
    if (pathname === "/api/calibrations" && req.method === "POST") {
      requireRole(user, "admin", "safety");
      const dev = db.devices.find((x) => x.id === body.deviceId);
      if (!dev) throw httpError(404, "device_not_found");
      if (!body.validFrom || !body.validUntil || new Date(body.validFrom) >= new Date(body.validUntil)) {
        throw httpError(400, "invalid_calibration_period");
      }
      const c = {
        id: id("C"), deviceId: dev.id, standard: body.standard || "", org: body.org || "",
        result: ["pass", "fail"].includes(body.result) ? body.result : "pass",
        validFrom: new Date(body.validFrom).toISOString(), validUntil: new Date(body.validUntil).toISOString(),
        recordedAt: nowIso(now), recordedBy: user.id, status: "valid", certificate: body.certificate || "",
      };
      const out = await store.mutate((d) => { d.calibrations.push(c); return c; });
      return json(res, 201, out.body);
    }

    // ---------- 读数录入 ----------
    if (pathname === "/api/readings" && req.method === "POST") {
      requireRole(user, "admin", "safety", "technician");
      scopePoint(user, db, body.pointId);
      const idemKey = req.headers["idempotency-key"] || null;
      const out = await store.mutate((d) => {
        const records = buildReadingRecords(d, body, { now });
        records.forEach((r) => assertNotDuplicate(d, r));
        const saved = records.map((r) => ({ id: id("RD"), ...r }));
        d.readings.push(...saved);
        rebuildAlerts(d, saved, () => id("AL"));
        return { accepted: saved.length, readings: saved, alerts: alertsTouched(d, saved) };
      }, { idemKey });
      return json(res, out.repeated ? 200 : 201, { repeated: out.repeated, ...out.body });
    }
    if (pathname === "/api/readings/batch" && req.method === "POST") {
      requireRole(user, "admin", "safety", "technician");
      const items = Array.isArray(body.items) ? body.items : null;
      if (!items || !items.length) throw httpError(400, "empty_batch");
      items.forEach((it) => scopePoint(user, db, it.pointId));
      const idemKey = req.headers["idempotency-key"] ? "batch:" + req.headers["idempotency-key"] : null;
      const out = await store.mutate((d) => {
        const all = [];
        const seen = new Set();
        for (const item of items) {
          const recs = buildReadingRecords(d, item, { now });
          for (const r of recs) {
            assertNotDuplicate(d, r);
            const k = r.pointId + "|" + r.metric + "|" + r.measuredAt;
            if (seen.has(k)) throw httpError(409, "duplicate_reading_in_batch");
            seen.add(k);
            all.push({ id: id("RD"), ...r });
          }
        }
        d.readings.push(...all);
        rebuildAlerts(d, all, () => id("AL"));
        return { accepted: all.length, readings: all, alerts: alertsTouched(d, all) };
      }, { idemKey });
      return json(res, out.repeated ? 200 : 201, { repeated: out.repeated, ...out.body });
    }
    if (pathname === "/api/readings" && req.method === "GET") {
      return json(res, 200, listReadings(db, user, urlParams(req)));
    }
    if (pathname === "/api/readings/rollback" && req.method === "POST") {
      requireRole(user, "admin", "safety");
      const out = await store.mutate((d) => {
        let rows = d.readings;
        if (Array.isArray(body.ids)) rows = rows.filter((r) => body.ids.includes(r.id));
        else {
          rows = rows.filter((r) =>
            (!body.pointId || r.pointId === body.pointId) &&
            (!body.metric || r.metric === body.metric) &&
            (!body.from || new Date(r.measuredAt) >= new Date(body.from)) &&
            (!body.to || new Date(r.measuredAt) <= new Date(body.to)));
        }
        if (!rows.length) throw httpError(404, "no_readings_matched");
        const blocked = d.rectifications
          .map((rc) => d.alerts.find((a) => a.id === rc.alertId))
          .filter(Boolean)
          .filter((a) => rows.some((r) => r.pointId === a.pointId && r.metric === a.metric &&
            new Date(r.measuredAt) >= new Date(a.startedAt) && new Date(r.measuredAt) <= new Date(a.lastAt)));
        if (blocked.length) {
          throw httpError(409, "rectification_blocks_rollback", {
            alerts: [...new Set(blocked.map((a) => a.id))],
          });
        }
        const affected = rows.map((r) => ({ pointId: r.pointId, metric: r.metric }));
        d.readings = d.readings.filter((r) => !rows.includes(r));
        rebuildAlerts(d, affected, () => id("AL"));
        return { rolledBack: rows.length, ids: rows.map((r) => r.id) };
      });
      return json(res, 200, out.body);
    }

    // ---------- 告警 ----------
    if (pathname === "/api/alerts" && req.method === "GET") {
      const q = urlParams(req);
      let list = db.alerts.filter((a) => scopedRooms(db, user).some((r) => r.id === roomOfPointSafe(db, a.pointId)));
      if (q.status) list = list.filter((a) => a.status === q.status);
      if (q.severity) list = list.filter((a) => a.severity === q.severity);
      if (q.pointId) list = list.filter((a) => a.pointId === q.pointId);
      list.sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
      return json(res, 200, list.map(alertView(db, user)));
    }
    const alertGet = pathname.match(/^\/api\/alerts\/([^/]+)$/);
    if (alertGet && req.method === "GET") {
      const a = db.alerts.find((x) => x.id === alertGet[1]);
      if (!a) throw httpError(404, "alert_not_found");
      scopePoint(user, db, a.pointId);
      return json(res, 200, alertView(db, user)(a));
    }
    const alertClose = pathname.match(/^\/api\/alerts\/([^/]+)\/close$/);
    if (alertClose && req.method === "POST") {
      requireRole(user, "admin", "safety");
      const out = await store.mutate((d) => {
        const a = d.alerts.find((x) => x.id === alertClose[1]);
        if (!a) throw httpError(404, "alert_not_found");
        scopeRoom(user, roomOfPointSafe(d, a.pointId));
        if (a.status === "closed") throw httpError(409, "alert_already_closed");
        if (a.status === "open") throw httpError(409, "alert_still_abnormal", "必须先恢复正常才能复核关闭");
        a.status = "closed";
        a.reviewedBy = user.id;
        a.reviewedByName = user.name;
        a.reviewedAt = nowIso(now);
        a.reviewNote = body.note || "";
        return a;
      });
      return json(res, 200, alertView(db, user)(out.body));
    }

    // ---------- 巡检 ----------
    if (pathname === "/api/inspections/generate" && req.method === "POST") {
      requireRole(user, "admin", "safety");
      const tz = getTimeZone(db);
      const date = body.date || localDateLabel(now, tz); // 默认“工作室本地今天”，不是 UTC 日期
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw httpError(400, "invalid_date");
      const shift = getShift(db, body.shiftCode);
      const win = shiftWindow(date, shift, tz);
      const out = await store.mutate((d) => {
        if (d.inspections.some((x) => x.date === date && x.shiftCode === shift.code)) {
          throw httpError(409, "inspection_already_generated", `${date} ${shift.name} 巡检已生成`);
        }
        const created = d.rooms.filter((r) => r.status === "active").map((room) => {
          const items = d.points
            .filter((p) => p.roomId === room.id && p.status === "active")
            .map((p) => ({ pointId: p.id, status: null, note: "", submittedAt: null, submittedBy: null }));
          return {
            id: id("IN"), roomId: room.id, date, shiftCode: shift.code, shiftName: shift.name, timeZone: tz,
            windowStart: win.start.toISOString(), windowEnd: win.end.toISOString(),
            localWindowStart: win.localStart, localWindowEnd: win.localEnd,
            status: items.length ? "pending" : "no_points", items,
            generatedAt: nowIso(now), generatedBy: user.id,
          };
        });
        d.inspections.push(...created);
        return created.map(inspectionView(d, user));
      });
      return json(res, 201, out.body);
    }
    if (pathname === "/api/inspections" && req.method === "GET") {
      const q = urlParams(req);
      let list = db.inspections.filter((x) => scopedRooms(db, user).some((r) => r.id === x.roomId));
      if (q.date) list = list.filter((x) => x.date === q.date);
      if (q.status) list = list.filter((x) => x.status === q.status);
      list.sort((a, b) => (b.date + b.shiftCode).localeCompare(a.date + a.shiftCode));
      return json(res, 200, list.map(inspectionView(db, user)));
    }
    const insGet = pathname.match(/^\/api\/inspections\/([^/]+)$/);
    if (insGet && req.method === "GET") {
      const ins = db.inspections.find((x) => x.id === insGet[1]);
      if (!ins) throw httpError(404, "inspection_not_found");
      scopeRoom(user, ins.roomId);
      return json(res, 200, inspectionView(db, user)(ins));
    }
    const insSubmit = pathname.match(/^\/api\/inspections\/([^/]+)\/submit$/);
    if (insSubmit && req.method === "POST") {
      // 预检（不落任何写入）
      const pre = db.inspections.find((x) => x.id === insSubmit[1]);
      if (!pre) throw httpError(404, "inspection_not_found");
      scopeRoom(user, pre.roomId);
      if (pre.status === "missed") throw httpError(409, "inspection_missed", "该巡检已漏检，禁止补交");
      if (pre.status === "submitted") {
        throw httpError(409, "inspection_already_submitted", "巡检已提交，禁止重复提交");
      }
      if (pre.status === "no_points") throw httpError(409, "inspection_no_points");
      const tnow = now.getTime();
      if (tnow < new Date(pre.windowStart).getTime()) {
        throw httpError(409, "inspection_not_started", "班次未开始，禁止越点提交");
      }
      // 超过宽限期：漏检状态与漏检时间单独提交落盘（提交体一律拒绝），保证查询持久可见
      if (tnow > new Date(pre.windowEnd).getTime() + 60 * 60 * 1000) {
        const marked = await store.mutate((d) => {
          const ins = d.inspections.find((x) => x.id === pre.id);
          if (ins.status === "pending") {
            ins.status = "missed";
            ins.missedAt = nowIso(now);
          }
          return inspectionView(d, user)(ins);
        });
        return json(res, 409, {
          error: "inspection_missed",
          detail: "已超过提交宽限期，按漏检处理",
          inspection: marked.body,
        });
      }
      // 载荷校验（仍在窗口内，未通过不落任何写入）
      const results = Array.isArray(body.results) ? body.results : [];
      const expected = pre.items.map((x) => x.pointId);
      const got = results.map((x) => x.pointId);
      const extra = got.filter((p) => !expected.includes(p));
      const missing = expected.filter((p) => !got.includes(p));
      if (extra.length) throw httpError(409, "inspection_extra_points", { extra });
      if (missing.length) throw httpError(409, "inspection_missing_points", { missing });
      if (new Set(got).size !== got.length) throw httpError(409, "inspection_duplicate_points");
      for (const r of results) {
        if (!["ok", "abnormal"].includes(r.status)) throw httpError(400, "invalid_item_status");
        if (r.status === "abnormal" && !(r.note || "").trim()) throw httpError(422, "abnormal_requires_note");
      }
      const out = await store.mutate((d) => {
        const ins = d.inspections.find((x) => x.id === pre.id);
        if (ins.status !== "pending") throw httpError(409, `inspection_${ins.status}`);
        for (const r of results) {
          const item = ins.items.find((x) => x.pointId === r.pointId);
          item.status = r.status;
          item.note = r.note || "";
          item.submittedAt = nowIso(now);
          item.submittedBy = user.id;
          item.submittedByName = user.name;
        }
        ins.status = "submitted";
        ins.submittedAt = nowIso(now);
        ins.submittedBy = user.id;
        return inspectionView(d, user)(ins);
      });
      return json(res, 200, out.body);
    }
    if (pathname === "/api/inspections/sweep" && req.method === "POST") {
      requireRole(user, "admin", "safety");
      const out = await store.mutate((d) => ({ missed: sweepMissedInspections(d, { now }) }));
      return json(res, 200, out.body);
    }

    // ---------- 整改 ----------
    if (pathname === "/api/rectifications" && req.method === "GET") {
      const q = urlParams(req);
      let list = db.rectifications.filter((rc) => {
        const a = db.alerts.find((x) => x.id === rc.alertId);
        return a && scopedRooms(db, user).some((r) => r.id === roomOfPointSafe(db, a.pointId));
      });
      if (q.status) list = list.filter((x) => x.status === q.status);
      return json(res, 200, list.map(rectView(db, user)));
    }
    if (pathname === "/api/rectifications" && req.method === "POST") {
      requireRole(user, "admin", "safety");
      const alert = db.alerts.find((a) => a.id === body.alertId);
      if (!alert) throw httpError(404, "alert_not_found", "整改必须关联有效告警");
      scopeRoom(user, roomOfPointSafe(db, alert.pointId));
      if (!body.action || !String(body.action).trim()) throw httpError(400, "action_required");
      const rc = {
        id: id("RC"), alertId: alert.id, action: String(body.action).trim(),
        ownerName: body.ownerName || user.name, dueAt: body.dueAt || null,
        status: "open", createdAt: nowIso(now), createdBy: user.id,
        closedAt: null, closedBy: null, closeNote: "",
      };
      const out = await store.mutate((d) => { d.rectifications.push(rc); return rc; });
      return json(res, 201, rectView(db, user)(out.body));
    }
    const rcClose = pathname.match(/^\/api\/rectifications\/([^/]+)\/close$/);
    if (rcClose && req.method === "POST") {
      requireRole(user, "admin", "safety");
      const out = await store.mutate((d) => {
        const rc = d.rectifications.find((x) => x.id === rcClose[1]);
        if (!rc) throw httpError(404, "rectification_not_found");
        const a = d.alerts.find((x) => x.id === rc.alertId);
        scopeRoom(user, roomOfPointSafe(d, a.pointId));
        if (rc.status === "closed") throw httpError(409, "rectification_already_closed");
        rc.status = "closed";
        rc.closedAt = nowIso(now);
        rc.closedBy = user.id;
        rc.closedByName = user.name;
        rc.closeNote = body.note || "";
        return rc;
      });
      return json(res, 200, rectView(db, user)(out.body));
    }

    // ---------- 班次配置 / 时区 / 概览 ----------
    if (pathname === "/api/config/timezone" && req.method === "PUT") {
      requireRole(user, "admin");
      if (!isValidTimeZone(body.timeZone)) throw httpError(400, "invalid_timezone");
      const out = await store.mutate((d) => { d.config.timeZone = body.timeZone; return d.config.timeZone; });
      return json(res, 200, { timeZone: out.body });
    }
    if (pathname === "/api/config/shifts" && req.method === "PUT") {
      requireRole(user, "admin");
      const shifts = body.shifts;
      if (!Array.isArray(shifts) || shifts.length !== 3) throw httpError(400, "shifts_must_be_three");
      for (const s of shifts) {
        if (!s.code || !/^\d{2}:\d{2}$/.test(s.start) || !/^\d{2}:\d{2}$/.test(s.end)) throw httpError(400, "invalid_shift");
      }
      const out = await store.mutate((d) => { d.config.shifts = shifts.map((s) => ({ code: s.code, name: s.name, start: s.start, end: s.end })); return d.config.shifts; });
      return json(res, 200, out.body);
    }
    if (pathname === "/api/stats" && req.method === "GET") {
      const rooms = scopedRooms(db, user).map((r) => r.id);
      const pids = new Set(db.points.filter((p) => rooms.includes(p.roomId)).map((p) => p.id));
      const alerts = db.alerts.filter((a) => pids.has(a.pointId));
      return json(res, 200, {
        rooms: rooms.length,
        activePoints: db.points.filter((p) => p.status === "active" && pids.has(p.id)).length,
        readings24h: db.readings.filter((r) => pids.has(r.pointId) && new Date(r.recordedAt) > now.getTime() - 86400000).length,
        openAlerts: alerts.filter((a) => a.status === "open").length,
        pendingReview: alerts.filter((a) => a.status === "pending_review").length,
        critical: alerts.filter((a) => a.status === "open" && a.severity === "critical").length,
        missedInspections: db.inspections.filter((x) => x.status === "missed" && rooms.includes(x.roomId)).length,
        openRectifications: db.rectifications.filter((rc) => rc.status === "open").length,
      });
    }

    throw httpError(404, "not_found");
  }

  // ---------- 视图与工具 ----------
  function sanitizeUser(u) {
    return { id: u.id, username: u.username, name: u.name, role: u.role, roomIds: u.roomIds };
  }
  function scopedRooms(db, user) {
    return db.rooms.filter((r) => user.roomIds.includes("*") || user.roomIds.includes(r.id));
  }
  function roomView(db) {
    return (r) => ({
      ...r,
      points: db.points.filter((p) => p.roomId === r.id).map((p) => ({ id: p.id, code: p.code, name: p.name, status: p.status, metrics: p.metrics })),
    });
  }
  function pointView(db) {
    return (p) => {
      const room = db.rooms.find((r) => r.id === p.roomId);
      const latest = {};
      for (const m of p.metrics) {
        const rows = db.readings.filter((r) => r.pointId === p.id && r.metric === m).sort((a, b) => new Date(b.measuredAt) - new Date(a.measuredAt));
        latest[m] = rows[0] ? { value: rows[0].value, measuredAt: rows[0].measuredAt, abnormal: rows[0].abnormal } : null;
      }
      return { ...p, roomCode: room?.code, roomName: room?.name, latest };
    };
  }
  function deviceView(db, now) {
    return (d) => {
      const cal = activeCalibration(db, d.id, nowIso(now));
      return { ...d, activeCalibration: cal ? { id: cal.id, validUntil: cal.validUntil, org: cal.org } : null, calibrationExpired: !cal };
    };
  }
  function calibrationView(db, now) {
    return (c) => ({
      ...c,
      deviceName: db.devices.find((d) => d.id === c.deviceId)?.name || c.deviceId,
      state: new Date(c.validUntil).getTime() < now.getTime() ? "expired" : "active",
    });
  }
  function alertView(db, viewer) {
    return (a) => {
      const p = db.points.find((x) => x.id === a.pointId);
      const room = db.rooms.find((r) => r.id === p?.roomId);
      const reviewer = a.reviewedBy ? db.users.find((u) => u.id === a.reviewedBy) : null;
      return {
        ...a,
        metricLabel: METRICS[a.metric].label, unit: METRICS[a.metric].unit,
        pointName: p?.name, pointCode: p?.code, roomName: room?.name,
        reviewedByName: reviewer?.name || a.reviewedByName || null,
        rectifications: db.rectifications.filter((r) => r.alertId === a.id).map((r) => ({ id: r.id, status: r.status, action: r.action })),
      };
    };
  }
  function inspectionView(db, viewer) {
    return (x) => {
      const tz = x.timeZone || getTimeZone(db);
      return {
        ...x,
        timeZone: tz,
        // 页面始终展示工作室本地墙上时间（夜班 22:00–次日 06:00 不会被解释成其他时段）
        localWindowStart: x.localWindowStart || toLocalString(x.windowStart, tz),
        localWindowEnd: x.localWindowEnd || toLocalString(x.windowEnd, tz),
        roomName: db.rooms.find((r) => r.id === x.roomId)?.name,
        items: x.items.map((it) => ({ ...it, pointName: db.points.find((p) => p.id === it.pointId)?.name })),
      };
    };
  }
  function rectView(db, viewer) {
    return (rc) => {
      const a = db.alerts.find((x) => x.id === rc.alertId);
      const p = a && db.points.find((x) => x.id === a.pointId);
      return {
        ...rc,
        alert: a ? { id: a.id, metric: a.metric, metricLabel: METRICS[a.metric].label, status: a.status, severity: a.severity, pointName: p?.name } : null,
      };
    };
  }
  function listReadings(db, user, q) {
    const rooms = scopedRooms(db, user).map((r) => r.id);
    let rows = db.readings.filter((r) => rooms.includes(roomOfPointSafe(db, r.pointId)));
    if (q.pointId) rows = rows.filter((r) => r.pointId === q.pointId);
    if (q.metric) rows = rows.filter((r) => r.metric === q.metric);
    if (q.from) rows = rows.filter((r) => new Date(r.measuredAt) >= new Date(q.from));
    if (q.to) rows = rows.filter((r) => new Date(r.measuredAt) <= new Date(q.to));
    rows.sort((a, b) => new Date(b.measuredAt) - new Date(a.measuredAt));
    const limit = Math.min(Number(q.limit) || 500, 2000);
    return rows.slice(0, limit);
  }
  function alertsTouched(d, saved) {
    const keys = new Set(saved.map((s) => s.pointId + "|" + s.metric));
    return d.alerts.filter((a) => keys.has(a.pointId + "|" + a.metric)).map(alertView(d, null));
  }
  function reqStr(v) {
    if (!v || !String(v).trim()) throw httpError(400, "required_field");
    return String(v).trim();
  }
  function reqScene(v) {
    if (!SCENES[v]) throw httpError(400, "invalid_scene", Object.keys(SCENES).join("/"));
    return v;
  }
  function sanitizeThreshold(t) {
    const out = {};
    for (const k of ["warnLow", "warnHigh", "critLow", "critHigh"]) {
      if (t[k] === null || t[k] === "") out[k] = null;
      else if (Number.isFinite(Number(t[k]))) out[k] = Number(t[k]);
    }
    return out;
  }
  function mergeThresholds(scene, override) {
    const base = JSON.parse(JSON.stringify(SCENES[scene].thresholds));
    if (override && typeof override === "object") {
      for (const m of Object.keys(override)) {
        if (base[m]) base[m] = { ...base[m], ...sanitizeThreshold(override[m]) };
      }
    }
    return base;
  }
  function sceneView() {
    return Object.fromEntries(Object.entries(SCENES).map(([k, v]) => [k, { label: v.label, metrics: v.metrics, thresholds: v.thresholds }]));
  }
  function roomOfPointSafe(db, pointId) {
    return db.points.find((p) => p.id === pointId)?.roomId || null;
  }
  function urlParams(req) {
    return Object.fromEntries(new URL(req.url, "http://x").searchParams);
  }

  return async function listener(req, res) {
    const pathname = new URL(req.url, "http://x").pathname;
    try {
      await handle(req, res, pathname);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      json(res, status, { error: err.code || "internal_error", detail: err.detail ?? err.message });
    }
  };
}
