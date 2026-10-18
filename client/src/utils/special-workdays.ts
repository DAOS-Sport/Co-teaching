import { format, addDays, isSameDay } from 'date-fns';

// 定義特殊工作日期（補班日）
export const SPECIAL_WORKDAYS = [
  { date: '2025-09-20', name: '週六補班' }, // 9/20週六補班
];

// 檢查指定日期是否為特殊工作日
export const isSpecialWorkday = (date: Date): boolean => {
  const dateStr = format(date, 'yyyy-MM-dd');
  return SPECIAL_WORKDAYS.some(special => special.date === dateStr);
};

// 獲取特殊工作日的顯示名稱
export const getSpecialWorkdayName = (date: Date): string | null => {
  const dateStr = format(date, 'yyyy-MM-dd');
  const special = SPECIAL_WORKDAYS.find(special => special.date === dateStr);
  return special?.name || null;
};

// 生成擴展的工作日陣列（包含特殊工作日）
export const getExtendedWeekDays = (weekStart: Date): Date[] => {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
};

// 生成擴展的週期名稱
export const getExtendedWeekdayNames = (weekStart: Date): string[] => {
  return ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
};

// 計算擴展的週期結束日期
export const getExtendedWeekEnd = (weekStart: Date): Date => {
  return addDays(weekStart, 6);
};
