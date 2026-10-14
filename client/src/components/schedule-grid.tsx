import { isPlaceholderCoach } from "@shared/scheduleRules";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import CoachAutocomplete from "./coach-autocomplete";
import type { Venue, TimeSlot, Schedule } from "@shared/schema";

interface ScheduleGridProps {
  date: string;
}

export default function ScheduleGrid({ date }: ScheduleGridProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeCell, setActiveCell] = useState<{ venueId: string; timeSlotId: string } | null>(null);

  const { data: venues } = useQuery<Venue[]>({
    queryKey: ['/api/venues'],
  });

  const { data: timeSlots } = useQuery<TimeSlot[]>({
    queryKey: ['/api/time-slots'],
  });

  const { data: schedules } = useQuery<(Schedule & { venue: Venue; timeSlot: TimeSlot })[]>({
    queryKey: ['/api/schedules', date],
  });

  const saveMutation = useMutation({
    mutationFn: async (scheduleData: {
      date: string;
      venueId: string;
      timeSlotId: string;
      className: string;
      coachName: string;
    }) => {
      const response = await apiRequest('POST', '/api/schedules', scheduleData);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/schedules', date] });
      queryClient.invalidateQueries({ queryKey: ['/api/conflicts', date] });
      toast({
        title: "儲存成功",
        description: "課表已更新",
      });
    },
    onError: (error) => {
      toast({
        title: "儲存失敗",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const getScheduleValue = (venueId: string, timeSlotId: string) => {
    const schedule = schedules?.find(s => s.venueId === venueId && s.timeSlotId === timeSlotId);
    if (!schedule) return '';
    return schedule.className && schedule.coachName 
      ? `${schedule.className} ${schedule.coachName}`
      : schedule.className || schedule.coachName || '';
  };

  const handleCellChange = (venueId: string, timeSlotId: string, value: string) => {
    const parts = value.split(' ');
    const className = parts.slice(0, -1).join(' ') || '';
    const coachName = parts[parts.length - 1] || '';

    if (value.trim()) {
      saveMutation.mutate({
        date,
        venueId,
        timeSlotId,
        className,
        coachName,
      });
    }
  };

  const getVenueHeaderClass = (color: string) => {
    switch (color) {
      case 'blue': return 'bg-blue-500';
      case 'green': return 'bg-green-500';
      case 'purple': return 'bg-purple-500';
      case 'yellow': return 'bg-yellow-500';
      case 'pink': return 'bg-pink-500';
      default: return 'bg-gray-500';
    }
  };

  if (!venues || !timeSlots) {
    return <div className="text-center py-8">載入中...</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className="time-cell bg-muted text-muted-foreground text-sm font-medium p-3 border border-border">
              節次/時間
            </th>
            {venues.map((venue) => (
              <th
                key={venue.id}
                className={`schedule-cell ${getVenueHeaderClass(venue.color)} text-white text-sm font-medium p-3 border border-border`}
                data-testid={`header-venue-${venue.name}`}
              >
                {venue.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {timeSlots.map((timeSlot) => (
            <tr key={timeSlot.id}>
              <td className="time-cell bg-muted text-sm font-medium p-3 border border-border" data-testid={`time-slot-${timeSlot.period}`}>
                {timeSlot.period}<br />
                <span className="text-xs text-muted-foreground">
                  {timeSlot.startTime}-{timeSlot.endTime}
                </span>
              </td>
              {venues.map((venue) => {
                const cellKey = `${venue.id}-${timeSlot.id}`;
                const value = getScheduleValue(venue.id, timeSlot.id);
                const isActive = activeCell?.venueId === venue.id && activeCell?.timeSlotId === timeSlot.id;
                
                return (
                  <td
                    key={cellKey}
                    className={`schedule-cell p-2 border cursor-pointer relative ${schedules?.some(s => s.venueId === venue.id && s.timeSlotId === timeSlot.id && (isPlaceholderCoach(s.coachName) || isPlaceholderCoach(s.coachName2))) ? "bg-red-200 border-red-600 text-red-950 hover:bg-red-300" : "border-border hover:bg-accent/50"}`}
                    data-testid={`cell-${venue.name}-${timeSlot.period}`}
                  >
                    <input
                      type="text"
                      className="w-full h-full bg-transparent text-xs placeholder-muted-foreground border-none outline-none resize-none"
                      placeholder="班級+教練"
                      value={value}
                      onFocus={() => setActiveCell({ venueId: venue.id, timeSlotId: timeSlot.id })}
                      onBlur={() => setActiveCell(null)}
                      onChange={(e) => handleCellChange(venue.id, timeSlot.id, e.target.value)}
                      data-testid={`input-${venue.name}-${timeSlot.period}`}
                    />
                    {isActive && (
                      <CoachAutocomplete
                        onSelect={(coachName: string) => {
                          const currentValue = value;
                          const parts = currentValue.split(' ');
                          const className = parts.slice(0, -1).join(' ') || parts[0] || '';
                          const newValue = className ? `${className} ${coachName}` : coachName;
                          handleCellChange(venue.id, timeSlot.id, newValue);
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
  );
}
