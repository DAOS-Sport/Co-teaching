import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Send, RefreshCw, FileDown } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  adminPassword,
  fmtDate,
  fmtWeek,
  statusBadge,
  recipientStatusBadge,
  triggerLabel,
  type RunDetailResponse,
} from "./helpers";

export function RunDetailDialog({
  runId,
  onClose,
}: {
  runId: string | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const open = !!runId;

  const { data, isLoading } = useQuery<RunDetailResponse>({
    queryKey: ["/api/admin/weekly-push/runs", runId],
    queryFn: async () => {
      const res = await fetch(
        `/api/admin/weekly-push/runs/${runId}?password=${encodeURIComponent(adminPassword())}`,
      );
      if (!res.ok) throw new Error("讀取詳情失敗");
      return res.json();
    },
    enabled: !!runId,
    refetchInterval: open ? 10000 : false,
  });

  const retryMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(
        `/api/admin/weekly-push/runs/${runId}/retry-failed`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-admin-password": adminPassword(),
          },
          body: JSON.stringify({}),
        },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || "重新推播失敗");
      return body;
    },
    onSuccess: (body) => {
      toast({
        title: "已排入失敗者重試",
        description: `原任務 ${String(body.newRunId).slice(0, 8)}... · ${body.recipientsCreated} 位收件人`,
      });
      queryClient.invalidateQueries({
        queryKey: ["/api/admin/weekly-push/runs"],
      });
      onClose();
    },
    onError: (err: Error) => {
      toast({
        title: "重試失敗",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const run = data?.run;
  const recipients = data?.recipients ?? [];

  const counts = recipients.reduce(
    (acc, r) => {
      acc.total += 1;
      if (r.status === "success") acc.success += 1;
      else if (r.status === "failed") acc.failed += 1;
      else if (r.status === "skipped") acc.skipped += 1;
      else acc.pending += 1;
      return acc;
    },
    { total: 0, success: 0, failed: 0, skipped: 0, pending: 0 },
  );

  const reportUrl = run?.reportPath
    ? `/api/admin/weekly-push/runs/${run.id}/report?password=${encodeURIComponent(adminPassword())}`
    : null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-4 w-4" />
            推播任務詳情
            {run && (
              <span className="text-xs text-muted-foreground font-mono ml-2">
                {run.id}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        {isLoading || !run ? (
          <div className="text-center py-8 text-sm text-muted-foreground">
            載入中...
          </div>
        ) : (
          <div className="space-y-4">
            {/* Summary */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div className="border rounded p-3">
                <p className="text-xs text-muted-foreground">週次</p>
                <p className="font-medium">
                  {fmtWeek(
                    String(run.weekStartDate),
                    String(run.weekEndDate),
                  )}
                </p>
              </div>
              <div className="border rounded p-3">
                <p className="text-xs text-muted-foreground">狀態</p>
                <div className="mt-1">{statusBadge(run.status)}</div>
              </div>
              <div className="border rounded p-3">
                <p className="text-xs text-muted-foreground">類型 / 觸發</p>
                <p className="font-medium">
                  {run.dryRun ? "預覽" : "正式"} ·{" "}
                  {triggerLabel(run.triggerSource)}
                </p>
              </div>
              <div className="border rounded p-3">
                <p className="text-xs text-muted-foreground">完成時間</p>
                <p className="font-medium">{fmtDate(run.completedAt)}</p>
              </div>
            </div>

            {/* Counts */}
            <div className="flex gap-2 flex-wrap text-xs">
              <span className="bg-gray-50 border rounded px-2.5 py-1">
                總計 <strong>{counts.total}</strong>
              </span>
              <span className="bg-green-50 border border-green-200 text-green-700 rounded px-2.5 py-1">
                成功 <strong>{counts.success}</strong>
              </span>
              <span className="bg-red-50 border border-red-200 text-red-700 rounded px-2.5 py-1">
                失敗 <strong>{counts.failed}</strong>
              </span>
              <span className="bg-gray-50 border border-gray-200 text-gray-600 rounded px-2.5 py-1">
                略過 <strong>{counts.skipped}</strong>
              </span>
              {counts.pending > 0 && (
                <span className="bg-blue-50 border border-blue-200 text-blue-700 rounded px-2.5 py-1">
                  進行中 <strong>{counts.pending}</strong>
                </span>
              )}
            </div>

            {run.errorMessage && (
              <div className="bg-red-50 border border-red-200 rounded p-3 text-xs text-red-700">
                <p className="font-medium mb-1">任務錯誤</p>
                <pre className="whitespace-pre-wrap font-mono">
                  {run.errorMessage}
                </pre>
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center gap-2 flex-wrap pt-1">
              {reportUrl ? (
                <a href={reportUrl} download>
                  <Button size="sm" variant="outline" className="h-8">
                    <FileDown className="h-4 w-4 mr-1" />
                    下載報表（CSV）
                  </Button>
                </a>
              ) : (
                <Button size="sm" variant="outline" className="h-8" disabled>
                  <FileDown className="h-4 w-4 mr-1" />
                  報表尚未產生
                </Button>
              )}
              <Button
                size="sm"
                className="h-8 bg-orange-500 hover:bg-orange-600"
                onClick={() => {
                  if (counts.failed === 0) {
                    toast({
                      title: "無需重試",
                      description: "此任務沒有失敗的收件人。",
                    });
                    return;
                  }
                  if (
                    !confirm(
                      `確定要對 ${counts.failed} 位失敗收件人重新推播？`,
                    )
                  )
                    return;
                  retryMutation.mutate();
                }}
                disabled={retryMutation.isPending || counts.failed === 0}
                data-testid="button-retry-failed"
              >
                <RefreshCw
                  className={`h-4 w-4 mr-1 ${retryMutation.isPending ? "animate-spin" : ""}`}
                />
                {retryMutation.isPending
                  ? "建立中..."
                  : `重新推播失敗（${counts.failed}）`}
              </Button>
            </div>

            {/* Recipient table */}
            <div className="border rounded overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-gray-50">
                    <TableHead className="text-sm whitespace-nowrap">
                      教練
                    </TableHead>
                    <TableHead className="text-sm whitespace-nowrap">
                      LINE ID
                    </TableHead>
                    <TableHead className="text-sm whitespace-nowrap">
                      狀態
                    </TableHead>
                    <TableHead className="text-sm whitespace-nowrap text-right">
                      嘗試
                    </TableHead>
                    <TableHead className="text-sm whitespace-nowrap">
                      發送時間
                    </TableHead>
                    <TableHead className="text-sm">錯誤訊息</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recipients.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={6}
                        className="text-center text-sm text-muted-foreground py-6"
                      >
                        尚無收件人
                      </TableCell>
                    </TableRow>
                  ) : (
                    [...recipients]
                      .sort((a, b) => {
                        const order = {
                          failed: 0,
                          pending: 1,
                          success: 2,
                          skipped: 3,
                        } as Record<string, number>;
                        const oa = order[a.status] ?? 9;
                        const ob = order[b.status] ?? 9;
                        if (oa !== ob) return oa - ob;
                        return a.recipientName.localeCompare(
                          b.recipientName,
                          "zh-TW",
                        );
                      })
                      .map((r) => (
                        <TableRow
                          key={r.id}
                          data-testid={`row-recipient-${r.id}`}
                        >
                          <TableCell className="text-sm font-medium whitespace-nowrap">
                            {r.recipientName}
                          </TableCell>
                          <TableCell className="text-xs font-mono text-gray-500 max-w-[200px] truncate">
                            {r.lineUserId || (
                              <span className="text-gray-300">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {recipientStatusBadge(r.status)}
                          </TableCell>
                          <TableCell className="text-sm text-right">
                            {r.attemptCount}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                            {fmtDate(r.sentAt)}
                          </TableCell>
                          <TableCell className="text-xs text-red-600 max-w-[280px]">
                            {r.errorMessage ? (
                              <span title={r.errorMessage}>
                                {r.errorCode ? (
                                  <span className="font-mono text-[10px] bg-red-50 border border-red-200 px-1 py-0.5 rounded mr-1">
                                    {r.errorCode}
                                  </span>
                                ) : null}
                                {r.errorMessage}
                              </span>
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
