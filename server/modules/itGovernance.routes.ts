import type { Express } from "express";
import { requireAdminPassword } from "../shared/auth/adminPassword";
import { getRagicSyncStatus } from "../ragic";
import { featureFlags } from "../config/featureFlags";
import { env } from "../config/env";

export function registerItGovernanceRoutes(app: Express): void {
  app.get("/api/admin/it-governance", requireAdminPassword, async (_req, res) => {
    const ragic = getRagicSyncStatus();

    const services = [
      {
        id: "line-notify",
        name: "LINE 推播通知",
        description: "每週課表推播 & 每日提醒，透過 LINE Messaging API 傳送給教練",
        enabled: featureFlags.enableLineNotify,
        configured: !!(env.lineChannelAccessToken),
        status: featureFlags.enableLineNotify && env.lineChannelAccessToken ? "ok" : !env.lineChannelAccessToken ? "misconfigured" : "disabled",
        endpoints: [
          "POST /api/admin/notify-daily",
          "POST /api/admin/send-fill-reminder",
          "POST /api/admin/send-notify-individual",
          "GET /api/admin/notify-logs",
        ],
      },
      {
        id: "ragic-sync",
        name: "Ragic 資料同步",
        description: "每日 03:00 自動從 Ragic 同步部門、教練姓名、LINE ID 及員工編號",
        enabled: featureFlags.enableRagicSync,
        configured: !!env.ragicApiKey,
        status: featureFlags.enableRagicSync && env.ragicApiKey ? "ok" : !env.ragicApiKey ? "misconfigured" : "disabled",
        lastSyncTime: ragic.lastSyncTime,
        isSyncing: ragic.isSyncing,
        lastSyncResult: ragic.lastSyncResult,
        endpoints: [
          "GET /api/admin/ragic-status",
          "POST /api/admin/ragic-sync",
        ],
      },
      {
        id: "weekly-push-queue",
        name: "週推播排隊系統 (pg-boss)",
        description: "以 pg-boss 佇列驅動的週推播，支援乾跑模式、CSV 報告、重試機制",
        enabled: featureFlags.enableWeeklyPushQueue,
        configured: featureFlags.enableWeeklyPushQueue,
        status: featureFlags.enableWeeklyPushQueue ? "ok" : "disabled",
        endpoints: [
          "POST /api/admin/weekly-push/enqueue",
          "GET /api/admin/weekly-push/runs",
          "GET /api/admin/weekly-push/runs/:runId",
          "GET /api/admin/weekly-push/runs/:runId/report",
          "POST /api/admin/weekly-push/runs/:runId/retry-failed",
        ],
      },
      {
        id: "line-auth",
        name: "LINE 登入 (Coach Portal)",
        description: "教練前台透過 LINE OAuth 登入，取得 30 天 session token",
        enabled: true,
        configured: !!(env.lineChannelId && env.lineChannelSecret),
        status: env.lineChannelId && env.lineChannelSecret ? "ok" : "misconfigured",
        endpoints: [
          "GET /api/auth/line",
          "GET /api/auth/line/callback",
          "GET /api/auth/line/status",
        ],
      },
      {
        id: "multi-school",
        name: "多校區模組",
        description: "支援多個學校獨立 schema，教師回饋與課表管理",
        enabled: featureFlags.enableSchoolModule,
        configured: featureFlags.enableSchoolModule,
        status: featureFlags.enableSchoolModule ? "ok" : "disabled",
        endpoints: [
          "GET /api/:schoolCode/schedules",
          "GET /api/:schoolCode/teachers",
          "GET /api/:schoolCode/feedbacks",
          "POST /api/:schoolCode/feedbacks",
        ],
      },
    ];

    const apiGroups = [
      {
        group: "認證",
        endpoints: [
          { method: "GET", path: "/api/auth/user", description: "取得目前 Replit 登入使用者", auth: "replit" },
          { method: "GET", path: "/api/auth/line", description: "啟動 LINE OAuth 登入流程", auth: "none" },
          { method: "GET", path: "/api/auth/line/callback", description: "LINE OAuth 回呼，核發 coach session token", auth: "none" },
          { method: "GET", path: "/api/auth/line/status", description: "檢查 LINE 登入是否已設定", auth: "none" },
        ],
      },
      {
        group: "場館管理",
        endpoints: [
          { method: "GET", path: "/api/venues", description: "場館清單", auth: "none" },
          { method: "POST", path: "/api/admin/venues", description: "新增場館", auth: "admin" },
          { method: "DELETE", path: "/api/admin/venues/:id", description: "刪除場館", auth: "admin" },
          { method: "GET", path: "/api/venue-infos", description: "場館說明、地圖、影片連結", auth: "none" },
          { method: "PUT", path: "/api/admin/venue-infos/:venueName", description: "更新場館詳細資訊", auth: "admin" },
        ],
      },
      {
        group: "課表管理",
        endpoints: [
          { method: "GET", path: "/api/schedules", description: "依日期範圍查詢課表", auth: "none" },
          { method: "POST", path: "/api/schedules", description: "新增或更新課程記錄", auth: "none" },
          { method: "GET", path: "/api/schedules/lock-status", description: "檢查課表是否已鎖定", auth: "none" },
          { method: "POST", path: "/api/schedules/copy-week", description: "複製整週課表", auth: "admin" },
          { method: "POST", path: "/api/schedules/lock", description: "鎖定場館週課表", auth: "admin" },
          { method: "POST", path: "/api/schedules/unlock", description: "解鎖並觸發 LINE 通知", auth: "admin" },
          { method: "PUT", path: "/api/schedules/:id/assign-coach", description: "指派教練至課程", auth: "admin" },
          { method: "PUT", path: "/api/schedules/:id", description: "更新課程名稱與教練", auth: "admin" },
          { method: "PATCH", path: "/api/schedules/:id", description: "部分更新（教練人數等）", auth: "admin" },
          { method: "DELETE", path: "/api/schedules/:id", description: "刪除課程（鎖定時禁止）", auth: "admin" },
          { method: "GET", path: "/api/schedules/vacant", description: "尚未指派教練的課程清單", auth: "none" },
          { method: "GET", path: "/api/schedules/:date", description: "特定日期所有課程", auth: "none" },
          { method: "GET", path: "/api/conflicts/:date", description: "偵測特定日期排課衝突", auth: "none" },
          { method: "GET", path: "/api/statistics", description: "教練堂數統計", auth: "none" },
        ],
      },
      {
        group: "教練管理",
        endpoints: [
          { method: "GET", path: "/api/coaches", description: "所有教練姓名清單", auth: "none" },
          { method: "GET", path: "/api/approved-coaches", description: "已核准教練帳號清單", auth: "none" },
          { method: "GET", path: "/api/coach-schedules", description: "特定教練的課程紀錄", auth: "none" },
          { method: "GET", path: "/api/coach-availability", description: "教練當週可用時段", auth: "none" },
          { method: "GET", path: "/api/admin/coach-venue-preferences", description: "所有教練場館偏好", auth: "admin" },
          { method: "POST", path: "/api/coach-registrations", description: "教練申請特定課程", auth: "none" },
          { method: "GET", path: "/api/coach-registrations/:scheduleId", description: "特定課程的申請清單", auth: "none" },
        ],
      },
      {
        group: "教練前台 (Coach Portal)",
        endpoints: [
          { method: "GET", path: "/api/coach-portal/me/:identifier", description: "取得登入教練個人資料", auth: "coach-token" },
          { method: "GET", path: "/api/coach-portal/my-schedule", description: "個人課表", auth: "coach-token" },
          { method: "GET", path: "/api/coach-portal/colleagues", description: "同場館同日同事清單", auth: "coach-token" },
          { method: "GET", path: "/api/coach-portal/availability", description: "個人可用時段", auth: "coach-token" },
          { method: "POST", path: "/api/coach-portal/availability", description: "儲存個人可用時段", auth: "coach-token" },
          { method: "GET", path: "/api/coach-portal/venue-preferences", description: "個人場館偏好", auth: "coach-token" },
          { method: "POST", path: "/api/coach-portal/venue-preferences", description: "儲存場館偏好", auth: "coach-token" },
          { method: "POST", path: "/api/coach-portal/register", description: "以 LINE 帳號申請新教練帳號", auth: "none" },
          { method: "POST", path: "/api/coach-portal/link-existing", description: "綁定 LINE 至已有教練帳號", auth: "none" },
        ],
      },
      {
        group: "管理後台",
        endpoints: [
          { method: "POST", path: "/api/admin/verify-password", description: "驗證管理密碼", auth: "admin" },
          { method: "GET", path: "/api/admin/coach-users", description: "教練帳號清單（含狀態）", auth: "admin" },
          { method: "PUT", path: "/api/admin/coach-users/:id/status", description: "核准或退回教練申請", auth: "admin" },
          { method: "PUT", path: "/api/admin/coach-users/:id/name", description: "修改教練姓名", auth: "admin" },
          { method: "GET", path: "/api/admin/coach-fillrate", description: "教練資料填寫率儀表板", auth: "admin" },
          { method: "POST", path: "/api/admin/set-coach-line-id", description: "手動綁定 LINE ID", auth: "admin" },
        ],
      },
      {
        group: "通知推播",
        endpoints: [
          { method: "POST", path: "/api/admin/notify-daily", description: "手動觸發明日提醒推播", auth: "admin" },
          { method: "POST", path: "/api/admin/send-fill-reminder", description: "提醒未填寫可用時段的教練", auth: "admin" },
          { method: "GET", path: "/api/admin/notify-logs", description: "查看特定日期的推播記錄", auth: "admin" },
        ],
      },
      {
        group: "Ragic 同步",
        endpoints: [
          { method: "GET", path: "/api/admin/ragic-status", description: "上次同步時間與結果", auth: "admin" },
          { method: "POST", path: "/api/admin/ragic-sync", description: "手動觸發完整 Ragic 同步", auth: "admin" },
        ],
      },
      {
        group: "週推播佇列",
        endpoints: [
          { method: "POST", path: "/api/admin/weekly-push/enqueue", description: "排入週推播工作（支援乾跑模式）", auth: "admin" },
          { method: "GET", path: "/api/admin/weekly-push/runs", description: "推播執行紀錄清單", auth: "admin" },
          { method: "GET", path: "/api/admin/weekly-push/runs/:runId", description: "單次執行詳情與收件人狀態", auth: "admin" },
          { method: "GET", path: "/api/admin/weekly-push/runs/:runId/report", description: "下載 CSV 或 XLSX 報告", auth: "admin" },
          { method: "POST", path: "/api/admin/weekly-push/runs/:runId/retry-failed", description: "重試失敗的收件人", auth: "admin" },
        ],
      },
      {
        group: "系統診斷",
        endpoints: [
          { method: "GET", path: "/api/deployment-test", description: "公開健康檢查（環境、DB 連線）", auth: "none" },
          { method: "GET", path: "/api/time-slots", description: "全域時段定義清單", auth: "none" },
        ],
      },
    ];

    res.json({
      generatedAt: new Date().toISOString(),
      environment: env.isProduction ? "production" : "development",
      isDeployment: env.isDeployment,
      featureFlags: {
        lineNotify: featureFlags.enableLineNotify,
        ragicSync: featureFlags.enableRagicSync,
        schoolModule: featureFlags.enableSchoolModule,
        weeklyPushQueue: featureFlags.enableWeeklyPushQueue,
        weeklyPushWorker: featureFlags.enableWeeklyPushWorker,
      },
      services,
      apiGroups,
    });
  });
}
