// Deterministic hints only. No external AI request and no invented root cause.
export function operationalDiagnosis(code:string):string {
  if(code==='METADATA_READONLY_REQUIRED')return '監控連線未確認為唯讀，已停止查詢；請檢查監控連線設定。';
  if(code.includes('MIGRATION_REQUIRED'))return '紀錄資料表尚未安裝；請由管理人員確認部署與資料庫版本。';
  if(code.includes('TIMEOUT')||code==='timeout')return '外部服務或回應內容超過時間界限；請用追蹤編號確認服務連線與回應時間。';
  if(code.includes('AMBIGUOUS'))return '人員名稱不唯一；需要已確認的固定識別對照。';
  if(code.includes('CONFLICT'))return '資料已被其他操作更新或鎖定；重新載入後確認內容。';
  if(code==='RAGIC_SYNC_FAILED'||code==='RAGIC_SYNC_PARTIAL_FAILED')return '同步未完整成功；請查看每筆同步結果，不能視為全員完成。';
  if(code==='INTERNAL_ERROR')return '已捕捉伺服器錯誤；此代碼不足以判定主因，需比對追蹤編號及部署時間。';
  return '目前資訊不足以判定主因；請保留追蹤編號、發生時間與操作情境。';
}
