import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useRef, useImperativeHandle, forwardRef } from "react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import CoachAutocomplete from "./coach-autocomplete";
import type { Venue, TimeSlot, Schedule } from "@shared/schema";
import { format, addDays, startOfWeek } from "date-fns";
import { getExtendedWeekDays, getExtendedWeekEnd, getExtendedWeekdayNames } from "@/utils/special-workdays";
import html2canvas from "html2canvas";

interface WeekScheduleGridProps {
  weekStart: Date;
}

export interface WeekScheduleGridRef {
  downloadDaySchedule: (dayIndex: number) => Promise<void>;
}

const WeekScheduleGrid = forwardRef<WeekScheduleGridRef, WeekScheduleGridProps>(({ weekStart }, ref) => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const dayRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [activeCell, setActiveCell] = useState<{ 
    date: string; 
    venueId: string; 
    timeSlotId: string; 
  } | null>(null);
  const [editingValues, setEditingValues] = useState<Record<string, string>>({});
  const [editingSchedule, setEditingSchedule] = useState<string | null>(null);
  const [editingVersion, setEditingVersion] = useState<number | undefined>();
  const [savingStates, setSavingStates] = useState<Record<string, boolean>>({});

  const weekDays = getExtendedWeekDays(weekStart); // 支援特殊工作日
  const weekEnd = getExtendedWeekEnd(weekStart);
  
  useImperativeHandle(ref, () => ({
    downloadDaySchedule: async (dayIndex: number) => {
      const dayElement = dayRefs.current[dayIndex];
      if (!dayElement) {
        toast({
          title: "下載失敗",
          description: "找不到課表元素",
          variant: "destructive",
        });
        return;
      }

      // 找到包含overflow的容器
      const overflowContainer = dayElement.querySelector('.overflow-x-auto') as HTMLElement;
      
      // 保存原始樣式（提升到try-catch外部以便finally訪問）
      let originalMaxHeight = '';
      let originalOverflow = '';
      let originalOverflowX = '';
      let originalOverflowY = '';
      
      if (overflowContainer) {
        originalMaxHeight = overflowContainer.style.maxHeight || '';
        originalOverflow = overflowContainer.style.overflow || '';
        originalOverflowX = overflowContainer.style.overflowX || '';
        originalOverflowY = overflowContainer.style.overflowY || '';
      }

      try {
        // 暫時移除所有overflow限制以捕獲完整內容
        if (overflowContainer) {
          overflowContainer.style.maxHeight = 'none';
          overflowContainer.style.overflow = 'visible';
          overflowContainer.style.overflowX = 'visible';
          overflowContainer.style.overflowY = 'visible';
        }

        // 等待DOM更新
        await new Promise(resolve => setTimeout(resolve, 100));

        const canvas = await html2canvas(dayElement, {
          scale: 2,
          backgroundColor: '#ffffff',
          logging: false,
          useCORS: true,
          windowHeight: dayElement.scrollHeight,
        });

        const link = document.createElement('a');
        const dateStr = format(weekDays[dayIndex], 'yyyy-MM-dd');
        link.download = `課表_${dateStr}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();

        toast({
          title: "下載成功",
          description: `課表已下載：${dateStr}`,
        });
      } catch (error) {
        console.error('Download error:', error);
        toast({
          title: "下載失敗",
          description: "無法生成圖片，請稍後再試",
          variant: "destructive",
        });
      } finally {
        // 無論成功或失敗，都恢復原始樣式
        if (overflowContainer) {
          overflowContainer.style.maxHeight = originalMaxHeight;
          overflowContainer.style.overflow = originalOverflow;
          overflowContainer.style.overflowX = originalOverflowX;
          overflowContainer.style.overflowY = originalOverflowY;
        }
      }
    },
  }));

  const { data: venues } = useQuery<Venue[]>({
    queryKey: ['/api/venues'],
  });

  const { data: timeSlots } = useQuery<TimeSlot[]>({
    queryKey: ['/api/time-slots'],
  });

  const { data: schedules } = useQuery<(Schedule & { venue: Venue; timeSlot: TimeSlot })[]>({
    queryKey: ['/api/schedules', format(weekStart, 'yyyy-MM-dd'), format(weekEnd, 'yyyy-MM-dd')],
    queryFn: async () => {
      const response = await fetch(`/api/schedules?startDate=${format(weekStart, 'yyyy-MM-dd')}&endDate=${format(weekEnd, 'yyyy-MM-dd')}`);
      if (!response.ok) throw new Error('Failed to fetch schedules');
      return response.json();
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (scheduleData: {
      date: string;
      venueId: string;
      timeSlotId: string;
      className: string;
      coachName: string;
    }) => {
      if (!scheduleData.className && !scheduleData.coachName) {
        // If both are empty, delete the schedule
        const existingSchedule = schedules?.find(s => 
          s.date === scheduleData.date && 
          s.venueId === scheduleData.venueId && 
          s.timeSlotId === scheduleData.timeSlotId
        );
        if (existingSchedule) {
          const response = await apiRequest('DELETE', `/api/schedules/${existingSchedule.id}`, { expectedVersion: existingSchedule.version });
          return response.json();
        }
        return null;
      }
      
      const response = await apiRequest('POST', '/api/schedules', scheduleData);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ 
        queryKey: ['/api/schedules', format(weekStart, 'yyyy-MM-dd'), format(weekEnd, 'yyyy-MM-dd')]
      });
      weekDays.forEach(day => {
        queryClient.invalidateQueries({ queryKey: ['/api/conflicts', format(day, 'yyyy-MM-dd')] });
      });
      // 只在發生錯誤時才顯示通知，成功時静默儲存
    },
    onError: (error) => {
      console.error('Save error:', error);
      toast({
        title: "儲存失敗",
        description: error.message || '網路連線問題，請稍後再試',
        variant: "destructive",
      });
    },
  });

  const getCellSchedules = (date: string, venueId: string, timeSlotId: string) => {
    return schedules?.filter(s => 
      s.date === date && s.venueId === venueId && s.timeSlotId === timeSlotId
    ) || [];
  };

  const deleteMutation = useMutation({
    mutationFn: async (scheduleId: string) => {
      const response = await apiRequest('DELETE', `/api/schedules/${scheduleId}`, { expectedVersion: editingSchedule === scheduleId ? editingVersion : schedules?.find(s => s.id === scheduleId)?.version });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ 
        queryKey: ['/api/schedules', format(weekStart, 'yyyy-MM-dd'), format(weekEnd, 'yyyy-MM-dd')]
      });
      weekDays.forEach(day => {
        queryClient.invalidateQueries({ queryKey: ['/api/conflicts', format(day, 'yyyy-MM-dd')] });
      });
      // 只在發生錯誤時才顯示通知
    },
    onError: (error) => {
      console.error('Delete error:', error);
      toast({
        title: "刪除失敗",
        description: error.message || '網路連線問題，請稍後再試',
        variant: "destructive",
      });
    },
  });

  const handleAddClass = (date: string, venueId: string, timeSlotId: string, value: string) => {
    const trimmedValue = value.trim();
    if (!trimmedValue) return;
    
    // 防止重複提交
    const cellKey = `${date}-${venueId}-${timeSlotId}`;
    if (saveMutation.isPending || savingStates[cellKey]) return;
    
    setSavingStates(prev => ({ ...prev, [cellKey]: true }));
    
    // Parse the input - format: 班級-教練名
    let className = '';
    let coachName = '';
    
    if (trimmedValue.includes('-')) {
      // Split by dash
      const parts = trimmedValue.split('-');
      className = parts[0].trim();
      coachName = parts.slice(1).join('-').trim(); // In case there are multiple dashes
    } else {
      // No dash - treat as class name only
      className = trimmedValue;
    }

    saveMutation.mutate({
      date,
      venueId,
      timeSlotId,
      className,
      coachName,
    }, {
      onSettled: () => {
        setSavingStates(prev => {
          const { [cellKey]: _, ...rest } = prev;
          return rest;
        });
      }
    });
  };

  const handleDeleteClass = (scheduleId: string) => {
    // 防止重複提交
    if (deleteMutation.isPending || savingStates[scheduleId]) return;
    
    setSavingStates(prev => ({ ...prev, [scheduleId]: true }));
    
    deleteMutation.mutate(scheduleId, {
      onSettled: () => {
        setSavingStates(prev => {
          const { [scheduleId]: _, ...rest } = prev;
          return rest;
        });
      }
    });
  };
  
  const updateMutation = useMutation({
    mutationFn: async (updateData: {
      scheduleId: string;
      className: string;
      coachName: string;
    }) => {
      const response = await apiRequest('PUT', `/api/schedules/${updateData.scheduleId}`, {
        expectedVersion: editingVersion,
        className: updateData.className,
        coachName: updateData.coachName,
      });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ 
        queryKey: ['/api/schedules', format(weekStart, 'yyyy-MM-dd'), format(weekEnd, 'yyyy-MM-dd')]
      });
      weekDays.forEach(day => {
        queryClient.invalidateQueries({ queryKey: ['/api/conflicts', format(day, 'yyyy-MM-dd')] });
      });
      setEditingSchedule(null);
      // 成功時静默儲存，不顯示通知
    },
    onError: (error) => {
      console.error('Update error:', error);
      toast({
        title: "更新失敗",
        description: error.message || '網路連線問題，請稍後再試',
        variant: "destructive",
      });
    },
  });
  
  const handleEditSchedule = (schedule: any) => {
    const displayValue = schedule.className && schedule.coachName 
      ? `${schedule.className}-${schedule.coachName}`
      : schedule.className || schedule.coachName || '';
    setEditingSchedule(schedule.id);
    setEditingVersion(schedule.version);
    setEditingValues({ ...editingValues, [schedule.id]: displayValue });
  };
  
  const handleUpdateSchedule = (scheduleId: string, value: string) => {
    const trimmedValue = value.trim();
    
    // 防止重複提交
    if (updateMutation.isPending || deleteMutation.isPending || savingStates[scheduleId]) return;
    
    setSavingStates(prev => ({ ...prev, [scheduleId]: true }));
    
    if (!trimmedValue) {
      // If empty, delete the schedule
      deleteMutation.mutate(scheduleId, {
        onSettled: () => {
          setSavingStates(prev => {
            const { [scheduleId]: _, ...rest } = prev;
            return rest;
          });
        }
      });
      return;
    }
    
    // Parse the input - format: 班級-教練名
    let className = '';
    let coachName = '';
    
    if (trimmedValue.includes('-')) {
      const parts = trimmedValue.split('-');
      className = parts[0].trim();
      coachName = parts.slice(1).join('-').trim();
    } else {
      className = trimmedValue;
    }

    updateMutation.mutate({
      scheduleId,
      className,
      coachName,
    }, {
      onSettled: () => {
        setSavingStates(prev => {
          const { [scheduleId]: _, ...rest } = prev;
          return rest;
        });
      }
    });
  };

  const getVenueHeaderClass = (color: string) => {
    switch (color) {
      case 'blue': return 'bg-blue-500';
      case 'green': return 'bg-green-500';
      case 'purple': return 'bg-purple-500';
      case 'yellow': return 'bg-yellow-500';
      case 'orange': return 'bg-orange-500';
      case 'pink': return 'bg-pink-500';
      default: return 'bg-gray-500';
    }
  };

  if (!venues || !timeSlots) {
    return <div className="text-center py-8">載入中...</div>;
  }

  const weekDayNames = getExtendedWeekdayNames(weekStart);

  return (
    <div className="space-y-8">
      {weekDays.map((day, dayIndex) => {
        const dateStr = format(day, 'yyyy-MM-dd');
        
        return (
          <div 
            key={dayIndex} 
            ref={(el) => dayRefs.current[dayIndex] = el}
            className="bg-card rounded-lg border border-border p-4"
          >
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold flex-1 text-center">
                {format(day, 'M月d日')} {weekDayNames[dayIndex]}
              </h3>
            </div>
            
            <div className="overflow-x-auto" style={{ maxHeight: '80vh', overflowY: 'auto' }}>
              <table className="w-full border-collapse relative">
                <thead className="sticky top-0 z-10">
                  <tr>
                    <th className="time-cell bg-muted text-muted-foreground text-sm font-medium p-3 border border-border sticky left-0 z-20">
                      節次/時間
                    </th>
                    {venues.map((venue) => (
                      <th
                        key={venue.id}
                        className={`schedule-cell ${getVenueHeaderClass(venue.color)} text-white text-sm font-medium p-3 border border-border`}
                        data-testid={`header-${dayIndex}-${venue.name}`}
                      >
                        {venue.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {timeSlots.map((timeSlot) => (
                    <tr key={timeSlot.id}>
                      <td className="time-cell bg-muted text-sm font-medium p-3 border border-border sticky left-0 z-10" data-testid={`time-slot-${dayIndex}-${timeSlot.period}`}>
                        {timeSlot.period}<br />
                        <span className="text-xs text-muted-foreground">
                          {timeSlot.startTime}-{timeSlot.endTime}
                        </span>
                      </td>
                      {venues.map((venue) => {
                        const cellKey = `${dateStr}-${venue.id}-${timeSlot.id}`;
                        const cellSchedules = getCellSchedules(dateStr, venue.id, timeSlot.id);
                        const isActive = activeCell?.date === dateStr && 
                                        activeCell?.venueId === venue.id && 
                                        activeCell?.timeSlotId === timeSlot.id;
                        const isCellSaving = savingStates[cellKey];
                        
                        return (
                          <td
                            key={cellKey}
                            className="schedule-cell p-2 border border-border hover:bg-accent/50 cursor-pointer relative align-top"
                            data-testid={`cell-${dayIndex}-${venue.name}-${timeSlot.period}`}
                            style={{ minHeight: '60px', verticalAlign: 'top' }}
                          >
                            <div className="space-y-1 min-h-full relative">
                              {isCellSaving && (
                                <div className="absolute inset-0 bg-background/80 flex items-center justify-center z-10 rounded">
                                  <div className="animate-spin rounded-full h-4 w-4 border-2 border-primary border-t-transparent"></div>
                                </div>
                              )}
                              {cellSchedules.map((schedule, index) => {
                                const isEditing = editingSchedule === schedule.id;
                                const isScheduleSaving = savingStates[schedule.id];
                                return (
                                  <div 
                                    key={schedule.id} 
                                    className={`flex items-center justify-between bg-background/50 rounded px-1 py-0.5 text-xs group relative ${isScheduleSaving ? 'opacity-60' : ''}`}
                                    data-testid={`schedule-item-${dayIndex}-${venue.name}-${timeSlot.period}-${index}`}
                                  >
                                    {isScheduleSaving && (
                                      <div className="absolute inset-0 bg-background/50 flex items-center justify-center z-10 rounded">
                                        <div className="animate-spin rounded-full h-3 w-3 border border-primary border-t-transparent"></div>
                                      </div>
                                    )}
                                    {isEditing ? (
                                      <input
                                        type="text"
                                        value={editingValues[schedule.id] || ''}
                                        onChange={(e) => setEditingValues({ ...editingValues, [schedule.id]: e.target.value })}
                                        onBlur={() => {
                                          handleUpdateSchedule(schedule.id, editingValues[schedule.id] || '');
                                        }}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter') {
                                            handleUpdateSchedule(schedule.id, editingValues[schedule.id] || '');
                                          } else if (e.key === 'Escape') {
                                            setEditingSchedule(null);
                                            const { [schedule.id]: _, ...rest } = editingValues;
                                            setEditingValues(rest);
                                          }
                                        }}
                                        autoFocus
                                        className="flex-1 bg-transparent border-none outline-none text-xs"
                                        data-testid={`input-edit-${dayIndex}-${venue.name}-${timeSlot.period}-${index}`}
                                      />
                                    ) : (
                                      <span 
                                        className="flex-1 cursor-pointer hover:bg-accent/30 rounded px-1 break-words"
                                        onDoubleClick={() => handleEditSchedule(schedule)}
                                        title="雙擊編輯課程"
                                        data-testid={`span-edit-${dayIndex}-${venue.name}-${timeSlot.period}-${index}`}
                                        style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}
                                      >
                                        {schedule.className && schedule.coachName 
                                          ? `${schedule.className}-${schedule.coachName}`
                                          : schedule.className || schedule.coachName || '未命名'}
                                      </span>
                                    )}
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleDeleteClass(schedule.id);
                                      }}
                                      disabled={isScheduleSaving || deleteMutation.isPending}
                                      className={`opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive/80 ml-1 transition-opacity ${
                                        isScheduleSaving || deleteMutation.isPending ? 'cursor-not-allowed opacity-30' : ''
                                      }`}
                                      data-testid={`button-delete-${dayIndex}-${venue.name}-${timeSlot.period}-${index}`}
                                    >
                                      <i className="fas fa-times text-xs"></i>
                                    </button>
                                  </div>
                                );
                              })}
                              <input
                                type="text"
                                className={`w-full bg-transparent text-xs placeholder-muted-foreground border-none outline-none p-1 ${isCellSaving ? 'pointer-events-none opacity-50' : ''}`}
                                placeholder={cellSchedules.length === 0 ? "班級-教練" : "新增課程"}
                                disabled={isCellSaving || saveMutation.isPending}
                                onFocus={() => setActiveCell({ date: dateStr, venueId: venue.id, timeSlotId: timeSlot.id })}
                                onBlur={(e) => {
                                  const value = e.target.value.trim();
                                  if (value && !isCellSaving && !saveMutation.isPending) {
                                    handleAddClass(dateStr, venue.id, timeSlot.id, value);
                                    e.target.value = '';
                                  }
                                  setActiveCell(null);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    const value = e.currentTarget.value.trim();
                                    if (value && !isCellSaving && !saveMutation.isPending) {
                                      handleAddClass(dateStr, venue.id, timeSlot.id, value);
                                      e.currentTarget.value = '';
                                    }
                                    e.currentTarget.blur();
                                  }
                                }}
                                data-testid={`input-${dayIndex}-${venue.name}-${timeSlot.period}`}
                              />
                            </div>
                            {isActive && (
                              <CoachAutocomplete
                                onSelect={(coachName: string) => {
                                  const input = document.querySelector(`[data-testid="input-${dayIndex}-${venue.name}-${timeSlot.period}"]`) as HTMLInputElement;
                                  if (input) {
                                    const currentValue = input.value;
                                    const newValue = currentValue ? `${currentValue}-${coachName}` : coachName;
                                    input.value = newValue;
                                  }
                                  setActiveCell(null);
                                }}
                              />
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
});

WeekScheduleGrid.displayName = 'WeekScheduleGrid';

export default WeekScheduleGrid;
