# 偕同課系統

管理場館、課表、教練可排時間、課程指派及通知。前端使用 React，後端使用 Express 與 TypeScript，資料庫使用 PostgreSQL／Drizzle。

## 程式導覽

| 目錄 | 責任 |
| --- | --- |
| `client/` | 管理端、教練端與教師端畫面 |
| `server/core/` | 業務規則、Use Cases 與 Ports。不得依賴外部套件、資料庫或執行環境 |
| `server/adapters/` | Repository 轉接、服務轉接及輸出格式 |
| `server/infrastructure/` | 課表與週通知的依賴組裝、交易實作 |
| `server/infra/` | 既有佇列、驗證、檔案儲存及平台整合 |
| `server/modules/` | 功能路由、背景處理與尚待逐步分層的既有模組 |
| `shared/contracts/` | 前後端共用 DTO；資料表定義另放 `shared/schema.ts` |
| `migrations/manual/` | 需經批准後明確執行的資料庫異動 |
| `tools/`、`scripts/` | 邊界檢查、維運及驗收工具 |
| `docs/` | 架構、規格、開發指引與歷史文件 |

本系統是 **Feature-based Modular Monolith**，逐步採用 Clean Architecture。`server/modules/_registry.ts` 是路由組裝入口；它不是外掛系統。新業務邏輯先定義 Use Case 與 Port，再由外層連接既有儲存及平台能力。

週通知的路徑為：

```text
HTTP／Worker／Wake → weeklyPush.service 相容入口
                       ↓
               infrastructure/weekly-push/composition
                       ↓
                 core/weekly-push Use Cases
                       ↓ Ports
          adapters → 既有儲存／交易／pg-boss
```

組裝入口負責提供依賴；核心不反向匯入組裝入口或 Adapter。詳見[週通知分層說明](docs/architecture/weekly-push.md)。

## 開發與檢查

沿用專案 Node 20 與 lockfile。於隔離開發環境安裝依賴後執行：

```sh
npm ci
npm run check
npm run check:architecture
npm run check:client-contracts
npm test
npm run build
```

`npm test` 使用合成資料，不代替真 PostgreSQL 或正式環境驗收。`npm run test:pg` 需要明確指定隔離資料庫與 opt-in；不可接正式庫。執行開發服務前，先確認其資料庫與必要環境變數。

## 發布與資料保護

Replit 保留既有網址與 Autoscale。`npm run start:autoscale` 是目前的正式啟動入口；外部喚醒、佇列接手及啟用模式須依[切換規格](docs/specs/notification-external-wake-b05.md)與實際驗收收據判斷。程式已發布不代表 B05 已切換完成。

啟動服務不得自動執行 schema 修補、資料回填或 migration。不要以 `npm run db:push` 作為發布步驟。資料庫異動與資料複製需要獨立批准；教師 identity migration 仍須依既有 HOLD 決定處理。

- [規格目錄](docs/README.md)
- [設計指引](docs/development/design-guidelines.md)
- [Agent 輔助資料](docs/development/assistant/README.md)

