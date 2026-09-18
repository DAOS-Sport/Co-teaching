import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import {
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
} from "lucide-react";
import type { WeeklyPushRun, WeeklyPushRecipient } from "@shared/schema";

export interface RunsResponse {
  runs: WeeklyPushRun[];
}

export interface RunDetailResponse {
  run: WeeklyPushRun;
  recipients: WeeklyPushRecipient[];
}

export const adminPassword = (): string =>
  (typeof window !== "undefined" &&
    sessionStorage.getItem("admin-password")) ||
  "";

export function fmtDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  try {
    return format(new Date(value), "yyyy/MM/dd HH:mm");
  } catch {
    return String(value);
  }
}

export function fmtWeek(start: string, end: string): string {
  const s = String(start).slice(0, 10);
  const e = String(end).slice(0, 10);
  return `${s} ~ ${e}`;
}

export function statusBadge(status: string) {
  switch (status) {
    case "queued":
      return (
        <Badge
          variant="outline"
          className="text-gray-600 border-gray-300 whitespace-nowrap"
        >
          <Clock className="h-3 w-3 mr-1" />
          排程中
        </Badge>
      );
    case "preparing":
    case "sending":
    case "reconciling":
      return (
        <Badge
          variant="outline"
          className="text-blue-700 border-blue-300 bg-blue-50 whitespace-nowrap"
        >
          <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
          執行中
        </Badge>
      );
    case "success":
      return (
        <Badge className="bg-green-500 hover:bg-green-600 whitespace-nowrap">
          <CheckCircle2 className="h-3 w-3 mr-1" />
          全部成功
        </Badge>
      );
    case "partial_success":
      return (
        <Badge className="bg-yellow-500 hover:bg-yellow-600 whitespace-nowrap">
          <AlertTriangle className="h-3 w-3 mr-1" />
          部分失敗
        </Badge>
      );
    case "cancelled":
      return <Badge variant="outline">已取消</Badge>;
    case "failed":
      return (
        <Badge variant="destructive" className="whitespace-nowrap">
          <XCircle className="h-3 w-3 mr-1" />
          全部失敗
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export function recipientStatusBadge(status: string) {
  switch (status) {
    case "success":
      return <Badge className="bg-green-500 whitespace-nowrap">成功</Badge>;
    case "failed":
      return (
        <Badge variant="destructive" className="whitespace-nowrap">
          失敗
        </Badge>
      );
    case "skipped":
      return (
        <Badge
          variant="outline"
          className="text-gray-500 border-gray-300 whitespace-nowrap"
        >
          略過
        </Badge>
      );
    case "pending":
      return (
        <Badge
          variant="outline"
          className="text-blue-600 border-blue-300 whitespace-nowrap"
        >
          等待中
        </Badge>
      );
    case "sending":
      return <Badge className="bg-blue-500 whitespace-nowrap">發送中</Badge>;
    case "retry_wait":
      return <Badge className="bg-amber-500 whitespace-nowrap">等待重試</Badge>;
    case "cancelled":
      return <Badge variant="outline">已取消</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export function triggerLabel(t: string): string {
  if (t === "cron") return "排程";
  if (t === "manual") return "手動";
  if (t === "retry") return "重送";
  return t;
}
