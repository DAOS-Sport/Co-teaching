import type { TimeSlotDto } from "@shared/contracts";
import { displayField, fieldLabels, previewRows, type BatchPreview } from "@/lib/schedule-ui";

const statuses = { create: "新增", update: "更新", skip: "略過", error: "錯誤" };
const reasons: Record<string, string> = { duplicate_class: "同名課程已存在", occupied_cell: "目標格已有課程" };

export function BatchPlanPreview({ preview, timeSlots = [] }: { preview: BatchPreview; timeSlots?: TimeSlotDto[] }) {
  return <section className="space-y-3" aria-label="批次預覽" data-testid="batch-preview">
    <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-sm">
      {([['total', '總計'], ['create', '新增'], ['update', '更新'], ['skip', '略過'], ['error', '錯誤'], ['warning', '警告']] as const).map(([key, label]) =>
        <div key={key} className="rounded border p-2">{label}<br /><strong>{preview.summary[key]}</strong></div>)}
    </div>
    {(preview.parseErrors ?? []).length > 0 && <div role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-800">
      {preview.parseErrors!.map((error, index) => <div key={`${error.line}-${index}`}>第 {error.line} 行：{error.message}</div>)}
    </div>}
    <div className="max-h-[42vh] overflow-auto rounded border">
      <table className="w-full text-xs text-left">
        <thead className="sticky top-0 bg-muted"><tr><th className="p-2">行／日期</th><th className="p-2">節次／班別</th><th className="p-2">結果與原因</th><th className="p-2">修改前 → 修改後</th></tr></thead>
        <tbody>{previewRows(preview).map((row, index) => <tr key={`${row.sourceId ?? row.line ?? index}-${row.status}`} className="border-t align-top" data-testid="batch-preview-row" data-status={row.status}>
          <td className="p-2 whitespace-nowrap">{row.line !== undefined ? `第 ${row.line} 行` : ''}<div>{row.date}</div></td>
          <td className="p-2">{row.period ?? timeSlots.find((slot) => slot.id === row.timeSlotId)?.period ?? row.timeSlotId}<div>{row.className || '空白班別'}</div></td>
          <td className="p-2"><strong>{statuses[row.status]}</strong>{row.reason && <div>{reasons[row.reason] ?? row.reason}</div>}
            {(row.issues ?? []).map((issue, i) => <div key={i} className={issue.severity === 'error' ? 'text-red-700' : 'text-amber-800'}>{issue.severity === 'warning' ? '警告：' : '錯誤：'}{issue.message}</div>)}</td>
          <td className="p-2 min-w-[180px]">{(row.changes ?? []).map((change, i) => <div key={i}>{fieldLabels[change.field] ?? change.field}：{displayField(change.before)} → <strong>{displayField(change.after)}</strong></div>)}
            {!!row.clearedFields?.length && <div className="mt-1 text-amber-800">將清空：{row.clearedFields.map((field) => fieldLabels[field] ?? field).join('、')}</div>}
            {!row.changes?.length && !row.clearedFields?.length && <span className="text-muted-foreground">沒有欄位變更</span>}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}
