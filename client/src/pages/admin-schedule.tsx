import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useEffect, useState, useRef } from "react";
import { useLocation } from "wouter";
import { isUnauthorizedError } from "@/lib/authUtils";
import { format, addDays, subDays, startOfWeek, addWeeks, subWeeks } from "date-fns";
import { zhTW } from "date-fns/locale";
import WeekScheduleGrid, { type WeekScheduleGridRef } from "@/components/week-schedule-grid";
import FloatingConflictAlert from "@/components/floating-conflict-alert";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function AdminSchedule() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [currentWeek, setCurrentWeek] = useState(startOfWeek(new Date(), { weekStartsOn: 1 }));
  const gridRef = useRef<WeekScheduleGridRef>(null);
  // 默認選擇今天，如果今天不在這週範圍內則選擇星期一
  const getTodayIndex = () => {
    const today = new Date();
    const todayDay = today.getDay(); // 0=Sunday, 1=Monday, ..., 6=Saturday
    if (todayDay >= 1 && todayDay <= 5) {
      return (todayDay - 1).toString(); // 轉換為0-4的索引
    }
    return "0"; // 週末默認選擇星期一
  };
  const [selectedDay, setSelectedDay] = useState<string>(getTodayIndex());
  const [isDownloading, setIsDownloading] = useState(false);

  // Remove Replit authentication requirement for public access

  // Allow public access to admin interface

  const navigateToPrevWeek = () => {
    setCurrentWeek(prev => subWeeks(prev, 1));
  };

  const navigateToNextWeek = () => {
    setCurrentWeek(prev => addWeeks(prev, 1));
  };

  const navigateToThisWeek = () => {
    setCurrentWeek(startOfWeek(new Date(), { weekStartsOn: 1 }));
  };

  const handleDownloadDaySchedule = async () => {
    if (isDownloading) return;
    
    setIsDownloading(true);
    try {
      const dayIndex = parseInt(selectedDay);
      if (gridRef.current) {
        await gridRef.current.downloadDaySchedule(dayIndex);
      }
    } finally {
      setIsDownloading(false);
    }
  };

  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const day = addDays(currentWeek, i);
    return {
      value: i.toString(),
      label: format(day, 'M月d日 (EEEE)', { locale: zhTW }),
    };
  });

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
              <span className="text-sm bg-primary text-primary-foreground px-3 py-1 rounded-full">
                管理員模式
              </span>
              {user && (
                <>
                  <div className="flex items-center space-x-2">
                    <div className="w-8 h-8 bg-primary rounded-full flex items-center justify-center">
                      <i className="fas fa-user text-primary-foreground text-sm"></i>
                    </div>
                    <span className="text-sm font-medium">{user.firstName || user.email || '管理員'}</span>
                  </div>
                  <Button 
                    variant="outline" 
                    size="sm"
                    onClick={() => window.location.href = '/api/logout'}
                    data-testid="button-logout"
                  >
                    登出
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="mb-6">
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
              className="whitespace-nowrap py-2 px-2 sm:px-1 border-b-2 border-transparent text-muted-foreground hover:text-foreground hover:border-border font-medium text-xs sm:text-sm rounded-t sm:rounded-none hover:bg-accent sm:hover:bg-transparent"
              onClick={() => setLocation('/multi-school-admin')}
              data-testid="tab-multi-school"
            >
              <i className="fas fa-school mr-1 sm:mr-2"></i>多學校管理
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

        <FloatingConflictAlert weekStart={currentWeek} />

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
            <div className="flex items-center space-x-2 w-full sm:w-auto flex-wrap gap-2">
              <div className="flex items-center space-x-2">
                <Select value={selectedDay} onValueChange={setSelectedDay}>
                  <SelectTrigger className="w-40 h-9 text-xs sm:text-sm">
                    <SelectValue placeholder="選擇日期" />
                  </SelectTrigger>
                  <SelectContent>
                    {weekDays.map((day) => (
                      <SelectItem key={day.value} value={day.value}>
                        {day.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={handleDownloadDaySchedule}
                  disabled={isDownloading}
                  data-testid="button-download-day"
                  className="flex-1 sm:flex-none text-xs sm:text-sm"
                >
                  {isDownloading ? (
                    <>
                      <div className="animate-spin rounded-full h-3 w-3 border-2 border-primary border-t-transparent mr-1 sm:mr-2"></div>
                      下載中...
                    </>
                  ) : (
                    <>
                      <i className="fas fa-download mr-1 sm:mr-2"></i>下載課表
                    </>
                  )}
                </Button>
              </div>
              <Button variant="secondary" size="sm" data-testid="button-copy-week" className="flex-1 sm:flex-none text-xs sm:text-sm">
                <i className="fas fa-copy mr-1 sm:mr-2"></i>複製週課表
              </Button>
              <Button size="sm" data-testid="button-save" className="flex-1 sm:flex-none text-xs sm:text-sm">
                <i className="fas fa-save mr-1 sm:mr-2"></i>儲存
              </Button>
            </div>
          </div>

          <WeekScheduleGrid ref={gridRef} weekStart={currentWeek} />
        </div>
      </main>
    </div>
  );
}
