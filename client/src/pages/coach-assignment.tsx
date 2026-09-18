import { useState, useEffect, useMemo, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronLeft, ChevronRight, Check, Users, Zap, BarChart3, AlertTriangle, ChevronDown, X, Search } from "lucide-react";
import { format, addWeeks, subWeeks, startOfWeek } from "date-fns";
import { zhTW } from "date-fns/locale";
import FloatingConflictAlert from "@/components/floating-conflict-alert";
import AdminLayout from "@/components/admin-layout";
import { useLocation } from "wouter";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { Venue, TimeSlot, Schedule, CoachAvailability } from "@shared/schema";
import {
  getExtendedWeekDays,
  getExtendedWeekdayNames,
  getExtendedWeekEnd,
} from "@/utils/special-workdays";

type ConflictDetail = { venueName: string; className: string };

interface CoachSearchSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  coaches: string[];       // 場館教練（已篩選）
  allCoaches: string[];    // 全部教練（代班模式用）
  available: Set<string>;
  softConflicts?: Map<string, ConflictDetail[]>; // 跨課衝堂：可點選但需確認
  hardDisabled?: Set<string>;                     // 同筆 schedule 的另一位教練：硬擋
  onSoftConflictSelect?: (coach: string, details: ConflictDetail[]) => void;
  placeholder: string;
  triggerClassName?: string;
  hasValue?: boolean;
}

function CoachSearchSelect({
  value,
  onValueChange,
  coaches,
  allCoaches,
  available,
  softConflicts,
  hardDisabled,
  onSoftConflictSelect,
  placeholder,
  triggerClassName = "",
  hasValue = false,
}: CoachSearchSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [substituteMode, setSubstituteMode] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setSearch("");
      setSubstituteMode(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const normalize = (s: string) => s.toLowerCase().replace(/[\s\(\)\（\）\-_]/g, "");
  const activeList = substituteMode ? allCoaches : coaches;
  const filtered = (list: string[]) =>
    search.trim() === ""
      ? list
      : list.filter((c) => {
          const q = search.toLowerCase().trim();
          return c.toLowerCase().includes(q) || normalize(c).includes(normalize(q));
        });

  const availableList = filtered(activeList.filter((c) => available.has(c)));
  const otherList = filtered(activeList.filter((c) => !available.has(c)));
  const noResults = availableList.length === 0 && otherList.length === 0;

  const handleSelect = (coach: string) => {
    const softDetails = softConflicts?.get(coach);
    if (softDetails && softDetails.length > 0 && onSoftConflictSelect) {
      setOpen(false);
      onSoftConflictSelect(coach, softDetails);
      return;
    }
    onValueChange(coach);
    setOpen(false);
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onValueChange("__clear__");
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`coach-select-trigger w-full text-xs px-2 py-1 rounded border flex items-center justify-between gap-1 ${triggerClassName}`}
      >
        <div className="flex items-start gap-1 min-w-0 flex-1">
          {hasValue && <Check className="h-3 w-3 flex-shrink-0 text-green-600" />}
          <span className={`coach-select-name min-w-0 ${value ? "" : "text-gray-400"}`}>
            {value || placeholder}
          </span>
        </div>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {value && (
            <span onClick={handleClear} className="rounded hover:bg-gray-200 p-0.5 cursor-pointer">
              <X className="h-2.5 w-2.5 text-gray-400" />
            </span>
          )}
          <ChevronDown className="h-3 w-3 text-gray-400" />
        </div>
      </button>

      {open && (
        <div className="coach-select-menu absolute z-50 top-full left-0 mt-0.5 bg-white border border-gray-200 rounded shadow-lg">
          {substituteMode && (
            <div className="px-2 py-1 text-[10px] text-orange-600 font-medium bg-orange-50 border-b border-orange-100 flex items-center justify-between">
              <span>代班模式：顯示全部教練</span>
              <button
                type="button"
                onClick={() => { setSubstituteMode(false); setSearch(""); }}
                className="text-orange-400 hover:text-orange-600 ml-1"
              >✕</button>
            </div>
          )}
          <div className="p-1.5 border-b flex items-center gap-1">
            <Search className="h-3 w-3 text-gray-400 flex-shrink-0" />
            <input
              ref={inputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={substituteMode ? "搜尋全部教練..." : "搜尋場館教練..."}
              className="flex-1 text-xs outline-none bg-transparent"
              onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
            />
          </div>
          <div className="max-h-48 overflow-y-auto">
            {availableList.length > 0 && (
              <>
                <div className="px-2 py-0.5 text-[10px] text-green-600 font-medium bg-green-50">✅ 可用教練</div>
                {availableList.map((coach) => {
                  const isHard = !!hardDisabled?.has(coach);
                  const isSoft = !isHard && !!softConflicts?.has(coach);
                  return (
                    <button
                      key={coach}
                      type="button"
                      disabled={isHard}
                      onClick={() => !isHard && handleSelect(coach)}
                      className={`w-full text-left px-2 py-1 text-xs hover:bg-gray-100 flex items-center gap-1 ${
                        isHard ? "opacity-40 line-through cursor-not-allowed" : ""
                      } ${isSoft ? "text-orange-600 bg-orange-50/50 hover:bg-orange-100" : ""} ${
                        value === coach ? "bg-blue-50 font-medium" : ""
                      }`}
                    >
                      {isSoft ? "⚠️" : "✅"} {coach}
                      {isHard ? " (同筆)" : isSoft ? " (衝堂)" : ""}
                    </button>
                  );
                })}
              </>
            )}
            {otherList.length > 0 && (
              <>
                <div className="px-2 py-0.5 text-[10px] text-gray-400 font-medium bg-gray-50 border-t">
                  {substituteMode ? "全部教練" : "場館教練"}
                </div>
                {otherList.map((coach) => {
                  const isHard = !!hardDisabled?.has(coach);
                  const isSoft = !isHard && !!softConflicts?.has(coach);
                  return (
                    <button
                      key={coach}
                      type="button"
                      disabled={isHard}
                      onClick={() => !isHard && handleSelect(coach)}
                      className={`w-full text-left px-2 py-1 text-xs hover:bg-gray-100 ${
                        isHard ? "opacity-40 line-through cursor-not-allowed text-gray-500" : ""
                      } ${isSoft ? "text-orange-600 bg-orange-50/50 hover:bg-orange-100" : "text-gray-500"} ${
                        value === coach ? "bg-blue-50 font-medium" : ""
                      }`}
                    >
                      {isSoft ? "⚠️ " : ""}{coach}
                      {isHard ? " (同筆)" : isSoft ? " (衝堂)" : ""}
                    </button>
                  );
                })}
              </>
            )}
            {noResults && search.trim() === "" && (
              <div className="px-2 py-2 text-xs text-gray-400 text-center">請輸入姓名搜尋</div>
            )}
            {noResults && search.trim() !== "" && (
              <>
                <div className="px-2 py-2 text-xs text-gray-400 text-center">無符合結果</div>
                <button
                  type="button"
                  onClick={() => handleSelect(search.trim())}
                  className="w-full text-left px-2 py-1.5 text-xs text-orange-600 hover:bg-orange-50 border-t border-orange-100 flex items-center gap-1 font-medium"
                >
                  <span className="flex-shrink-0">＋</span>
                  <span>直接使用「{search.trim()}」</span>
                </button>
              </>
            )}
          </div>
          {!substituteMode && (
            <div className="border-t border-orange-100">
              <button
                type="button"
                onClick={() => { setSubstituteMode(true); setSearch(""); setTimeout(() => inputRef.current?.focus(), 50); }}
                className="w-full text-left px-2 py-1.5 text-xs text-orange-600 hover:bg-orange-50 flex items-center gap-1 font-medium"
              >
                <span className="flex-shrink-0">＋</span>
                <span>指派代班教練（顯示全部）</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CoachAssignmentContent() {
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
  const [selectedCell, setSelectedCell] = useState<{
    date: string;
    timeSlotId: string;
    timeSlotOrder: number;
  } | null>(null);
  const [selectedScheduleId, setSelectedScheduleId] = useState<string | null>(null);
  const [showRightPanel, setShowRightPanel] = useState(false);
  const [conflictConfirm, setConflictConfirm] = useState<{
    coach: string;
    details: ConflictDetail[];
    onConfirm: () => void;
  } | null>(null);

  const { data: venues } = useQuery<Venue[]>({ queryKey: ["/api/venues"] });
  const { data: timeSlots } = useQuery<TimeSlot[]>({ queryKey: ["/api/time-slots"] });

  const weekStart = format(currentWeek, "yyyy-MM-dd");
  const weekEnd = format(getExtendedWeekEnd(currentWeek), "yyyy-MM-dd");
  // This page intentionally displays weekdays only. Keep weekEnd on Sunday so
  // weekend records remain loaded for conflict checks and are never modified.
  const displayedWeekDays = useMemo(
    () => getExtendedWeekDays(currentWeek).slice(0, 5),
    [currentWeek]
  );
  const displayedWeekDayNames = useMemo(
    () => getExtendedWeekdayNames(currentWeek).slice(0, 5),
    [currentWeek]
  );

  useEffect(() => {
    if (venues && venues.length > 0 && !selectedVenue) setSelectedVenue(venues[0].id);
  }, [venues, selectedVenue]);

  useEffect(() => {
    if (!selectedVenue) return;
    const params = new URLSearchParams();
    params.set("venueId", selectedVenue);
    params.set("week", weekStart);
    setLocation(`/mgt-x9k7p2/assign?${params.toString()}`, { replace: true });
  }, [selectedVenue, weekStart, setLocation]);

  const { data: schedules = [] } = useQuery<(Schedule & { venue: Venue; timeSlot: TimeSlot })[]>({
    queryKey: [`/api/schedules?startDate=${weekStart}&endDate=${weekEnd}&venueId=${selectedVenue}`],
    enabled: !!selectedVenue,
  });

  const { data: allSchedules = [] } = useQuery<(Schedule & { venue: Venue; timeSlot: TimeSlot })[]>({
    queryKey: [`/api/schedules?startDate=${weekStart}&endDate=${weekEnd}`],
  });

  const { data: coaches = [] } = useQuery<string[]>({ queryKey: ["/api/approved-coaches"] });

  const { data: availability = [] } = useQuery<CoachAvailability[]>({
    queryKey: ["/api/coach-availability", weekStart],
    queryFn: async () => {
      const res = await fetch(`/api/coach-availability?weekStart=${weekStart}`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const { data: venuePrefsMap = {} } = useQuery<Record<string, string[]>>({
    queryKey: ["/api/admin/coach-venue-preferences"],
    queryFn: async () => {
      const password = sessionStorage.getItem("admin-password") || "";
      const res = await fetch(`/api/admin/coach-venue-preferences?password=${password}`);
      if (!res.ok) return {};
      return res.json();
    },
  });

  const availabilityMap = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const a of availability) {
      const key = `${a.dayOfWeek}-${a.timeSlotOrder}`;
      if (!map.has(key)) map.set(key, new Set());
      map.get(key)!.add(a.coachName);
    }
    return map;
  }, [availability]);

  const getAvailableCoaches = (dayOfWeek: number, timeSlotOrder: number, venueName?: string): Set<string> => {
    const timeAvailable = availabilityMap.get(`${dayOfWeek}-${timeSlotOrder}`) || new Set<string>();
    if (!venueName) return timeAvailable;
    const result = new Set<string>();
    Array.from(timeAvailable).forEach((coach) => {
      const prefs = venuePrefsMap[coach];
      if (!prefs || prefs.length === 0) result.add(coach);
      else if (prefs.includes(venueName)) result.add(coach);
    });
    return result;
  };

  const getConflictingCoaches = (
    date: string,
    timeSlotId: string,
    currentScheduleId: string
  ): Map<string, ConflictDetail[]> => {
    const conflicting = new Map<string, ConflictDetail[]>();
    const push = (name: string, detail: ConflictDetail) => {
      const arr = conflicting.get(name);
      if (arr) arr.push(detail);
      else conflicting.set(name, [detail]);
    };
    allSchedules.forEach((s) => {
      if (s.id === currentScheduleId || s.date !== date || s.timeSlotId !== timeSlotId) return;
      const detail: ConflictDetail = {
        venueName: s.venue?.name || "",
        className: s.className || "(未命名班級)",
      };
      if (s.coachName) push(s.coachName, detail);
      if (s.coachName2) push(s.coachName2, detail);
    });
    return conflicting;
  };

  const getCoach1Conflicts = (schedule: Schedule & { venue: Venue; timeSlot: TimeSlot }) => {
    const softConflicts = getConflictingCoaches(schedule.date, schedule.timeSlotId, schedule.id);
    const hardDisabled = new Set<string>();
    if (schedule.coachName2) hardDisabled.add(schedule.coachName2);
    return { softConflicts, hardDisabled };
  };

  const getCoach2Conflicts = (schedule: Schedule & { venue: Venue; timeSlot: TimeSlot }) => {
    const softConflicts = getConflictingCoaches(schedule.date, schedule.timeSlotId, schedule.id);
    const hardDisabled = new Set<string>();
    if (schedule.coachName) hardDisabled.add(schedule.coachName);
    return { softConflicts, hardDisabled };
  };

  const getAssignedCoachesForSlot = (date: string, timeSlotId: string): Set<string> => {
    const assigned = new Set<string>();
    allSchedules.forEach((s) => {
      if (s.date !== date || s.timeSlotId !== timeSlotId) return;
      if (s.coachName) assigned.add(s.coachName);
      if (s.coachName2) assigned.add(s.coachName2);
    });
    return assigned;
  };

  const assignCoachMutation = useMutation({
    mutationFn: async ({
      scheduleId, expectedVersion, coachName, coachName2, coach1IsTeaching, coach2IsTeaching,
    }: {
      scheduleId: string;
      expectedVersion: number;
      coachName?: string;
      coachName2?: string;
      coach1IsTeaching?: boolean;
      coach2IsTeaching?: boolean;
    }) => {
      const adminPassword = sessionStorage.getItem("admin-password") || "";
      const body: any = { expectedVersion };
      if (coachName !== undefined) body.coachName = coachName;
      if (coachName2 !== undefined) body.coachName2 = coachName2;
      if (coach1IsTeaching !== undefined) body.coach1IsTeaching = coach1IsTeaching;
      if (coach2IsTeaching !== undefined) body.coach2IsTeaching = coach2IsTeaching;
      const res = await fetch(`/api/schedules/${scheduleId}/assign-coach`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-admin-password": adminPassword },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        predicate: (query) =>
          typeof query.queryKey[0] === "string" &&
          (query.queryKey[0].includes("/api/schedules") || query.queryKey[0].includes("/api/conflicts")),
      });
      queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0]).includes("/api/statistics") });
      localStorage.setItem("scheduleLastModified", Date.now().toString());
      toast({ title: "指派成功", description: "教練已更新，將於上課前一天推播通知" });
    },
    onError: (error) => {
      toast({ title: "指派失敗", description: error.message, variant: "destructive" });
    },
  });

  useEffect(() => {
    if (venues && venues.length > 0 && !selectedVenue) {
      setSelectedVenue(venues[0].id);
    }
  }, [venues, selectedVenue]);

  const schedulesByDateAndTime: Record<string, Record<string, (Schedule & { venue: Venue; timeSlot: TimeSlot })[]>> = {};
  schedules.forEach((schedule) => {
    if (schedule.venue.id === selectedVenue) {
      if (!schedulesByDateAndTime[schedule.date]) schedulesByDateAndTime[schedule.date] = {};
      if (!schedulesByDateAndTime[schedule.date][schedule.timeSlotId])
        schedulesByDateAndTime[schedule.date][schedule.timeSlotId] = [];
      schedulesByDateAndTime[schedule.date][schedule.timeSlotId].push(schedule);
    }
  });

  const weeklyStats = useMemo(() => {
    const stats: Record<string, { assigned: number; available: number }> = {};
    for (const coach of coaches) stats[coach] = { assigned: 0, available: 0 };
    for (const a of availability) {
      if (stats[a.coachName]) stats[a.coachName].available++;
    }
    for (const s of allSchedules) {
      if (s.coachName && stats[s.coachName]) stats[s.coachName].assigned++;
      if (s.coachName2 && stats[s.coachName2]) stats[s.coachName2].assigned++;
    }
    return stats;
  }, [coaches, availability, allSchedules]);

  const missingCoachCount = useMemo(() => {
    let missing = 0;
    for (const s of schedules) {
      if (!s.className || s.venue.id !== selectedVenue) continue;
      if (!s.coachName) missing++;
      if ((s.coachCount || 1) >= 2 && !s.coachName2) missing++;
    }
    return missing;
  }, [schedules, selectedVenue]);

  const selectedVenueData = venues?.find((v) => v.id === selectedVenue);

  // 場館教練：有填偏好且包含此場館，或尚未填任何偏好者
  const venueEligibleCoaches = useMemo(() => {
    const venueName = selectedVenueData?.name;
    if (!venueName) return coaches;
    return coaches.filter((coach) => {
      const prefs = venuePrefsMap[coach];
      return !prefs || prefs.length === 0 || prefs.includes(venueName);
    });
  }, [coaches, selectedVenueData, venuePrefsMap]);

  // SWIM-05: 依 (isAvailable, prefersVenue) 評分，優先指派最合適教練
  const scoredCandidates = (dayOfWeek: number, timeSlotOrder: number, venueName: string, excludeSet: Set<string>): string[] => {
    const timeAvailSet = availabilityMap.get(`${dayOfWeek}-${timeSlotOrder}`) || new Set<string>();
    const scored: { coach: string; score: number }[] = [];
    for (const coach of venueEligibleCoaches) {
      if (excludeSet.has(coach)) continue;
      const isAvailable = timeAvailSet.has(coach);
      const prefs = venuePrefsMap[coach];
      const prefersVenue = !!(prefs && prefs.length > 0 && prefs.includes(venueName));
      const noPrefsSet = !prefs || prefs.length === 0;
      let score = 0;
      if (isAvailable && prefersVenue) score = 3;
      else if (isAvailable && noPrefsSet) score = 2;
      else if (isAvailable) score = 2;
      else if (prefersVenue) score = 1;
      else continue; // neither: exclude
      scored.push({ coach, score });
    }
    return scored.sort((a, b) => b.score - a.score).map((x) => x.coach);
  };

  const handleAutoFill = () => {
    const unfilled = schedules.filter(
      (s) => s.className && s.venue.id === selectedVenue && (!s.coachName || ((s.coachCount || 1) >= 2 && !s.coachName2))
    );
    let filled = 0;
    const localCounts: Record<string, number> = {};
    for (const coach of coaches) localCounts[coach] = weeklyStats[coach]?.assigned || 0;
    const venueName = selectedVenueData?.name || "";

    const pickBest = (candidates: string[], timeAvailSet: Set<string>): string | undefined => {
      return candidates.sort((a, b) => {
        const scoreOf = (c: string) => {
          const prefs = venuePrefsMap[c];
          const inAvail = timeAvailSet.has(c);
          const prefV = !!(prefs && prefs.length > 0 && prefs.includes(venueName));
          return inAvail && prefV ? 3 : inAvail ? 2 : 1;
        };
        const diff = scoreOf(b) - scoreOf(a);
        return diff !== 0 ? diff : (localCounts[a] || 0) - (localCounts[b] || 0);
      })[0];
    };

    for (const schedule of unfilled) {
      const date = new Date(schedule.date);
      const dayOfWeek = date.getDay() === 0 ? 7 : date.getDay();
      const timeSlotOrder = schedule.timeSlot?.order || 0;
      const timeAvailSet = availabilityMap.get(`${dayOfWeek}-${timeSlotOrder}`) || new Set<string>();
      const conflictingMap = getConflictingCoaches(schedule.date, schedule.timeSlotId, schedule.id);
      const conflicting = new Set<string>(conflictingMap.keys());
      let assignedCoach1 = schedule.coachName || "";
      if (!schedule.coachName) {
        const candidates = scoredCandidates(dayOfWeek, timeSlotOrder, venueName, conflicting);
        if (candidates.length > 0) {
          const best = pickBest(candidates, timeAvailSet)!;
          assignCoachMutation.mutate({ scheduleId: schedule.id, expectedVersion: schedule.version, coachName: best });
          localCounts[best] = (localCounts[best] || 0) + 1;
          assignedCoach1 = best;
          filled++;
        }
      }
      if ((schedule.coachCount || 1) >= 2 && !schedule.coachName2) {
        const exclude2 = new Set(conflicting);
        if (assignedCoach1) exclude2.add(assignedCoach1);
        const candidates2 = scoredCandidates(dayOfWeek, timeSlotOrder, venueName, exclude2);
        if (candidates2.length > 0) {
          const best2 = pickBest(candidates2, timeAvailSet)!;
          assignCoachMutation.mutate({ scheduleId: schedule.id, expectedVersion: schedule.version, coachName2: best2 });
          localCounts[best2] = (localCounts[best2] || 0) + 1;
          filled++;
        }
      }
    }
    if (filled === 0) {
      toast({ title: "無可用教練", description: "沒有符合條件的教練可自動指派", variant: "destructive" });
    } else {
      toast({ title: "自動指派完成", description: `已嘗試指派 ${filled} 個教練` });
    }
  };

  const sidebarAvailableCoaches = selectedCell
    ? (() => {
        const d = new Date(selectedCell.date);
        const dayOfWeek = d.getDay() === 0 ? 7 : d.getDay();
        const available = getAvailableCoaches(dayOfWeek, selectedCell.timeSlotOrder, selectedVenueData?.name);
        const assigned = getAssignedCoachesForSlot(selectedCell.date, selectedCell.timeSlotId);
        return {
          available: Array.from(available).filter((c) => !assigned.has(c)),
          assigned: Array.from(assigned),
        };
      })()
    : null;

  const weekDateLabel = `${format(currentWeek, "yyyy/MM/dd")} - ${format(
    new Date(currentWeek.getTime() + 6 * 86400000),
    "MM/dd"
  )}`;

  const headerCenter = (
    <div className="flex items-center gap-2 flex-nowrap">
      <span className="text-sm font-medium whitespace-nowrap">選擇場館：</span>
      <select value={selectedVenue} onChange={(event) => setSelectedVenue(event.target.value)} className="w-36 h-8 rounded border bg-background px-2 text-sm">
        <option value="">請選擇場館</option>
          {venues?.map((venue) => (
            <option key={venue.id} value={venue.id}>{venue.name}</option>
          ))}
      </select>
      <span className="text-xs text-muted-foreground">{venues?.find((venue) => venue.id === selectedVenue)?.name || "未選擇"}</span>
      <Button variant="outline" size="icon" className="h-8 w-8"
        onClick={() => setCurrentWeek((prev) => subWeeks(prev, 1))}>
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <span className="text-sm font-semibold whitespace-nowrap">{weekDateLabel}</span>
      <Button variant="outline" size="icon" className="h-8 w-8"
        onClick={() => setCurrentWeek((prev) => addWeeks(prev, 1))}>
        <ChevronRight className="h-4 w-4" />
      </Button>
      <Button variant="outline" className="h-8 text-sm px-3"
        onClick={() => setCurrentWeek(startOfWeek(new Date(), { weekStartsOn: 1 }))}>
        本週
      </Button>
    </div>
  );

  const headerRight = (
    <div className="flex items-center gap-2">
      <button
        onClick={() => setShowRightPanel(v => !v)}
        title={showRightPanel ? "隱藏本週統計" : "顯示本週統計"}
        className={`flex items-center gap-1 h-8 px-2 rounded-md border text-xs transition-colors ${
          showRightPanel
            ? "bg-blue-100 border-blue-300 text-blue-700"
            : "bg-white border-gray-200 text-gray-500 hover:bg-gray-50"
        }`}
      >
        <BarChart3 className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">本週統計</span>
      </button>
      <span className="text-sm bg-blue-500 text-white px-3 py-1 rounded-full">教練指派</span>
    </div>
  );

  /* Right panel: available coaches + weekly stats */
  const rightPanelContent = (
    <div className="p-3 space-y-4">
      {selectedCell && sidebarAvailableCoaches && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Users className="h-4 w-4" />
              可用教練
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              {selectedCell.date.slice(5)} 第{selectedCell.timeSlotOrder}節
            </p>
          </CardHeader>
          <CardContent className="space-y-2">
            {sidebarAvailableCoaches.available.length > 0 ? (
              <div className="space-y-1">
                <div className="text-[10px] text-green-600 font-medium">
                  可指派 ({sidebarAvailableCoaches.available.length})
                </div>
                {sidebarAvailableCoaches.available.map((c) => (
                  <div key={c} className="text-xs bg-green-50 border border-green-200 rounded px-2 py-1 flex items-center gap-1">
                    <Check className="h-3 w-3 text-green-500" />
                    {c}
                    <span className="text-[10px] text-muted-foreground ml-auto">
                      {weeklyStats[c]?.assigned || 0}堂
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">此時段無可用教練</p>
            )}
            {sidebarAvailableCoaches.assigned.length > 0 && (
              <div className="space-y-1">
                <div className="text-[10px] text-blue-600 font-medium">
                  已指派 ({sidebarAvailableCoaches.assigned.length})
                </div>
                {sidebarAvailableCoaches.assigned.map((c) => (
                  <div key={c} className="text-xs bg-blue-50 border border-blue-200 rounded px-2 py-1">{c}</div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <BarChart3 className="h-4 w-4" />
            本週統計
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {coaches.map((coach) => {
              const stats = weeklyStats[coach];
              if (!stats) return null;
              return (
                <div key={coach} className="flex items-center justify-between text-xs py-0.5">
                  <span className="truncate mr-2">{coach}</span>
                  <Badge variant="outline" className="text-[10px] h-5 px-1 flex-shrink-0">
                    {stats.assigned}/{stats.available}
                  </Badge>
                </div>
              );
            })}
          </div>
          <div className="mt-2 pt-2 border-t text-[10px] text-muted-foreground">
            指派數 / 可用時段數
          </div>
        </CardContent>
      </Card>
    </div>
  );

  if (!venues || !timeSlots) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-primary">載入中...</div>
      </div>
    );
  }

  return (
    <AdminLayout
      activeTab="assign"
      headerCenter={headerCenter}
      headerRight={headerRight}
      rightPanel={showRightPanel ? rightPanelContent : undefined}
    >
      <div className="p-4">
        {/* Missing coach alert */}
        {missingCoachCount > 0 && (
          <div className="mb-4 flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              <span className="text-sm text-amber-700">
                尚有 <strong>{missingCoachCount}</strong> 個教練缺口未指派
              </span>
            </div>
            {/* 自動指派按鈕 — 暫時隱藏 */}
            {false && (
            <Button
              size="sm"
              variant="outline"
              className="text-xs border-purple-300 text-purple-600 hover:bg-purple-50"
              onClick={handleAutoFill}
              disabled={assignCoachMutation.isPending}
            >
              <Zap className="h-3 w-3 mr-1" />
              自動指派
            </Button>
            )}
          </div>
        )}

        {/* Schedule table */}
        {selectedVenue ? (
          <div className="overflow-x-auto">
            <table className="coach-assignment-table border-collapse">
              <colgroup>
                <col className="time-column" />
                {displayedWeekDays.map((date) => (
                  <col key={format(date, "yyyy-MM-dd")} className="weekday-column" />
                ))}
              </colgroup>
              <thead className="sticky top-0 z-10">
                <tr>
                  <th className="border border-gray-300 p-2 bg-gray-50 w-28 min-w-[112px] sticky left-0 z-20 shadow-[2px_0_4px_rgba(0,0,0,0.1)]">
                    節次/時間
                  </th>
                  {displayedWeekDays.map((date, index) => (
                    <th key={format(date, "yyyy-MM-dd")} className="schedule-column border border-gray-300 p-2 bg-gray-50">
                      <div className="text-center">
                        <div className="font-semibold">{displayedWeekDayNames[index]}</div>
                        <div className="text-sm text-gray-600">{format(date, "MM/dd")}</div>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {timeSlots.map((timeSlot) => (
                  <tr key={timeSlot.id}>
                    <td className="border border-gray-300 p-2 bg-gray-50 text-center sticky left-0 z-10 shadow-[2px_0_4px_rgba(0,0,0,0.1)] w-28 min-w-[112px]">
                      <div className="font-medium">{timeSlot.period}</div>
                      <div className="text-xs text-gray-600">
                        {timeSlot.startTime}-{timeSlot.endTime}
                      </div>
                    </td>
                    {displayedWeekDays.map((date, index) => {
                      const dateStr = format(date, "yyyy-MM-dd");
                      const daySchedules = schedulesByDateAndTime[dateStr]?.[timeSlot.id] || [];
                      const dayOfWeek = date.getDay() === 0 ? 7 : date.getDay();
                      const isSelected =
                        selectedCell?.date === dateStr && selectedCell?.timeSlotId === timeSlot.id;

                      return (
                        <td
                          key={`${timeSlot.id}-${index}`}
                          className={`assignment-cell border border-gray-300 p-1 align-top cursor-pointer transition-colors ${
                            isSelected ? "ring-2 ring-inset ring-blue-400 bg-blue-50/30" : ""
                          }`}
                          onClick={() =>
                            setSelectedCell({
                              date: dateStr,
                              timeSlotId: timeSlot.id,
                              timeSlotOrder: timeSlot.order,
                            })
                          }
                        >
                          {/* Keep cards stacked so each card retains enough width for names and controls. */}
                          <div className="flex flex-col gap-1">
                            {daySchedules.map((schedule) => {
                              if (!schedule.className) return null;
                              const hasCoach = !!schedule.coachName;
                              const hasCoach2 = !!schedule.coachName2;
                              const needsTwo = (schedule.coachCount || 1) >= 2;
                              const coach1Info = getCoach1Conflicts(schedule);
                              const coach2Info = getCoach2Conflicts(schedule);
                              const available = getAvailableCoaches(
                                dayOfWeek,
                                timeSlot.order,
                                selectedVenueData?.name
                              );
                              const isMissing = !hasCoach || (needsTwo && !hasCoach2);
                              const isCardSelected = selectedScheduleId === schedule.id;
                              const missingBg = isMissing
                                ? !hasCoach
                                  ? "bg-red-50 border border-red-200"
                                  : "bg-amber-50 border border-amber-200"
                                : "bg-white border border-gray-200";

                              return (
                                <div
                                  key={schedule.id}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedCell({ date: dateStr, timeSlotId: timeSlot.id, timeSlotOrder: timeSlot.order });
                                    setSelectedScheduleId(isCardSelected ? null : schedule.id);
                                  }}
                                  className={`assignment-card rounded p-1 space-y-1 cursor-pointer transition-all ${missingBg} ${
                                    isCardSelected ? "ring-2 ring-blue-500 shadow-md" : "hover:shadow-sm"
                                  }`}
                                >
                                  <div className="bg-gray-700 text-white text-xs px-1.5 py-0.5 rounded text-center break-words whitespace-normal leading-4">
                                    <span className="font-bold">{schedule.className}</span>
                                    <span className="font-normal opacity-90">｜需{schedule.coachCount || 1}位</span>
                                  </div>
                                  <div className="coach-assignment-row">
                                    <CoachSearchSelect
                                      value={schedule.coachName || ""}
                                      onValueChange={(value) => {
                                        assignCoachMutation.mutate({
                                          scheduleId: schedule.id, expectedVersion: schedule.version,
                                          coachName: value === "__clear__" ? "" : value,
                                        });
                                      }}
                                      coaches={venueEligibleCoaches}
                                      allCoaches={coaches}
                                      available={available}
                                      softConflicts={coach1Info.softConflicts}
                                      hardDisabled={coach1Info.hardDisabled}
                                      onSoftConflictSelect={(coach, details) =>
                                        setConflictConfirm({
                                          coach,
                                          details,
                                          onConfirm: () =>
                                            assignCoachMutation.mutate({
                                              scheduleId: schedule.id, expectedVersion: schedule.version,
                                              coachName: coach,
                                            }),
                                        })
                                      }
                                      placeholder="教練1"
                                      hasValue={hasCoach}
                                      triggerClassName={
                                        hasCoach ? "border-green-400 bg-green-50" : "border-red-400 bg-red-50"
                                      }
                                    />
                                    {hasCoach && (
                                      <select
                                        aria-label={`${schedule.className} 第一位教練角色`}
                                        value={schedule.coach1IsTeaching ? "teaching" : "assist"}
                                        onChange={(e) => {
                                          assignCoachMutation.mutate({
                                            scheduleId: schedule.id, expectedVersion: schedule.version,
                                            coach1IsTeaching: e.target.value === "teaching",
                                          });
                                        }}
                                        onClick={(e) => e.stopPropagation()}
                                        className="coach-role-select h-8 rounded border bg-white px-1 text-xs"
                                      ><option value="teaching">當班教學</option><option value="assist">協同教學</option></select>
                                    )}
                                  </div>
                                  {needsTwo && (
                                    <div className="coach-assignment-row">
                                      <CoachSearchSelect
                                        value={schedule.coachName2 || ""}
                                        onValueChange={(value) => {
                                          assignCoachMutation.mutate({
                                            scheduleId: schedule.id, expectedVersion: schedule.version,
                                            coachName2: value === "__clear__" ? "" : value,
                                          });
                                        }}
                                        coaches={venueEligibleCoaches}
                                        allCoaches={coaches}
                                        available={available}
                                        softConflicts={coach2Info.softConflicts}
                                        hardDisabled={coach2Info.hardDisabled}
                                        onSoftConflictSelect={(coach, details) =>
                                          setConflictConfirm({
                                            coach,
                                            details,
                                            onConfirm: () =>
                                              assignCoachMutation.mutate({
                                                scheduleId: schedule.id, expectedVersion: schedule.version,
                                                coachName2: coach,
                                              }),
                                          })
                                        }
                                        placeholder="教練2"
                                        hasValue={hasCoach2}
                                        triggerClassName={
                                          hasCoach2
                                            ? "border-blue-400 bg-blue-50"
                                            : "border-amber-400 bg-amber-50"
                                        }
                                      />
                                      {hasCoach2 && (
                                        <select
                                          aria-label={`${schedule.className} 第二位教練角色`}
                                          value={schedule.coach2IsTeaching ? "teaching" : "assist"}
                                          onChange={(e) => {
                                            assignCoachMutation.mutate({
                                              scheduleId: schedule.id, expectedVersion: schedule.version,
                                              coach2IsTeaching: e.target.value === "teaching",
                                            });
                                          }}
                                          onClick={(e) => e.stopPropagation()}
                                          className="coach-role-select h-8 rounded border bg-white px-1 text-xs"
                                        ><option value="teaching">當班教學</option><option value="assist">協同教學</option></select>
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="flex items-center justify-center h-48 text-muted-foreground">
            請在上方選擇場館
          </div>
        )}
      </div>
      <FloatingConflictAlert weekStart={currentWeek} />
      <AlertDialog
        open={!!conflictConfirm}
        onOpenChange={(open) => {
          if (!open) setConflictConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-orange-600">
              <AlertTriangle className="h-5 w-5" />
              教練衝堂提醒
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <div>
                  教練 <strong className="text-orange-700">{conflictConfirm?.coach}</strong>{" "}
                  在此時段已被指派以下課程：
                </div>
                <ul className="list-disc list-inside bg-orange-50 border border-orange-200 rounded p-2 text-sm space-y-0.5">
                  {conflictConfirm?.details.map((d, i) => (
                    <li key={i}>
                      <span className="font-medium">{d.venueName}</span>
                      {d.venueName && d.className ? "：" : ""}
                      {d.className}
                    </li>
                  ))}
                </ul>
                <div className="text-sm text-muted-foreground">是否仍要繼續指派？</div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-orange-600 hover:bg-orange-700"
              onClick={() => {
                conflictConfirm?.onConfirm();
                setConflictConfirm(null);
              }}
            >
              確認新增
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminLayout>
  );
}

export default function CoachAssignment() {
  return <CoachAssignmentContent />;
}
