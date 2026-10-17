# Issue #12 完整續作契約 CA3

2026-10-17。來源：[Issue #12](https://github.com/DAOS-Sport/Co-teaching/issues/12)。基準：Replit `c8301a6`，首批核心 `a88a767`。本頁延伸 A1，保留 client/server 外框，逐責任抽出純 TypeScript 核心。研究／原始反例／逐次候選收據保留於本次交付證據目錄；本頁不將舊結果冒充新候選驗收。

## 使命、驗收與範圍

完成原工單 20 項（A7、B9、C4），另加 S0：預設網頁啟動不得修補、初始化或清理資料庫，不得啟動通知、Ragic 同步、排程或 session pruning。既有 schema、migrations、lockfile 與 `.replit` 保留。所有破壞性／故障測試只用新建隔離 PostgreSQL，正常使用者資料不可當 fixture。

| AC | 可驗證結果與入口 |
| --- | --- |
| S0 | 真 `server/index.ts`、唯讀 PG role、舊 feature flags 全開仍能監聽；零 SQL 寫入意圖，schema/rows/sequences 前後相同。OIDC discovery 與 Neon→pg driver bridge 的隔離邊界須明列。 |
| A01 | 每個 direct/indirect writer 與 caller、資料庫範圍、版本／鎖／audit／通知契約有矩陣。獨立 school legacy domain 不冒稱已遷移主核心。 |
| A02–05 | update/assign/create 共用政策與同交易 audit；428/409、鎖定班名、可指派教練、綁定警告確認及跨列競爭；HTTP 與真 MCP protocol 同語意。 |
| A06 | 舊示範 importer route 410、函式拒絕；歷史 Git 可回查，不再執行硬編碼 fixture。 |
| A07 | core 不依框架；真 PG audit 23502 時先觀察 pending mutation，再證明整筆回滾。 |
| B01–03 | 同一批次 planner、signed preview、交易內重查；缺欄保留／明示空值清空、完整差異；整批拒絕／回滾；以 live index expression 獨立核對 class identity；限制複製日期、重疊、鎖定與重送。 |
| B04 | client 使用明確 JSON DTO；AST 循 aliases、reexports、type imports、dynamic imports 及 package declarations 驗無 Drizzle/schema 依賴。 |
| B05–09 | 單一顯式 pg-boss scheduler、可按 scope 停用／回復；業務＋recipient＋job 同交易；固定 ID/body/to/retry key；實測 claim、重複觸發及 accepted-before-mark crash；LINE 409/header/24h/unknown 正確分流。 |
| C01–04 | 同三個合成任務真瀏覽器 baseline/candidate，記步驟／時間／錯誤；共用預覽，候選／原因／差異同區；URL/back/reload、失敗草稿與 loading/error/empty/conflict；儲存與通知收據分開。 |

## 分層與寫入協定

- `server/core/scheduling`：entities、ports、政策、update/assign/create use cases、批次 planner。`server/core/notifications`：投遞狀態與重試政策，均無外部 import。
- `server/adapters`：storage repository、batch snapshot/commit、HMAC、API error presenter。既有 repository facade 委派給這些實作。
- `server/infrastructure/scheduling`：composition、transaction advisory locks。`server/infra/queue`：既有 pg-boss driver、同交易 SQL adapter、顯式 worker/schedule lifecycle。
- `shared/contracts`：JSON DTO、純 Zod validation；不以 Drizzle infer/reexport 偽裝分離。

排課 writer 先取同一 transaction advisory mutex `schedule-writes`，再取既有課程／教練細鎖、讀狀態、CAS、寫 audit。venue 級刪課與 coach availability／核准名單異動也取此鎖。這會序列化排課寫入，未宣稱吞吐量提升。同一 transaction client 的 context 查詢按順序 await，避免 pg 的並行 query 棄用警告。

school accessor 使用單一 `school_<code>` search_path，缺 schema／表直接失敗，不回退 `public`、不自動 DDL/seed。legacy school CRUD 的教師資料、schema 版本與既有正式資料相容性需獨立核對，不能從主排課測試推定。對既有 school schema 不執行補欄或資料遷移。

## 批次確認契約

匯入 `POST /api/admin/schedules/import/preview`、複製 `POST /api/schedules/copy-week` 的 `preview:true` 取得 5 分鐘 HMAC token。commit 必須帶 `confirmationToken`；綁定完整 input 與 relevant snapshot，狀態變更回 409 `PREVIEW_CHANGED` 和新 preview。缺 token 回 `PREVIEW_REQUIRED`。前端保留輸入，禁止自動重新提交。

import rows 包含 create/update/skip/error、issues、changes、clearedFields。未提供欄位保留；提供空白明示清空。MCP 保存每列 providedFields，避免 JSON 缺欄被 TSV 補空誤清。class identity 重用既有唯一 index SQL，不能以 JavaScript 去空白規則猜測 PostgreSQL 正規式／collation；不更改既有 index。

copy 來源範圍最多 7 天、日期嚴格有效、不可與目標週重疊。occupied/duplicate 列進 `skippedRows`，可插入列在 `rows`；兩者共用畫面預覽。目標日期鎖定阻擋整批。保留不複製教練及備註的既有政策並明示清空內容；重送舊 token 不新增資料或 audit。

## 通知與歷史不確定性

使用既有 run/recipient 表與 pg-boss 10.4.2 `SendOptions.db`，不新增 outbox 或應用 schema。第一次外發前保存固定 recipient、payload、UUID retry key、首次嘗試時間。業務 mutation 與 job 插入共用同一 transaction；queue 不存在則全部回滾。

accepted 只代表 LINE 平台受理，沒有送達證據。409 需 accepted-request header；timeout/5xx 為接受結果 unknown，可在原 key 的 24 小時及嘗試上限內重試，之後保持 unknown，不換 key 猜送。claim lease 與 fencing 阻止舊 worker 覆寫新結果。

一般通知的 destination 以固定 notification identity 分區，符合既有 run 唯一索引；同日不同通知各自建立 run/job，不以共用 destination 互相阻擋。

daily 依目標日期＋既有帳號 ID 固定 identity；恢復時沿用首 payload/key，不以新課表內容更換重試身份。舊 daily log 可能在外發前建立：存在 log 卻無 durable record 時，標 `unknown/legacy_untracked` 並交人工核對。姓名多重匹配不得任選第一人，不自動合併人員。摘要依穩定結果版本區分新業務通知，同一結果的重試仍沿用首 payload/key。

週推播主 job、recipient-only 重試與 reconcile 共用 finalization；report／summary 出錯不能假裝完成，已 accepted 的 recipient 不重送。daily legacy log 只在 accepted 後寫入；沒有 durable record 的舊 log 保持 unknown。Healthchecks 週監控只由 weekly 任務回報，一般通知不能替週推播報成功。清理與停止 worker 失敗必須向上回報，不能假稱已清理／停止。

正式環境的歷史狀態、Neon transport、LINE 真受理／送達與既有 schema 尚未由本文件推定通過。

## 維護、切換與回復

`npm start` 僅啟網頁。啟動不再呼叫資料修補、初始化、日誌／報表清理、Ragic 或通知 cron。S0 相容維護 wrapper 需顯式 `{mode:"maintenance"}`；這只是 API context，不能取代操作者授權。獨立通知 runtime 的顯式 API 不要求此 context，仍須符合操作者的維護授權。

`startNotificationRuntime()` 顯式啟動 worker，預設不設定排程；`configureNotificationSchedules({enabled:true})` 才建立排程，回傳包含 `previous` 與 `kinds` 的 scope receipt，供 `restoreNotificationSchedules(receipt)` 回復相同範圍。單週排程回復不可移除 daily/reconcile/cleanup。此 lifecycle 應有同時啟動、全範圍及部分範圍的真 PG 驗收。

worker 使用 `migrate:false` 不代表維護零寫入：queue registration、partition、schedule、job、report cleanup 均會改 DB。正式啟用須另核 schema 版本、權限、舊 cron 轉換與監控，取得相應批准；本次沒有啟用或送件。既有 same-process readiness 未就緒時，wet-run endpoint 拒絕，不能以網頁 listening 當通知 ready。

切換前保留既有排程快照、先在隔離環境驗證 disable/configure/restore，再由已批准的維護入口啟用。不要同時保留 legacy node-cron 與 pg-boss 通知 trigger。預設網頁更新與正式通知切換是兩個獨立驗收，不能悄悄停掉舊流程後宣稱完成。

## 驗證命令與證據界線

`npm run check`、`npm test`、`npm run check:architecture`、`npm run check:client-contracts`、`npm run build`。`npm run test:pg` 只接受明確 opt-in、127.0.0.1 非 5432 的新建 `ct_ca3_*` DB（舊 A1 專案測試保留 ct_a1_* 相容 gate）。不得使用現有 application URL 或以 skip 當驗收。

PG 測試包含真正 SQL 約束回滾、第三連線 block 兩個 writer、批次狀態改變、live index oracle、school public fallback 正／反對照、MCP Streamable HTTP、job 同交易、crash 恢復及 schedule lifecycle。瀏覽器使用同一合成任務並保存 screenshot、HTTP receipt 與 source hashes；操作 wall time 包含工具／分析停頓，不作正式效能百分比比較。

Git commit、push、PR review、merge、Replit pull、Run、Publish 與正式資料庫驗收分開記錄。沒有部署收據就不稱已上線。CodeRabbit 安裝遭政策拒絕後不換入口繞過；人工獨立 review 與 CodeRabbit 結果分開。
