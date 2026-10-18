import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { askConfirm } from "@/components/confirm-popup";

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

/**
 * Pulls the admin password out of sessionStorage, set by PasswordProtect
 * after a successful /api/admin/verify-password handshake. We attach it on
 * every request so admin-only endpoints (DELETE/PATCH/PUT on schedules etc.)
 * accept calls made via apiRequest without each caller threading the header
 * by hand.
 */
function getAdminAuthHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const password = sessionStorage.getItem("admin-password");
  return password ? { "x-admin-password": password } : {};
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const headers: Record<string, string> = { ...getAdminAuthHeaders() };
  if (data) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

const isScheduleListKey = (key: readonly unknown[]) =>
  typeof key[0] === "string" && key[0].includes("/api/schedules");

type CachedSchedule = { id?: unknown; version?: unknown };

/** The version of a schedule row as this page last loaded it (#8). */
export function cachedScheduleVersion(id: string): number | undefined {
  const cached = queryClient.getQueriesData<CachedSchedule[]>({
    predicate: (query) => isScheduleListKey(query.queryKey),
  });
  for (const [, rows] of cached) {
    if (!Array.isArray(rows)) continue;
    const row = rows.find((candidate) => candidate?.id === id);
    if (row && typeof row.version === "number") return row.version;
  }
  return undefined;
}

/** Puts a saved row's new version into every cached schedule list right away. */
function applySavedSchedule(saved: unknown) {
  if (!saved || typeof saved !== "object") return;
  const { venue: _venue, timeSlot: _timeSlot, ...fields } = saved as Record<string, unknown>;
  if (typeof fields.id !== "string" || typeof fields.version !== "number") return;
  queryClient.setQueriesData<CachedSchedule[]>(
    { predicate: (query) => isScheduleListKey(query.queryKey) },
    (rows) => (Array.isArray(rows) ? rows.map((row) => (row?.id === fields.id ? { ...row, ...fields } : row)) : rows),
  );
}

interface ScheduleWarning {
  code: string;
  message: string;
}

/**
 * apiRequest for schedule writes the server may hold for confirmation
 * (409 CONFIRM_REQUIRED: coach conflict, or outside the coach's filled
 * availability). Asks once; on OK resends with those codes confirmed,
 * on cancel throws without saving. `preconfirmed` lists codes the page
 * has already confirmed in its own UI.
 */
export async function apiRequestWithConfirm(
  method: string,
  url: string,
  data: Record<string, unknown>,
  preconfirmed: string[] = [],
): Promise<Response> {
  const send = (confirmWarnings: string[], confirmationToken?: string) =>
    fetch(url, {
      method,
      headers: { ...getAdminAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ ...data, confirmWarnings, confirmationToken }),
      credentials: "include",
    });

  let res = await send(preconfirmed);
  if (res.status === 409) {
    const body = await res.clone().json().catch(() => null);
    if (body?.code === "CONFIRM_REQUIRED" && Array.isArray(body.warnings)) {
      const warnings = body.warnings as ScheduleWarning[];
      const messages = warnings.map((warning) => warning?.message).filter((message): message is string => typeof message === "string" && message.trim().length > 0);
      if (messages.length === 0) messages.push(typeof body.message === "string" && body.message.trim().length > 0 ? body.message : "資料狀態已變更，請重新確認後再儲存。");
      const confirmed = await askConfirm("請確認", messages);
      if (!confirmed) {
        throw new Error("已取消，未儲存");
      }
      res = await send([...preconfirmed, ...warnings.map((warning) => warning.code)], typeof body.confirmationToken === "string" ? body.confirmationToken : undefined);
    }
  }

  if (!res.ok) {
    const body = await res.clone().json().catch(() => null);
    // Someone else saved this row first: reload so the next try uses fresh data.
    if (body?.code === "VERSION_CONFLICT") {
      queryClient.invalidateQueries({ predicate: (query) => isScheduleListKey(query.queryKey) });
    }
    if (typeof body?.message === "string") throw Object.assign(new Error(body.message), { code: body.code, status: res.status });
  }
  await throwIfResNotOk(res);
  if (method !== "DELETE") applySavedSchedule(await res.clone().json().catch(() => null));
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(queryKey.join("/") as string, {
      credentials: "include",
      headers: getAdminAuthHeaders(),
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
