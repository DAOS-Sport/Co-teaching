# Issue 12｜Clean Architecture 第一批：共用排課寫入政策

TASK CT-CLEAN-ARCH-20261017／OWNER Codex root／SPEC CA2-A1／2026-10-17。

工單：https://github.com/DAOS-Sport/Co-teaching/issues/12 。先讀完工單後才制定本批；本單為分批總工單，不把一批完成當總工單完成。

## 目標、來源與授權

Replit為唯一來源。已核Replit release HEAD c8301a640cf4613cb8af68988fba8a75b81fe85b、clean；tree0d15d00654b4b8831a532faffed50f4ddb5d15f1與GitHub先前5bc05b6相同。完整467commit／3203object歷史已詞法掃描，舊公開候選與202個binary語意缺口保留；新同步沒有新blob，commit身份亦已在公開history。GitHub release已FF對齊c830，main未變。新隔離分支refactor/clean-architecture-20261017從c830工作，旁邊舊dirty clone不動。

使用者直接要求實作、code review與優化；工單正文只是契約來源，不單憑它推定DB／正式部署授權。保留client/server外框，服務端採server/core、server/adapters、server/infrastructure；以AssignCoach／UpdateSchedule先落地，不為對齊示意一口氣搬全站。早期Rust核心提議不覆蓋本次純TypeScript核心明確要求。沒有新增計薪／Booking／角色或人員ID遷移。

CodeRabbit安裝已獲使用者指示，但官方install.ps1下載檢查遭平台policy拒絕（blocked by policy）；不改入口繞過，CodeRabbit安裝／審查NOT_RUN。人工審查及獨立工程可繼續；沒有程式或diff外送CodeRabbit。spec-driven-development方法採先SPEC→具體工單→驗證；不把其示意human gate當新增逐步批准，現有授權內自主完成。

## Baseline Review

1. MCP update_schedule未要求／傳expectedVersion，寫後才回警告；HTTP有428／409及寫前確認。這是當前source可重現的入口不一致，本批修正。
2. 目前confirmWarnings只攜帶代碼；舊確認可覆蓋新衝突。本批讓確認綁定當次變更、目前row version及影響警告的資料狀態。
3. route檢查與實際寫入之間沒有跨課程同教練序列化；本批新增交易內確定順序鎖並重讀，測 migrated HTTP/MCP update/assign併發，不外推所有批次／其他舊入口已統一。
4. .replit postMerge會npm install＋db:push。為避免未來pull偷偷改DB，本批將此hook改為無DDL／無app啟動的明示檢查／提示；實際部署不執行，這是刻意且獨立記錄的營運安全變更。

## 分層與本批檔案責任

- server/core/scheduling/entities.ts：schedule mutation所需純資料型別、patch、warnings與業務錯誤；不使用Drizzle/Zod infer。
- server/core/scheduling/policies.ts：純排課規則；沿用目前sameCoach／promotion／跨場館與可排時段語意，不自行合併匯入的不同規則。
- server/core/scheduling/ports.ts：針對用例所需Repository、UnitOfWork、Locks、Audit、Confirmation介面；不新增Generic Repository或每張表Entity。
- server/core/scheduling/use-cases.ts：createScheduleUseCases，提供updateSchedule／assignCoach；取得版本、鎖、重讀、政策／警告確認、寫入與audit由同一交易涵蓋。
- server/adapters/repositories/schedule-mutation.repository.ts：將既有storage能力對應窄Repository Port，保留CAS與現有資料欄位；不將IStorage整包搬入core。
- server/adapters/services/schedule-confirmation.ts：以外層注入的秘密／clock實作signed confirmation；不讀env，token不進log。
- server/adapters/presenters/schedule-error.ts：業務錯誤對HTTP／MCP輸出映射。
- server/infrastructure/scheduling/composition.ts：建立依賴並注入；使用既有inTransaction／txDb／audit，不新增DI container。
- server/modules/schedule.routes.ts與server/mcp/schedulingTools.ts：保留入口與現有transport驗證／認證，改呼叫共用用例；這些舊路徑是本批尚未全面搬移的技術入口，不能假稱全server已Clean。
- client/src/lib/queryClient.ts：既有409確認流程帶回server提供的confirmationToken；重新出現不同狀態的警告不得自動接受。
- shared/schema.ts及migrations/**逐byte保持；前端DB Contract分離、其他批次Use Cases、通知與畫面改善屬#12後續B/C，不在本批冒稱完成。

## 核心契約與不可改行為

UseCase Input包括scheduleId、expectedVersion、mutation patch、confirmWarnings與confirmationToken，audit context由入口認證後傳入。核心錯誤code與payload純資料；HTTP維持VERSION_REQUIRED→428、VERSION_CONFLICT→409、SCHEDULE_LOCKED／CONFIRM_REQUIRED→409、DUPLICATE_COACH→400、缺row→404；MCP回相同業務code，仍維持MCP自身error envelope。

鎖定後仍可指派教練及既有教學旗標；修改鎖定班名必拒絕。MCP不能以forceLocked跳過共同政策。對鎖定後人數是否可改等UNKNOWN不創造新規則，保持既有入口的patch準備語意並標待後續統一。

交易先鎖schedule id再重讀目前row；針對old/new date/timeSlot/實際教練canonical name的鎖以固定排序取得，然後載入警告依賴並驗證／寫入。row CAS仍由既有repository expectedVersion做最後防線；audit在相同ALS交易中，不能由UseCase外的事後catch吞掉。

confirmationToken由adapter簽章當次row version、canonical mutation及目前警告資料狀態，確認只在相同context有效，並有到期；核心只透過Port issue／verify，不import crypto或env。已確認代碼不帶有效token時仍回當前警告及新token，沒有寫入。警告來自同交易重讀，不以舊UI自稱preconfirmed放行新衝突。

D-A1-01：date／venueId／timeSlotId任一變更代表既有教練移到新位置，須重新查目標時段警告。core gate涵蓋整個core目錄；Node測試放core外，production間接引入test本身仍必須拒絕。本批測試使用明確setSchedulingLocksForTest注入，不按環境／假DSN自動跳過真鎖；真PG測試必須使用預設鎖與真的DB層失敗。

HTTP與MCP成功回應既有欄位保留；新增expectedVersion要求為工單明確bug修正，MCP find_schedules必須提供可用version。輸入格式／日期／場館／教練解析仍transport adapter責任。

## 驗收

- A1-01 鎖定Replit→GitHub來源與dirty，原碼、schema、migrations與排程基準hash保存。
- A1-02 修前反例：MCP無version／stale version可寫；只帶舊warning code可放行新狀態。修後兩入口缺version／stale均零業務寫入、相同code。
- A1-03 core在沒有Express／DB／外部SDK時可測；AST依賴gate沿re-export／dynamic import／require查，不允許外層、node builtin、環境設定或外部套件穿入core；gate自身有拒絕fixture。
- A1-04 保留鎖定可指派、slot promotion、duplicate coach、跨場館及可排時段確認；新資料使舊token失效，無確認不能寫。兩不同課程同教練並行時後來者須看到新狀態並要求確認。
- A1-05 真隔離PostgreSQL驗write＋audit DB層失敗一起rollback、版本競爭及跨列鎖策略；原子性不可只用JS mock宣稱。若環境無能力明示BLOCKED，不上線。
- A1-06 同基底與改後check／既有test／build；本批新增單元及adapter整合；schema/migration檔案hash不變，job註冊不變（hook安全變更另列）。沒有實際LINE、Ragic或正式DB寫入。
- A1-07 範圍diff秘密／個資scan＋完整相關history核對，獨立review；可審的GitHub branch／draft PR，#12保持OPEN。CodeRabbit若仍受安裝拒絕則NOT_RUN，不用人工結果替代。
- A1-08 GitHub後核Replit的branch／HEAD／dirty／未追蹤碰撞／FF／postMerge／入口／套件相容；只模擬merge／build與安全隔離，不直接pull／Run／Publish。使用者另核實機入口前不得叫部署完成。

## 命令、停止與回復

沿用Node20 hosted、Windows本機bundled Node24.19.0；npm ci --ignore-scripts --no-audit --no-fund只安裝lock既有依賴。檢查npm run check、npm test、npm run build；新core／architecture／整合測試另明列，不能藏在未執行的test檔。baseline與candidate原始輸出分開保存。

不改產品DB、DSN、schema/migrations、真通知、worker gate、Replit設定、既有dirty候選；不force／reset／改公開性／merge／Publish，不啟用付費CodeRabbit overage。政策拒絕停受影響分支，同方法3次無新證據停路徑。任何core／資料完整性／必要真PG gate未過，不合併／部署或關閉#12。

本批為獨立commit／PR可回復；程式revert不代表資料庫還原（本批不改schema）。GitHub aligned release保持原c830，架構只在feature分支。備份、snapshot、mock、編譯、PR、部署及正式驗收各自記錄。

D-A1-02：真正架構gate曾拒絕core目錄中的Node測試依賴，保留FAIL，搬到server/core-scheduling.test.ts，只調相對imports，不放寬gate。
D-A1-03：獨立review重現assign-coach的count guard早於version、outer missing-row未回業務code；同一pure requireScheduleVersion在transport準備前與core鎖後重讀時執行，保留version優先與missing code。警告已消失的舊token仍需fresh確認，Presenter保留可理解的訊息。

D-A1-04：review用純反例證明初版rollback測試可被寫前500誤通過；補同交易pending patch/version與兩次DB 23502，舊反例已被新assertions拒絕。跨課程改混合HTTP/MCP並由第三連線持真coach lock，觀察兩個pg_locks waiters後釋放；不以Promise.all自行推論真的交疊。原弱證據與工具錯誤保留在本機收據。

### 重現測試

`npm run check:architecture`、`npm run check`、`npm test`、`npm run build`。核心單元位於server/core-scheduling.test.ts，簽章測試在adapter旁，core目錄本身不含Node測試依賴。

真PG另用`npm run test:pg`：只供全新、可丟棄的localhost資料庫，需`CT_THROWAWAY_PG=1`與`AUDIT_PG_URL`，URL host必須127.0.0.1、具明確port、dbname以ct_a1_開頭。先將相同schema建立在此隔離DB；測試會truncate合成資料，禁止指向任何應用DB。兩檔序列執行避免互相truncate。此測試使用node-postgres，不代替正式Neon transport驗收。
