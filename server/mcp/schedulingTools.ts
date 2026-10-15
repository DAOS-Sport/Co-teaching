import { and, between, eq, inArray, sql } from "drizzle-orm";
import { txDb as db, inTransaction } from "../shared/dbContext";
import { MCP_ACTOR, recordAudit, scheduleContext, scheduleFields } from "../shared/audit";
import { storage } from "../storage";
import {
  coachAvailability,
  coachUsers,
  schedules,
  type CoachAvailability,
} from "@shared/schema";
import {
  commitScheduleImport,
  previewScheduleImport,
} from "../modules/scheduleImport.service";
import { sameCoach, isPlaceholderCoach, isRealCoachName, UNSTAFFED_COACH } from "@shared/scheduleRules";
import type { ScheduleUpdateFields } from "../repositories/schedule.repository";

type JsonObject = Record<string, unknown>;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 366;
const MAX_BATCH_ROWS = 500;

export const schedulingTools = [
  {
    name: "get_scheduling_catalog",
    title: "取得排班資料目錄",
    description:
      "取得所有場館、節次與教練姓名。建立或修改課程前先呼叫，以使用系統中的正確名稱。",
    inputSchema: objectSchema({
      includeInactiveCoaches: {
        type: "boolean",
        default: false,
        description: "是否包含尚未核准或已退回的教練帳號",
      },
    }),
    annotations: readOnlyAnnotations(),
  },
  {
    name: "find_schedules",
    title: "搜尋課程",
    description:
      "依日期、場館、教練或班別搜尋課程。修改或刪除前必須先搜尋並取得 scheduleId；若結果不只一堂，應讓使用者確認目標。",
    inputSchema: objectSchema(
      {
        startDate: { type: "string", format: "date" },
        endDate: { type: "string", format: "date" },
        venueName: { type: "string" },
        coachName: { type: "string" },
        className: { type: "string" },
        scheduleId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      },
      ["startDate", "endDate"],
    ),
    annotations: readOnlyAnnotations(),
  },
  {
    name: "create_or_update_schedules",
    title: "批次新增或更新課程",
    description:
      "在指定場館一次新增最多 500 堂課。可先 previewOnly=true 預覽；updateMatching=true 時會更新同場館、日期、節次及班別完全相同的課程。",
    inputSchema: objectSchema(
      {
        venueName: { type: "string", minLength: 1 },
        rows: {
          type: "array",
          minItems: 1,
          maxItems: MAX_BATCH_ROWS,
          items: objectSchema(
            {
              date: { type: "string", format: "date" },
              period: { type: "integer", minimum: 1, maximum: 7 },
              className: { type: "string", minLength: 1 },
              coachName: { type: ["string", "null"], description: "已核准教練姓名；000 表示確認無人；null 清除" },
              coachName2: { type: ["string", "null"], description: "已核准教練姓名；000 表示確認無人；null 清除" },
              coachCount: { type: "integer", enum: [1, 2] },
              notes: { type: ["string", "null"] },
            },
            ["date", "period", "className"],
          ),
        },
        updateMatching: { type: "boolean", default: false },
        previewOnly: { type: "boolean", default: false },
      },
      ["venueName", "rows"],
    ),
    annotations: mutatingAnnotations(false),
  },
  {
    name: "update_schedule",
    title: "修改單堂課",
    description:
      "用 scheduleId 修改一堂課，可變更日期、場館、節次、班別、兩位教練、教學角色、人數及備註。課表鎖定時需先解鎖，或在使用者明確要求下使用 forceLocked。",
    inputSchema: objectSchema(
      {
        scheduleId: { type: "string", minLength: 1 },
        date: { type: "string", format: "date" },
        venueName: { type: "string" },
        period: { type: "integer", minimum: 1, maximum: 7 },
        className: { type: "string", minLength: 1 },
        coachName: { type: ["string", "null"], description: "已核准教練姓名；000 表示確認無人；null 清除" },
        coachName2: { type: ["string", "null"], description: "已核准教練姓名；000 表示確認無人；null 清除" },
        coachCount: { type: "integer", enum: [1, 2] },
        coach1IsTeaching: { type: "boolean" },
        coach2IsTeaching: { type: "boolean" },
        notes: { type: ["string", "null"] },
        forceLocked: { type: "boolean", default: false },
      },
      ["scheduleId"],
    ),
    annotations: mutatingAnnotations(false),
  },
  {
    name: "delete_schedules",
    title: "刪除課程",
    description:
      "依 scheduleId 刪除一堂或多堂課。只能使用 find_schedules 已確認的 ID；鎖定課程只在使用者明確要求時設 forceLocked=true。",
    inputSchema: objectSchema(
      {
        scheduleIds: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
        },
        forceLocked: { type: "boolean", default: false },
      },
      ["scheduleIds"],
    ),
    annotations: mutatingAnnotations(true),
  },
  {
    name: "set_schedule_lock",
    title: "鎖定或解鎖課表",
    description: "依場館與日期範圍鎖定或解鎖課表。",
    inputSchema: objectSchema(
      {
        venueName: { type: "string", minLength: 1 },
        startDate: { type: "string", format: "date" },
        endDate: { type: "string", format: "date" },
        locked: { type: "boolean" },
      },
      ["venueName", "startDate", "endDate", "locked"],
    ),
    annotations: mutatingAnnotations(false),
  },
  {
    name: "get_coach_availability",
    title: "查詢教練可排課時段",
    description: "查詢一位教練在日期範圍內填寫的每週可排課節次。",
    inputSchema: objectSchema(
      {
        coachName: { type: "string", minLength: 1 },
        startDate: { type: "string", format: "date" },
        endDate: { type: "string", format: "date" },
      },
      ["coachName", "startDate", "endDate"],
    ),
    annotations: readOnlyAnnotations(),
  },
  {
    name: "set_recurring_availability",
    title: "設定重複可排課時段",
    description:
      "一次設定一位教練跨多週的固定可排課時段。dayOfWeek 為週一=1至週日=7；periods 為第1至第7節。merge 加入、remove 移除、replace 取代日期範圍內原有時段。",
    inputSchema: objectSchema(
      {
        coachName: { type: "string", minLength: 1 },
        startDate: { type: "string", format: "date" },
        endDate: { type: "string", format: "date" },
        daysOfWeek: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "integer", minimum: 1, maximum: 7 },
        },
        periods: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "integer", minimum: 1, maximum: 7 },
        },
        mode: { type: "string", enum: ["merge", "remove", "replace"], default: "merge" },
      },
      ["coachName", "startDate", "endDate", "daysOfWeek", "periods"],
    ),
    annotations: mutatingAnnotations(false),
  },
  {
    name: "set_coach_venue_preferences",
    title: "設定教練場館偏好",
    description:
      "設定教練可排課的場館偏好。replace 完全取代、merge 加入、remove 移除指定場館。",
    inputSchema: objectSchema(
      {
        coachName: { type: "string", minLength: 1 },
        venueNames: {
          type: "array",
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
        },
        mode: { type: "string", enum: ["replace", "merge", "remove"], default: "replace" },
      },
      ["coachName", "venueNames"],
    ),
    annotations: mutatingAnnotations(false),
  },
];

const MUTATING_TOOLS = new Set([
  "create_or_update_schedules",
  "update_schedule",
  "delete_schedules",
  "set_schedule_lock",
  "set_recurring_availability",
  "set_coach_venue_preferences",
]);

/** #3: writes and their audit row commit together; MCP is the actor. */
const mcpAudit = (entry: Omit<Parameters<typeof recordAudit>[0], "actor">) =>
  recordAudit({ actor: MCP_ACTOR, ...entry });

export async function callSchedulingTool(name: string, rawArgs: unknown): Promise<unknown> {
  const args = asObject(rawArgs);
  if (MUTATING_TOOLS.has(name)) return inTransaction(() => dispatchSchedulingTool(name, args));
  return dispatchSchedulingTool(name, args);
}

async function dispatchSchedulingTool(name: string, args: JsonObject): Promise<unknown> {
  switch (name) {
    case "get_scheduling_catalog":
      return getCatalog(optionalBoolean(args, "includeInactiveCoaches") ?? false);
    case "find_schedules":
      return findSchedules(args);
    case "create_or_update_schedules":
      return createOrUpdateSchedules(args);
    case "update_schedule":
      return updateSchedule(args);
    case "delete_schedules":
      return deleteSchedules(args);
    case "set_schedule_lock":
      return setScheduleLock(args);
    case "get_coach_availability":
      return getCoachAvailability(args);
    case "set_recurring_availability":
      return setRecurringAvailability(args);
    case "set_coach_venue_preferences":
      return setCoachVenuePreferences(args);
    default:
      throw new Error(`未知的排班工具：${name}`);
  }
}

async function getCatalog(includeInactiveCoaches: boolean) {
  const [venueRows, slotRows, coachRows] = await Promise.all([
    storage.getVenues(),
    storage.getTimeSlots(),
    includeInactiveCoaches ? storage.getAllCoachUsers() : storage.getApprovedCoachUsers(),
  ]);
  return {
    venues: venueRows.map(({ id, name, color, order }) => ({ id, name, color, order })),
    timeSlots: slotRows.map(({ id, period, startTime, endTime, order }) => ({
      id,
      period,
      startTime,
      endTime,
      order,
    })),
    coaches: coachRows.map(({ id, name, linkedCoachName, status }) => ({
      id,
      name,
      schedulingName: linkedCoachName || name,
      status,
    })),
  };
}

async function findSchedules(args: JsonObject) {
  const { startDate, endDate } = readDateRange(args);
  const limit = optionalInteger(args, "limit", 1, 500) ?? 100;
  const venueName = optionalString(args, "venueName");
  const coachName = optionalString(args, "coachName");
  const className = optionalString(args, "className");
  const scheduleId = optionalString(args, "scheduleId");
  const rows = await storage.getSchedulesByDateRange(startDate, endDate);
  const filtered = rows.filter((row) => {
    if (scheduleId && row.id !== scheduleId) return false;
    if (venueName && !includesNormalized(row.venue.name, venueName)) return false;
    if (className && !includesNormalized(row.className || "", className)) return false;
    if (
      coachName &&
      !includesNormalized(row.coachName || "", coachName) &&
      !includesNormalized(row.coachName2 || "", coachName)
    ) return false;
    return true;
  });
  return {
    totalMatched: filtered.length,
    truncated: filtered.length > limit,
    schedules: filtered
      .sort((a, b) => a.date.localeCompare(b.date) || a.timeSlot.order - b.timeSlot.order)
      .slice(0, limit)
      .map(formatSchedule),
  };
}

async function createOrUpdateSchedules(args: JsonObject) {
  const venue = await resolveVenue(requiredString(args, "venueName"));
  const rawRows = requiredArray(args, "rows", 1, MAX_BATCH_ROWS).map(asObject);
  const rows = [] as Array<{
    date: string;
    period: number;
    className: string;
    coachName: string | null;
    coachName2: string | null;
    coachCount: 1 | 2;
    notes: string | null;
  }>;
  for (const row of rawRows) {
    const date = requiredDate(row, "date");
    const period = requiredInteger(row, "period", 1, 7);
    const className = cleanTsv(requiredString(row, "className"), "className");
    const requestedCoach1 = optionalNullableString(row, "coachName");
    const requestedCoach2 = optionalNullableString(row, "coachName2");
    const coachName = requestedCoach1 ? await resolveScheduleCoachName(requestedCoach1) : null;
    const coachName2 = requestedCoach2 ? await resolveScheduleCoachName(requestedCoach2) : null;
    if (sameCoach(coachName, coachName2)) throw new Error("同一堂課不可指派同一位教練兩次");
    const coachCount = (optionalInteger(row, "coachCount", 1, 2) ?? (coachName2 ? 2 : 1)) as 1 | 2;
    if (coachName2 && coachCount !== 2) throw new Error(`${date} ${className}：教練2存在時 coachCount 必須是 2`);
    const notesValue = optionalNullableString(row, "notes");
    rows.push({
      date,
      period,
      className,
      coachName,
      coachName2,
      coachCount,
      notes: notesValue == null ? null : cleanTsv(notesValue, "notes"),
    });
  }
  const text = [
    "日期\t節次\t班別\t教練1\t教練2\t教練人數\t備註",
    ...rows.map((row) => [
      row.date,
      row.period,
      row.className,
      row.coachName || "",
      row.coachName2 || "",
      row.coachCount,
      row.notes || "",
    ].join("\t")),
  ].join("\n");
  const mode = optionalBoolean(args, "updateMatching") ? "update_matching" : "insert_only";
  if (optionalBoolean(args, "previewOnly")) {
    return previewScheduleImport(venue.id, text, mode);
  }
  const result = await commitScheduleImport(venue.id, text, mode);
  if (result.committed) {
    await mcpAudit({
      action: "schedule.import",
      entity: "schedule_import",
      entityId: venue.id,
      after: { venueName: venue.name, created: result.created, updated: result.updated },
      reason: venue.name,
    });
  }
  return result;
}

async function updateSchedule(args: JsonObject) {
  const scheduleId = requiredString(args, "scheduleId");
  const existing = await storage.getScheduleById(scheduleId);
  if (!existing) throw new Error(`找不到課程 ${scheduleId}`);
  if (existing.isClassLocked && !optionalBoolean(args, "forceLocked")) {
    throw new Error("課程已鎖定；請先解鎖，或在使用者明確要求後設 forceLocked=true");
  }
  const update: ScheduleUpdateFields = {};
  if (args.date !== undefined) update.date = requiredDate(args, "date");
  if (args.venueName !== undefined) update.venueId = (await resolveVenue(requiredString(args, "venueName"))).id;
  if (args.period !== undefined) update.timeSlotId = (await resolveTimeSlot(requiredInteger(args, "period", 1, 7))).id;
  if (args.className !== undefined) update.className = requiredString(args, "className").trim();
  if (args.notes !== undefined) update.notes = optionalNullableString(args, "notes");

  const requestedCoach1 = args.coachName === undefined ? undefined : optionalNullableString(args, "coachName");
  const requestedCoach2 = args.coachName2 === undefined ? undefined : optionalNullableString(args, "coachName2");
  if (requestedCoach1 !== undefined) update.coachName = requestedCoach1 ? await resolveScheduleCoachName(requestedCoach1) : null;
  if (requestedCoach2 !== undefined) update.coachName2 = requestedCoach2 ? await resolveScheduleCoachName(requestedCoach2) : null;
  if (args.coachCount !== undefined) update.coachCount = requiredInteger(args, "coachCount", 1, 2);
  if (args.coach1IsTeaching !== undefined) update.coach1IsTeaching = requiredBoolean(args, "coach1IsTeaching");
  if (args.coach2IsTeaching !== undefined) update.coach2IsTeaching = requiredBoolean(args, "coach2IsTeaching");

  let nextCoach1 = update.coachName !== undefined ? update.coachName : existing.coachName;
  let nextCoach2 = update.coachName2 !== undefined ? update.coachName2 : existing.coachName2;
  let nextCoachCount = update.coachCount ?? existing.coachCount;
  if (sameCoach(nextCoach1, nextCoach2)) throw new Error("同一堂課不可指派同一位教練兩次");
  if (nextCoach2 && nextCoachCount < 2) {
    nextCoachCount = 2;
    update.coachCount = 2;
  }
  if (nextCoachCount === 1) {
    if (!nextCoach1 && nextCoach2) nextCoach1 = nextCoach2;
    nextCoach2 = null;
    update.coachName = nextCoach1;
    update.coachName2 = null;
    update.coach2IsTeaching = false;
  } else if (!nextCoach1 && nextCoach2) {
    update.coachName = nextCoach2;
    update.coachName2 = null;
    update.coach1IsTeaching = update.coach2IsTeaching ?? existing.coach2IsTeaching;
    update.coach2IsTeaching = false;
  }
  const updated = await storage.updateSchedule(scheduleId, update);
  await mcpAudit({
    action: "schedule.update",
    entity: "schedule",
    entityId: scheduleId,
    before: scheduleFields(existing),
    after: scheduleFields(updated),
    reason: await scheduleContext(existing),
  });
  const [detail] = (await storage.getSchedulesByDateRange(updated.date, updated.date)).filter((row) => row.id === scheduleId);
  const assignedCoaches = [updated.coachName, updated.coachName2].filter(isRealCoachName);
  const conflicts = assignedCoaches.length ? await storage.getConflicts(updated.date) : [];
  return {
    updated: detail ? formatSchedule(detail) : updated,
    conflictWarnings: conflicts.filter((item) =>
      assignedCoaches.includes(item.coachName),
    ),
  };
}

async function deleteSchedules(args: JsonObject) {
  const ids = requiredArray(args, "scheduleIds", 1, 100).map((value) => {
    if (typeof value !== "string" || !value.trim()) throw new Error("scheduleIds 必須是非空字串陣列");
    return value.trim();
  });
  if (new Set(ids).size !== ids.length) throw new Error("scheduleIds 不可重複");
  const forceLocked = optionalBoolean(args, "forceLocked") ?? false;
  return db.transaction(async (tx) => {
    const found = await tx.select().from(schedules).where(inArray(schedules.id, ids)).for("update");
    if (found.length !== ids.length) {
      const foundIds = new Set(found.map((row) => row.id));
      throw new Error(`找不到課程：${ids.filter((id) => !foundIds.has(id)).join(", ")}`);
    }
    const locked = found.filter((row) => row.isClassLocked);
    if (locked.length && !forceLocked) {
      throw new Error(`有 ${locked.length} 堂課已鎖定；請先解鎖或在使用者明確要求後設 forceLocked=true`);
    }
    const deleted = await tx.delete(schedules).where(inArray(schedules.id, ids)).returning();
    await mcpAudit({
      action: "schedule.bulk_delete",
      entity: "schedule",
      entityId: ids.length === 1 ? ids[0] : `${ids.length} 筆`,
      after: { deleted: deleted.length },
      reason: deleted.slice(0, 5).map((row) => `${row.date} ${row.className ?? ""}`.trim()).join("、") + (deleted.length > 5 ? "…" : ""),
    });
    return {
      deletedCount: deleted.length,
      deleted: deleted.map((row) => ({
        id: row.id,
        date: row.date,
        venueId: row.venueId,
        timeSlotId: row.timeSlotId,
        className: row.className,
        coachName: row.coachName,
        coachName2: row.coachName2,
      })),
    };
  });
}

async function setScheduleLock(args: JsonObject) {
  const venue = await resolveVenue(requiredString(args, "venueName"));
  const { startDate, endDate } = readDateRange(args);
  const locked = requiredBoolean(args, "locked");
  if (locked) await storage.lockSchedules(venue.id, startDate, endDate);
  else await storage.unlockSchedules(venue.id, startDate, endDate);
  await mcpAudit({
    action: locked ? "schedule.lock" : "schedule.unlock",
    entity: "schedule_week",
    entityId: venue.id,
    after: { venueName: venue.name, startDate, endDate, locked },
    reason: `${venue.name} ${startDate} ~ ${endDate}`,
  });
  return { success: true, venue: venue.name, startDate, endDate, locked };
}

async function getCoachAvailability(args: JsonObject) {
  const coachName = await resolveCoachName(requiredString(args, "coachName"));
  const { startDate, endDate } = readDateRange(args);
  const firstWeek = mondayOf(startDate);
  const lastWeek = mondayOf(endDate);
  const rows = await db
    .select()
    .from(coachAvailability)
    .where(and(
      eq(coachAvailability.coachName, coachName),
      between(coachAvailability.weekStart, firstWeek, lastWeek),
    ));
  return {
    coachName,
    startDate,
    endDate,
    slots: rows
      .filter((row) => inDateRange(dateForSlot(row.weekStart, row.dayOfWeek), startDate, endDate))
      .sort(compareAvailability)
      .map(formatAvailability),
  };
}

async function setRecurringAvailability(args: JsonObject) {
  const coachName = await resolveCoachName(requiredString(args, "coachName"));
  const { startDate, endDate } = readDateRange(args);
  const days = readUniqueIntegers(args, "daysOfWeek", 1, 7);
  const periods = readUniqueIntegers(args, "periods", 1, 7);
  const mode = optionalEnum(args, "mode", ["merge", "remove", "replace"] as const) ?? "merge";
  const weeks = enumerateMondays(startDate, endDate);

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`grok-availability:${coachName}`}))`);
    const existing = await tx
      .select()
      .from(coachAvailability)
      .where(and(
        eq(coachAvailability.coachName, coachName),
        between(coachAvailability.weekStart, weeks[0], weeks[weeks.length - 1]),
      ));
    const byWeek = new Map<string, CoachAvailability[]>();
    for (const row of existing) byWeek.set(row.weekStart, [...(byWeek.get(row.weekStart) || []), row]);
    let added = 0;
    let removed = 0;

    for (const weekStart of weeks) {
      const current = new Set((byWeek.get(weekStart) || []).map(slotKey));
      const target = new Set<string>();
      for (const day of days) {
        const actualDate = dateForSlot(weekStart, day);
        if (!inDateRange(actualDate, startDate, endDate)) continue;
        for (const period of periods) target.add(`${day}-${period}`);
      }
      const next = new Set(current);
      if (mode === "replace") {
        for (const key of Array.from(next)) {
          const day = Number(key.split("-")[0]);
          if (inDateRange(dateForSlot(weekStart, day), startDate, endDate)) next.delete(key);
        }
        for (const key of Array.from(target)) next.add(key);
      } else if (mode === "merge") {
        for (const key of Array.from(target)) next.add(key);
      } else {
        for (const key of Array.from(target)) next.delete(key);
      }
      added += Array.from(next).filter((key) => !current.has(key)).length;
      removed += Array.from(current).filter((key) => !next.has(key)).length;
      await tx.delete(coachAvailability).where(and(
        eq(coachAvailability.coachName, coachName),
        eq(coachAvailability.weekStart, weekStart),
      ));
      if (next.size) {
        await tx.insert(coachAvailability).values(Array.from(next).map((key) => {
          const [dayOfWeek, timeSlotOrder] = key.split("-").map(Number);
          return { coachName, weekStart, dayOfWeek, timeSlotOrder };
        }));
      }
    }
    await mcpAudit({
      action: "availability.save",
      entity: "coach_availability",
      entityId: coachName,
      after: { mode, added, removed },
      reason: `${coachName} ${startDate} ~ ${endDate}`,
    });
    return {
      success: true,
      coachName,
      startDate,
      endDate,
      weeksAffected: weeks.length,
      mode,
      added,
      removed,
      daysOfWeek: days,
      periods,
    };
  });
}

async function setCoachVenuePreferences(args: JsonObject) {
  const coachName = await resolveCoachName(requiredString(args, "coachName"));
  const requested = requiredArray(args, "venueNames", 0, 100).map((value) => {
    if (typeof value !== "string" || !value.trim()) throw new Error("venueNames 必須是場館名稱陣列");
    return value.trim();
  });
  const resolved = await Promise.all(requested.map(resolveVenue));
  const names = resolved.map((venue) => venue.name);
  const mode = optionalEnum(args, "mode", ["replace", "merge", "remove"] as const) ?? "replace";
  const current = (await storage.getCoachVenuePreferences(coachName)).map((row) => row.venueName);
  let next: string[];
  if (mode === "replace") next = names;
  else if (mode === "merge") next = Array.from(new Set([...current, ...names]));
  else {
    const removed = new Set(names);
    next = current.filter((name) => !removed.has(name));
  }
  await storage.setCoachVenuePreferences(coachName, next);
  await mcpAudit({
    action: "availability.venues",
    entity: "coach_availability",
    entityId: coachName,
    before: { venues: current },
    after: { venues: next },
    reason: coachName,
  });
  return { success: true, coachName, mode, venueNames: next };
}

async function resolveVenue(input: string) {
  const all = await storage.getVenues();
  const normalized = normalize(input);
  const matches = all.filter((venue) => normalize(venue.name) === normalized);
  if (matches.length === 1) return matches[0];
  const suggestions = all.filter((venue) => includesNormalized(venue.name, input)).map((venue) => venue.name);
  throw new Error(`找不到唯一場館「${input}」${suggestions.length ? `；可能是：${suggestions.join("、")}` : ""}`);
}

async function resolveTimeSlot(period: number) {
  const slots = await storage.getTimeSlots();
  const slot = slots.find((item) => item.order === period);
  if (!slot) throw new Error(`找不到第 ${period} 節`);
  return slot;
}

async function resolveScheduleCoachName(input: string): Promise<string> {
  return isPlaceholderCoach(input) ? UNSTAFFED_COACH : resolveCoachName(input);
}

async function resolveCoachName(input: string): Promise<string> {
  const coaches = await storage.getApprovedCoachUsers();
  const normalized = normalize(input);
  const matches = coaches.filter((coach) =>
    normalize(coach.name) === normalized || normalize(coach.linkedCoachName || "") === normalized,
  );
  const canonical = Array.from(new Set(matches.map((coach) => coach.linkedCoachName || coach.name)));
  if (canonical.length === 1) return canonical[0];
  const suggestions = coaches
    .filter((coach) => includesNormalized(coach.name, input) || includesNormalized(coach.linkedCoachName || "", input))
    .map((coach) => coach.linkedCoachName || coach.name);
  throw new Error(`找不到唯一的已核准教練「${input}」${suggestions.length ? `；可能是：${Array.from(new Set(suggestions)).join("、")}` : ""}`);
}

function formatSchedule(row: Awaited<ReturnType<typeof storage.getSchedulesByDateRange>>[number]) {
  return {
    scheduleId: row.id,
    date: row.date,
    venueName: row.venue.name,
    period: row.timeSlot.order,
    time: `${row.timeSlot.startTime}-${row.timeSlot.endTime}`,
    className: row.className,
    coachName: row.coachName,
    coachName2: row.coachName2,
    coachCount: row.coachCount,
    coach1IsTeaching: row.coach1IsTeaching,
    coach2IsTeaching: row.coach2IsTeaching,
    isClassLocked: row.isClassLocked,
    notes: row.notes,
  };
}

function formatAvailability(row: CoachAvailability) {
  return {
    date: dateForSlot(row.weekStart, row.dayOfWeek),
    weekStart: row.weekStart,
    dayOfWeek: row.dayOfWeek,
    period: row.timeSlotOrder,
  };
}

function compareAvailability(a: CoachAvailability, b: CoachAvailability): number {
  return a.weekStart.localeCompare(b.weekStart) || a.dayOfWeek - b.dayOfWeek || a.timeSlotOrder - b.timeSlotOrder;
}

function slotKey(row: Pick<CoachAvailability, "dayOfWeek" | "timeSlotOrder">): string {
  return `${row.dayOfWeek}-${row.timeSlotOrder}`;
}

function mondayOf(date: string): string {
  const parsed = parseDate(date);
  const day = parsed.getUTCDay() || 7;
  parsed.setUTCDate(parsed.getUTCDate() - day + 1);
  return parsed.toISOString().slice(0, 10);
}

function dateForSlot(weekStart: string, dayOfWeek: number): string {
  const parsed = parseDate(weekStart);
  parsed.setUTCDate(parsed.getUTCDate() + dayOfWeek - 1);
  return parsed.toISOString().slice(0, 10);
}

function enumerateMondays(startDate: string, endDate: string): string[] {
  const result: string[] = [];
  let cursor = parseDate(mondayOf(startDate));
  const last = mondayOf(endDate);
  while (cursor.toISOString().slice(0, 10) <= last) {
    result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return result;
}

function parseDate(value: string): Date {
  if (!DATE_PATTERN.test(value)) throw new Error(`日期必須是 YYYY-MM-DD：${value}`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`無效日期：${value}`);
  }
  return parsed;
}

function readDateRange(args: JsonObject): { startDate: string; endDate: string } {
  const startDate = requiredDate(args, "startDate");
  const endDate = requiredDate(args, "endDate");
  const start = parseDate(startDate).getTime();
  const end = parseDate(endDate).getTime();
  if (end < start) throw new Error("endDate 不可早於 startDate");
  if ((end - start) / 86_400_000 > MAX_RANGE_DAYS) throw new Error(`日期範圍不可超過 ${MAX_RANGE_DAYS} 天`);
  return { startDate, endDate };
}

function requiredDate(args: JsonObject, key: string): string {
  const value = requiredString(args, key);
  parseDate(value);
  return value;
}

function inDateRange(value: string, start: string, end: string): boolean {
  return value >= start && value <= end;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("zh-TW").replace(/[\s　]/g, "");
}

function includesNormalized(value: string, query: string): boolean {
  return normalize(value).includes(normalize(query));
}

function cleanTsv(value: string, field: string): string {
  if (/[\t\r\n]/.test(value)) throw new Error(`${field} 不可包含 Tab 或換行`);
  return value.trim();
}

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("工具參數必須是物件");
  return value as JsonObject;
}

function requiredString(args: JsonObject, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} 必須是非空字串`);
  return value.trim();
}

function optionalString(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${key} 必須是字串`);
  return value.trim();
}

function optionalNullableString(args: JsonObject, key: string): string | null | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${key} 必須是字串或 null`);
  return value.trim() || null;
}

function requiredBoolean(args: JsonObject, key: string): boolean {
  const value = args[key];
  if (typeof value !== "boolean") throw new Error(`${key} 必須是 boolean`);
  return value;
}

function optionalBoolean(args: JsonObject, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${key} 必須是 boolean`);
  return value;
}

function requiredInteger(args: JsonObject, key: string, min: number, max: number): number {
  const value = args[key];
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${key} 必須是 ${min} 到 ${max} 的整數`);
  }
  return value as number;
}

function optionalInteger(args: JsonObject, key: string, min: number, max: number): number | undefined {
  if (args[key] === undefined) return undefined;
  return requiredInteger(args, key, min, max);
}

function requiredArray(args: JsonObject, key: string, min: number, max: number): unknown[] {
  const value = args[key];
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${key} 必須是長度 ${min} 到 ${max} 的陣列`);
  }
  return value;
}

function readUniqueIntegers(args: JsonObject, key: string, min: number, max: number): number[] {
  const values = requiredArray(args, key, 1, max - min + 1).map((value) => {
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
      throw new Error(`${key} 只能包含 ${min} 到 ${max} 的整數`);
    }
    return value as number;
  });
  if (new Set(values).size !== values.length) throw new Error(`${key} 不可重複`);
  return values.sort((a, b) => a - b);
}

function optionalEnum<T extends readonly string[]>(args: JsonObject, key: string, allowed: T): T[number] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${key} 必須是 ${allowed.join("、")}`);
  return value as T[number];
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

function readOnlyAnnotations() {
  return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
}

function mutatingAnnotations(destructive: boolean) {
  return { readOnlyHint: false, destructiveHint: destructive, idempotentHint: false, openWorldHint: false };
}
