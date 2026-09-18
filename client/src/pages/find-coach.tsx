import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { format, addDays, startOfWeek } from "date-fns";
import { zhTW } from "date-fns/locale";
import type { Venue, TimeSlot, Schedule } from "@shared/schema";
import { getExtendedWeekDays, getExtendedWeekEnd } from "@/utils/special-workdays";

interface ScheduleWithRegistrations extends Schedule {
  venue: Venue;
  timeSlot: TimeSlot;
  registrations: Array<{
    id: string;
    coachName: string;
    registeredAt: string;
  }>;
}

export default function FindCoach() {
  const [, setLocation] = useLocation();
  const [selectedSchedule, setSelectedSchedule] = useState<ScheduleWithRegistrations | null>(null);
  const [coachName, setCoachName] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [currentWeek, setCurrentWeek] = useState(() => startOfWeek(new Date(), { weekStartsOn: 1 }));
  const { toast } = useToast();

  const weekDays = getExtendedWeekDays(currentWeek); // 支援特殊工作日
  const weekEnd = getExtendedWeekEnd(currentWeek);

  // 獲取場館和時段
  const { data: venues } = useQuery<Venue[]>({
    queryKey: ['/api/venues'],
  });

  const { data: timeSlots } = useQuery<TimeSlot[]>({
    queryKey: ['/api/time-slots'],
  });

  // 獲取沒有教練的課程（週為單位，優化版本）
  const { data: schedulesWithoutCoach, isLoading } = useQuery<ScheduleWithRegistrations[]>({
    queryKey: ['/api/schedules-without-coach', format(currentWeek, 'yyyy-MM-dd'), format(weekEnd, 'yyyy-MM-dd')],
    queryFn: async () => {
      const startDate = format(currentWeek, 'yyyy-MM-dd');
      const endDate = format(weekEnd, 'yyyy-MM-dd');
      const response = await fetch(`/api/schedules-without-coach?startDate=${startDate}&endDate=${endDate}`);
      if (!response.ok) throw new Error('Failed to fetch schedules');
      return response.json();
    },
    staleTime: 1000 * 60 * 5, // 5分鐘內不重新查詢
  });

  // 教練登記 mutation
  const registerMutation = useMutation({
    mutationFn: async ({ scheduleId, coachName }: { scheduleId: string; coachName: string }) => {
      const response = await fetch('/api/coach-registrations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ scheduleId, coachName }),
      });
      if (!response.ok) throw new Error('Failed to register coach');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/schedules-without-coach'] });
      setDialogOpen(false);
      setCoachName("");
      setSelectedSchedule(null);
      toast({
        title: "登記成功",
        description: "教練已成功登記此課程",
      });
    },
    onError: (error) => {
      console.error('Registration error:', error);
      toast({
        title: "登記失敗",
        description: error.message || '網路連線問題，請稍後再試',
        variant: "destructive",
      });
    },
  });

  const handleRegister = () => {
    if (!selectedSchedule || !coachName.trim()) {
      toast({
        title: "請填寫教練姓名",
        variant: "destructive",
      });
      return;
    }

    registerMutation.mutate({
      scheduleId: selectedSchedule.id,
      coachName: coachName.trim(),
    });
  };

  const navigateToPrevWeek = () => {
    setCurrentWeek(prev => addDays(prev, -7));
  };

  const navigateToNextWeek = () => {
    setCurrentWeek(prev => addDays(prev, 7));
  };

  const navigateToThisWeek = () => {
    setCurrentWeek(startOfWeek(new Date(), { weekStartsOn: 1 }));
  };

  const getVenueColorClass = (color: string) => {
    switch (color) {
      case 'blue': return 'bg-blue-100 text-blue-900 border-blue-300';
      case 'green': return 'bg-green-100 text-green-900 border-green-300';
      case 'purple': return 'bg-purple-100 text-purple-900 border-purple-300';
      case 'yellow': return 'bg-yellow-100 text-yellow-900 border-yellow-300';
      case 'pink': return 'bg-pink-100 text-pink-900 border-pink-300';
      case 'orange': return 'bg-orange-100 text-orange-900 border-orange-300';
      default: return 'bg-gray-100 text-gray-900 border-gray-300';
    }
  };

  // 解析多教練名稱的函數
  const parseCoachNames = (coachName: string): string[] => {
    if (!coachName) return [];
    
    // 直接以破折號分割教練名稱
    // 支持格式: "教練1-教練2" 或 "班級-教練1-教練2"
    const parts = coachName.split('-').map(p => p.trim()).filter(p => p.length > 0);
    
    // 如果只有一個部分，直接返回
    if (parts.length <= 1) {
      return [coachName];
    }
    
    // 識別哪些部分是教練名稱（人名）
    const coaches: string[] = [];
    
    for (const part of parts) {
      // 跳過明顯是班級/課程名稱的部分
      if (
        part.match(/^[A-Z]+\d+$/) || // 如 "ABC123"
        part.match(/^\d+$/) || // 純數字
        part.match(/[\u4e00-\u9fff]+\d+$/) || // 中文+數字，如 "新北160"
        part.includes('班') ||
        part.includes('級') ||
        part.includes('課') ||
        part.includes('泳') ||
        part.includes('游') ||
        part.includes('高中') ||
        part.includes('國中') ||
        part.includes('小學') ||
        part.length <= 2 // 太短的代碼
      ) {
        continue;
      }
      
      // 如果看起來像人名（包含中文且長度合適，且不包含數字）
      if (part.length >= 2 && part.match(/^[\u4e00-\u9fff]+$/) && !part.match(/\d/)) {
        coaches.push(part);
      }
    }
    
    // 如果沒有識別出教練，返回所有部分（除了第一個，因為通常是班級名）
    if (coaches.length === 0) {
      return parts.length > 1 ? parts.slice(1) : [coachName];
    }
    
    return coaches;
  };

  // 獲取特定日期和時段的課程
  const getScheduleForSlot = (date: Date, venueId: string, timeSlotId: string) => {
    const dateStr = format(date, 'yyyy-MM-dd');
    return schedulesWithoutCoach?.find(s => 
      s.date === dateStr && 
      s.venueId === venueId && 
      s.timeSlotId === timeSlotId
    );
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-primary">載入中...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-card border-b border-border shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col sm:flex-row justify-between items-center h-auto sm:h-16 py-4 gap-4">
            <div className="flex items-center space-x-4">
              <i className="fas fa-swimming-pool text-primary text-xl sm:text-2xl"></i>
              <h1 className="text-lg sm:text-xl font-bold text-primary">五泳池課表整合系統</h1>
            </div>
            <div className="flex items-center space-x-4">
              <span className="text-sm bg-green-500 text-white px-3 py-1 rounded-full">
                尋找教練
              </span>
            </div>
          </div>
        </div>
        
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <nav className="flex flex-wrap gap-2 sm:space-x-8 sm:gap-0" aria-label="Tabs">
            <button 
              className="whitespace-nowrap py-2 px-2 sm:px-1 border-b-2 border-transparent text-muted-foreground hover:text-foreground hover:border-border font-medium text-xs sm:text-sm rounded-t sm:rounded-none hover:bg-accent sm:hover:bg-transparent"
              onClick={() => setLocation('/coach')}
              data-testid="tab-coach-view"
            >
              <i className="fas fa-user-clock mr-1 sm:mr-2"></i>教練視圖
            </button>
            <button 
              className="whitespace-nowrap py-2 px-2 sm:px-1 border-b-2 border-transparent text-muted-foreground hover:text-foreground hover:border-border font-medium text-xs sm:text-sm rounded-t sm:rounded-none hover:bg-accent sm:hover:bg-transparent"
              onClick={() => setLocation('/venue-schedule')}
              data-testid="tab-venue-schedule"
            >
              <i className="fas fa-building mr-1 sm:mr-2"></i>場館課表顯示
            </button>
            <button 
              className="whitespace-nowrap py-2 px-2 sm:px-1 border-b-2 border-transparent text-muted-foreground hover:text-foreground hover:border-border font-medium text-xs sm:text-sm rounded-t sm:rounded-none hover:bg-accent sm:hover:bg-transparent"
              onClick={() => setLocation('/mgt-x9k7p2/class-edit')}
              data-testid="tab-venue-schedule-edit"
            >
              <i className="fas fa-edit mr-1 sm:mr-2"></i>學校課表編輯 (第一階段)
            </button>
            <button
              className="whitespace-nowrap py-2 px-2 sm:px-1 border-b-2 border-transparent text-muted-foreground hover:text-foreground hover:border-border font-medium text-xs sm:text-sm rounded-t sm:rounded-none hover:bg-accent sm:hover:bg-transparent"
              onClick={() => setLocation("/mgt-x9k7p2/assign")}
              data-testid="tab-coach-assignment"
            >
              <i className="fas fa-user-plus mr-1 sm:mr-2"></i>教練指派 (第二階段)
            </button>
            <button 
              className="whitespace-nowrap py-2 px-2 sm:px-1 border-b-2 border-transparent text-muted-foreground hover:text-foreground hover:border-border font-medium text-xs sm:text-sm rounded-t sm:rounded-none hover:bg-accent sm:hover:bg-transparent"
              onClick={() => setLocation('/mgt-x9k7p2/stats')}
              data-testid="tab-statistics"
            >
              <i className="fas fa-chart-bar mr-1 sm:mr-2"></i>堂數統計
            </button>
            <button 
              className="whitespace-nowrap py-2 px-2 sm:px-1 border-b-2 border-primary text-primary font-medium text-xs sm:text-sm rounded-t sm:rounded-none bg-accent sm:bg-transparent"
              data-testid="tab-find-coach"
            >
              <i className="fas fa-search mr-1 sm:mr-2"></i>尋找教練
            </button>
            <button
              className="whitespace-nowrap py-2 px-2 sm:px-1 border-b-2 border-transparent text-muted-foreground hover:text-foreground hover:border-border font-medium text-xs sm:text-sm rounded-t sm:rounded-none hover:bg-accent sm:hover:bg-transparent"
              onClick={() => setLocation("/mgt-x9k7p2/approval")}
              data-testid="tab-coach-approval"
            >
              <i className="fas fa-user-check mr-1 sm:mr-2"></i>教練審核
            </button>
            <button
              className="whitespace-nowrap py-2 px-2 sm:px-1 border-b-2 border-transparent text-green-600 hover:text-green-700 hover:border-green-400 font-medium text-xs sm:text-sm rounded-t sm:rounded-none hover:bg-green-50 sm:hover:bg-transparent"
              onClick={() => setLocation("/coach-portal")}
              data-testid="tab-coach-portal"
            >
              <i className="fas fa-door-open mr-1 sm:mr-2"></i>教練前台
            </button>
          </nav>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8">
        <div className="bg-card rounded-lg shadow-sm border border-border p-6">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-6 gap-4">
            <div className="flex items-center space-x-2 sm:space-x-4 w-full sm:w-auto">
              <Button
                variant="ghost"
                size="sm"
                onClick={navigateToPrevWeek}
                data-testid="button-prev-week"
                className="h-8 w-8 p-0 sm:h-9 sm:w-9"
              >
                <i className="fas fa-chevron-left text-xs sm:text-sm"></i>
              </Button>
              <h2 className="text-sm sm:text-lg font-semibold text-center flex-1 sm:flex-none" data-testid="text-current-week">
                {format(currentWeek, 'yyyy年M月d日', { locale: zhTW })} - {format(addDays(currentWeek, 6), 'M月d日', { locale: zhTW })}
              </h2>
              <Button
                variant="ghost"
                size="sm"
                onClick={navigateToNextWeek}
                data-testid="button-next-week"
                className="h-8 w-8 p-0 sm:h-9 sm:w-9"
              >
                <i className="fas fa-chevron-right text-xs sm:text-sm"></i>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={navigateToThisWeek}
                data-testid="button-this-week"
                className="text-xs sm:text-sm px-2 sm:px-3"
              >
                本週
              </Button>
            </div>
            <div className="text-sm text-muted-foreground">
              <div className="flex items-center gap-4">
                <span className="flex items-center gap-1">
                  <div className="w-3 h-3 bg-red-50 border border-dashed border-red-400 rounded"></div>
                  紅色虛線：缺教練課程
                </span>
                <span>點擊「我可以教」進行登記</span>
              </div>
            </div>
          </div>

          {!venues || !timeSlots ? (
            <div className="text-center py-8">
              <div className="text-muted-foreground">載入中...</div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className="border border-border p-2 bg-muted text-center text-sm font-medium min-w-20">
                      節次/時間
                    </th>
                    {weekDays.map((day) => (
                      <th key={format(day, 'yyyy-MM-dd')} className="border border-border p-2 bg-muted text-center text-sm font-medium min-w-32">
                        <div>{format(day, 'M月d日', { locale: zhTW })}</div>
                        <div className="text-xs text-muted-foreground">
                          {format(day, 'EEE', { locale: zhTW })}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {timeSlots?.map((timeSlot) => (
                    <tr key={timeSlot.id}>
                      <td className="border border-border p-2 bg-muted text-center text-sm font-medium">
                        <div>{timeSlot.period}</div>
                        <div className="text-xs text-muted-foreground">
                          {timeSlot.startTime}-{timeSlot.endTime}
                        </div>
                      </td>
                      {weekDays.map((day) => {
                        const dateStr = format(day, 'yyyy-MM-dd');
                        return (
                          <td key={`${dateStr}-${timeSlot.id}`} className="border border-border p-1">
                            <div className="grid gap-1">
                              {venues?.map((venue) => {
                                const schedule = getScheduleForSlot(day, venue.id, timeSlot.id);
                                if (!schedule) return null;
                                
                                // 判斷缺教練的情況
                                const isNoCoach = !schedule.coachName || schedule.coachName === '';
                                const hasCoachButMissing = schedule.coachName && schedule.coachName.includes('缺');
                                const isMissingCoach = isNoCoach || hasCoachButMissing;
                                
                                return (
                                  <div key={venue.id} className="relative">
                                    <div className={`p-3 rounded-lg text-xs ${getVenueColorClass(venue.color)} ${
                                      isMissingCoach 
                                        ? 'border-2 border-dashed border-red-500 shadow-sm' 
                                        : 'border border-solid shadow-sm'
                                    }`}>
                                      <div className="font-bold mb-1 text-sm">{schedule.className}</div>
                                      <div className="text-xs font-medium mb-2 opacity-80">{venue.name}</div>
                                      
                                      {/* 顯示教練狀態 */}
                                      {isNoCoach ? (
                                        <div className="text-xs text-red-700 font-bold mb-2 bg-red-50 px-2 py-1 rounded border border-red-200">缺教練</div>
                                      ) : hasCoachButMissing ? (
                                        <div className="mb-2">
                                          <div className="text-xs font-medium mb-1 opacity-70">目前教練：</div>
                                          <div className="flex flex-wrap gap-1">
                                            {parseCoachNames(schedule.coachName || '').map((coach, index) => (
                                              <div key={index} className="text-xs font-medium bg-orange-50 px-2 py-1 rounded border border-orange-200 text-orange-800">
                                                {coach}
                                              </div>
                                            ))}
                                          </div>
                                          <div className="text-xs text-red-700 font-bold mt-1 bg-red-50 px-2 py-1 rounded border border-red-200">還需要更多教練</div>
                                        </div>
                                      ) : schedule.coachName ? (
                                        <div className="mb-2">
                                          <div className="text-xs font-medium mb-1 opacity-70">目前教練：</div>
                                          <div className="flex flex-wrap gap-1">
                                            {parseCoachNames(schedule.coachName || '').map((coach, index) => (
                                              <div key={index} className="text-xs font-medium bg-blue-50 px-2 py-1 rounded border border-blue-200 text-blue-800">
                                                {coach}
                                              </div>
                                            ))}
                                          </div>
                                        </div>
                                      ) : null}
                                      
                                      {/* 顯示登記教練 */}
                                      {schedule.registrations.length > 0 && (
                                        <div className="mb-2">
                                          <div className="text-xs font-medium mb-1 opacity-70">登記教練：</div>
                                          <div className="flex flex-wrap gap-1">
                                            {schedule.registrations.map((reg) => (
                                              <Badge key={reg.id} className="text-xs px-2 py-1 bg-green-100 text-green-800 border border-green-300 font-medium">
                                                {reg.coachName}
                                              </Badge>
                                            ))}
                                          </div>
                                        </div>
                                      )}
                                      
                                      <Dialog open={dialogOpen && selectedSchedule?.id === schedule.id} 
                                             onOpenChange={(open) => {
                                               setDialogOpen(open);
                                               if (!open) {
                                                 setSelectedSchedule(null);
                                                 setCoachName("");
                                               }
                                             }}>
                                        <DialogTrigger asChild>
                                          <Button 
                                            size="sm"
                                            onClick={() => setSelectedSchedule(schedule)}
                                            className="w-full bg-green-600 hover:bg-green-700 text-white text-xs h-7 font-medium shadow-sm"
                                            data-testid={`button-register-${schedule.id}`}
                                          >
                                            我可以教
                                          </Button>
                                        </DialogTrigger>
                                        <DialogContent>
                                          <DialogHeader>
                                            <DialogTitle>教練登記</DialogTitle>
                                          </DialogHeader>
                                          <div className="space-y-4">
                                            <div>
                                              <p className="text-sm text-muted-foreground mb-2">課程資訊：</p>
                                              <p className="font-medium">{schedule.className}</p>
                                              <p className="text-sm text-muted-foreground">
                                                {schedule.venue.name} - {schedule.timeSlot.period} 
                                                ({schedule.timeSlot.startTime}-{schedule.timeSlot.endTime})
                                              </p>
                                              <p className="text-sm text-muted-foreground">
                                                {format(new Date(schedule.date), 'yyyy/MM/dd (EEE)', { locale: zhTW })}
                                              </p>
                                            </div>
                                            
                                            <div>
                                              <Label htmlFor="coachName">教練姓名</Label>
                                              <Input
                                                id="coachName"
                                                value={coachName}
                                                onChange={(e) => setCoachName(e.target.value)}
                                                placeholder="請輸入您的姓名"
                                                data-testid="input-coach-name"
                                              />
                                            </div>

                                            <div className="flex justify-end space-x-2">
                                              <Button 
                                                variant="outline" 
                                                onClick={() => {
                                                  setDialogOpen(false);
                                                  setSelectedSchedule(null);
                                                  setCoachName("");
                                                }}
                                                data-testid="button-cancel"
                                              >
                                                取消
                                              </Button>
                                              <Button 
                                                onClick={handleRegister}
                                                disabled={registerMutation.isPending || !coachName.trim()}
                                                data-testid="button-confirm-register"
                                              >
                                                {registerMutation.isPending ? '登記中...' : '確認登記'}
                                              </Button>
                                            </div>
                                          </div>
                                        </DialogContent>
                                      </Dialog>
                                    </div>
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
          )}
        </div>
      </main>
    </div>
  );
}
