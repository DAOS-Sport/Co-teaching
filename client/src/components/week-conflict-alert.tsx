import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { format, addDays } from "date-fns";

interface WeekConflictAlertProps {
  weekStart: Date;
}

export default function WeekConflictAlert({ weekStart }: WeekConflictAlertProps) {
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  
  const conflictQueries = weekDays.map(day => 
    useQuery<{ coachName: string; timeSlotId: string; venues: string[] }[]>({
      queryKey: ['/api/conflicts', format(day, 'yyyy-MM-dd')],
    })
  );

  const { data: timeSlots } = useQuery<{ id: string; period: string }[]>({
    queryKey: ['/api/time-slots'],
  });

  // Collect all conflicts from the week
  const allConflicts = conflictQueries.flatMap((query, dayIndex) => 
    (query.data || []).map(conflict => ({
      ...conflict,
      dayName: ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'][dayIndex],
      date: format(weekDays[dayIndex], 'M月d日')
    }))
  );

  if (allConflicts.length === 0) {
    return null;
  }

  const getTimePeriod = (timeSlotId: string) => {
    const timeSlot = timeSlots?.find(ts => ts.id === timeSlotId);
    return timeSlot?.period || '未知時段';
  };

  return (
    <Alert className="mb-6 bg-destructive/10 border-destructive/20" data-testid="alert-week-conflicts">
      <div className="flex items-start">
        <i className="fas fa-exclamation-triangle text-destructive mr-3 mt-1"></i>
        <div className="flex-1">
          <h3 className="text-sm font-medium text-destructive mb-2">本週發現衝突</h3>
          <AlertDescription>
            <ul className="text-sm text-destructive space-y-1">
              {allConflicts.map((conflict, index) => (
                <li 
                  key={index}
                  className="cursor-pointer hover:underline"
                  data-testid={`conflict-item-${index}`}
                >
                  • {conflict.date} {conflict.dayName} {getTimePeriod(conflict.timeSlotId)}：{conflict.coachName}同時出現在{conflict.venues.join('和')}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </div>
      </div>
    </Alert>
  );
}
