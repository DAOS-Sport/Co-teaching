import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Copy, FileText, Upload } from "lucide-react";
import { format, addWeeks, subWeeks, startOfWeek, addDays } from "date-fns";
import { zhTW } from "date-fns/locale";
import FloatingConflictAlert from "@/components/floating-conflict-alert";
import AdminLayout from "@/components/admin-layout";
import { useLocation } from "wouter";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Venue, TimeSlot, Schedule } from "@shared/schema";
import {
  parseScheduleImportText,
  SCHEDULE_IMPORT_TEMPLATE,
  type ScheduleImportMode,
} from "@shared/scheduleImport";
import {
  getExtendedWeekDays,
  getExtendedWeekdayNames,
  getExtendedWeekEnd,
} from "@/utils/special-workdays";

type ImportIssue = { severity: "error" | "warning"; code: string; message: string };
type ImportPreviewRow = {
  line: number;
  date: string;
  period: number;
  className: string;
  coachName: string | null;
  coachName2: string | null;
  coachCount: 1 | 2;
  notes: string | null;
  status: "create" | "update" | "skip" | "error";
  issues: ImportIssue[];
};
type ImportPreview = {
  venue: { id: string; name: string } | null;
  mode: ScheduleImportMode;
  rows: ImportPreviewRow[];
  parseErrors: { line: number; message: string }[];
  summary: { total: number; create: number; update: number; skip: number; error: number; warning: number };
  canCommit: boolean;
};

function ScheduleTextImportDialog({
  open,
  onOpenChange,
  venueId,
  venueName,
  adminPassword,
  onCommitted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  venueId: string;
  venueName: string;
  adminPassword: string;
  onCommitted: () => void;
}) {
  const { toast } = useToast();
  const [text, setText] = useState(SCHEDULE_IMPORT_TEMPLATE);
  const [mode, setMode] = useState<ScheduleImportMode>("insert_only");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [clientErrors, setClientErrors] = useState<{ line: number; message: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);

  const requestPreview = async () => {
    const parsed = parseScheduleImportText(text);
    setClientErrors(parsed.errors);
    setPreview(null);
    if (parsed.errors.length > 0) return;
    setLoading(true);
    try {
      const res = await fetch("/api/admin/schedules/import/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-password": adminPassword },
        body: JSON.stringify({ venueId, text, mode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "預覽失敗");
      setPreview(data);
    } catch (error) {
      toast({
        title: "預覽失敗",
        description: error instanceof Error ? error.message : "無法解析課表",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const commit = async () => {
    setCommitting(true);
    try {
      const res = await fetch("/api/admin/schedules/import/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-password": adminPassword },
        body: JSON.stringify({ venueId, text, mode }),
      });
      const data = await res.json();
      if (res.status === 409 && data.preview) {
        setPreview(data.preview);
        throw new Error("課表狀態已改變，請檢查更新後的預覽");
      }
      if (!res.ok) throw new Error(data.message || "匯入失敗");
      toast({
        title: "課表匯入完成",
        description: `新增 ${data.created} 筆、更新 ${data.updated} 筆、跳過 ${data.skipped} 筆`,
      });
      onCommitted();
      onOpenChange(false);
      setPreview(null);
    } catch (error) {
      toast({
        title: "匯入失敗",
        description: error instanceof Error ? error.message : "未寫入任何資料",
        variant: "destructive",
      });
    } finally {
      setCommitting(false);
    }
  };

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 500_000) {
      toast({ title: "檔案過大", description: "文字檔不可超過 500 KB", variant: "destructive" });
      return;
    }
    setText(await file.text());
    setPreview(null);
    setClientErrors([]);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><FileText className="h-5 w-5" />文字匯入課表</DialogTitle>
          <DialogDescription>
            匯入場館：<strong>{venueName || "尚未選擇"}</strong>。請貼上 Tab 分隔文字，預覽確認後才會寫入。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-1 h-8 px-3 border rounded-md text-sm cursor-pointer hover:bg-accent">
              <Upload className="h-3.5 w-3.5" />選擇 .txt / .tsv
              <input
                type="file"
                accept=".txt,.tsv,text/plain,text/tab-separated-values"
                className="hidden"
                onChange={(event) => void loadFile(event.target.files?.[0])}
              />
            </label>
            <Button type="button" variant="outline" size="sm" onClick={() => { setText(SCHEDULE_IMPORT_TEMPLATE); setPreview(null); }}>
              套用範本
            </Button>
            <label className="text-sm ml-auto flex items-center gap-2">
              重複課程處理
              <select
                value={mode}
                onChange={(event) => { setMode(event.target.value as ScheduleImportMode); setPreview(null); }}
                className="h-8 rounded border bg-background px-2"
              >
                <option value="insert_only">只新增，既有資料跳過</option>
                <option value="update_matching">更新相同課程</option>
              </select>
            </label>
          </div>

          <textarea
            value={text}
            onChange={(event) => { setText(event.target.value); setPreview(null); setClientErrors([]); }}
            className="w-full min-h-48 rounded-md border bg-background p-3 font-mono text-xs"
            spellCheck={false}
            aria-label="課表匯入文字"
          />
          <p className="text-xs text-muted-foreground">
            必填欄位：日期、節次、班別。日期格式 YYYY-MM-DD，節次 1–7，一次最多 500 筆。
          </p>

          {clientErrors.length > 0 && (
            <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {clientErrors.map((error, index) => <div key={`${error.line}-${index}`}>第 {error.line} 行：{error.message}</div>)}
            </div>
          )}

          {preview && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 text-center text-sm">
                <div className="rounded bg-slate-100 p-2">總計<br /><strong>{preview.summary.total}</strong></div>
                <div className="rounded bg-green-50 text-green-700 p-2">新增<br /><strong>{preview.summary.create}</strong></div>
                <div className="rounded bg-blue-50 text-blue-700 p-2">更新<br /><strong>{preview.summary.update}</strong></div>
                <div className="rounded bg-gray-100 text-gray-600 p-2">跳過<br /><strong>{preview.summary.skip}</strong></div>
                <div className="rounded bg-red-50 text-red-700 p-2">錯誤<br /><strong>{preview.summary.error}</strong></div>
                <div className="rounded bg-amber-50 text-amber-700 p-2">警告<br /><strong>{preview.summary.warning}</strong></div>
              </div>
              {preview.parseErrors.length > 0 && (
                <div className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
                  {preview.parseErrors.map((error, index) => <div key={`${error.line}-${index}`}>第 {error.line} 行：{error.message}</div>)}
                </div>
              )}
              <div className="max-h-72 overflow-auto border rounded">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-gray-50">
                    <tr><th className="p-2 text-left">行</th><th className="p-2 text-left">日期</th><th>節次</th><th className="text-left">班別</th><th className="text-left">教練</th><th>結果</th><th className="text-left">訊息</th></tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row) => (
                      <tr key={row.line} className="border-t align-top">
                        <td className="p-2">{row.line}</td><td className="p-2 whitespace-nowrap">{row.date}</td><td className="p-2 text-center">{row.period}</td>
                        <td className="p-2">{row.className}</td><td className="p-2">{[row.coachName, row.coachName2].filter(Boolean).join("、") || "—"}</td>
                        <td className="p-2 text-center whitespace-nowrap">{{ create: "新增", update: "更新", skip: "跳過", error: "錯誤" }[row.status]}</td>
                        <td className="p-2">{row.issues.map((issue, index) => <div key={index} className={issue.severity === "error" ? "text-red-600" : "text-amber-600"}>{issue.message}</div>)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button onClick={() => void requestPreview()} disabled={loading || !venueId || !text.trim()}>
              {loading ? "檢查中..." : "解析並預覽"}
            </Button>
            {preview && (
              <Button onClick={() => void commit()} disabled={!preview.canCommit || committing} className="bg-green-600 hover:bg-green-700">
                {committing ? "匯入中..." : `確認匯入 ${preview.summary.create + preview.summary.update} 筆`}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function VenueScheduleEditContent() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const initialParams = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const [selectedVenue, setSelectedVenue] = useState<string>(() => initialParams.get("venueId") || "");
  const [currentWeek, setCurrentWeek] = useState<Date>(() => {
    const requestedWeek = initialParams.get("week");
    const parsed = requestedWeek ? new Date(`${requestedWeek}T00:00:00`) : new Date();
    return startOfWeek(Number.isNaN(parsed.getTime()) ? new Date() : parsed, { weekStartsOn: 1 });
  });
  const [activeCell, setActiveCell] = useState<{
    date: string;
    timeSlotId: string;
  } | null>(null);
  const [showCopyWeek, setShowCopyWeek] = useState(false);
  const [showTextImport, setShowTextImport] = useState(false);
  const [cellDrafts, setCellDrafts] = useState<Record<string, string>>({});
  const [cellSaveState, setCellSaveState] = useState<Record<string, "saving" | "saved" | "error">>({});
  const [cellLastSaved, setCellLastSaved] = useState<Record<string, string>>({});
  const savingKeys = useRef(new Set<string>());
  const [copyPreview, setCopyPreview] = useState<null | {
    sourceCount: number;
    plannedCount: number;
    duplicateClassSkipped: number;
    occupiedCellSkipped: number;
    items: { date: string; timeSlotId: string; className: string }[];
  }>(null);
  const [copySourceWeek, setCopySourceWeek] = useState<Date>(() =>
    subWeeks(startOfWeek(new Date(), { weekStartsOn: 1 }), 1)
  );

  const { data: venues } = useQuery<Venue[]>({
    queryKey: ["/api/venues"],
  });

  const { data: timeSlots } = useQuery<TimeSlot[]>({
    queryKey: ["/api/time-slots"],
  });

  const weekStart = format(currentWeek, "yyyy-MM-dd");
  const weekEnd = format(getExtendedWeekEnd(currentWeek), "yyyy-MM-dd");

  const { data: schedules = [], isLoading: schedulesLoading, isError: schedulesError, refetch: refetchSchedules } = useQuery<
    (Schedule & { venue: Venue; timeSlot: TimeSlot })[]
  >({
    queryKey: [
      `/api/schedules?startDate=${weekStart}&endDate=${weekEnd}&venueId=${selectedVenue}`,
    ],
    enabled: !!selectedVenue,
  });

  useEffect(() => {
    if (venues && venues.length > 0 && !selectedVenue) {
      setSelectedVenue(venues[0].id);
    }
  }, [venues, selectedVenue]);

  useEffect(() => {
    if (!selectedVenue) return;
    const params = new URLSearchParams();
    params.set("venueId", selectedVenue);
    params.set("week", weekStart);
    setLocation(`/mgt-x9k7p2/class-edit?${params.toString()}`, { replace: true });
  }, [selectedVenue, weekStart, setLocation]);

  const adminPassword =
    typeof window !== "undefined"
      ? sessionStorage.getItem("admin-password") || ""
      : "";

  const saveClass = async (data: { date: string; timeSlotId: string; className: string }) => {
    const key = `${data.date}:${data.timeSlotId}`;
    const className = data.className.trim();
    if (!className || savingKeys.current.has(key)) return;
    savingKeys.current.add(key);
    setCellSaveState((state) => ({ ...state, [key]: "saving" }));
    try {
      const response = await fetch("/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-password": adminPassword },
        body: JSON.stringify({
          date: data.date,
          venueId: selectedVenue,
          timeSlotId: data.timeSlotId,
          className,
          coachName: null,
          coachName2: null,
          coachCount: 1,
          coach1IsTeaching: true,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 409 && body.code === "DUPLICATE_CLASS_IN_CELL") {
          throw new Error(`此時段已經有「${className}」，沒有重複新增。`);
        }
        throw new Error(body.message || "儲存失敗");
      }
      setCellDrafts((drafts) => ({ ...drafts, [key]: "" }));
      setCellLastSaved((saved) => ({ ...saved, [key]: className }));
      setCellSaveState((state) => ({ ...state, [key]: "saved" }));
      queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0]).includes("/api/schedules") });
      queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0]).includes("/api/statistics") });
      window.setTimeout(() => setCellSaveState((state) => {
        if (state[key] !== "saved") return state;
        const next = { ...state };
        delete next[key];
        return next;
      }), 1500);
    } catch (error) {
      setCellSaveState((state) => ({ ...state, [key]: "error" }));
      toast({ title: "儲存失敗", description: error instanceof Error ? error.message : "未知錯誤", variant: "destructive" });
    } finally {
      savingKeys.current.delete(key);
    }
  };

  const deleteMutation = useMutation({
    mutationFn: async (scheduleId: string) => {
      const response = await fetch(`/api/schedules/${scheduleId}`, {
        method: "DELETE",
        headers: {
          "x-admin-password": adminPassword,
        },
      });
      if (!response.ok) {
        const text = (await response.text()) || response.statusText;
        throw new Error(`${response.status}: ${text}`);
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        predicate: (query) =>
          typeof query.queryKey[0] === "string" &&
          query.queryKey[0].includes("/api/schedules"),
      });
      queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0]).includes("/api/statistics") });
      toast({ title: "已刪除" });
    },
    onError: (error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      let description = `刪除失敗：${msg}`;
      if (msg.includes("409") || msg.includes("課表已鎖定")) {
        description = "課表已鎖定，請先解鎖該週才能刪除";
      } else if (msg.includes("401")) {
        description = "密碼驗證失敗，請重新登入";
      }
      toast({
        title: "刪除失敗",
        description,
        variant: "destructive",
      });
    },
  });

  const updateCoachCountMutation = useMutation({
    mutationFn: async ({
      scheduleId,
      coachCount,
    }: {
      scheduleId: string;
      coachCount: number;
    }) => {
      const response = await fetch(`/api/schedules/${scheduleId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-admin-password": adminPassword,
        },
        body: JSON.stringify({ coachCount }),
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        predicate: (query) =>
          typeof query.queryKey[0] === "string" &&
          query.queryKey[0].includes("/api/schedules"),
      });
      queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0]).includes("/api/statistics") });
    },
    onError: (error) => {
      toast({ title: "更新失敗", description: error.message, variant: "destructive" });
    },
  });

  const copyWeekMutation = useMutation({
    mutationFn: async (commit: boolean) => {
      const sourceStart = format(copySourceWeek, "yyyy-MM-dd");
      const sourceEnd = format(getExtendedWeekEnd(copySourceWeek), "yyyy-MM-dd");
      const targetStart = format(currentWeek, "yyyy-MM-dd");
      const response = await fetch("/api/schedules/copy-week", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-password": adminPassword,
        },
        body: JSON.stringify({
          sourceStartDate: sourceStart,
          sourceEndDate: sourceEnd,
          targetStartDate: targetStart,
          venueId: selectedVenue,
          preview: !commit,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || "複製失敗");
      return body;
    },
    onSuccess: (data, commit) => {
      if (!commit) {
        setCopyPreview(data);
        return;
      }
      toast({
        title: "複製成功",
        description: `已複製 ${data.copied} 個班級`,
      });
      queryClient.invalidateQueries({
        predicate: (query) =>
          typeof query.queryKey[0] === "string" &&
          query.queryKey[0].includes("/api/schedules"),
      });
      setShowCopyWeek(false);
      setCopyPreview(null);
    },
    onError: () => {
      toast({ title: "複製失敗", variant: "destructive" });
    },
  });

  const schedulesByDateAndTime: Record<
    string,
    Record<string, (Schedule & { venue: Venue; timeSlot: TimeSlot })[]>
  > = {};

  schedules.forEach((schedule) => {
    if (schedule.venue.id === selectedVenue) {
      if (!schedulesByDateAndTime[schedule.date]) {
        schedulesByDateAndTime[schedule.date] = {};
      }
      if (!schedulesByDateAndTime[schedule.date][schedule.timeSlotId]) {
        schedulesByDateAndTime[schedule.date][schedule.timeSlotId] = [];
      }
      schedulesByDateAndTime[schedule.date][schedule.timeSlotId].push(schedule);
    }
  });

  const handleDeleteClass = (schedule: Schedule & { timeSlot: TimeSlot }) => {
    if (window.confirm(`確定刪除「${schedule.className || "未命名"}」？\n${schedule.date}　${schedule.timeSlot.period}`)) {
      deleteMutation.mutate(schedule.id);
    }
  };

  const weekDateLabel = `${format(currentWeek, "yyyy/MM/dd")} - ${format(addDays(currentWeek, 6), "MM/dd")}`;

  const headerCenter = (
    <div className="flex items-center gap-2 flex-nowrap">
      <span className="text-sm font-medium whitespace-nowrap">選擇場館：</span>
      <select value={selectedVenue} onChange={(event) => {
        setSelectedVenue(event.target.value);
        setActiveCell(null);
        setCellDrafts({});
          setCellSaveState({});
          setCellLastSaved({});
        setCopyPreview(null);
      }} className="w-36 h-8 text-sm rounded border bg-background px-2">
        <option value="">請選擇場館</option>
          {venues?.map((venue) => (
            <option key={venue.id} value={venue.id}>
              {venue.name}
            </option>
          ))}
      </select>
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {venues?.find((venue) => venue.id === selectedVenue)?.name || "未選擇"}
      </span>
      <Button
        variant="outline"
        size="icon"
        className="h-8 w-8"
        onClick={() => setCurrentWeek((prev) => subWeeks(prev, 1))}
        data-testid="button-prev-week"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <span className="text-sm font-semibold whitespace-nowrap">{weekDateLabel}</span>
      <Button
        variant="outline"
        size="icon"
        className="h-8 w-8"
        onClick={() => setCurrentWeek((prev) => addWeeks(prev, 1))}
        data-testid="button-next-week"
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
      <Button
        variant="outline"
        className="h-8 text-sm px-3"
        onClick={() => setCurrentWeek(startOfWeek(new Date(), { weekStartsOn: 1 }))}
        data-testid="button-current-week"
      >
        本週
      </Button>
      <Button
        variant="outline"
        className="h-8 text-sm px-3"
        onClick={() => {
          setCopySourceWeek(subWeeks(currentWeek, 1));
          setCopyPreview(null);
          setShowCopyWeek(true);
        }}
      >
        <Copy className="h-3.5 w-3.5 mr-1" />
        複製週課表
      </Button>
      <Button
        variant="outline"
        className="h-8 text-sm px-3"
        onClick={() => setShowTextImport(true)}
        disabled={!selectedVenue}
      >
        <FileText className="h-3.5 w-3.5 mr-1" />
        文字匯入
      </Button>
    </div>
  );

  const headerRight = (
    <span className="text-sm bg-slate-100 text-slate-700 border px-3 py-1 rounded-full">
      目前頁面：學校課表編輯
    </span>
  );

  if (!venues || !timeSlots) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-primary">載入中...</div>
      </div>
    );
  }

  return (
    <AdminLayout activeTab="class-edit" headerCenter={headerCenter} headerRight={headerRight}>
      <div className="p-4">
        <ScheduleTextImportDialog
          open={showTextImport}
          onOpenChange={setShowTextImport}
          venueId={selectedVenue}
          venueName={venues.find((venue) => venue.id === selectedVenue)?.name || ""}
          adminPassword={adminPassword}
          onCommitted={() => {
            queryClient.invalidateQueries({
              predicate: (query) => typeof query.queryKey[0] === "string" && query.queryKey[0].includes("/api/schedules"),
            });
          }}
        />
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-indigo-200 bg-indigo-50 p-4">
          <div>
            <p className="font-medium text-indigo-900">用記事本一次新增課表</p>
            <p className="text-xs text-indigo-700">可貼上文字，或上傳 .txt／.tsv 檔；系統會先預覽，確認後才寫入。</p>
          </div>
          <Button onClick={() => setShowTextImport(true)} disabled={!selectedVenue} className="bg-indigo-600 hover:bg-indigo-700">
            <Upload className="mr-2 h-4 w-4" />從記事本／TSV 匯入
          </Button>
        </div>
        <Dialog open={showCopyWeek} onOpenChange={(open) => { setShowCopyWeek(open); if (!open) setCopyPreview(null); }}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>複製週課表</DialogTitle>
              <DialogDescription>只複製到完全空白的格子；不刪除、不修改、不覆蓋目標週資料。</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 text-sm">
              <div className="grid gap-2 rounded border p-3">
                <div>場館：<strong>{venues.find((venue) => venue.id === selectedVenue)?.name}</strong></div>
                <label className="flex items-center gap-2">來源週週一：
                  <input type="date" value={format(copySourceWeek, "yyyy-MM-dd")} onChange={(event) => {
                    setCopySourceWeek(startOfWeek(new Date(`${event.target.value}T00:00:00`), { weekStartsOn: 1 }));
                    setCopyPreview(null);
                  }} className="rounded border px-2 py-1" />
                </label>
                <div>來源週：{format(copySourceWeek, "yyyy/MM/dd")}～{format(addDays(copySourceWeek, 6), "yyyy/MM/dd")}</div>
                <div>目標週：{format(currentWeek, "yyyy/MM/dd")}～{format(addDays(currentWeek, 6), "yyyy/MM/dd")}</div>
              </div>
              {copyPreview && <div className="space-y-3 rounded border border-blue-200 bg-blue-50 p-3">
                <div className="grid grid-cols-2 gap-2">
                  <div>來源：<strong>{copyPreview.sourceCount}</strong> 筆</div>
                  <div>預計新增：<strong>{copyPreview.plannedCount}</strong> 筆</div>
                  <div>同名略過：<strong>{copyPreview.duplicateClassSkipped}</strong> 筆</div>
                  <div>目標格已有課程略過：<strong>{copyPreview.occupiedCellSkipped}</strong> 筆</div>
                </div>
                <div className="max-h-56 overflow-auto rounded bg-white border">
                  {copyPreview.items.map((item, index) => <div key={`${item.date}-${item.timeSlotId}-${index}`} className="border-b px-3 py-2 last:border-0">
                    {item.date}　{timeSlots.find((slot) => slot.id === item.timeSlotId)?.period || item.timeSlotId}　{item.className}
                  </div>)}
                </div>
              </div>}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setShowCopyWeek(false)}>取消</Button>
                {!copyPreview ? <Button onClick={() => copyWeekMutation.mutate(false)} disabled={copyWeekMutation.isPending || format(copySourceWeek, "yyyy-MM-dd") === format(currentWeek, "yyyy-MM-dd")}>
                  {copyWeekMutation.isPending ? "預覽中..." : "下一步：預覽"}
                </Button> : <Button onClick={() => copyWeekMutation.mutate(true)} disabled={copyWeekMutation.isPending || copyPreview.plannedCount === 0}>
                  {copyWeekMutation.isPending ? "複製中..." : `確認複製 ${copyPreview.plannedCount} 筆`}
                </Button>}
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Schedule Table */}
        {selectedVenue ? (
          <div>
            {schedulesLoading && <div className="mb-3 rounded border bg-slate-50 p-3 text-sm">課表載入中…</div>}
            {schedulesError && <div className="mb-3 flex items-center justify-between rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              <span>課表讀取失敗</span><Button size="sm" variant="outline" onClick={() => void refetchSchedules()}>重新載入</Button>
            </div>}
            {!schedulesLoading && !schedulesError && schedules.filter((schedule) => schedule.venue.id === selectedVenue).length === 0 &&
              <div className="mb-3 rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700">本週尚無課表，可直接在下方空格新增。</div>}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse min-w-[600px]">
              <thead className="sticky top-0 z-10">
                <tr>
                  <th className="border border-gray-300 p-2 bg-gray-50 w-20 sticky left-0 z-20 shadow-[2px_0_4px_rgba(0,0,0,0.1)]">
                    節次/時間
                  </th>
                  {getExtendedWeekDays(currentWeek).map((date, index) => {
                    const weekDayNames = getExtendedWeekdayNames(currentWeek);
                    return (
                      <th key={index} className="border border-gray-300 p-2 bg-gray-50 min-w-32">
                        <div className="text-center">
                          <div className="font-semibold">{weekDayNames[index]}</div>
                          <div className="text-sm text-gray-600">{format(date, "MM/dd")}</div>
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {timeSlots.map((timeSlot) => (
                  <tr key={timeSlot.id}>
                    <td className="border border-gray-300 p-2 bg-gray-50 text-center sticky left-0 z-10 shadow-[2px_0_4px_rgba(0,0,0,0.1)]">
                      <div className="font-medium">{timeSlot.period}</div>
                      <div className="text-xs text-gray-600">
                        {timeSlot.startTime}-{timeSlot.endTime}
                      </div>
                    </td>
                    {getExtendedWeekDays(currentWeek).map((date, index) => {
                      const dateStr = format(date, "yyyy-MM-dd");
                      const daySchedules = schedulesByDateAndTime[dateStr]?.[timeSlot.id] || [];

                      return (
                        <td
                          key={`${timeSlot.id}-${index}`}
                          className="border border-gray-300 p-1 align-top hover:bg-accent/50 cursor-pointer relative"
                          style={{ minHeight: "60px", verticalAlign: "top" }}
                        >
                          <div className="space-y-1 min-h-[60px]">
                            {daySchedules.map((schedule) => (
                              <div
                                key={schedule.id}
                                className="flex items-center justify-between bg-background/50 rounded px-1 py-0.5 text-xs group"
                              >
                                <span className="flex-1 truncate">{schedule.className || "未命名"}</span>
                                <div className="flex items-center gap-0.5 ml-1">
                                  <select
                                    value={schedule.coachCount || 1}
                                    onChange={(e) => {
                                      e.stopPropagation();
                                      updateCoachCountMutation.mutate({
                                        scheduleId: schedule.id,
                                        coachCount: parseInt(e.target.value),
                                      });
                                    }}
                                    onClick={(e) => e.stopPropagation()}
                                    className="text-[10px] bg-blue-50 border border-blue-200 rounded px-0.5 py-0 cursor-pointer hover:bg-blue-100"
                                    title="教練人數"
                                  >
                                    <option value={1}>1位</option>
                                    <option value={2}>2位</option>
                                  </select>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleDeleteClass(schedule);
                                    }}
                                    className="inline-flex h-8 w-8 items-center justify-center rounded text-destructive hover:bg-red-50"
                                    aria-label={`刪除 ${schedule.className || "未命名"}`}
                                    data-testid={`button-delete-${schedule.id}`}
                                  >
                                    <i className="fas fa-times text-xs"></i>
                                  </button>
                                </div>
                              </div>
                            ))}
                            {(() => {
                              const cellKey = `${dateStr}:${timeSlot.id}`;
                              const saveState = cellSaveState[cellKey];
                              return <div>
                            <input
                              type="text"
                              value={cellDrafts[cellKey] ?? ""}
                              className="w-full bg-transparent text-xs placeholder-muted-foreground border-none outline-none p-1"
                              placeholder={daySchedules.length === 0 ? "輸入班級名稱" : "新增課程"}
                              onFocus={() => setActiveCell({ date: dateStr, timeSlotId: timeSlot.id })}
                              onChange={(event) => setCellDrafts((drafts) => ({ ...drafts, [cellKey]: event.target.value }))}
                              disabled={saveState === "saving"}
                              onBlur={() => {
                                void saveClass({ date: dateStr, timeSlotId: timeSlot.id, className: cellDrafts[cellKey] ?? "" });
                                setActiveCell(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  void saveClass({ date: dateStr, timeSlotId: timeSlot.id, className: cellDrafts[cellKey] ?? "" });
                                  e.currentTarget.blur();
                                }
                              }}
                              data-testid={`input-${dateStr}-${timeSlot.id}`}
                            />
                            {saveState === "saving" && <span className="text-[10px] text-blue-600">{cellDrafts[cellKey]}　儲存中…</span>}
                            {saveState === "saved" && <span className="text-[10px] text-green-600">{cellLastSaved[cellKey]}　✓ 已儲存</span>}
                            {saveState === "error" && <span className="text-[10px] text-red-600">儲存失敗　<button className="underline" onMouseDown={(event) => event.preventDefault()} onClick={() => void saveClass({ date: dateStr, timeSlotId: timeSlot.id, className: cellDrafts[cellKey] ?? "" })}>重試</button></span>}
                            </div>;
                            })()}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-48 text-muted-foreground">
            請在上方選擇場館
          </div>
        )}
      </div>
      <FloatingConflictAlert weekStart={currentWeek} />
    </AdminLayout>
  );
}

export default function VenueScheduleEdit() {
  return <VenueScheduleEditContent />;
}
