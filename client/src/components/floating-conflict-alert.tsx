import { useState, useEffect } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { format, addDays } from "date-fns";
import { AlertTriangle, Minimize2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

interface FloatingConflictAlertProps {
  weekStart: Date;
}

const COLLAPSED_KEY = "conflict_alert_collapsed";
const POSITION_KEY = "conflict_alert_position";

export default function FloatingConflictAlert({ weekStart }: FloatingConflictAlertProps) {
  const [isCollapsed, setIsCollapsed] = useState(() => {
    const saved = localStorage.getItem(COLLAPSED_KEY);
    return saved === "true";
  });
  
  const [position, setPosition] = useState(() => {
    const saved = localStorage.getItem(POSITION_KEY);
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        return { x: 0, y: 0 };
      }
    }
    return { x: 0, y: 0 };
  });
  
  // Ensure weekStart is a valid Date object
  if (!weekStart || !(weekStart instanceof Date) || isNaN(weekStart.getTime())) {
    return null;
  }
  
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  
  const conflictQueries = useQueries({
    queries: weekDays.map(day => ({
      queryKey: [`/api/conflicts/${format(day, 'yyyy-MM-dd')}`],
    })),
  });

  const { data: timeSlots } = useQuery<{ id: string; period: string }[]>({
    queryKey: ['/api/time-slots'],
  });

  const allConflicts = conflictQueries.flatMap((query, dayIndex) => 
    ((query.data as { coachName: string; timeSlotId: string; venues: string[] }[]) || []).map(conflict => ({
      ...conflict,
      dayName: ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'][dayIndex],
      date: format(weekDays[dayIndex], 'M月d日')
    }))
  );

  const getTimePeriod = (timeSlotId: string) => {
    const timeSlot = timeSlots?.find(ts => ts.id === timeSlotId);
    return timeSlot?.period || '未知時段';
  };

  const handleToggleCollapse = () => {
    const newCollapsed = !isCollapsed;
    setIsCollapsed(newCollapsed);
    localStorage.setItem(COLLAPSED_KEY, String(newCollapsed));
  };

  const handleDragEnd = (_event: any, info: any) => {
    const newPosition = { x: info.point.x, y: info.point.y };
    setPosition(newPosition);
    localStorage.setItem(POSITION_KEY, JSON.stringify(newPosition));
  };

  if (allConflicts.length === 0) {
    return null;
  }

  return (
    <AnimatePresence mode="wait">
      {isCollapsed ? (
        <motion.button
          key="collapsed"
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0, opacity: 0 }}
          transition={{ type: "spring", stiffness: 260, damping: 20 }}
          drag
          dragMomentum={false}
          dragElastic={0}
          onDragEnd={handleDragEnd}
          onClick={handleToggleCollapse}
          className="fixed bottom-6 right-6 w-16 h-16 bg-destructive rounded-full shadow-2xl flex items-center justify-center cursor-pointer hover:scale-110 transition-transform z-[9999]"
          style={{ 
            x: position.x, 
            y: position.y,
            touchAction: 'none'
          }}
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.95 }}
          data-testid="floating-conflict-dot"
          aria-label="展開衝突通知"
        >
          <AlertTriangle className="w-8 h-8 text-white" strokeWidth={2.5} />
        </motion.button>
      ) : (
        <motion.div
          key="expanded"
          initial={{ scale: 0.3, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.3, opacity: 0 }}
          transition={{ type: "spring", stiffness: 260, damping: 20 }}
          role="dialog"
          aria-live="polite"
          aria-label="本週臨時異動通知"
          className="fixed w-[400px] max-w-[calc(100vw-3rem)] bg-white dark:bg-card rounded-xl shadow-2xl border-2 border-destructive z-[9999] p-5"
          style={{
            bottom: position.y === 0 ? '24px' : 'auto',
            right: position.x === 0 ? '24px' : 'auto',
            left: position.x !== 0 ? `${position.x}px` : 'auto',
            top: position.y !== 0 ? `${position.y}px` : 'auto',
            transformOrigin: 'bottom right'
          }}
          data-testid="floating-conflict-alert"
        >
          <button
            onClick={handleToggleCollapse}
            className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-lg hover:bg-muted transition-colors z-10"
            aria-label="收縮通知"
            data-testid="button-minimize-notification"
          >
            <Minimize2 className="w-5 h-5 text-muted-foreground" />
          </button>

          <div 
            className="space-y-3 cursor-pointer select-none hover:bg-muted/30 rounded-lg p-2 -m-2 transition-colors"
            onClick={handleToggleCollapse}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleToggleCollapse();
              }
            }}
            aria-label="點擊收縮通知"
          >
            <div className="flex items-center">
              <div className="w-2 h-2 rounded-full bg-destructive mr-2" aria-hidden="true"></div>
              <h3 className="text-base font-medium text-foreground">本週臨時異動</h3>
            </div>

            <div className="pr-8">
              <ul className="text-sm text-destructive space-y-2">
                {allConflicts.map((conflict, index) => (
                  <li 
                    key={index}
                    className="leading-relaxed"
                    data-testid={`floating-conflict-item-${index}`}
                  >
                    • {conflict.date} {conflict.dayName} {getTimePeriod(conflict.timeSlotId)}：
                    <span className="font-medium">{conflict.coachName}</span>
                    同時出現在{conflict.venues.join('和')}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
