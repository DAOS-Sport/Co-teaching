export const SCHEDULE_IMPORT_MAX_ROWS = 500;

export type ScheduleImportMode = "insert_only" | "update_matching";

export type ScheduleImportInputRow = {
  line: number;
  date: string;
  period: number;
  className: string;
  coachName: string | null;
  coachName2: string | null;
  coachCount: 1 | 2;
  notes: string | null;
};

export type ScheduleImportParseError = {
  line: number;
  message: string;
};

export type ScheduleImportParseResult = {
  rows: ScheduleImportInputRow[];
  errors: ScheduleImportParseError[];
};

const HEADER_ALIASES: Record<string, keyof Omit<ScheduleImportInputRow, "line">> = {
  日期: "date",
  date: "date",
  節次: "period",
  period: "period",
  班別: "className",
  班級: "className",
  classname: "className",
  教練1: "coachName",
  教練一: "coachName",
  coach1: "coachName",
  教練2: "coachName2",
  教練二: "coachName2",
  coach2: "coachName2",
  教練人數: "coachCount",
  coachcount: "coachCount",
  備註: "notes",
  notes: "notes",
};

function normalizeHeader(value: string): string {
  return value.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[\s_-]/g, "");
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parsePeriod(value: string): number | null {
  const match = value.trim().match(/^(?:第)?([1-7])(?:節)?$/);
  return match ? Number(match[1]) : null;
}

/** Parse tab-separated text copied from a spreadsheet or saved by Notepad. */
export function parseScheduleImportText(text: string): ScheduleImportParseResult {
  const errors: ScheduleImportParseError[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();

  if (lines.length === 0 || !lines[0].trim()) {
    return { rows: [], errors: [{ line: 1, message: "請貼上含標題列的課表資料" }] };
  }

  const headers = lines[0].split("\t");
  const columns = new Map<keyof Omit<ScheduleImportInputRow, "line">, number>();
  headers.forEach((header, index) => {
    const field = HEADER_ALIASES[normalizeHeader(header)];
    if (field && !columns.has(field)) columns.set(field, index);
  });

  for (const required of ["date", "period", "className"] as const) {
    if (!columns.has(required)) {
      const label = required === "date" ? "日期" : required === "period" ? "節次" : "班別";
      errors.push({ line: 1, message: `缺少必要欄位「${label}」` });
    }
  }
  if (errors.length > 0) return { rows: [], errors };

  const dataLines = lines.slice(1).filter((line) => line.trim().length > 0);
  if (dataLines.length > SCHEDULE_IMPORT_MAX_ROWS) {
    return {
      rows: [],
      errors: [{ line: 1, message: `一次最多匯入 ${SCHEDULE_IMPORT_MAX_ROWS} 筆資料` }],
    };
  }

  const rows: ScheduleImportInputRow[] = [];
  lines.slice(1).forEach((rawLine, offset) => {
    const line = offset + 2;
    if (!rawLine.trim()) return;
    const cells = rawLine.split("\t").map((cell) => cell.trim());
    const read = (field: keyof Omit<ScheduleImportInputRow, "line">): string => {
      const index = columns.get(field);
      return index === undefined ? "" : cells[index] ?? "";
    };

    const date = read("date");
    const period = parsePeriod(read("period"));
    const className = read("className");
    const coachName = read("coachName") || null;
    const coachName2 = read("coachName2") || null;
    const rawCoachCount = read("coachCount");
    const parsedCoachCount = rawCoachCount ? Number(rawCoachCount) : coachName2 ? 2 : 1;
    const rowErrors: string[] = [];

    if (!isValidDate(date)) rowErrors.push("日期必須是有效的 YYYY-MM-DD");
    if (!period) rowErrors.push("節次必須是 1 到 7");
    if (!className) rowErrors.push("班別不可空白");
    if (parsedCoachCount !== 1 && parsedCoachCount !== 2)
      rowErrors.push("教練人數只能是 1 或 2");
    if (coachName2 && parsedCoachCount !== 2)
      rowErrors.push("填寫教練2時，教練人數必須是 2");
    if (coachName && coachName2 && coachName === coachName2)
      rowErrors.push("教練1與教練2不可相同");

    if (rowErrors.length > 0 || !period || (parsedCoachCount !== 1 && parsedCoachCount !== 2)) {
      rowErrors.forEach((message) => errors.push({ line, message }));
      return;
    }

    rows.push({
      line,
      date,
      period,
      className,
      coachName,
      coachName2,
      coachCount: parsedCoachCount,
      notes: read("notes") || null,
    });
  });

  if (rows.length === 0 && errors.length === 0) {
    errors.push({ line: 2, message: "沒有可匯入的資料列" });
  }
  return { rows, errors };
}

export const SCHEDULE_IMPORT_TEMPLATE = [
  "日期\t節次\t班別\t教練1\t教練2\t教練人數\t備註",
  "2026-09-07\t1\t新北116\t潘思蒓\t\t1\t",
  "2026-09-07\t2\t新北117\t宋輝煌\t\t1\t第一次上課",
].join("\n");
