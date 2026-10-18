# 週通知分層

## 邊界

`server/core/weekly-push/` 只含 TypeScript。`entities.ts` 定義業務資料投影；`ports.ts` 定義儲存、名單、交易、佇列、時間、識別碼及訊息格式契約。核心不引用 Express、Drizzle、pg-boss、環境變數或資料表型別。

`use-cases.ts` 決定是否沿用既有批次、是否因歷史通知阻擋新送、建立通知身份及如何重試失敗者。`roster.ts` 決定收件名單，使用既有核心教練姓名規則。先建立姓名索引，再處理教練名單；同一課表兩欄同名只計一次。不同帳號具有同一排課姓名時，仍拒絕建立批次。

`server/infrastructure/weekly-push/composition.ts` 是依賴組裝入口，將既有 storage、交易、識別碼、時間及 Adapter 注入 Use Cases。`server/modules/weeklyPush/weeklyPush.service.ts` 保留舊呼叫名稱，讓 HTTP、Worker 與 Wake 沿原入口執行。

## 交易與通知身份

Repository Adapter 沿用既有 `createRunBundle`：批次、收件者與 orchestrator job 必須同一交易提交。Use Case 不拆成三次獨立寫入。併發建立時沿用勝出的批次，不另發新工作。

重試失敗者仍使用原批次、原收件者及原 LINE retry key。重置失敗狀態與排入 recipient job 位於同一交易。此重構不改重試次數、訊息文字、去重鍵、dry-run、舊通知保護、預設週次或截止期限政策。

## 驗證與限制

`server/weekly-push-use-cases.test.ts` 直接執行核心反例；`server/notification-cutover-parity.test.ts` 從相容 Service 經真實組裝／Use Case／Adapter 載入，僅替換最外層 I/O。原切換測試及隔離 PostgreSQL 測試保留。`npm run check:architecture` 從 AST 檢查核心全部依賴與執行環境存取。

這是週通知的增量重構。其他功能仍有既有分層，不能據此宣稱全系統已達 Clean Architecture。索引減少重複掃描，實際線上延遲、容量及成本差異尚待量測。B05 自動喚醒與正式 active 驗收另行判定。
