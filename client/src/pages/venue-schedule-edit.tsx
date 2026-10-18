import { useState, useEffect, useRef } from "react";
import { BatchPlanPreview } from "@/components/schedule/batch-plan-preview";
import { batchContext, bindPreview, canCommitPreview, clearSubmittedDraft, failedSaveState, ordinarySaveReceipt, previewCommitToken, readScheduleLocation, scheduleCellKey, scheduleLocation, validDateOnly, type BatchPreview, type BoundPreview, type SaveState } from "@/lib/schedule-ui";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Copy, FileText, Upload } from "lucide-react";
import { format, addWeeks, subWeeks, startOfWeek, addDays } from "date-fns";
import { zhTW } from "date-fns/locale";
import FloatingConflictAlert from "@/components/floating-conflict-alert";
import AdminLayout from "@/components/admin-layout";
import { apiRequestWithConfirm, cachedScheduleVersion } from "@/lib/queryClient";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { VenueDto as Venue, TimeSlotDto as TimeSlot, ScheduleDto as Schedule } from "@shared/contracts";
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

type ImportPreview = BatchPreview & { venue: { id: string; name: string } | null; mode: ScheduleImportMode };

function ScheduleTextImportDialog({ open, onOpenChange, venueId, venueName, adminPassword, onCommitted }: {
  open: boolean; onOpenChange: (open: boolean) => void; venueId: string; venueName: string;
  adminPassword: string; onCommitted: () => void;
}) {
  const { toast } = useToast();
  const [text, setText] = useState(SCHEDULE_IMPORT_TEMPLATE);
  const [mode, setMode] = useState<ScheduleImportMode>("insert_only");
  const [boundPreview, setBoundPreview] = useState<BoundPreview<ImportPreview> | null>(null);
  const [clientErrors, setClientErrors] = useState<{ line: number; message: string }[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const context = batchContext({ venueId, text, mode });
  const latestContext = useRef(context); latestContext.current = context;
  const requestId = useRef(0);
  const preview = boundPreview?.value;
  const invalidate = () => { requestId.current++; setBoundPreview(null); setClientErrors([]); setError(""); setLoading(false); };
  useEffect(() => { setBoundPreview(null); setError(""); }, [context]);

  const requestPreview = async () => {
    const parsed = parseScheduleImportText(text);
    setClientErrors(parsed.errors); setBoundPreview(null); setError("");
    if (parsed.errors.length) return;
    const id = ++requestId.current, requestedContext = context;
    setLoading(true);
    try {
      const res = await fetch("/api/admin/schedules/import/preview", {
        method: "POST", headers: { "Content-Type": "application/json", "x-admin-password": adminPassword },
        body: JSON.stringify({ venueId, text, mode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "預覽失敗");
      if (id === requestId.current && requestedContext === latestContext.current) setBoundPreview(bindPreview(data, requestedContext));
    } catch (failure) {
      if (id === requestId.current && requestedContext === latestContext.current) setError(failure instanceof Error ? failure.message : "預覽失敗，輸入已保留。");
    } finally { if (id === requestId.current) setLoading(false); }
  };

  const commit = async () => {
    let confirmationToken: string;
    try { confirmationToken = previewCommitToken(boundPreview, context); }
    catch (failure) { setError((failure as Error).message); return; }
    const requestedContext = context;
    setCommitting(true); setError("");
    try {
      const res = await fetch("/api/admin/schedules/import/commit", {
        method: "POST", headers: { "Content-Type": "application/json", "x-admin-password": adminPassword },
        body: JSON.stringify({ venueId, text, mode, confirmationToken }),
      });
      const data = await res.json();
      if (res.status === 409 && data.preview) {
        if (requestedContext === latestContext.current) setBoundPreview(bindPreview(data.preview, requestedContext));
        setError("課表狀態已變更，已更新預覽；輸入保留，請重新檢查後手動確認。");
        return;
      }
      if (!res.ok) throw new Error(data.message || "匯入失敗");
      toast({ title: "課表已儲存", description: `新增 ${data.created}、更新 ${data.updated}、略過 ${data.skipped}；未安排通知。` });
      onCommitted(); onOpenChange(false); setBoundPreview(null);
    } catch (failure) {
      setBoundPreview(null);
      setError(`${failure instanceof Error ? failure.message : "匯入結果未確認"}。輸入已保留，請重新預覽後再試。`);
    } finally { setCommitting(false); }
  };

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 500_000) { setError("檔案超過 500 KB，請分批匯入。"); return; }
    try { setText(await file.text()); invalidate(); }
    catch { setError("檔案讀取失敗，原輸入已保留。"); }
  };

  return <Dialog open={open} onOpenChange={(next) => { if (committing) return; if (!next) invalidate(); onOpenChange(next); }}>
    <DialogContent className="max-w-6xl max-h-[92vh] overflow-y-auto">
      <DialogHeader><DialogTitle className="flex items-center gap-2"><FileText className="h-5 w-5" />文字匯入課表</DialogTitle>
        <DialogDescription>匯入場館：<strong>{venueName || '請先選擇場館'}</strong>。先預覽修改與警告，再確認寫入。</DialogDescription></DialogHeader>
      <div className="space-y-3">
        <div className="flex gap-3 flex-wrap items-center text-sm">
          <label className="flex gap-2 items-center"><Upload className="h-4 w-4" />選擇 .txt / .tsv<input type="file" accept=".txt,.tsv,text/plain,text/tab-separated-values" disabled={committing} onChange={(event) => void loadFile(event.target.files?.[0])} /></label>
          <Button type="button" variant="outline" size="sm" disabled={committing} onClick={() => { setText(SCHEDULE_IMPORT_TEMPLATE); invalidate(); }}>套用範本</Button>
          <label>重複課程處理 <select value={mode} disabled={committing} onChange={(event) => { setMode(event.target.value as ScheduleImportMode); invalidate(); }} className="rounded border p-1">
            <option value="insert_only">只新增，既有資料跳過</option><option value="update_matching">更新相同課程</option></select></label>
        </div>
        <textarea value={text} disabled={committing} onChange={(event) => { setText(event.target.value); invalidate(); }} className="w-full min-h-[180px] rounded border p-2 font-mono text-xs" spellCheck={false} aria-label="課表匯入文字" />
        <p className="text-xs text-muted-foreground">日期 YYYY-MM-DD、節次 1–7，一次最多 500 筆。輸入變更後須重新預覽。</p>
        {!!clientErrors.length && <div role="alert" className="text-sm text-red-700">{clientErrors.map((item, index) => <div key={index}>第 {item.line} 行：{item.message}</div>)}</div>}
        {error && <div role="alert" className="rounded border border-amber-300 bg-amber-50 p-2 text-sm">{error}</div>}
        {preview && <BatchPlanPreview preview={preview} />}
        <div className="flex justify-end gap-2"><Button variant="outline" disabled={committing} onClick={() => { invalidate(); onOpenChange(false); }}>取消</Button>
          <Button disabled={loading || committing || !venueId || !text.trim()} onClick={() => void requestPreview()}>{loading ? '預覽中…' : '預覽'}</Button>
          {preview && <Button disabled={committing || loading || !canCommitPreview(boundPreview, context)} onClick={() => void commit()}>{committing ? '儲存中…' : `確認儲存 ${preview.summary.create + preview.summary.update} 筆`}</Button>}
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}


function VenueScheduleEditContent() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const initialLocation = useRef(readScheduleLocation(typeof window !== "undefined" ? window.location.search : ""));
  const locationRestoring = useRef(false), locationInitialized = useRef(false);
  const [selectedVenue, setSelectedVenue] = useState(initialLocation.current.venueId);
  const [currentWeek, setCurrentWeek] = useState<Date>(initialLocation.current.week);
  const [activeCell, setActiveCell] = useState<{
    date: string;
    timeSlotId: string;
  } | null>(null);
  const [showCopyWeek, setShowCopyWeek] = useState(false);
  const [showTextImport, setShowTextImport] = useState(false);
  const [cellDrafts, setCellDrafts] = useState<Record<string, string>>({});
  const [cellSaveState, setCellSaveState] = useState<Record<string, SaveState>>({});
  const [cellLastSaved, setCellLastSaved] = useState<Record<string, string>>({});
  const savingKeys = useRef(new Set<string>());
  const [coachCountDrafts, setCoachCountDrafts] = useState<Record<string, number>>({});
  const [coachCountSaveState, setCoachCountSaveState] = useState<Record<string, SaveState>>({});
  const [coachCountErrors, setCoachCountErrors] = useState<Record<string, string>>({});
  const coachCountRevisions = useRef<Record<string, number>>({});
  const [copyPreview, setCopyPreview] = useState<BoundPreview<BatchPreview & { plannedCount: number }> | null>(null);
  const [copyError, setCopyError] = useState("");
  const [copySourceWeek, setCopySourceWeek] = useState<Date>(() =>
    subWeeks(startOfWeek(new Date(), { weekStartsOn: 1 }), 1)
  );

  const { data: venues, isError: venuesError, refetch: refetchVenues } = useQuery<Venue[]>({
    queryKey: ["/api/venues"],
  });

  const { data: timeSlots, isError: timeSlotsError, refetch: refetchTimeSlots } = useQuery<TimeSlot[]>({
    queryKey: ["/api/time-slots"],
  });

  const weekStart = format(currentWeek, "yyyy-MM-dd");
  const weekEnd = format(getExtendedWeekEnd(currentWeek), "yyyy-MM-dd");
  const copyContext = batchContext({ venueId: selectedVenue, sourceStartDate: format(copySourceWeek, "yyyy-MM-dd"), sourceEndDate: format(getExtendedWeekEnd(copySourceWeek), "yyyy-MM-dd"), targetStartDate: weekStart });
  const latestCopyContext = useRef(copyContext); latestCopyContext.current = copyContext;
  useEffect(() => { setCopyPreview(null); setCopyError(""); }, [copyContext]);

  const { data: schedules = [], isLoading: schedulesLoading, isError: schedulesError, refetch: refetchSchedules } = useQuery<
    (Schedule & { venue: Venue; timeSlot: TimeSlot })[]
  >({
    queryKey: [
      `/api/schedules?startDate=${weekStart}&endDate=${weekEnd}&venueId=${selectedVenue}`,
    ],
    enabled: !!selectedVenue,
  });

  useEffect(() => {
    if (venues && venues.length > 0 && !venues.some((venue) => venue.id === selectedVenue)) {
      setSelectedVenue(venues[0].id);
    }
  }, [venues, selectedVenue]);

  useEffect(() => {
    const restore = () => { const state = readScheduleLocation(window.location.search); locationRestoring.current = true; setSelectedVenue(state.venueId); setCurrentWeek(state.week); };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  useEffect(() => {
    if (!selectedVenue) return;
    if (locationRestoring.current) { locationRestoring.current = false; locationInitialized.current = true; return; }
    const next = scheduleLocation(window.location.pathname, selectedVenue, currentWeek);
    if (next !== window.location.pathname + window.location.search) window.history[locationInitialized.current ? "pushState" : "replaceState"](null, "", next);
    locationInitialized.current = true;
  }, [selectedVenue, currentWeek]);

  const adminPassword =
    typeof window !== "undefined"
      ? sessionStorage.getItem("admin-password") || ""
      : "";

  const saveClass = async (data: { date: string; timeSlotId: string; className: string }) => {
    const key = scheduleCellKey(selectedVenue, data.date, data.timeSlotId);
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
          throw Object.assign(new Error(`此時段已經有「${className}」，沒有重複新增。`), { code: body.code, status: response.status });
        }
        throw Object.assign(new Error(body.message || "儲存失敗"), { code: body.code, status: response.status });
      }
      setCellDrafts((drafts) => clearSubmittedDraft(drafts, key, data.className));
      setCellLastSaved((saved) => ({ ...saved, [key]: className }));
      setCellSaveState((state) => ({ ...state, [key]: "saved" }));
      queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0]).includes("/api/schedules") });
      queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0]).includes("/api/statistics") });

    } catch (error) {
      setCellSaveState((state) => ({ ...state, [key]: failedSaveState(error) }));
      toast({ title: "儲存失敗", description: error instanceof Error ? error.message : "未知錯誤", variant: "destructive" });
    } finally {
      savingKeys.current.delete(key);
    }
  };

  const deleteMutation = useMutation({
    mutationFn: async (scheduleId: string) => {
      const response = await apiRequestWithConfirm(
        "DELETE",
        `/api/schedules/${scheduleId}?expectedVersion=${cachedScheduleVersion(scheduleId) ?? ""}`,
        {},
      );
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
      // Server messages (locked week, changed by someone else) are shown as-is.
      let description = msg;
      if (msg.includes("401") || msg.includes("需要管理員密碼")) {
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
    onMutate: (variables) => {
      const id = variables.scheduleId;
      setCoachCountDrafts((previous) => ({ ...previous, [id]: variables.coachCount }));
      setCoachCountSaveState((previous) => ({ ...previous, [id]: "saving" }));
      setCoachCountErrors((previous) => ({ ...previous, [id]: "" }));
      const revision = (coachCountRevisions.current[id] ?? 0) + 1; coachCountRevisions.current[id] = revision;
      return { revision };
    },
    mutationFn: async ({
      scheduleId,
      coachCount,
    }: {
      scheduleId: string;
      coachCount: number;
    }) => {
      const response = await apiRequestWithConfirm("PATCH", `/api/schedules/${scheduleId}`, {
        coachCount,
        expectedVersion: cachedScheduleVersion(scheduleId),
      });
      return response.json();
    },
    onSuccess: (_saved, variables, context) => {
      const id = variables.scheduleId;
      setCoachCountDrafts((previous) => clearSubmittedDraft(previous, id, variables.coachCount));
      if (context?.revision === coachCountRevisions.current[id]) {
        setCoachCountSaveState((previous) => ({ ...previous, [id]: "saved" }));
        setCoachCountErrors((previous) => ({ ...previous, [id]: "" }));
        toast({ title: "課表已儲存", description: ordinarySaveReceipt });
      }
      queryClient.invalidateQueries({ predicate: (query) => typeof query.queryKey[0] === "string" && query.queryKey[0].includes("/api/schedules") });
      queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0]).includes("/api/statistics") });
    },
    onError: (error, variables, context) => {
      const id = variables.scheduleId;
      if (!context || context.revision === coachCountRevisions.current[id]) {
        setCoachCountSaveState((previous) => ({ ...previous, [id]: failedSaveState(error) }));
        setCoachCountErrors((previous) => ({ ...previous, [id]: error.message }));
        toast({ title: failedSaveState(error) === "conflict" ? "版本衝突，教練人數已保留" : "儲存失敗，教練人數已保留", description: error.message, variant: "destructive" });
      }
    },
  });

  const copyWeekMutation = useMutation({
    mutationFn: async (commit: boolean) => {
      const context = copyContext;
      const confirmationToken = commit ? previewCommitToken(copyPreview, context) : undefined;
      setCopyError("");
      const response = await fetch("/api/schedules/copy-week", {
        method: "POST", headers: { "Content-Type": "application/json", "x-admin-password": adminPassword },
        body: JSON.stringify({ sourceStartDate: format(copySourceWeek, "yyyy-MM-dd"), sourceEndDate: format(getExtendedWeekEnd(copySourceWeek), "yyyy-MM-dd"), targetStartDate: weekStart, venueId: selectedVenue, preview: !commit, confirmationToken }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 409 && body.preview) {
        if (context === latestCopyContext.current) setCopyPreview(bindPreview(body.preview, context));
        throw Object.assign(new Error("課表已變更，已更新預覽；日期保留，請重新檢查後手動確認。"), { preview: true });
      }
      if (!response.ok) throw Object.assign(new Error(body.message || "複製失敗"), { code: body.code, status: response.status });
      return { body, context };
    },
    onSuccess: ({ body, context }, commit) => {
      if (!commit) { if (context === latestCopyContext.current) setCopyPreview(bindPreview(body, context)); return; }
      toast({ title: "課表已儲存", description: "已複製 " + body.copied + " 筆；未安排通知。" });
      queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0]).includes("/api/schedules") });
      if (context === latestCopyContext.current) { setShowCopyWeek(false); setCopyPreview(null); }
    },
    onError: (error: Error & { preview?: boolean }) => { if (!error.preview) setCopyPreview(null); setCopyError(error.message); },
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

  if ((!venues && venuesError) || (!timeSlots && timeSlotsError)) return <div role="alert" className="p-4 text-red-700">場館或節次讀取失敗。<Button variant="outline" onClick={() => { void refetchVenues(); void refetchTimeSlots(); }}>重新載入</Button></div>;
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
                    if (validDateOnly(event.target.value)) setCopySourceWeek(startOfWeek(new Date(`${event.target.value}T12:00:00`), { weekStartsOn: 1 }));
                    setCopyPreview(null);
                  }} className="rounded border px-2 py-1" />
                </label>
                <div>來源週：{format(copySourceWeek, "yyyy/MM/dd")}～{format(addDays(copySourceWeek, 6), "yyyy/MM/dd")}</div>
                <div>目標週：{format(currentWeek, "yyyy/MM/dd")}～{format(addDays(currentWeek, 6), "yyyy/MM/dd")}</div>
              </div>
              {copyError && <div role="alert" className="rounded border border-amber-300 bg-amber-50 p-2 text-sm">{copyError}</div>}
              {copyPreview && <BatchPlanPreview preview={copyPreview.value} timeSlots={timeSlots} />}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setShowCopyWeek(false)}>取消</Button>
                {!copyPreview ? <Button onClick={() => copyWeekMutation.mutate(false)} disabled={copyWeekMutation.isPending || format(copySourceWeek, "yyyy-MM-dd") === format(currentWeek, "yyyy-MM-dd")}>
                  {copyWeekMutation.isPending ? "預覽中..." : "下一步：預覽"}
                </Button> : <Button onClick={() => copyWeekMutation.mutate(true)} disabled={copyWeekMutation.isPending || !canCommitPreview(copyPreview, copyContext)}>
                  {copyWeekMutation.isPending ? "複製中..." : `確認複製 ${copyPreview.value.summary.create} 筆`}
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
                                className="flex items-center justify-between bg-background/50 rounded px-1 py-0.5 text-xs group flex-wrap"
                              >
                                <span className="flex-1 truncate">{schedule.className || "未命名"}</span>
                                <div className="flex items-center gap-0.5 ml-1">
                                  <select
                                    value={coachCountDrafts[schedule.id] ?? (schedule.coachCount || 1)}
                                    disabled={coachCountSaveState[schedule.id] === "saving"}
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
                              {coachCountSaveState[schedule.id] && <div className="basis-full text-xs space-y-1 mt-1" data-testid="coach-count-receipt" data-state={coachCountSaveState[schedule.id]}>
      <div role="status">{coachCountSaveState[schedule.id] === 'saving' ? '教練人數儲存中…' : coachCountSaveState[schedule.id] === 'saved' ? ordinarySaveReceipt : coachCountSaveState[schedule.id] === 'conflict' ? '版本衝突，教練人數選擇已保留。' : '儲存失敗，教練人數選擇已保留。'}</div>
      {coachCountErrors[schedule.id] && <div role="alert" className="text-red-700">{coachCountErrors[schedule.id]}</div>}
      {(coachCountSaveState[schedule.id] === 'error' || coachCountSaveState[schedule.id] === 'conflict') && <div className="flex gap-2 flex-wrap">
        <Button size="sm" variant="outline" onClick={() => void refetchSchedules()}>重新讀取（保留選擇）</Button>
        <Button size="sm" onClick={() => updateCoachCountMutation.mutate({ scheduleId: schedule.id, coachCount: coachCountDrafts[schedule.id] ?? schedule.coachCount })}>確認重試</Button>
      </div>}
    </div>}</div>
                            ))}
                            {(() => {
                              const cellKey = scheduleCellKey(selectedVenue, dateStr, timeSlot.id);
                              const saveState = cellSaveState[cellKey];
                              return <div>
                            <input
                              type="text"
                              value={cellDrafts[cellKey] ?? ""}
                              className="w-full bg-transparent text-xs placeholder-muted-foreground border-none outline-none p-1"
                              placeholder={daySchedules.length === 0 ? "輸入班級名稱" : "新增課程"}
                              onFocus={() => setActiveCell({ date: dateStr, timeSlotId: timeSlot.id })}
                              onChange={(event) => { setCellDrafts((drafts) => ({ ...drafts, [cellKey]: event.target.value })); setCellSaveState((state) => ({ ...state, [cellKey]: "dirty" })); }}
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
                            {saveState === "dirty" && <span className="text-xs text-amber-800">尚未儲存</span>}
                             {saveState === "saving" && <span className="text-[10px] text-blue-600">{cellDrafts[cellKey]}　儲存中…</span>}
                            {saveState === "saved" && <span className="text-[10px] text-green-600">{cellLastSaved[cellKey]}　✓ {ordinarySaveReceipt}</span>}
                            {(saveState === "error" || saveState === "conflict") && <span className="text-[10px] text-red-600">{saveState === "conflict" ? "版本衝突，草稿保留；請重新載入後重試" : "儲存失敗，草稿保留"}　<button className="underline" onMouseDown={(event) => event.preventDefault()} onClick={() => void saveClass({ date: dateStr, timeSlotId: timeSlot.id, className: cellDrafts[cellKey] ?? "" })}>重試</button></span>}
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
