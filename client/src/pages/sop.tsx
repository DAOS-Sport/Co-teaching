import { useState } from "react";
import AdminLayout from "@/components/admin-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface Section {
  id: string;
  title: string;
  icon: string;
  badge?: string;
  badgeColor?: string;
  steps: Step[];
}

interface Step {
  title: string;
  desc: string;
  sub?: string[];
  warn?: string;
  tip?: string;
}

const adminSections: Section[] = [
  {
    id: "schedule-phase1",
    title: "第一階段：建立課表 & 鎖定場次",
    icon: "fa-edit",
    badge: "第一階段",
    badgeColor: "bg-blue-100 text-blue-700",
    steps: [
      {
        title: "進入「學校課表編輯」",
        desc: "點選左側選單的「學校課表編輯」，選擇要編輯的場館及週次。",
      },
      {
        title: "填入課程名稱",
        desc: "在空白欄位點擊後輸入課程名稱（例如：新光103），按下確認或點擊其他格即可儲存。",
        sub: [
          "可同時在多個時段填寫",
          "課程名稱填完後系統會自動顯示該場次",
        ],
      },
      {
        title: "鎖定場次",
        desc: "確認當週場館課程名稱無誤後，點擊頁面上方「鎖定本週」按鈕。",
        warn: "鎖定後課程名稱欄位將無法再修改，僅能進行教練指派。若需重新編輯，請先解鎖。",
        sub: [
          "鎖定是以「場館 + 週次」為單位",
          "可個別鎖定不同場館的不同週次",
        ],
      },
      {
        title: "解鎖（如需修改）",
        desc: "若課程名稱需要更改，點擊「解鎖本週」後即可重新編輯，完成後再次鎖定。",
      },
    ],
  },
  {
    id: "schedule-phase2",
    title: "第二階段：指派教練",
    icon: "fa-user-plus",
    badge: "第二階段",
    badgeColor: "bg-purple-100 text-purple-700",
    steps: [
      {
        title: "進入「教練指派」",
        desc: "點選左側選單「教練指派」，選擇場館及週次。僅已鎖定的場次才能進行教練指派。",
      },
      {
        title: "查看可用教練",
        desc: "右側面板顯示該週已設定「可上課」的教練名單，並以顏色標示衝突狀態。",
        sub: [
          "綠色：無衝突，可指派",
          "黃色：偏好其他場館，仍可指派",
          "紅色：已有其他場次衝突，請避免",
        ],
      },
      {
        title: "手動指派",
        desc: "點擊課表格後，從下拉選單選擇教練姓名。可分別指派「主教練」與「協同教練2」。",
        tip: "使用「自動填入」功能可根據教練可用性一鍵分配，之後再手動調整不符合的部分。",
      },
      {
        title: "自動填入",
        desc: "點擊右上角「自動填入」按鈕，系統依照教練可用時段與場館偏好自動分配教練。",
        warn: "自動填入會覆蓋已手動指派的教練，建議在全部手動之前先執行一次自動，再微調。",
      },
      {
        title: "確認無衝突",
        desc: "頁面右下角「衝突提示」區塊若顯示衝突，代表同一教練在同時段被指派到兩個場館，需手動解決。",
      },
    ],
  },
  {
    id: "coach-approval",
    title: "教練審核與 LINE ID 管理",
    icon: "fa-user-check",
    steps: [
      {
        title: "進入「教練審核」頁面",
        desc: "新教練透過教練前台（LINE 登入）完成申請後，會出現在此頁面的「待審核」清單。",
      },
      {
        title: "審核教練申請",
        desc: "確認教練姓名、員工編號與 Ragic 系統資料一致後，點擊「核准」完成審核。若資料有誤可點「拒絕」。",
        sub: [
          "核准後教練可正常登入教練前台",
          "拒絕後教練需重新申請",
        ],
      },
      {
        title: "LINE ID 綁定",
        desc: "Ragic 每日 03:00 自動同步教練 LINE ID。若需手動修正，可在審核頁面直接輸入並儲存教練的 LINE User ID。",
        tip: "LINE User ID 格式為 U 開頭的 33 字元字串，可從 LINE 開發者後台或教練前台登入紀錄取得。",
      },
      {
        title: "Ragic 手動同步",
        desc: "若需立即更新教練資料（不等每日排程），可點擊「立即同步 Ragic」按鈕觸發一次性同步。",
      },
    ],
  },
  {
    id: "coach-availability",
    title: "教練可用時段設定（教練操作）",
    icon: "fa-calendar-check",
    steps: [
      {
        title: "教練登入教練前台",
        desc: "教練透過 LINE 登入後進入教練前台，點選「可用時段」分頁。",
      },
      {
        title: "填寫平日可用矩陣",
        desc: "矩陣橫軸為星期一到星期五，縱軸為第一節到第七節。點擊格子切換「可上課 ✓」或「不可上課」。",
        sub: [
          "打勾代表該時段可以排課",
          "設定後管理員指派時即可看到此教練的可用狀態",
        ],
      },
      {
        title: "設定場館偏好",
        desc: "在「場館偏好」分頁，教練可勾選偏好的場館。系統自動填入時優先安排於偏好場館。",
      },
    ],
  },
  {
    id: "weekly-push",
    title: "週推播（LINE 課表通知）",
    icon: "fa-paper-plane",
    steps: [
      {
        title: "進入「週推播」頁面",
        desc: "每週可手動觸發一次推播，系統會將下週課表資訊發送給每位有 LINE ID 的教練。",
      },
      {
        title: "乾跑測試（建議先做）",
        desc: "勾選「乾跑模式（不實際發送）」後按「執行推播」，系統會跑完整流程但不送出 LINE 訊息，可檢查收件人名單與課表內容是否正確。",
        tip: "正式推播前務必先執行乾跑確認，避免發送錯誤資訊給教練。",
      },
      {
        title: "正式推播",
        desc: "確認乾跑結果無誤後，取消乾跑勾選，輸入要推播的「週起始日」（週一日期），按「執行推播」。",
        sub: [
          "系統會自動避免同一週重複推播（若已推播成功則擋住重複觸發）",
          "每位教練收到的訊息僅包含自己當週的課次",
        ],
      },
      {
        title: "查看推播結果",
        desc: "執行後可在頁面下方「推播紀錄」看到本次 Run 的狀態。點擊「詳情」可看到每位教練的發送狀態（成功／失敗／略過）。",
      },
      {
        title: "重試失敗發送",
        desc: "若部分教練發送失敗（網路錯誤或 LINE 暫時異常），可點擊「重試失敗者」重新對這些教練發送，不影響已成功的教練。",
        warn: "若失敗原因是「教練 LINE ID 無效」，重試也不會成功，需先修正 LINE ID 再重試。",
      },
      {
        title: "下載報表",
        desc: "每次推播完成後可下載 CSV 或 Excel 報表，內含每位教練的發送狀態、時間、錯誤訊息等完整記錄。",
        sub: [
          "報表保留 90 天，超過後自動清除",
          "Excel 格式（.xlsx）支援中文欄位標題，適合直接用 Excel 開啟",
        ],
      },
    ],
  },
  {
    id: "stats",
    title: "堂數統計",
    icon: "fa-chart-bar",
    steps: [
      {
        title: "進入「堂數統計」",
        desc: "選擇要統計的日期區間，系統會依場館、教練統計課堂數。",
      },
      {
        title: "主教練 vs 協同教練",
        desc: "統計分為「主教練堂數」與「協同教練2堂數」，可分開或合計檢視。",
        tip: "若某教練掛名協同但實際教課，請在指派時使用「協同教練2（實際授課）」欄位，統計才會正確反映。",
      },
      {
        title: "匯出資料",
        desc: "點擊「匯出 Excel」可下載完整統計表，方便製作薪資或績效報告。",
      },
    ],
  },
  {
    id: "venue-management",
    title: "場館管理",
    icon: "fa-building",
    steps: [
      {
        title: "新增場館",
        desc: "在「教練審核」或「場館管理」頁面可新增場館，填入場館名稱、顏色標籤與公開網址。",
      },
      {
        title: "設定公開課表網址",
        desc: "每個場館可設定一個「公開網址鍵值」，對應 /school/{鍵值} 的公開課表頁面，供學生或家長查看。",
      },
      {
        title: "影片連結",
        desc: "可為場館設定教學影片連結，顯示在公開課表頁供家長參考。",
      },
      {
        title: "刪除場館",
        desc: "刪除場館前請確認該場館無未來排定的課程，否則相關課程資料也會一併移除。",
        warn: "刪除操作無法復原，請謹慎操作。",
      },
    ],
  },
  {
    id: "ragic-sync",
    title: "Ragic 資料同步",
    icon: "fa-sync",
    steps: [
      {
        title: "自動同步時間",
        desc: "系統每日 03:00（台北時間）自動從 Ragic 拉取最新的教練名單、員工編號、LINE ID 等資料。",
      },
      {
        title: "同步範圍",
        desc: "同步內容包含：各部門教練姓名、員工編號、LINE User ID。",
        sub: [
          "已離職或不在 Ragic 清單的教練會被自動排除",
          "新加入的教練若尚未有 LINE ID，同步後仍需手動補填",
        ],
      },
      {
        title: "手動觸發同步",
        desc: "若需立即更新（不等每日排程），在「教練審核」頁面點擊「立即同步 Ragic」，同步結果會顯示在頁面上方。",
      },
    ],
  },
];

const employeeSections: Section[] = [
  {
    id: "emp-coach-portal",
    title: "教練前台（手機端）完整說明",
    icon: "fa-mobile-alt",
    badge: "教練適用",
    badgeColor: "bg-green-100 text-green-700",
    steps: [
      {
        title: "首次登入與申請帳號",
        desc: "開啟教練前台網址，點擊「使用 LINE 帳號登入」，完成 LINE 授權後填寫姓名與員工編號送出申請。",
        sub: [
          "申請後需等管理員審核，通過前功能有限制",
          "若超過 2 個工作天未審核，請聯繫管理員",
        ],
      },
      {
        title: "查看本週課表",
        desc: "登入後首頁「我的課表」卡片即顯示本週所有排課，以日期分組列出場館、時段與課程名稱。",
        tip: "點選課表旁的日曆圖示，可將課程一鍵加入 Google 日曆。",
      },
      {
        title: "切換週次",
        desc: "點擊課表標題列左右箭頭可查看上週或下週排課。",
      },
      {
        title: "填寫可用時段（重要）",
        desc: "滾動到「可用時段」區塊，在格子中點擊您可以上課的時段，格子變綠色代表已標記。管理員依此安排課次。",
        sub: [
          "橫軸為星期一到五，縱軸為第一到七節",
          "藍色格（🔒）= 已排課，不可修改",
          "修改後系統自動儲存，頁面上方會顯示「✓ 可用時段已填寫」",
        ],
        tip: "建議每月初更新一次，確保排課準確。",
      },
      {
        title: "設定場館偏好",
        desc: "可排課地點由管理端統一設定，教練不需自行選擇。",
      },
      {
        title: "查看今日同場館教練",
        desc: "「今日同場館教練」區塊顯示今天在同一場館的其他教練姓名與聯絡電話，方便現場協調。",
      },
      {
        title: "查看場館資訊",
        desc: "「場館資訊」列出各場館介紹、教學影片連結與 Google Maps 導航，點擊即可開啟。",
      },
    ],
  },
  {
    id: "emp-coach-view",
    title: "教練視圖（週課表總覽）",
    icon: "fa-user-clock",
    badge: "教練適用",
    badgeColor: "bg-green-100 text-green-700",
    steps: [
      {
        title: "進入教練視圖",
        desc: "從側邊欄點選「教練視圖」圖示，或直接前往 /coach。",
      },
      {
        title: "選擇教練",
        desc: "頁面上方下拉選單選擇教練姓名，下方格子即顯示該教練整週課次（以場館顏色區分）。",
        tip: "已登入者預設自動選取自己的名字。",
      },
      {
        title: "切換週次",
        desc: "標題列左右箭頭切換上一週或下一週。",
      },
      {
        title: "看懂課表色塊",
        desc: "每個色塊代表一個課次，顯示場館名稱、課程名稱、上課時間。不同場館底色不同。",
      },
    ],
  },
  {
    id: "emp-venue-schedule",
    title: "場館課表顯示",
    icon: "fa-building",
    badge: "教練適用",
    badgeColor: "bg-green-100 text-green-700",
    steps: [
      {
        title: "選擇場館",
        desc: "頁面左上角下拉選單選擇場館，課表立即更新為該場館的排課狀況。",
      },
      {
        title: "切換週次",
        desc: "標題列左右箭頭切換週次查看不同週課表。",
      },
      {
        title: "看懂格子",
        desc: "橫軸為每天日期，縱軸為節次時間。格子顯示課程名稱與負責教練（主教練/協同教練）。",
        sub: [
          "藍色字為主教練",
          "若有協同教練，以「-」連接顯示",
          "空白格 = 該時段無排課",
        ],
      },
    ],
  },
  {
    id: "troubleshooting",
    title: "常見問題排除",
    icon: "fa-tools",
    steps: [
      {
        title: "教練收不到 LINE 推播",
        desc: "請請管理員確認：",
        sub: [
          "教練是否有正確的 LINE User ID（U 開頭 33 碼）",
          "教練是否已封鎖 LINE 官方帳號（封鎖後無法發送）",
          "週推播報表中該教練的發送狀態與錯誤原因",
        ],
      },
      {
        title: "課表鎖定後無法編輯課程名稱",
        desc: "這是正常行為。第一階段鎖定後即進入第二階段（教練指派）。若需修改課程名稱，請先在「學校課表編輯」頁面解鎖該週。",
      },
      {
        title: "教練指派時看不到某教練",
        desc: "可能原因：",
        sub: [
          "教練尚未審核通過",
          "教練未設定該週的可用時段",
          "教練帳號在 Ragic 中已被標示為停用",
        ],
      },
      {
        title: "Ragic 同步後教練資料沒更新",
        desc: "確認 Ragic 上資料是否正確填寫，以及是否在可同步的部門清單內。確認後可手動觸發一次同步再確認。",
      },
      {
        title: "統計堂數與預期不符",
        desc: "請確認：",
        sub: [
          "課表指派欄位（主教練 vs 協同教練2）是否填在正確欄位",
          "統計日期區間是否涵蓋目標週次",
          "若教練有改名，新舊名稱可能各自累計",
        ],
      },
    ],
  },
];

function StepCard({ step, index }: { step: Step; index: number }) {
  return (
    <div className="flex gap-4">
      <div className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 text-primary text-sm font-bold flex items-center justify-center mt-0.5">
        {index + 1}
      </div>
      <div className="flex-1 pb-5">
        <p className="font-semibold text-foreground mb-1">{step.title}</p>
        <p className="text-sm text-muted-foreground leading-relaxed">{step.desc}</p>
        {step.sub && (
          <ul className="mt-2 space-y-1">
            {step.sub.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                <span className="text-primary mt-0.5">•</span>
                <span>{s}</span>
              </li>
            ))}
          </ul>
        )}
        {step.tip && (
          <div className="mt-2 flex items-start gap-2 rounded-md bg-green-50 border border-green-200 px-3 py-2">
            <i className="fas fa-lightbulb text-green-600 text-xs mt-0.5 flex-shrink-0"></i>
            <p className="text-xs text-green-700 leading-relaxed">{step.tip}</p>
          </div>
        )}
        {step.warn && (
          <div className="mt-2 flex items-start gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2">
            <i className="fas fa-exclamation-triangle text-amber-600 text-xs mt-0.5 flex-shrink-0"></i>
            <p className="text-xs text-amber-700 leading-relaxed">{step.warn}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function SectionCard({ section }: { section: Section }) {
  const [open, setOpen] = useState(true);
  return (
    <Card className="overflow-hidden">
      <CardHeader
        className="cursor-pointer select-none py-4 px-5 hover:bg-accent/50 transition-colors"
        onClick={() => setOpen(!open)}
      >
        <CardTitle className="flex items-center gap-3 text-base font-semibold">
          <span className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
            <i className={`fas ${section.icon} text-primary text-sm`}></i>
          </span>
          <span className="flex-1">{section.title}</span>
          {section.badge && (
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${section.badgeColor ?? "bg-gray-100 text-gray-600"}`}>
              {section.badge}
            </span>
          )}
          <i className={`fas ${open ? "fa-chevron-up" : "fa-chevron-down"} text-muted-foreground text-xs ml-1`}></i>
        </CardTitle>
      </CardHeader>
      {open && (
        <CardContent className="px-5 pt-3 pb-2">
          {section.steps.map((step, i) => (
            <StepCard key={i} step={step} index={i} />
          ))}
        </CardContent>
      )}
    </Card>
  );
}

export default function Sop() {
  return (
    <AdminLayout activeTab="sop">
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        {/* Page header */}
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <i className="fas fa-book-open text-primary"></i>
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">操作說明 SOP</h1>
            <p className="text-sm text-muted-foreground">五泳池課表整合系統 — 完整操作流程指南</p>
          </div>
        </div>

        {/* Quick nav */}
        <Card className="bg-blue-50/60 border-blue-200">
          <CardContent className="px-5 py-4">
            <p className="text-xs font-semibold text-blue-700 mb-2 uppercase tracking-wide flex items-center gap-1.5">
              <i className="fas fa-user-shield text-blue-500"></i> 管理員操作
            </p>
            <div className="flex flex-wrap gap-2 mb-3">
              {adminSections.map((s) => (
                <button
                  key={s.id}
                  className="text-xs px-3 py-1.5 rounded-full bg-white border border-blue-200 text-blue-700 hover:bg-blue-100 transition-colors"
                  onClick={() => document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                >
                  <i className={`fas ${s.icon} mr-1.5`}></i>
                  {s.title}
                </button>
              ))}
            </div>
            <p className="text-xs font-semibold text-green-700 mb-2 uppercase tracking-wide flex items-center gap-1.5">
              <i className="fas fa-user text-green-500"></i> 員工／教練操作
            </p>
            <div className="flex flex-wrap gap-2">
              {employeeSections.map((s) => (
                <button
                  key={s.id}
                  className="text-xs px-3 py-1.5 rounded-full bg-white border border-green-200 text-green-700 hover:bg-green-100 transition-colors"
                  onClick={() => document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                >
                  <i className={`fas ${s.icon} mr-1.5`}></i>
                  {s.title}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Admin sections */}
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-border" />
          <span className="flex items-center gap-2 text-xs font-semibold text-blue-700 px-3 py-1 bg-blue-50 border border-blue-200 rounded-full">
            <i className="fas fa-user-shield"></i>
            管理員操作說明
          </span>
          <div className="h-px flex-1 bg-border" />
        </div>
        {adminSections.map((s) => (
          <div key={s.id} id={s.id}>
            <SectionCard section={s} />
          </div>
        ))}

        {/* Employee sections */}
        <div className="flex items-center gap-3 pt-2">
          <div className="h-px flex-1 bg-border" />
          <span className="flex items-center gap-2 text-xs font-semibold text-green-700 px-3 py-1 bg-green-50 border border-green-200 rounded-full">
            <i className="fas fa-user"></i>
            員工／教練操作說明
          </span>
          <div className="h-px flex-1 bg-border" />
        </div>
        {employeeSections.map((s) => (
          <div key={s.id} id={s.id}>
            <SectionCard section={s} />
          </div>
        ))}

        <p className="text-center text-xs text-muted-foreground py-4">
          如有其他問題請聯繫系統管理員
        </p>
      </div>
    </AdminLayout>
  );
}
