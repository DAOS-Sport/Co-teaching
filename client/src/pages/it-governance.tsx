import { useQuery } from "@tanstack/react-query";
import AdminLayout from "@/components/admin-layout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { getQueryFn } from "@/lib/queryClient";

interface ServiceStatus {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  configured: boolean;
  status: "ok" | "disabled" | "misconfigured";
  endpoints?: string[];
  lastSyncTime?: string | null;
  isSyncing?: boolean;
  lastSyncResult?: {
    venues?: { total: number; added: string[] };
    coaches?: { total: number; added: number; lineIdsSynced: number; employeeIdsSynced: number };
  } | null;
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
  environment: string;
  isDeployment: boolean;
  featureFlags: Record<string, boolean>;
  services: ServiceStatus[];
  apiGroups: ApiGroup[];
}

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

const STATUS_CONFIG = {
  ok: { label: "正常", icon: "fa-circle-check", color: "text-green-600" },
  disabled: { label: "已停用", icon: "fa-circle-minus", color: "text-gray-400" },
  misconfigured: { label: "未設定", icon: "fa-circle-exclamation", color: "text-amber-500" },
};

function ServiceCard({ svc }: { svc: ServiceStatus }) {
  const st = STATUS_CONFIG[svc.status];
  return (
    <Card className="border">
      <CardHeader className="pb-2 pt-3 px-4">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm font-semibold leading-snug">{svc.name}</CardTitle>
          <span className={`flex items-center gap-1 text-xs font-medium whitespace-nowrap ${st.color}`}>
            <i className={`fas ${st.icon} text-xs`}></i>
            {st.label}
          </span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{svc.description}</p>
      </CardHeader>
      <CardContent className="px-4 pb-3 space-y-2">
        {svc.lastSyncTime && (
          <div className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">上次同步：</span>
            {new Date(svc.lastSyncTime).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}
            {svc.isSyncing && <span className="ml-2 text-blue-600 animate-pulse">同步中…</span>}
          </div>
        )}
        {svc.lastSyncResult && (
          <div className="text-xs text-muted-foreground space-y-0.5">
            {svc.lastSyncResult.venues && (
              <div>場館：{svc.lastSyncResult.venues.total} 筆（新增 {svc.lastSyncResult.venues.added.length}）</div>
            )}
            {svc.lastSyncResult.coaches && (
              <div>教練：{svc.lastSyncResult.coaches.total} 位、LINE ID 已同步 {svc.lastSyncResult.coaches.lineIdsSynced} 筆</div>
            )}
          </div>
        )}
        {svc.endpoints && svc.endpoints.length > 0 && (
          <div className="space-y-0.5">
            {svc.endpoints.map((ep) => (
              <code key={ep} className="block text-[10px] bg-muted rounded px-1.5 py-0.5 text-muted-foreground font-mono truncate">
                {ep}
              </code>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EndpointRow({ ep }: { ep: ApiEndpoint }) {
  const auth = AUTH_LABELS[ep.auth] ?? AUTH_LABELS.none;
  const mc = METHOD_COLORS[ep.method] ?? "bg-gray-100 text-gray-700";
  return (
    <div className="flex items-start gap-2 py-1.5 border-b border-border last:border-0">
      <span className={`inline-block text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 mt-0.5 ${mc}`}>
        {ep.method}
      </span>
      <code className="text-xs font-mono text-foreground flex-1 break-all leading-relaxed">{ep.path}</code>
      <span className={`hidden sm:inline-block text-[10px] px-1.5 py-0.5 rounded shrink-0 mt-0.5 ${auth.color}`}>
        {auth.label}
      </span>
      <span className="text-xs text-muted-foreground shrink-0 hidden md:block mt-0.5 max-w-[200px] truncate">{ep.description}</span>
    </div>
  );
}

export default function ItGovernancePage() {
  const { data, isLoading, isError } = useQuery<ItGovernanceData>({
    queryKey: ["/api/admin/it-governance"],
    queryFn: getQueryFn({ on401: "returnNull" }),
    refetchInterval: 30_000,
  });

  const okCount = data?.services.filter((s) => s.status === "ok").length ?? 0;
  const totalCount = data?.services.length ?? 0;
  const endpointTotal = data?.apiGroups.reduce((n, g) => n + g.endpoints.length, 0) ?? 0;

  return (
    <AdminLayout activeTab="it-governance">
      <div className="p-4 max-w-5xl mx-auto space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h1 className="text-lg font-bold text-foreground flex items-center gap-2">
              <i className="fas fa-shield-halved text-primary"></i>
              IT 治理總覽
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              系統服務狀態、API 端點目錄與對接指引
            </p>
          </div>
          {data && (
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>
                更新：{new Date(data.generatedAt).toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei" })}
              </span>
              <Badge variant={data.isDeployment ? "default" : "secondary"}>
                {data.isDeployment ? "Production" : "Development"}
              </Badge>
            </div>
          )}
        </div>

        {isLoading && (
          <div className="text-center py-16 text-muted-foreground text-sm">
            <i className="fas fa-spinner fa-spin mr-2"></i>載入中…
          </div>
        )}

        {isError && (
          <div className="text-center py-16 text-destructive text-sm">
            <i className="fas fa-triangle-exclamation mr-2"></i>載入失敗，請確認管理員密碼是否正確
          </div>
        )}

        {data && (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Card className="border">
                <CardContent className="pt-4 pb-3 px-4 text-center">
                  <div className="text-2xl font-bold text-green-600">{okCount}/{totalCount}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">服務正常</div>
                </CardContent>
              </Card>
              <Card className="border">
                <CardContent className="pt-4 pb-3 px-4 text-center">
                  <div className="text-2xl font-bold text-primary">{endpointTotal}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">API 端點數</div>
                </CardContent>
              </Card>
              <Card className="border">
                <CardContent className="pt-4 pb-3 px-4 text-center">
                  <div className="text-2xl font-bold text-foreground">{data.apiGroups.length}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">功能模組數</div>
                </CardContent>
              </Card>
              <Card className="border">
                <CardContent className="pt-4 pb-3 px-4 text-center">
                  <div className="text-2xl font-bold text-foreground">
                    {Object.values(data.featureFlags).filter(Boolean).length}/
                    {Object.values(data.featureFlags).length}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">功能旗標開啟</div>
                </CardContent>
              </Card>
            </div>

            {/* Feature flags */}
            <Card className="border">
              <CardHeader className="pb-2 pt-3 px-4">
                <CardTitle className="text-sm">功能旗標（Feature Flags）</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-3">
                <div className="flex flex-wrap gap-2">
                  {Object.entries(data.featureFlags).map(([key, val]) => (
                    <span
                      key={key}
                      className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full border ${
                        val
                          ? "bg-green-50 border-green-200 text-green-700"
                          : "bg-gray-50 border-gray-200 text-gray-500"
                      }`}
                    >
                      <i className={`fas ${val ? "fa-toggle-on" : "fa-toggle-off"} text-[10px]`}></i>
                      {key}
                    </span>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Services */}
            <section>
              <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                <i className="fas fa-plug text-muted-foreground"></i>
                接入服務狀態
              </h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {data.services.map((svc) => (
                  <ServiceCard key={svc.id} svc={svc} />
                ))}
              </div>
            </section>

            <Separator />

            {/* API catalog */}
            <section>
              <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
                <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <i className="fas fa-code text-muted-foreground"></i>
                  API 端點目錄
                </h2>
                <div className="flex items-center gap-2 text-[10px]">
                  {Object.entries(METHOD_COLORS).map(([m, c]) => (
                    <span key={m} className={`px-1.5 py-0.5 rounded font-bold ${c}`}>{m}</span>
                  ))}
                </div>
              </div>

              <div className="space-y-4">
                {data.apiGroups.map((grp) => (
                  <Card key={grp.group} className="border">
                    <CardHeader className="pb-1 pt-3 px-4">
                      <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        {grp.group}
                        <span className="ml-2 font-normal normal-case text-[10px]">
                          {grp.endpoints.length} 個端點
                        </span>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="px-4 pb-3">
                      {grp.endpoints.map((ep) => (
                        <EndpointRow key={`${ep.method}-${ep.path}`} ep={ep} />
                      ))}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>

            <Separator />

            {/* Integration guide */}
            <section>
              <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                <i className="fas fa-book text-muted-foreground"></i>
                認證方式說明
              </h2>
              <Card className="border">
                <CardContent className="px-4 py-3 space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <div className="text-xs font-semibold mb-1">管理員端點（admin）</div>
                      <p className="text-xs text-muted-foreground">
                        Header 加上 <code className="bg-muted px-1 rounded">x-admin-password: &lt;ADMIN_PASSWORD&gt;</code>，
                        或 Query 參數 <code className="bg-muted px-1 rounded">?adminPassword=...</code>。
                        前端由 <code className="bg-muted px-1 rounded">sessionStorage("admin-password")</code> 自動注入。
                      </p>
                    </div>
                    <div>
                      <div className="text-xs font-semibold mb-1">教練前台（coach-token）</div>
                      <p className="text-xs text-muted-foreground">
                        LINE OAuth 登入後核發 30 天 Session Token，每次請求帶
                        <code className="bg-muted px-1 rounded ml-1">x-coach-token: &lt;token&gt;</code>。
                        Token 儲存於 <code className="bg-muted px-1 rounded">sessionStorage("coach_portal_token")</code>。
                        Token 失效（403）時前端自動導回登入頁。
                      </p>
                    </div>
                    <div>
                      <div className="text-xs font-semibold mb-1">公開端點（none）</div>
                      <p className="text-xs text-muted-foreground">無需認證，任何人皆可呼叫。適用於教練視圖、場館課表等唯讀展示用途。</p>
                    </div>
                    <div>
                      <div className="text-xs font-semibold mb-1">Replit Auth</div>
                      <p className="text-xs text-muted-foreground">
                        僅限 Replit 平台登入使用者（OpenID Connect Session Cookie），
                        目前僅 <code className="bg-muted px-1 rounded">/api/auth/user</code> 使用。
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </section>

          </>
        )}
      </div>
    </AdminLayout>
  );
}
