import { useAuth } from "@/hooks/useAuth";
import CoachHelpCard from "@/components/coach-help-card";
import type { HelpSection } from "@/components/coach-help-card";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, useMemo } from "react";
import { format, startOfWeek, addWeeks, subWeeks } from "date-fns";
import { zhTW } from "date-fns/locale";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Check, ChevronsUpDown } from "lucide-react";
import type { Schedule, Venue, TimeSlot } from "@shared/schema";
import { getExtendedWeekDays, getExtendedWeekdayNames, getExtendedWeekEnd } from "@/utils/special-workdays";
import AdminLayout from "@/components/admin-layout";

export default function CoachView() {
  const { user } = useAuth();
  const [currentWeek, setCurrentWeek] = useState(startOfWeek(new Date(), { weekStartsOn: 1 }));
  const [selectedCoach, setSelectedCoach] = useState<string>('');
  const [coachPickerOpen, setCoachPickerOpen] = useState(false);

  const weekStart = format(currentWeek, 'yyyy-MM-dd');
  const weekEnd = format(getExtendedWeekEnd(currentWeek), 'yyyy-MM-dd');

  const { data: coaches } = useQuery<string[]>({
    queryKey: ['/api/coaches'],
  });

  const { data: schedules, isLoading: schedulesLoading } = useQuery<(Schedule & { venue: Venue; timeSlot: TimeSlot })[]>({
    queryKey: ['/api/coach-schedules', { startDate: weekStart, endDate: weekEnd, coachName: selectedCoach }],
    queryFn: async () => {
      const params = new URLSearchParams({ startDate: weekStart, endDate: weekEnd });
      if (selectedCoach) params.append('coachName', selectedCoach);
      const response = await fetch(`/api/coach-schedules?${params}`);
      if (!response.ok) throw new Error('Failed to fetch schedules');
      return response.json();
    },
    enabled: !!selectedCoach,
  });

  const derivedCoaches = useMemo(() => {
    return coaches ? [...coaches].sort() : [];
  }, [coaches]);

  useEffect(() => {
    if (!selectedCoach && derivedCoaches && derivedCoaches.length > 0) {
      if (user?.role === 'admin') {
        setSelectedCoach(derivedCoaches[0]);
      } else if (user?.coachName) {
        setSelectedCoach(user.coachName);
      } else {
        setSelectedCoach(derivedCoaches[0]);
      }
    }
  }, [user, derivedCoaches, selectedCoach]);

  const weekDays = getExtendedWeekDays(currentWeek);

  const getSchedulesForDay = (date: Date) => {
    const dateStr = format(date, 'yyyy-MM-dd');
    const todays = schedules?.filter(s => s.date === dateStr) || [];
    if (!selectedCoach) return todays;
    return todays.filter(s => {
      // coach2 (偕同) must also count — backend returns rows where the
      // selected coach is coachName OR coachName2; the client must
      // mirror that or 偕同 entries silently disappear from the view.
      if (s.coachName2 && s.coachName2.trim() === selectedCoach) return true;
      if (!s.coachName) return false;
      if (s.coachName === selectedCoach) return true;
      const coaches = s.coachName.split('-').map(c => c.trim());
      return coaches.includes(selectedCoach);
    });
  };

  const getVenueColorClass = (color: string) => {
    switch (color) {
      case 'blue': return 'venue-blue';
      case 'green': return 'venue-green';
      case 'purple': return 'venue-purple';
      case 'yellow': return 'venue-yellow';
      case 'pink': return 'venue-pink';
      case 'orange': return 'venue-orange';
      default: return 'bg-muted';
    }
  };

  const headerCenter = (
    <div className="flex items-center gap-2 flex-nowrap">
      <span className="text-sm font-medium whitespace-nowrap">選擇教練：</span>
      <Popover open={coachPickerOpen} onOpenChange={setCoachPickerOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={coachPickerOpen}
            aria-label="搜尋並選擇教練"
            className="h-8 w-44 justify-between px-2 text-sm font-normal"
            data-testid="select-coach"
          >
            <span className="truncate">{selectedCoach || "搜尋教練姓名"}</span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-0" align="start">
          <Command>
            <CommandInput
              placeholder="輸入教練姓名..."
              data-testid="input-coach-search"
            />
            <CommandList>
              <CommandEmpty>找不到符合的教練</CommandEmpty>
              <CommandGroup>
                {derivedCoaches.map((coach) => (
                  <CommandItem
                    key={coach}
                    value={coach}
                    onSelect={() => {
                      setSelectedCoach(coach);
                      setCoachPickerOpen(false);
                    }}
                    data-testid={`option-${coach}`}
                  >
                    <Check className={`h-4 w-4 ${selectedCoach === coach ? "opacity-100" : "opacity-0"}`} />
                    {coach}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <Button variant="outline" size="icon" className="h-8 w-8"
        onClick={() => setCurrentWeek(prev => subWeeks(prev, 1))}
        data-testid="button-prev-week">
        <i className="fas fa-chevron-left text-xs"></i>
      </Button>
      <span className="text-sm font-semibold whitespace-nowrap" data-testid="text-week-range">
        {format(currentWeek, 'yyyy年M月d日', { locale: zhTW })} - {format(getExtendedWeekEnd(currentWeek), 'M月d日', { locale: zhTW })}
      </span>
      <Button variant="outline" size="icon" className="h-8 w-8"
        onClick={() => setCurrentWeek(prev => addWeeks(prev, 1))}
        data-testid="button-next-week">
        <i className="fas fa-chevron-right text-xs"></i>
      </Button>
    </div>
  );

  const headerRight = (
    <span className="text-sm bg-green-500 text-white px-3 py-1 rounded-full">教練視圖</span>
  );

  if (schedulesLoading) {
    return (
      <AdminLayout activeTab="coach-view" headerCenter={headerCenter} headerRight={headerRight}>
        <div className="flex items-center justify-center h-64">
          <div className="text-primary">載入中...</div>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout activeTab="coach-view" headerCenter={headerCenter} headerRight={headerRight}>
      <div className="p-6">
        <div className="bg-card rounded-lg shadow-sm border border-border p-6">
          <h2 className="text-base sm:text-lg font-semibold mb-6" data-testid="text-coach-name">
            教練課表查詢
          </h2>
          <div className={`grid grid-cols-1 gap-4 ${weekDays.length === 6 ? 'md:grid-cols-6' : 'md:grid-cols-5'}`}>
            {weekDays.map((day, index) => {
              const daySchedules = getSchedulesForDay(day);
              const weekDayNames = getExtendedWeekdayNames(currentWeek);
              return (
                <div key={index} className="text-center">
                  <div className="text-sm font-medium text-muted-foreground mb-3" data-testid={`text-day-${index}`}>
                    {weekDayNames[index]}
                  </div>
                  <div className="space-y-2">
                    {daySchedules.length > 0 ? (
                      daySchedules.map((schedule) => (
                        <Card
                          key={schedule.id}
                          className={`${getVenueColorClass(schedule.venue.color)} text-white cursor-pointer hover:opacity-90 transition-opacity`}
                          data-testid={`class-card-${schedule.id}`}
                        >
                          <CardContent className="p-3 text-xs">
                            <div className="font-medium">{schedule.venue.name}</div>
                            <div>{schedule.className}</div>
                            <div className="text-xs opacity-80">
                              {schedule.timeSlot.startTime}-{schedule.timeSlot.endTime}
                            </div>
                          </CardContent>
                        </Card>
                      ))
                    ) : (
                      <Card className="bg-muted text-muted-foreground">
                        <CardContent className="p-3 text-xs">
                          <div>無課程</div>
                        </CardContent>
                      </Card>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* 員工使用說明 */}
      <div className="max-w-2xl mx-auto px-4 py-4">
        <CoachHelpCard sections={coachViewHelp} />
      </div>
    </AdminLayout>
  );
}

const coachViewHelp: HelpSection[] = [
  {
    title: "使用說明",
    icon: "fa-user-clock",
    steps: [
      {
        title: "查看個人週課表",
        desc: "點開頁面上方的教練欄位，可直接輸入姓名搜尋並選擇教練；下方格子會顯示該教練整週的所有課次，以場館顏色區分。",
        tip: "預設會自動選取您自己的名字（需登入）。",
      },
      {
        title: "切換週次",
        desc: "點擊頁面標題列的左右箭頭即可切換上一週或下一週。",
      },
      {
        title: "看懂課表格",
        desc: "每個色塊代表一個課次，顯示場館名稱、課程名稱與上課時間。",
        sub: [
          "顏色對應場館（不同場館有不同底色）",
          "若同一時段有多堂課，格子內會疊加顯示",
        ],
      },
    ],
  },
];
