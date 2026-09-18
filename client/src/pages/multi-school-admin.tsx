import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useLocation } from 'wouter';
import { format, addDays, startOfWeek, addWeeks } from 'date-fns';
import { zhTW } from 'date-fns/locale';
import { School, ChevronLeft, ChevronRight, Edit, Plus, Save, X } from 'lucide-react';
import type { Schedule, TimeSlot, Venue, TeacherFeedback } from '@shared/schema';
import TeacherLinkManager from '@/components/teacher-link-manager';

// 多學校管理後台
export default function MultiSchoolAdmin() {
  const [, setLocation] = useLocation();
  const [selectedSchool, setSelectedSchool] = useState<string>('demo');
  const [isEditMode, setIsEditMode] = useState(false);
  const [editingCell, setEditingCell] = useState<{date: string, timeSlotId: string} | null>(null);
  const [newSchedule, setNewSchedule] = useState({ className: '', coachName: '' });
  const queryClient = useQueryClient();
  const [currentWeek, setCurrentWeek] = useState(() => {
    // 設定為新北高中課表資料的週期（2024年9月22日週）
    const targetDate = new Date('2024-09-22');
    return startOfWeek(targetDate, { weekStartsOn: 1 });
  });

  // 可用學校列表（實際環境中可能從API獲取）
  const availableSchools = [
    { code: 'demo', name: '新北高中' }
  ];

  // 獲取選定學校的數據 - 根據當前週期查詢
  const { data: schedules = [] } = useQuery<Schedule[]>({
    queryKey: [`/api/${selectedSchool}/schedules`, format(currentWeek, 'yyyy-MM-dd')],
    queryFn: async () => {
      const startDate = format(currentWeek, 'yyyy-MM-dd');
      const endDate = format(addDays(currentWeek, 6), 'yyyy-MM-dd');
      const response = await fetch(`/api/${selectedSchool}/schedules?startDate=${startDate}&endDate=${endDate}`);
      if (!response.ok) {
        console.error('API 錯誤:', response.status, response.statusText);
        throw new Error('Failed to fetch schedules');
      }
      const data = await response.json();
      console.log(`查詢 ${startDate} 到 ${endDate}:`, data.length, '筆課表');
      return data;
    },
    enabled: !!selectedSchool,
  });

  const { data: timeSlots = [] } = useQuery<TimeSlot[]>({
    queryKey: [`/api/${selectedSchool}/time-slots`],
    queryFn: async () => {
      const response = await fetch(`/api/${selectedSchool}/time-slots`);
      if (!response.ok) {
        console.error('時間段 API 錯誤:', response.status, response.statusText);
        throw new Error('Failed to fetch time slots');
      }
      const data = await response.json();
      console.log('時間段資料載入:', data.length, '個');
      return data;
    },
    enabled: !!selectedSchool,
  });

  const { data: venues = [] } = useQuery<Venue[]>({
    queryKey: [`/api/${selectedSchool}/venues`],
    enabled: !!selectedSchool,
  });

  // 獲取老師回覆狀態
  const { data: feedbacks = [] } = useQuery<any[]>({
    queryKey: [`/api/${selectedSchool}/feedbacks`, 'all'],
    queryFn: async () => {
      const adminPassword = (typeof window !== 'undefined' && sessionStorage.getItem('admin-password')) || '';
      const response = await fetch(`/api/admin/${selectedSchool}/feedbacks`, {
        headers: adminPassword ? { 'x-admin-password': adminPassword } : {},
      });
      if (!response.ok) {
        console.warn('獲取回覆狀態失敗:', response.status);
        return [];
      }
      return response.json();
    },
  });

  // 週期導航
  const navigateToPrevWeek = () => setCurrentWeek(prev => addWeeks(prev, -1));
  const navigateToNextWeek = () => setCurrentWeek(prev => addWeeks(prev, 1));
  
  // 生成週內日期
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(currentWeek, i));
  
  // 根據時間段和日期組織課程數據
  const getScheduleForDayAndSlot = (date: Date, timeSlotId: string) => {
    const dateStr = format(date, 'yyyy-MM-dd');
    const filtered = schedules.filter(s => 
      format(new Date(s.date), 'yyyy-MM-dd') === dateStr && s.timeSlotId === timeSlotId
    );
    return filtered;
  };

  // 獲取課程的回覆狀態
  const getFeedbackForSchedule = (scheduleId: string) => {
    return feedbacks.find(f => f.schedule_id === scheduleId);
  };

  // 新增課表
  const addSchedule = useMutation({
    mutationFn: async (data: {
      date: string;
      timeSlotId: string;
      className: string;
      coachName: string;
      venueId: string;
    }) => {
      const response = await fetch(`/api/${selectedSchool}/schedules`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-password': sessionStorage.getItem('admin-password') || '',
        },
        body: JSON.stringify({
          ...data,
          notes: '新增課程'
        })
      });
      if (!response.ok) throw new Error('Failed to add schedule');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/${selectedSchool}/schedules`] });
      setEditingCell(null);
      setNewSchedule({ className: '', coachName: '' });
    }
  });

  // 刪除課表
  const deleteSchedule = useMutation({
    mutationFn: async (scheduleId: string) => {
      const response = await fetch(`/api/${selectedSchool}/schedules/${scheduleId}`, {
        method: 'DELETE',
        headers: { 'x-admin-password': sessionStorage.getItem('admin-password') || '' },
      });
      if (!response.ok) throw new Error('Failed to delete schedule');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/${selectedSchool}/schedules`] });
    }
  });

  // 獲取選中學校的資訊
  const selectedSchoolInfo = availableSchools.find(s => s.code === selectedSchool);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-4">
            <h1 className="text-2xl font-bold text-gray-900 flex items-center">
              <School className="mr-2 h-6 w-6 text-blue-600" />
              多學校協作管理系統
            </h1>
            <Button 
              variant="outline" 
              onClick={() => setLocation('/mgt-x9k7p2/schedule')}
            >
              返回主控台
            </Button>
          </div>

          {/* 導航欄 */}
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
              <i className="fas fa-edit mr-1 sm:mr-2"></i>場館課表編輯
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
              onClick={() => setLocation('/teacher-portal')}
              data-testid="tab-teacher-portal"
            >
              <i className="fas fa-users mr-1 sm:mr-2"></i>教師協作回覆
            </button>
            <button 
              className="whitespace-nowrap py-2 px-2 sm:px-1 border-b-2 border-primary text-primary font-medium text-xs sm:text-sm rounded-t sm:rounded-none bg-accent sm:bg-transparent"
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
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <TeacherLinkManager />
        {/* 學校選擇和週期導航 */}
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 mb-6">
          <div className="flex items-center gap-4">
            <Select value={selectedSchool} onValueChange={setSelectedSchool}>
              <SelectTrigger className="w-64">
                <SelectValue placeholder="請選擇學校..." />
              </SelectTrigger>
              <SelectContent>
                {availableSchools.map((school) => (
                  <SelectItem key={school.code} value={school.code}>
                    {school.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            
            {/* 編輯模式開關 */}
            <Button
              variant={isEditMode ? "default" : "outline"}
              onClick={() => {
                console.log('編輯模式切換:', isEditMode, '->', !isEditMode);
                setIsEditMode(!isEditMode);
              }}
              className="flex items-center gap-2"
              data-testid="toggle-edit-mode"
            >
              <Edit className="h-4 w-4" />
              {isEditMode ? '退出編輯' : '編輯模式'}
            </Button>
          </div>
          
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={navigateToPrevWeek}
              className="h-8 w-8 p-0"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm font-medium min-w-32 text-center">
              {format(currentWeek, 'MM/dd', { locale: zhTW })} - {format(addDays(currentWeek, 6), 'MM/dd', { locale: zhTW })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={navigateToNextWeek}
              className="h-8 w-8 p-0"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* 學校課表主標題 */}
        <div className="text-center mb-6">
          <h2 className="text-xl font-bold">
            {selectedSchoolInfo?.name} {format(currentWeek, 'MM.dd', { locale: zhTW })}-{format(addDays(currentWeek, 6), 'MM.dd', { locale: zhTW })}
          </h2>
        </div>

        {/* 課表表格 */}
        <div className="bg-white border-2 border-gray-800 overflow-hidden">
          <Table className="w-full border-collapse">
            <TableHeader>
              <TableRow className="border-b-2 border-gray-800">
                <TableHead className="border-r-2 border-gray-800 text-center font-bold text-black bg-gray-100 w-20">
                  星期<br />節次
                </TableHead>
                {weekDays.map((day, index) => (
                  <TableHead 
                    key={index}
                    className="border-r-2 border-gray-800 text-center font-bold text-black bg-gray-100 min-w-32"
                  >
                    {['一', '二', '三', '四', '五'][index]}<br />
                    {format(day, 'MM/dd')}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {timeSlots.slice(0, 7).map((timeSlot, periodIndex) => (
                <TableRow key={timeSlot.id} className="border-b border-gray-800">
                  <TableCell className="border-r-2 border-gray-800 text-center font-bold bg-gray-50 text-black">
                    {periodIndex + 1}
                  </TableCell>
                  {weekDays.map((day, dayIndex) => {
                    const daySchedules = getScheduleForDayAndSlot(day, timeSlot.id);
                    return (
                      <TableCell 
                        key={dayIndex}
                        className="border-r border-gray-800 p-2 align-top min-h-16 relative"
                      >
                        {daySchedules.length > 0 ? (
                          <div className="space-y-1">
                            {daySchedules.map((schedule, idx) => {
                              const feedback = getFeedbackForSchedule(schedule.id);
                              return (
                                <div key={idx} className="text-blue-600 text-sm leading-tight relative">
                                  <div className="flex items-center justify-between">
                                    <div>
                                      <div>{schedule.className}</div>
                                      <div>{schedule.coachName}</div>
                                    </div>
                                    
                                    {/* 回覆狀態顯示 */}
                                    {feedback && (
                                      <Badge 
                                        variant={
                                          feedback.status === 'need_coop' ? 'destructive' :
                                          feedback.status === 'reschedule' ? 'secondary' :
                                          'default'
                                        }
                                        className="text-xs ml-1"
                                      >
                                        {feedback.status === 'need_coop' ? '需協同' :
                                         feedback.status === 'reschedule' ? '調課' : '不需協同'}
                                      </Badge>
                                    )}
                                    
                                    {/* 編輯模式下的刪除按鈕 */}
                                    {isEditMode && (
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-6 w-6 p-0 text-red-500 hover:text-red-700"
                                        onClick={() => deleteSchedule.mutate(schedule.id)}
                                      >
                                        <X className="h-3 w-3" />
                                      </Button>
                                    )}
                                  </div>
                                  
                                  {/* 顯示調課資訊 */}
                                  {feedback?.status === 'reschedule' && feedback.reschedule_date && (
                                    <div className="text-xs text-gray-500">
                                      調至: {feedback.reschedule_date} {feedback.reschedule_period}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="h-12"></div>
                        )}
                        
                        {/* 編輯模式下的新增按鈕 */}
                        {isEditMode && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className={`${daySchedules.length === 0 ? 'absolute inset-0 w-full h-full' : 'mt-1 w-full'} flex items-center justify-center text-gray-400 hover:text-gray-600 border border-dashed border-gray-300 hover:border-gray-400`}
                            onClick={() => setEditingCell({
                              date: format(day, 'yyyy-MM-dd'),
                              timeSlotId: timeSlot.id
                            })}
                          >
                            <Plus className="h-4 w-4" />
                            {daySchedules.length === 0 ? '' : '新增班級'}
                          </Button>
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        
        {/* 新增課表對話框 */}
        <Dialog 
          open={!!editingCell} 
          onOpenChange={(open) => !open && setEditingCell(null)}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>新增課表</DialogTitle>
            </DialogHeader>
            
            {editingCell && (
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium">日期與時間</label>
                  <p className="text-sm text-gray-600">
                    {format(new Date(editingCell.date), 'yyyy年MM月dd日')} 
                    第{timeSlots.findIndex(ts => ts.id === editingCell.timeSlotId) + 1}節
                  </p>
                </div>
                
                <div>
                  <label className="text-sm font-medium">班級</label>
                  <Input
                    value={newSchedule.className}
                    onChange={(e) => setNewSchedule(prev => ({...prev, className: e.target.value}))}
                    placeholder="請輸入班級名稱（如：301）"
                  />
                </div>
                
                <div>
                  <label className="text-sm font-medium">教師</label>
                  <Input
                    value={newSchedule.coachName}
                    onChange={(e) => setNewSchedule(prev => ({...prev, coachName: e.target.value}))}
                    placeholder="請輸入教師姓名"
                  />
                </div>
                
                <div className="flex justify-end gap-2">
                  <Button 
                    variant="outline" 
                    onClick={() => setEditingCell(null)}
                  >
                    取消
                  </Button>
                  <Button 
                    onClick={() => {
                      if (newSchedule.className && newSchedule.coachName && venues.length > 0) {
                        addSchedule.mutate({
                          date: editingCell.date,
                          timeSlotId: editingCell.timeSlotId,
                          className: newSchedule.className,
                          coachName: newSchedule.coachName,
                          venueId: venues[0].id // 使用第一個場館
                        });
                      }
                    }}
                    disabled={!newSchedule.className || !newSchedule.coachName || addSchedule.isPending}
                  >
                    {addSchedule.isPending ? '新增中...' : '新增'}
                  </Button>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
