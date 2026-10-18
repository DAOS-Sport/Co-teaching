import { Link, useLocation } from "wouter";

export type ActiveTab =
  | "coach-view"
  | "venue-schedule"
  | "class-edit"
  | "assign"
  | "stats"
  | "approval"
  | "weekly-push"
  | "sop"
  | "it-governance"
  | "coach-portal";

interface NavItem {
  key: ActiveTab;
  label: string;
  icon: string;
  path: string;
  isGreen?: boolean;
}

const navItems: NavItem[] = [
  { key: "coach-view",      label: "教練視圖", icon: "fa-user-clock",   path: "/coach" },
  { key: "venue-schedule",  label: "場館課表", icon: "fa-building",     path: "/venue-schedule" },
  { key: "class-edit",      label: "課表編輯", icon: "fa-edit",         path: "/mgt-x9k7p2/class-edit" },
  { key: "assign",          label: "教練指派", icon: "fa-user-plus",    path: "/mgt-x9k7p2/assign" },
  { key: "stats",           label: "堂數統計", icon: "fa-chart-bar",    path: "/mgt-x9k7p2/stats" },
  { key: "approval",        label: "教練審核", icon: "fa-user-check",   path: "/mgt-x9k7p2/approval" },
  { key: "weekly-push",     label: "週推播",   icon: "fa-paper-plane",  path: "/mgt-x9k7p2/weekly-push" },
  { key: "sop",             label: "SOP說明",  icon: "fa-book-open",    path: "/mgt-x9k7p2/sop" },
  { key: "it-governance",   label: "IT治理",   icon: "fa-shield-halved", path: "/mgt-x9k7p2/it-governance" },
  { key: "coach-portal",    label: "教練前台", icon: "fa-door-open",    path: "/coach-portal", isGreen: true },
];

interface AdminLayoutProps {
  activeTab: ActiveTab;
  headerCenter?: React.ReactNode;
  headerRight?: React.ReactNode;
  rightPanel?: React.ReactNode;
  children: React.ReactNode;
}

export default function AdminLayout({
  activeTab,
  headerCenter,
  headerRight,
  rightPanel,
  children,
}: AdminLayoutProps) {
  const [location] = useLocation();

  return (
    <div className="flex flex-col h-screen bg-background overflow-hidden">

      {/* ── Row 1: Logo bar ── */}
      <header className="h-12 bg-card border-b border-border shadow-sm flex items-center px-3 gap-2 flex-shrink-0">
        <i className="fas fa-swimming-pool text-primary text-base flex-shrink-0"></i>
        <span className="text-sm font-bold text-primary whitespace-nowrap hidden sm:inline">
          五泳池課表整合系統
        </span>
        {headerRight && (
          <div className="flex items-center gap-2 ml-auto flex-shrink-0">
            {headerRight}
          </div>
        )}
      </header>

      {/* ── Row 2: Horizontal nav tabs ── */}
      <nav className="flex-shrink-0 bg-card border-b border-border overflow-x-auto scrollbar-none">
        <div className="flex min-w-max">
          {navItems.map((item) => {
            const isActive = location === item.path ||
              (item.key === "assign" && ["/mgt-x9k7p2/coach-assign", "/mgt-x9k7p2/coach-assignment"].includes(location)) ||
              (!location && item.key === activeTab);
            const isGreen = !!item.isGreen;
            return (
              <Link
                key={item.key}
                href={item.path}
                className={`flex flex-col items-center justify-center gap-0.5 px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap border-b-2 min-w-[56px]
                  ${isActive
                    ? isGreen
                      ? "border-green-500 text-green-700 bg-green-50"
                      : "border-primary text-primary bg-blue-50"
                    : isGreen
                      ? "border-transparent text-green-600 hover:bg-green-50 hover:text-green-700"
                      : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
                  }`}
              >
                <i className={`fas ${item.icon} text-sm`}></i>
                <span className="text-[10px] leading-tight">{item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>

      {/* ── Row 3: Page controls (headerCenter) ── */}
      {headerCenter && (
        <div className="flex-shrink-0 bg-card border-b border-border px-3 py-1.5 flex items-center gap-2 overflow-x-auto scrollbar-none">
          {headerCenter}
        </div>
      )}

      {/* ── Body ── */}
      <div className="flex flex-1 overflow-hidden min-h-0">
        <main className="flex-1 overflow-auto min-w-0">
          {children}
        </main>
        {rightPanel && (
          <aside className="w-64 flex-shrink-0 overflow-y-auto border-l border-border bg-background">
            {rightPanel}
          </aside>
        )}
      </div>
    </div>
  );
}
