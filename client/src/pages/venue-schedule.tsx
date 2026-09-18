import { useState, useEffect, useRef } from "react";
import CoachHelpCard from "@/components/coach-help-card";
import type { HelpSection } from "@/components/coach-help-card";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Download, Loader2 } from "lucide-react";
import { format, addWeeks, subWeeks, startOfWeek, addDays } from "date-fns";
import type { Venue, TimeSlot, Schedule } from "@shared/schema";
import { getExtendedWeekDays, getExtendedWeekdayNames, getExtendedWeekEnd } from "@/utils/special-workdays";
import FloatingConflictAlert from "@/components/floating-conflict-alert";
import AdminLayout from "@/components/admin-layout";
import { useToast } from "@/hooks/use-toast";
import html2canvas from "html2canvas";

export default function VenueSchedule() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const scheduleExportRef = useRef<HTMLDivElement>(null);
  const [selectedVenue, setSelectedVenue] = useState<string>("");
  const [isDownloading, setIsDownloading] = useState(false);
  const [currentWeek, setCurrentWeek] = useState<Date>(() => {
    const now = new Date();
    return startOfWeek(now, { weekStartsOn: 1 });
  });

  const { data: venues } = useQuery<Venue[]>({
    queryKey: ["/api/venues"],
  });

  const { data: timeSlots } = useQuery<TimeSlot[]>({
    queryKey: ["/api/time-slots"],
  });

  const weekStart = format(currentWeek, "yyyy-MM-dd");
  const weekEnd = format(getExtendedWeekEnd(currentWeek), "yyyy-MM-dd");

  const { data: schedules = [], isLoading: schedulesLoading } = useQuery<(Schedule & { venue: Venue; timeSlot: TimeSlot })[]>({
    queryKey: [`/api/schedules?startDate=${weekStart}&endDate=${weekEnd}&venueId=${selectedVenue}`],
    enabled: !!selectedVenue,
  });

  useEffect(() => {
    if (venues && venues.length > 0 && !selectedVenue) {
      setSelectedVenue(venues[0].id);
    }
  }, [venues, selectedVenue]);

  const schedulesByDateAndTime: Record<string, Record<string, (Schedule & { venue: Venue; timeSlot: TimeSlot })[]>> = {};
  schedules.forEach(schedule => {
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

  const weekDateLabel = `${format(currentWeek, "yyyy/MM/dd")} - ${format(addDays(currentWeek, 6), "MM/dd")}`;
  const selectedVenueName = venues?.find((venue) => venue.id === selectedVenue)?.name || "場館";

  const handleDownloadWeekSchedule = async () => {
    const scheduleElement = scheduleExportRef.current;
    if (!scheduleElement || !selectedVenue || isDownloading) return;

    setIsDownloading(true);
    try {
      await document.fonts?.ready;

      const canvas = await html2canvas(scheduleElement, {
        scale: 2,
        backgroundColor: "#ffffff",
        logging: false,
        useCORS: true,
        width: scheduleElement.scrollWidth,
        height: scheduleElement.scrollHeight,
        windowWidth: scheduleElement.scrollWidth,
        windowHeight: scheduleElement.scrollHeight,
        onclone: (_document, clonedElement) => {
          clonedElement.querySelectorAll<HTMLElement>(".sticky").forEach((element) => {
            element.style.position = "static";
          });
        },
      });

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (result) => result ? resolve(result) : reject(new Error("無法產生 JPG")),
          "image/jpeg",
          0.92,
        );
      });

      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const safeVenueName = selectedVenueName.replace(/[\\/:*?"<>|]/g, "_");
      link.download = `${safeVenueName}_週課表_${weekStart}_${weekEnd}.jpg`;
      link.href = objectUrl;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);

      toast({
        title: "下載完成",
        description: `${selectedVenueName} ${weekDateLabel} 課表已儲存為 JPG`,
      });
    } catch (error) {
      console.error("Failed to download venue schedule:", error);
      toast({
        title: "下載失敗",
        description: "無法產生課表圖片，請稍後再試。",
        variant: "destructive",
      });
    } finally {
      setIsDownloading(false);
    }
  };

  const headerCenter = (
    <div className="flex items-center gap-2 flex-nowrap">
      <span className="text-sm font-medium whitespace-nowrap">選擇場館：</span>
      <select value={selectedVenue} onChange={(event) => setSelectedVenue(event.target.value)} className="w-36 h-8 rounded border bg-background px-2 text-sm">
        <option value="">請選擇場館</option>
          {venues?.map((venue) => (
            <option key={venue.id} value={venue.id}>
              {venue.name}
            </option>
          ))}
      </select>
      <span className="text-xs text-muted-foreground">{venues?.find((venue) => venue.id === selectedVenue)?.name || "未選擇"}</span>
      <Button variant="outline" size="icon" className="h-8 w-8"
        onClick={() => setCurrentWeek(prev => subWeeks(prev, 1))}>
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <span className="text-sm font-semibold whitespace-nowrap">{weekDateLabel}</span>
      <Button variant="outline" size="icon" className="h-8 w-8"
        onClick={() => setCurrentWeek(prev => addWeeks(prev, 1))}>
        <ChevronRight className="h-4 w-4" />
      </Button>
      <Button variant="outline" className="h-8 text-sm px-3"
        onClick={() => setCurrentWeek(startOfWeek(new Date(), { weekStartsOn: 1 }))}>
        本週
      </Button>
      <Button
        variant="outline"
        className="h-8 text-sm px-3"
        onClick={handleDownloadWeekSchedule}
        disabled={!selectedVenue || schedulesLoading || isDownloading}
        data-testid="button-download-week-jpg"
      >
        {isDownloading ? (
          <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
        ) : (
          <Download className="mr-1.5 h-4 w-4" />
        )}
        {isDownloading ? "產生中..." : "下載本週 JPG"}
      </Button>
    </div>
  );

  const headerRight = (
    <div className="flex items-center gap-2">
      <span className="text-sm bg-green-500 text-white px-3 py-1 rounded-full">場館課表顯示</span>
      <Button variant="outline" size="sm" onClick={() => setLocation("/mgt-x9k7p2/class-edit")}>
        管理員功能
      </Button>
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
    <AdminLayout activeTab="venue-schedule" headerCenter={headerCenter} headerRight={headerRight}>
      <div className="p-4">
        {selectedVenue ? (
          <div className="overflow-x-auto">
            <div ref={scheduleExportRef} className="inline-block min-w-full bg-white">
              <div className="flex items-end justify-between gap-6 border border-b-0 border-gray-300 bg-white px-4 py-3">
                <div>
                  <div className="text-xl font-bold text-gray-900">{selectedVenueName}週課表</div>
                  <div className="mt-0.5 text-sm text-gray-600">五泳池課表整合系統</div>
                </div>
                <div className="whitespace-nowrap text-sm font-medium text-gray-700">{weekDateLabel}</div>
              </div>
              <table className="w-full border-collapse min-w-[600px]">
                <thead className="sticky top-0 z-10">
                  <tr>
                    <th className="border border-gray-300 p-2 bg-gray-50 w-20 sticky left-0 z-20 shadow-[2px_0_4px_rgba(0,0,0,0.1)]">
                      節次/時間
                    </th>
                    {getExtendedWeekDays(currentWeek).map((date, index) => {
                      const weekDayNames = getExtendedWeekdayNames(currentWeek);
                      return (
                        <th key={index} className="border border-gray-300 p-2 bg-gray-50 min-w-48">
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
                        <div className="text-xs text-gray-600">{timeSlot.startTime}-{timeSlot.endTime}</div>
                      </td>
                      {getExtendedWeekDays(currentWeek).map((date, index) => {
                        const dateStr = format(date, "yyyy-MM-dd");
                        const daySchedules = schedulesByDateAndTime[dateStr]?.[timeSlot.id] || [];
                        return (
                          <td key={`${timeSlot.id}-${index}`} className="border border-gray-300 p-1 align-top">
                            <div className="grid grid-cols-2 gap-1 min-h-[48px]">
                              {daySchedules.map((schedule, idx) => (
                                <div
                                  key={`${schedule.id}-${idx}`}
                                  className="p-1 rounded bg-blue-100 border border-blue-200"
                                >
                                  <div className="text-sm font-bold text-blue-800 leading-tight">
                                    {schedule.className || "游泳課"}
                                  </div>
                                  {(schedule.coachName || schedule.coachName2) && (
                                    <div className="text-xs text-blue-600 leading-snug mt-0.5">
                                      {[schedule.coachName, schedule.coachName2].filter(Boolean).join("-")}
                                    </div>
                                  )}
                                  {schedule.notes && (
                                    <div className="text-xs text-gray-600 mt-0.5">{schedule.notes}</div>
                                  )}
                                </div>
                              ))}
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

      {/* 員工使用說明 */}
      <div className="max-w-2xl mx-auto px-4 py-4">
        <CoachHelpCard sections={venueScheduleHelp} />
      </div>
    </AdminLayout>
  );
}

const venueScheduleHelp: HelpSection[] = [
  {
    title: "使用說明",
    icon: "fa-building",
    steps: [
      {
        title: "選擇場館",
        desc: "頁面左上角下拉選單選擇要查看的場館，課表會立即更新為該場館的排課狀況。",
      },
      {
        title: "切換週次",
        desc: "點擊標題列的左右箭頭切換週次，查看不同週的場館課表。",
      },
      {
        title: "下載週課表",
        desc: "點擊「下載本週 JPG」，可將畫面上目前顯示的完整週課表下載成圖片。",
      },
      {
        title: "看懂課表格",
        desc: "表格橫軸為每天日期，縱軸為節次時間。每個格子顯示課程名稱與負責教練。",
        sub: [
          "藍色字為主教練，若有協同教練會以「-」連接顯示",
          "空白格表示該時段無排課",
        ],
      },
    ],
  },
];
