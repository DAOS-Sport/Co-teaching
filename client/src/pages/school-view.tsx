import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRoute } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, MapPin, Video, ExternalLink } from "lucide-react";
import { format, addWeeks, subWeeks, startOfWeek, addDays } from "date-fns";
import { zhTW } from "date-fns/locale";
import type { Venue, TimeSlot, Schedule, VenueInfo } from "@shared/schema";
import { getExtendedWeekDays, getExtendedWeekdayNames, getExtendedWeekEnd } from "@/utils/special-workdays";

export default function SchoolView() {
  const [, params] = useRoute("/school/:venueName");
  const venueName = params?.venueName ? decodeURIComponent(params.venueName) : "";

  const [currentWeek, setCurrentWeek] = useState<Date>(() => {
    return startOfWeek(new Date(), { weekStartsOn: 1 });
  });

  const { data: venues } = useQuery<Venue[]>({
    queryKey: ["/api/venues"],
  });

  const { data: timeSlots } = useQuery<TimeSlot[]>({
    queryKey: ["/api/time-slots"],
  });

  const { data: venueInfos = [] } = useQuery<VenueInfo[]>({
    queryKey: ["/api/venue-infos"],
    queryFn: async () => {
      const res = await fetch("/api/venue-infos");
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const venue = venues?.find(v => v.name === venueName);
  const venueInfo = venueInfos.find(v => v.venueName === venueName);

  const weekStart = format(currentWeek, "yyyy-MM-dd");
  const weekEnd = format(getExtendedWeekEnd(currentWeek), "yyyy-MM-dd");

  const { data: schedules = [] } = useQuery<(Schedule & { venue: Venue; timeSlot: TimeSlot })[]>({
    queryKey: [`/api/schedules?startDate=${weekStart}&endDate=${weekEnd}&venueId=${venue?.id}`],
    enabled: !!venue?.id,
  });

  const schedulesByDateAndTime: Record<string, Record<string, (Schedule & { venue: Venue; timeSlot: TimeSlot })[]>> = {};

  schedules.forEach(schedule => {
    if (schedule.venue.id === venue?.id) {
      if (!schedulesByDateAndTime[schedule.date]) {
        schedulesByDateAndTime[schedule.date] = {};
      }
      if (!schedulesByDateAndTime[schedule.date][schedule.timeSlotId]) {
        schedulesByDateAndTime[schedule.date][schedule.timeSlotId] = [];
      }
      schedulesByDateAndTime[schedule.date][schedule.timeSlotId].push(schedule);
    }
  });

  if (!venueName) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="py-12 text-center">
            <p className="text-lg text-muted-foreground">找不到指定的學校</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!venues || !timeSlots) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-muted-foreground">載入中...</div>
      </div>
    );
  }

  if (!venue) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="py-12 text-center">
            <p className="text-lg font-medium mb-2">找不到場館</p>
            <p className="text-muted-foreground">「{venueName}」不存在於系統中</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const venueColor = `var(--venue-${venue.color})`;

  return (
    <div className="min-h-screen bg-gray-50">
      <header
        className="shadow-sm border-b-4"
        style={{
          backgroundColor: `color-mix(in srgb, ${venueColor} 15%, white)`,
          borderBottomColor: venueColor,
        }}
      >
        <div className="max-w-5xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <i
                className="fas fa-swimming-pool text-xl"
                style={{ color: `color-mix(in srgb, ${venueColor} 80%, black)` }}
              ></i>
              <div>
                <h1
                  className="text-2xl font-bold"
                  style={{ color: `color-mix(in srgb, ${venueColor} 80%, black)` }}
                >
                  {venue.name}
                </h1>
                <p className="text-sm" style={{ color: `color-mix(in srgb, ${venueColor} 60%, #666)` }}>
                  游泳課課表
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              {venueInfo?.mapUrl && (
                <a
                  href={venueInfo.mapUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs px-3 py-2 rounded-lg transition-colors border"
                  style={{
                    color: `color-mix(in srgb, ${venueColor} 80%, black)`,
                    borderColor: `color-mix(in srgb, ${venueColor} 50%, white)`,
                    backgroundColor: `color-mix(in srgb, ${venueColor} 10%, white)`,
                  }}
                >
                  <MapPin className="h-3.5 w-3.5" />
                  導航
                </a>
              )}
              {venueInfo?.videoUrl && (
                <a
                  href={venueInfo.videoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs px-3 py-2 rounded-lg transition-colors border"
                  style={{
                    color: `color-mix(in srgb, ${venueColor} 80%, black)`,
                    borderColor: `color-mix(in srgb, ${venueColor} 50%, white)`,
                    backgroundColor: `color-mix(in srgb, ${venueColor} 10%, white)`,
                  }}
                >
                  <Video className="h-3.5 w-3.5" />
                  場館影片
                </a>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-4">
        {venueInfo?.description && (
          <div className="mb-4 bg-white border rounded-lg p-3 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">進入方式：</span>
            {venueInfo.description}
          </div>
        )}

        <div className="flex items-center justify-center gap-3 mb-4">
          <Button
            variant="outline"
            size="icon"
            onClick={() => setCurrentWeek(prev => subWeeks(prev, 1))}
            className="h-9 w-9"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>

          <div className="text-sm font-semibold text-center whitespace-nowrap min-w-[220px]">
            {format(currentWeek, "yyyy年MM月dd日", { locale: zhTW })} - {format(addDays(currentWeek, 6), "MM月dd日", { locale: zhTW })}
          </div>

          <Button
            variant="outline"
            size="icon"
            onClick={() => setCurrentWeek(prev => addWeeks(prev, 1))}
            className="h-9 w-9"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setCurrentWeek(startOfWeek(new Date(), { weekStartsOn: 1 }))}
            className="text-xs"
          >
            本週
          </Button>
        </div>

        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse min-w-[600px]">
                <thead>
                  <tr>
                    <th
                      className="border border-gray-200 p-2 w-20 sticky left-0 z-10 shadow-[2px_0_4px_rgba(0,0,0,0.05)] text-sm"
                      style={{
                        backgroundColor: `color-mix(in srgb, ${venueColor} 20%, white)`,
                        color: `color-mix(in srgb, ${venueColor} 80%, black)`,
                      }}
                    >
                      <div className="font-bold text-sm leading-tight mb-0.5">{venue.name}</div>
                      <div className="text-xs opacity-80">節次</div>
                    </th>
                    {getExtendedWeekDays(currentWeek).map((date, index) => {
                      const weekDayNames = getExtendedWeekdayNames(currentWeek);
                      const isToday = format(date, "yyyy-MM-dd") === format(new Date(), "yyyy-MM-dd");
                      return (
                        <th
                          key={index}
                          className={`border border-gray-200 p-2 min-w-28 ${isToday ? 'bg-blue-50' : 'bg-gray-50'}`}
                        >
                          <div className="text-center">
                            <div className={`font-semibold text-base ${isToday ? 'text-blue-600' : ''}`}>
                              {weekDayNames[index]}
                            </div>
                            <div className={`text-sm ${isToday ? 'text-blue-500' : 'text-gray-500'}`}>
                              {format(date, "MM/dd")}
                            </div>
                            {isToday && (
                              <div className="text-xs text-blue-500 font-medium">今天</div>
                            )}
                          </div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {timeSlots.map((timeSlot) => (
                    <tr key={timeSlot.id}>
                      <td
                        className="border border-gray-200 p-2 text-center sticky left-0 z-10 shadow-[2px_0_4px_rgba(0,0,0,0.05)]"
                        style={{
                          backgroundColor: `color-mix(in srgb, ${venueColor} 20%, white)`,
                          color: `color-mix(in srgb, ${venueColor} 80%, black)`,
                        }}
                      >
                        <div className="font-medium text-base">{timeSlot.period}</div>
                        <div className="text-xs opacity-80">
                          {timeSlot.startTime}-{timeSlot.endTime}
                        </div>
                      </td>
                      {getExtendedWeekDays(currentWeek).map((date, index) => {
                        const dateStr = format(date, "yyyy-MM-dd");
                        const daySchedules = schedulesByDateAndTime[dateStr]?.[timeSlot.id] || [];
                        const isToday = dateStr === format(new Date(), "yyyy-MM-dd");

                        return (
                          <td
                            key={`${timeSlot.id}-${index}`}
                            className={`border border-gray-200 p-1 align-top ${isToday ? 'bg-blue-50/50' : ''}`}
                          >
                            <div className="space-y-1 min-h-[50px]">
                              {daySchedules.map((schedule, idx) => (
                                <div
                                  key={`${schedule.id}-${idx}`}
                                  className="text-sm p-2 rounded"
                                  style={{
                                    backgroundColor: `color-mix(in srgb, ${venueColor} 15%, white)`,
                                    border: `1px solid color-mix(in srgb, ${venueColor} 30%, white)`,
                                  }}
                                >
                                  <div className="font-medium" style={{ color: `color-mix(in srgb, ${venueColor} 80%, black)` }}>
                                    {schedule.className || '游泳課'}
                                  </div>
                                  {schedule.coachName && (
                                    <div className="text-gray-600 text-xs">
                                      {schedule.coachName}
                                      {schedule.coachName2 && ` / ${schedule.coachName2}`}
                                    </div>
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
          </CardContent>
        </Card>

        <div className="mt-4 text-center text-xs text-muted-foreground">
          五泳池課表整合系統 - {venue.name}
        </div>
      </main>
    </div>
  );
}
