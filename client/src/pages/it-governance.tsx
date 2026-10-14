import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import AdminLayout from "@/components/admin-layout";
import { Badge } from "@/components/ui/badge";
import { getQueryFn } from "@/lib/queryClient";

// ─── Types ──────────────────────────────────────────────────────────────

interface ServiceStatus {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  configured: boolean;
  status: "ok" | "disabled" | "misconfigured" | "error" | "timeout" | "unknown";
  checkedAt?: string;
  code?: string;
  endpoints?: string[];
  lastSyncTime?: string | null;
  isSyncing?: boolean;
}

interface ApiEndpoint {
  method: string;
  path: string;
  description: string;
  auth: "none" | "admin" | "coach-token" | "replit";
}

interface ApiGroup {
  group: string;
  endpoints: ApiEndpoint[];
}

interface ItGovernanceData {
  generatedAt: string;
  isDeployment: boolean;
  featureFlags: Record<string, boolean>;
  services: ServiceStatus[];
  apiGroups: ApiGroup[];
}

interface ActivityRow {
  id: number;
  occurredAt: string;
  actor: string;
  action: string;
  entity: string;
  entityId: string;
  beforeData: unknown;
  afterData: unknown;
  reason: string | null;
}

interface LogRow {
  id: number;
  occurredAt: string;
  level: "error" | "warn" | "info";
  source: string;
  code: string | null;
  message: string | null;
  method: string | null;
  route: string | null;
  status: number | null;
}

interface RagicItem {
  id: number;
  sourceId: string;
  errorCode: string | null;
  errorMessage: string | null;
}

interface RagicRun {
  id: string;
  trigger: string;
  displayStatus: string;
  startedAt: string;
  finishedAt: string | null;
  totalCount: number;
  successCount: number;
  failureCount: number;
  errorCode: string | null;
  items: RagicItem[];
}

interface EndpointStat {
  method: string | null;
  route: string | null;
  errors: number;
  refusals: number;
  lastErrorAt: string | null;
}

// ─── Labels ─────────────────────────────────────────────────────────────

const METHOD_COLORS: Record<string, string> = {
  GET: "bg-blue-100 text-blue-800",
  POST: "bg-green-100 text-green-800",
  PUT: "bg-yellow-100 text-yellow-800",
  PATCH: "bg-orange-100 text-orange-800",
  DELETE: "bg-red-100 text-red-800",
};

const AUTH_LABELS: Record<string, { label: string; color: string }> = {
  none: { label: "公開", color: "bg-gray-100 text-gray-600" },
  admin: { label: "管理員", color: "bg-purple-100 text-purple-700" },
  "coach-token": { label: "教練Token", color: "bg-teal-100 text-teal-700" },
  replit: { label: "Replit Auth", color: "bg-indigo-100 text-indigo-700" },
};

const SERVICE_STATUS: Record<ServiceStatus["status"], { label: string; icon: string; color: string; rank: number }> = {
  error: { label: "異常", icon: "fa-circle-exclamation", color: "text-red-600", rank: 0 },
  timeout: { label: "連線逾時", icon: "fa-clock", color: "text-red-600", rank: 0 },
  misconfigured: { label: "未設定", icon: "fa-circle-exclamation", color: "text-amber-500", rank: 1 },
  unknown: { label: "尚未驗證", icon: "fa-circle-question", color: "text-amber-500", rank: 2 },
  ok: { label: "連線正常", icon: "fa-circle-check", color: "text-green-600", rank: 3 },
  disabled: { label: "已停用", icon: "fa-circle-minus", color: "text-gray-400", rank: 4 },
};

const ACTIVITY_FILTERS: { key: string; label: string }[] = [
  { key: "", label: "全部" },
  { key: "schedule", label: "課表" },
  { key: "venue", label: "場館" },
  { key: "availability", label: "教練時段" },
  { key: "coach", label: "教練帳號" },
  { key: "trigger", label: "推播與同步" },
];

const ACTION_LABELS: Record<string, string> = {
  "schedule.create": "新增課程",
  "schedule.update": "修改課程",
  "schedule.patch": "修改教練人數",
  "schedule.assign": "指派教練",
  "schedule.delete": "刪除課程",
  "schedule.lock": "鎖定課表",
  "schedule.unlock": "解鎖課表",
  "schedule.copy_week": "複製整週",
  "schedule.import": "匯入課表",
  "venue.create": "新增場館",
  "venue.delete": "刪除場館",
  "venue_info.update": "修改場館資訊",
  "availability.save": "儲存可排時段",
  "coach.status": "審核教練帳號",
  "coach.rename": "修改教練姓名",
  "coach.line_bind": "綁定 LINE",
  "coach.line_clear": "解除 LINE",
  "coach.register": "教練申請帳號",
  "coach.link": "教練綁定帳號",
  "coach_rules.update": "修改教練守則",
  "notify.daily": "發送明日提醒",
  "notify.fill_reminder": "提醒填寫時段",
  "notify.individual": "個別推播",
  "ragic.sync": "手動 Ragic 同步",
  "weekly_push.enqueue": "排入週推播",
  "weekly_push.cancel": "取消週推播",
  "weekly_push.reconcile": "對帳週推播",
  "weekly_push.retry": "重試週推播",
};

const FIELD_LABELS: Record<string, string> = {
  className: "班名",
  coachName: "教練1",
  coachName2: "教練2",
  coachCount: "教練人數",
  coach1IsTeaching: "教練1授課",
  coach2IsTeaching: "教練2授課",
  isClassLocked: "鎖定",
  date: "日期",
  notes: "備註",
  name: "名稱",
  status: "狀態",
  lineId: "LINE",
  mapUrl: "地圖",
  videoUrl: "影片",
  description: "說明",
};

const RUN_STATUS: Record<string, { label: string; color: string }> = {
  failed: { label: "失敗", color: "bg-red-100 text-red-700" },
  interrupted: { label: "中斷", color: "bg-red-100 text-red-700" },
  partial_failed: { label: "部分失敗", color: "bg-amber-100 text-amber-700" },
  running: { label: "進行中", color: "bg-blue-100 text-blue-700" },
  success: { label: "成功", color: "bg-green-100 text-green-700" },
};

const TRIGGER_LABELS: Record<string, string> = { schedule: "排程", manual: "手動", startup: "啟動" };
const SOURCE_LABELS: Record<string, string> = { api: "API", ragic: "Ragic", notify: "通知", system: "系統" };

const taipei = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }) : "—";

const statKey = (method: string | null, route: string | null) => `${method ?? ""} ${route ?? ""}`;

/** Changed fields as "欄位：改前 → 改後" (at most six). */
function describeChange(before: unknown, after: unknown): string[] {
  const b = before && typeof before === "object" ? (before as Record<string, unknown>) : {};
  const a = after && typeof after === "object" ? (after as Record<string, unknown>) : {};
  const show = (v: unknown) => (v === null || v === undefined || v === "" ? "（空）" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const keys = Array.from(new Set([...Object.keys(b), ...Object.keys(a)])).filter(
    (k) => !["id", "createdAt", "updatedAt", "version", "venue", "timeSlot"].includes(k),
  );
  return keys
    .filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]))
    .slice(0, 6)
    .map((k) => `${FIELD_LABELS[k] ?? k}：${show(b[k])} → ${show(a[k])}`);
}

// ─── Panels ─────────────────────────────────────────────────────────────

function Panel({ title, icon, right, children }: { title: string; icon: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-lg border bg-card">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <i className={`fas ${icon} text-muted-foreground`}></i>
          {title}
        </h2>
        {right}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  );
}

function ActivityPanel() {
  const [group, setGroup] = useState("");
  const { data, isError } = useQuery<{ rows: ActivityRow[] }>({
    queryKey: [`/api/admin/it/activity?limit=150${group ? `&group=${group}` : ""}`],
    queryFn: getQueryFn({ on401: "returnNull" }),
    refetchInterval: 30_000,
  });
  const rows = data?.rows ?? [];
  return (
    <Panel
      title="活動紀錄"
      icon="fa-clock-rotate-left"
      right={
        <div className="flex flex-wrap gap-1">
          {ACTIVITY_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setGroup(f.key)}
              className={`rounded-full border px-2 py-0.5 text-[11px] ${group === f.key ? "border-primary bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      }
    >
      {isError && <p className="p-3 text-xs text-destructive">活動紀錄載入失敗</p>}
      {!isError && rows.length === 0 && <p className="p-3 text-xs text-muted-foreground">目前沒有紀錄</p>}
      <ul className="divide-y">
        {rows.map((row) => {
          const changes = describeChange(row.beforeData, row.afterData);
          return (
            <li key={row.id} className="px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="font-mono text-muted-foreground">{taipei(row.occurredAt)}</span>
                <span className="font-medium">{ACTION_LABELS[row.action] ?? row.action}</span>
                <span className="text-muted-foreground">by {row.actor}</span>
              </div>
              {changes.length > 0 && (
                <ul className="mt-0.5 space-y-0.5 text-muted-foreground">
                  {changes.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              )}
              {row.reason && <p className="mt-0.5 text-muted-foreground">說明：{row.reason}</p>}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function LogLine({ row }: { row: LogRow }) {
  const isError = row.level === "error";
  return (
    <li className={`px-3 py-2 text-xs ${isError ? "bg-red-50 dark:bg-red-950/30" : ""}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="font-mono text-muted-foreground">{taipei(row.occurredAt)}</span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${isError ? "bg-red-600 text-white" : row.level === "warn" ? "bg-gray-200 text-gray-700" : "bg-blue-100 text-blue-700"}`}>
          {isError ? "ERROR" : row.level === "warn" ? "拒絕" : "INFO"}
        </span>
        <span className="text-muted-foreground">{SOURCE_LABELS[row.source] ?? row.source}</span>
        {row.code && <span className="font-mono">{row.code}</span>}
      </div>
      {(row.route || row.message) && (
        <div className={`mt-0.5 break-all ${isError ? "text-red-700 dark:text-red-400" : "text-muted-foreground"}`}>
          {row.route && <span className="font-mono">{row.method} {row.route}</span>}
          {row.route && row.message && " · "}
          {row.message}
        </div>
      )}
    </li>
  );
}

function LogPanel() {
  const { data, isError } = useQuery<{ errors: LogRow[]; others: LogRow[] }>({
    queryKey: ["/api/admin/it/logs?limit=150"],
    queryFn: getQueryFn({ on401: "returnNull" }),
    refetchInterval: 30_000,
  });
  const errors = data?.errors ?? [];
  const others = data?.others ?? [];
  return (
    <Panel
      title="LOG 日誌"
      icon="fa-file-lines"
      right={
        <span className={`text-xs font-semibold ${errors.length ? "text-red-600" : "text-green-600"}`}>
          近 7 天錯誤 {errors.length}
        </span>
      }
    >
      {isError && <p className="p-3 text-xs text-destructive">日誌載入失敗</p>}
      {errors.length > 0 && (
        <>
          <div className="sticky top-0 z-10 bg-red-600 px-3 py-1 text-[11px] font-semibold text-white">錯誤（優先處理）</div>
          <ul className="divide-y">
            {errors.map((row) => (
              <LogLine key={row.id} row={row} />
            ))}
          </ul>
        </>
      )}
      <div className="sticky top-0 z-10 bg-muted px-3 py-1 text-[11px] font-semibold text-muted-foreground">其他紀錄</div>
      {!isError && others.length === 0 && <p className="p-3 text-xs text-muted-foreground">目前沒有紀錄</p>}
      <ul className="divide-y">
        {others.map((row) => (
          <LogLine key={row.id} row={row} />
        ))}
      </ul>
    </Panel>
  );
}

function RagicRunsSection() {
  const { data, isError } = useQuery<{ runs: RagicRun[] }>({
    queryKey: ["/api/admin/it/ragic-runs?limit=30"],
    queryFn: getQueryFn({ on401: "returnNull" }),
    refetchInterval: 30_000,
  });
  const runs = data?.runs ?? [];
  return (
    <section className="rounded-lg border bg-card">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <i className="fas fa-rotate text-muted-foreground"></i>
        <h2 className="text-sm font-semibold">Ragic 同步紀錄</h2>
        <span className="text-xs text-muted-foreground">失敗與中斷的排前面</span>
      </header>
      {isError && <p className="p-3 text-xs text-destructive">同步紀錄載入失敗</p>}
      {!isError && runs.length === 0 && <p className="p-3 text-xs text-muted-foreground">尚無同步紀錄（新版上線後的第一次同步開始記錄）</p>}
      <ul className="divide-y">
        {runs.map((run) => {
          const st = RUN_STATUS[run.displayStatus] ?? { label: run.displayStatus, color: "bg-gray-100 text-gray-700" };
          return (
            <li key={run.id} className="px-3 py-2 text-xs">
              <details open={run.items.length > 0 && run.displayStatus !== "success"}>
                <summary className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${st.color}`}>{st.label}</span>
                  <span className="font-mono text-muted-foreground">{taipei(run.startedAt)}</span>
                  <span>{TRIGGER_LABELS[run.trigger] ?? run.trigger}</span>
                  <span className="text-muted-foreground">
                    共 {run.totalCount} 筆、失敗 {run.failureCount} 筆
                  </span>
                  {run.errorCode && <span className="font-mono text-red-600">{run.errorCode}</span>}
                </summary>
                {run.items.length > 0 && (
                  <ul className="mt-1 space-y-0.5 border-l-2 border-red-200 pl-3 text-red-700 dark:text-red-400">
                    {run.items.map((item) => (
                      <li key={item.id}>
                        <span className="font-mono">#{item.sourceId}</span> {item.errorCode} {item.errorMessage}
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ServicesSection({ services }: { services: ServiceStatus[] }) {
  const sorted = [...services].sort((a, b) => SERVICE_STATUS[a.status].rank - SERVICE_STATUS[b.status].rank);
  return (
    <section className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
      {sorted.map((svc) => {
        const st = SERVICE_STATUS[svc.status];
        return (
          <div key={svc.id} className={`flex flex-col gap-1 rounded-lg border bg-card px-3 py-2 ${st.rank === 0 ? "border-red-300" : ""}`}>
            <div className="flex items-start justify-between gap-2">
              <span className="text-sm font-semibold leading-snug">{svc.name}</span>
              <span className={`flex shrink-0 items-center gap-1 text-xs font-medium ${st.color}`}>
                <i className={`fas ${st.icon} text-xs`}></i>
                {st.label}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground">{svc.description}</p>
            {svc.checkedAt && <p className="text-[11px] text-muted-foreground">檢查：{taipei(svc.checkedAt)}</p>}
            {svc.lastSyncTime && (
              <p className="text-[11px] text-muted-foreground">
                上次同步：{taipei(svc.lastSyncTime)}
                {svc.isSyncing && <span className="ml-1 animate-pulse text-blue-600">同步中…</span>}
              </p>
            )}
          </div>
        );
      })}
    </section>
  );
}

function ApiCatalogSection({ groups, stats }: { groups: ApiGroup[]; stats: EndpointStat[] }) {
  const byKey = useMemo(() => new Map(stats.map((s) => [statKey(s.method, s.route), s])), [stats]);
  const listed = new Set(groups.flatMap((g) => g.endpoints.map((e) => statKey(e.method, e.path))));
  const unlisted: ApiGroup = {
    group: "未列入目錄",
    endpoints: stats
      .filter((s) => !listed.has(statKey(s.method, s.route)))
      .map((s) => ({ method: s.method ?? "?", path: s.route ?? "?", description: "日誌中出現、目錄未列", auth: "none" as const })),
  };
  const all = unlisted.endpoints.length ? [...groups, unlisted] : groups;
  const scored = all.map((g) => {
    const endpoints = g.endpoints
      .map((ep) => ({ ep, stat: byKey.get(statKey(ep.method, ep.path)) }))
      .sort((a, b) => (b.stat?.errors ?? 0) - (a.stat?.errors ?? 0) || (b.stat?.refusals ?? 0) - (a.stat?.refusals ?? 0));
    const errors = endpoints.reduce((n, e) => n + (e.stat?.errors ?? 0), 0);
    const refusals = endpoints.reduce((n, e) => n + (e.stat?.refusals ?? 0), 0);
    return { group: g.group, endpoints, errors, refusals };
  });
  scored.sort((a, b) => b.errors - a.errors || b.refusals - a.refusals);
  const total = groups.reduce((n, g) => n + g.endpoints.length, 0);

  return (
    <details className="rounded-lg border bg-card">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-semibold">
        <i className="fas fa-code text-muted-foreground"></i>
        API 端點目錄
        <span className="text-xs font-normal text-muted-foreground">
          {total} 個端點 · 近 7 天錯誤 {scored.reduce((n, g) => n + g.errors, 0)}、拒絕 {scored.reduce((n, g) => n + g.refusals, 0)}
        </span>
      </summary>
      <div className="space-y-2 border-t p-3">
        {scored.map((g) => (
          <details key={g.group} open={g.errors > 0} className="rounded border">
            <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-1.5 text-xs font-semibold">
              {g.group}
              <span className="font-normal text-muted-foreground">{g.endpoints.length} 個端點</span>
              {g.errors > 0 && <span className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] text-white">錯誤 {g.errors}</span>}
              {g.refusals > 0 && <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] text-gray-700">拒絕 {g.refusals}</span>}
            </summary>
            <ul className="border-t px-3">
              {g.endpoints.map(({ ep, stat }) => {
                const auth = AUTH_LABELS[ep.auth] ?? AUTH_LABELS.none;
                return (
                  <li key={`${ep.method}-${ep.path}`} className="flex flex-wrap items-center gap-2 border-b py-1.5 last:border-0">
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${METHOD_COLORS[ep.method] ?? "bg-gray-100 text-gray-700"}`}>{ep.method}</span>
                    <code className="min-w-0 flex-1 break-all font-mono text-xs">{ep.path}</code>
                    {!!stat?.errors && <span className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] text-white">錯誤 {stat.errors}</span>}
                    {!!stat?.refusals && <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] text-gray-700">拒絕 {stat.refusals}</span>}
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${auth.color}`}>{auth.label}</span>
                    <span className="hidden max-w-[260px] truncate text-xs text-muted-foreground md:block">{ep.description}</span>
                  </li>
                );
              })}
            </ul>
          </details>
        ))}
      </div>
    </details>
  );
}

function ReferenceSection({ flags }: { flags: Record<string, boolean> }) {
  return (
    <details className="rounded-lg border bg-card">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-semibold">
        <i className="fas fa-book text-muted-foreground"></i>
        功能旗標與認證方式
      </summary>
      <div className="space-y-3 border-t p-3 text-xs">
        <div className="flex flex-wrap gap-2">
          {Object.entries(flags).map(([key, on]) => (
            <span key={key} className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 ${on ? "border-green-200 bg-green-50 text-green-700" : "border-gray-200 bg-gray-50 text-gray-500"}`}>
              <i className={`fas ${on ? "fa-toggle-on" : "fa-toggle-off"} text-[10px]`}></i>
              {key}
            </span>
          ))}
        </div>
        <div className="grid gap-3 text-muted-foreground sm:grid-cols-2">
          <p><b className="text-foreground">管理員（admin）</b>：Header 帶 <code className="rounded bg-muted px-1">x-admin-password</code>，前端從 sessionStorage 自動帶入。</p>
          <p><b className="text-foreground">教練前台（coach-token）</b>：LINE 登入後核發 30 天 token，請求帶 <code className="rounded bg-muted px-1">x-coach-token</code>。</p>
          <p><b className="text-foreground">公開（none）</b>：無需認證，僅用於唯讀展示。</p>
          <p><b className="text-foreground">Replit Auth</b>：僅 <code className="rounded bg-muted px-1">/api/auth/user</code> 使用。</p>
        </div>
      </div>
    </details>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────

export default function ItGovernancePage() {
  const { data, isLoading, isError } = useQuery<ItGovernanceData>({
    queryKey: ["/api/admin/it-governance"],
    queryFn: getQueryFn({ on401: "returnNull" }),
    refetchInterval: 30_000,
  });
  const { data: stats } = useQuery<{ rows: EndpointStat[] }>({
    queryKey: ["/api/admin/it/endpoint-stats"],
    queryFn: getQueryFn({ on401: "returnNull" }),
    refetchInterval: 30_000,
  });
  const { data: logs } = useQuery<{ errors: LogRow[] }>({
    queryKey: ["/api/admin/it/logs?limit=150"],
    queryFn: getQueryFn({ on401: "returnNull" }),
    refetchInterval: 30_000,
  });

  const services = data?.services ?? [];
  const okCount = services.filter((s) => s.status === "ok").length;
  const errorCount = logs?.errors.length ?? 0;
  const ragic = services.find((s) => s.id === "ragic-sync");

  return (
    <AdminLayout activeTab="it-governance">
      <div className="flex min-h-full flex-col gap-3 p-3">
        {/* Summary bar */}
        <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-card px-3 py-2">
          <h1 className="flex items-center gap-2 text-base font-bold">
            <i className="fas fa-shield-halved text-primary"></i>
            IT 治理
          </h1>
          <span className={`text-sm font-semibold ${errorCount ? "text-red-600" : "text-green-600"}`}>
            <i className={`fas ${errorCount ? "fa-triangle-exclamation" : "fa-circle-check"} mr-1`}></i>
            近 7 天錯誤 {errorCount}
          </span>
          <span className="text-sm">服務正常 {okCount}/{services.length}</span>
          {ragic?.lastSyncTime && <span className="text-sm text-muted-foreground">Ragic 上次同步 {taipei(ragic.lastSyncTime)}</span>}
          <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            {data && <>更新 {taipei(data.generatedAt)}</>}
            {data && <Badge variant={data.isDeployment ? "default" : "secondary"}>{data.isDeployment ? "Production" : "Development"}</Badge>}
          </span>
        </header>

        {isLoading && <p className="py-10 text-center text-sm text-muted-foreground">載入中…</p>}
        {isError && <p className="py-10 text-center text-sm text-destructive">載入失敗，請確認管理員密碼是否正確</p>}

        {/* Activity + log: side by side, each scrolls on its own */}
        <div className="flex min-h-[420px] shrink-0 flex-col gap-3 lg:h-[62vh] lg:flex-row">
          <ActivityPanel />
          <LogPanel />
        </div>

        {data && <ServicesSection services={services} />}
        <RagicRunsSection />
        {data && <ApiCatalogSection groups={data.apiGroups} stats={stats?.rows ?? []} />}
        {data && <ReferenceSection flags={data.featureFlags} />}
      </div>
    </AdminLayout>
  );
}
