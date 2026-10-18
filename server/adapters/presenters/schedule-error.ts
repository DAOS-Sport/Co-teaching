import { ScheduleMutationError } from "../../core/scheduling/entities";

export function presentScheduleMutationError(error: unknown) {
  if (!(error instanceof ScheduleMutationError)) return null;
  const messages: Record<string, string> = {
    VERSION_REQUIRED: "請重新整理頁面後再操作",
    VERSION_CONFLICT: "這筆課程剛被其他人修改過，畫面已重新整理，請確認後再操作一次",
    SCHEDULE_LOCKED: "課表已鎖定，請先解鎖該週才能新增或修改課程名稱",
  };
  const status = error.code === "VERSION_REQUIRED" ? 428
    : error.code === "SCHEDULE_NOT_FOUND" ? 404 : error.code === "DUPLICATE_COACH" ? 400 : 409;
  return { status, body: {
    code: error.code,
    message: error.code === "CONFIRM_REQUIRED" && error.warnings?.length ? `需要確認：${error.warnings.map(warning => warning.message).join("；")}` : messages[error.code] ?? error.message,
    ...(error.warnings ? { warnings: error.warnings, confirmationToken: error.confirmationToken } : {}),
  } };
}
