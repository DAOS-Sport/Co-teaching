export function weeklyPushAvailability(flags?: Record<string, boolean>, workerReady?: boolean) {
  if (!flags) return { ready: false, reason: "尚未取得週推播功能狀態，請重新整理。" };
  if (flags.weeklyPushQueue !== true) return { ready: false, reason: "週推播佇列已停用，無法建立預覽或推播任務。" };
  if (flags.weeklyPushWorker !== true) return { ready: false, reason: "週推播執行器已停用，無法處理預覽或推播任務。" };
  if (workerReady !== true) return { ready: false, reason: "週推播執行器尚未確認就緒，請重新整理狀態。" };
  return { ready: true, reason: "執行器已登記；任務與送達結果仍以後端紀錄為準。" };
}

export function requireWeeklyRuns(value: unknown): asserts value is { runs: unknown[] } {
  if (!value || typeof value !== "object" || !("runs" in value) || !Array.isArray(value.runs)) {
    throw new Error("週推播紀錄回覆格式不正確，無法判定是否有紀錄。");
  }
}
