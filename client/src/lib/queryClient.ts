import { QueryClient, QueryFunction } from "@tanstack/react-query";

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
  const send = (confirmWarnings: string[]) =>
    fetch(url, {
      method,
      headers: { ...getAdminAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ ...data, confirmWarnings }),
      credentials: "include",
    });

  let res = await send(preconfirmed);
  if (res.status === 409) {
    const body = await res.clone().json().catch(() => null);
    if (body?.code === "CONFIRM_REQUIRED" && Array.isArray(body.warnings)) {
      const warnings = body.warnings as ScheduleWarning[];
      const lines = warnings.map((warning) => `• ${warning.message}`).join("\n");
      if (!window.confirm(`請確認：\n${lines}\n\n仍要儲存嗎？`)) {
        throw new Error("已取消，未儲存");
      }
      res = await send([...preconfirmed, ...warnings.map((warning) => warning.code)]);
    }
  }

  await throwIfResNotOk(res);
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
