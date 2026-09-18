import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CheckCircle, XCircle, Users, BookOpen, MapPin, Save, Bell, Send, Copy, ExternalLink, Link, Plus, Trash2, RefreshCw, Cloud, FileDown, Pencil, RotateCcw, MessageSquare } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import * as XLSX from "xlsx";
import type { CoachUser, Venue, VenueInfo } from "@shared/schema";
import AdminLayout from "@/components/admin-layout";

// Read from sessionStorage on every call so we always pick up whatever
// PasswordProtect wrote after the user signed in — never a stale empty
// string captured at module load. The literal is never embedded in source.
const adminPassword = (): string =>
  (typeof window !== "undefined" && sessionStorage.getItem("admin-password")) || "";

function CoachApprovalContent() {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<"users" | "rules" | "venues" | "notify">("users");

  const headerRight = (
    <span className="text-sm bg-purple-500 text-white px-3 py-1 rounded-full">教練審核</span>
  );

  return (
    <AdminLayout activeTab="approval" headerRight={headerRight}>
      <div className="max-w-7xl mx-auto p-4 space-y-4">
        <div className="flex gap-2 border-b pb-2 flex-wrap">
          <Button
            variant={activeTab === "users" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveTab("users")}
          >
            <Users className="h-4 w-4 mr-1" />
            教練審核
          </Button>
          <Button
            variant={activeTab === "rules" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveTab("rules")}
          >
            <BookOpen className="h-4 w-4 mr-1" />
            教練守則
          </Button>
          <Button
            variant={activeTab === "venues" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveTab("venues")}
          >
            <MapPin className="h-4 w-4 mr-1" />
            場館資訊
          </Button>
          <Button
            variant={activeTab === "notify" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveTab("notify")}
          >
            <Bell className="h-4 w-4 mr-1" />
            推播通知
          </Button>
        </div>

        {activeTab === "users" && <CoachUsersSection />}
        {activeTab === "rules" && <CoachRulesSection />}
        {activeTab === "venues" && <VenueInfoSection />}
        {activeTab === "notify" && <NotificationSection />}
      </div>
    </AdminLayout>
  );
}

interface CoachFillRate {
  name: string;
  lineId: string | null;
  hasAvailability: boolean;
  availabilitySlots: number;
  hasVenuePrefs: boolean;
  venuePrefsCount: number;
}

function CoachUsersSection() {
  const { toast } = useToast();
  const [filter, setFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [editingUser, setEditingUser] = useState<{ id: string; name: string } | null>(null);
  const [editName, setEditName] = useState("");
  const [editingLineCoachId, setEditingLineCoachId] = useState<string | null>(null);
  const [lineIdInput, setLineIdInput] = useState("");
  const [showFillRate, setShowFillRate] = useState(false);

  const { data: coachUsers = [], isLoading } = useQuery<CoachUser[]>({
    queryKey: ["/api/admin/coach-users", filter],
    queryFn: async () => {
      const url = filter === "pending"
        ? `/api/admin/coach-users?status=pending&password=${adminPassword()}`
        : `/api/admin/coach-users?password=${adminPassword()}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const { data: venuePrefsMap = {} } = useQuery<Record<string, string[]>>({
    queryKey: ["/api/admin/coach-venue-preferences"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/coach-venue-preferences?password=${adminPassword()}`);
      if (!res.ok) return {};
      return res.json();
    },
  });

  const { data: fillRateData, isLoading: fillRateLoading } = useQuery<{ coaches: CoachFillRate[]; summary: { total: number; filledAvailability: number; filledVenuePrefs: number; linkedLine: number } }>({
    queryKey: ["/api/admin/coach-fillrate"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/coach-fillrate?password=${adminPassword()}`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: showFillRate,
  });

  const sendReminderMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/send-fill-reminder", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-password": adminPassword() },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "發送失敗");
      return data;
    },
    onSuccess: (data) => {
      toast({ title: "發送完成", description: `已成功推播 ${data.sent} 位教練` });
    },
    onError: (err: Error) => {
      toast({ title: "發送失敗", description: err.message, variant: "destructive" });
    },
  });

  const approveMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const res = await fetch(`/api/admin/coach-users/${id}/status`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-admin-password": adminPassword() },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/coach-users"] });
    },
  });

  const editNameMutation = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      const res = await fetch(`/api/admin/coach-users/${id}/name`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-admin-password": adminPassword() },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error("更新失敗");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/coach-users"] });
      setEditingUser(null);
    },
  });

  const setLineIdMutation = useMutation({
    mutationFn: async ({ coachUserId, lineId }: { coachUserId: string; lineId: string }) => {
      const res = await fetch(`/api/admin/set-coach-line-id`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-password": adminPassword() },
        body: JSON.stringify({ coachUserId, lineId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "綁定失敗");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/coach-users"] });
      setEditingLineCoachId(null);
      setLineIdInput("");
    },
    onError: (err: Error) => {
      alert(err.message);
    },
  });

  const clearLineIdMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/clear-coach-line-id/${id}`, {
        method: "DELETE",
        headers: { "x-admin-password": adminPassword() },
      });
      if (!res.ok) throw new Error("清除失敗");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/coach-users"] });
    },
  });

  const ragicSyncMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/ragic-sync", {
        method: "POST",
        headers: { "x-admin-password": adminPassword() },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "同步失敗");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/coach-users"] });
    },
    onError: (err: Error) => {
      alert(err.message);
    },
  });

  const statusLabel = (s: string) =>
    s === "approved" ? "已通過" : s === "pending" ? "待審核" : "已拒絕";

  const statusBadge = (status: string) => {
    switch (status) {
      case "pending":
        return <Badge variant="outline" className="text-yellow-600 border-yellow-400 whitespace-nowrap">待審核</Badge>;
      case "approved":
        return <Badge className="bg-green-500 whitespace-nowrap">已通過</Badge>;
      case "rejected":
        return <Badge variant="destructive" className="whitespace-nowrap">已拒絕</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const filteredUsers = coachUsers
    .filter((u) => filter === "all" || u.status === filter)
    .filter((u) => {
      if (!search.trim()) return true;
      const q = search.trim();
      return u.name.includes(q) || (u.phone || "").includes(q) || (u.email || "").includes(q);
    });

  const pendingCount = coachUsers.filter((u) => u.status === "pending").length;

  const exportToExcel = () => {
    const rows = filteredUsers.map((u) => ({
      姓名: u.name,
      員編: u.employeeId || "",
      電話: u.phone || "",
      信箱: u.email || "",
      LINE綁定狀態: u.lineId ? "已綁定" : "未綁定",
      LINE_ID: u.lineId || "",
      可排課地點: (venuePrefsMap[u.name] || []).join("、"),
      註冊時間: u.createdAt ? format(new Date(u.createdAt), "yyyy/MM/dd HH:mm") : "",
      狀態: statusLabel(u.status),
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const colWidths = [
      { wch: 8 }, { wch: 10 }, { wch: 14 }, { wch: 28 },
      { wch: 12 }, { wch: 36 }, { wch: 30 }, { wch: 16 }, { wch: 8 },
    ];
    ws["!cols"] = colWidths;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "教練列表");
    XLSX.writeFile(wb, `教練列表_${format(new Date(), "yyyyMMdd_HHmm")}.xlsx`);
  };

  return (
    <>
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <CardTitle className="text-base flex items-center gap-2">
            教練列表
            {pendingCount > 0 && (
              <Badge className="bg-red-500 text-xs">{pendingCount} 待審</Badge>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-sm"
              onClick={() => ragicSyncMutation.mutate()}
              disabled={ragicSyncMutation.isPending}
            >
              <RefreshCw className={`h-4 w-4 mr-1 ${ragicSyncMutation.isPending ? "animate-spin" : ""}`} />
              {ragicSyncMutation.isPending ? "同步中..." : "同步 Ragic"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-sm text-green-700 border-green-300 hover:bg-green-50"
              onClick={exportToExcel}
              disabled={filteredUsers.length === 0}
            >
              <FileDown className="h-4 w-4 mr-1" />
              匯出 Excel
            </Button>
            <Select value={filter} onValueChange={setFilter}>
              <SelectTrigger className="w-28 h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部</SelectItem>
                <SelectItem value="pending">待審核</SelectItem>
                <SelectItem value="approved">已通過</SelectItem>
                <SelectItem value="rejected">已拒絕</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="mt-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜尋姓名、電話、信箱..."
            className="h-9 text-sm"
          />
        </div>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {isLoading ? (
          <div className="text-center py-8 text-muted-foreground">載入中...</div>
        ) : filteredUsers.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">目前無教練資料</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600 whitespace-nowrap w-[80px]">姓名</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600 whitespace-nowrap w-[80px]">員編</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600 whitespace-nowrap w-[110px]">電話</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600 w-[200px]">信箱</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600 w-[220px]">LINE 綁定</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600 w-[160px]">可排課地點</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600 whitespace-nowrap w-[80px]">狀態</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600 whitespace-nowrap w-[110px]">註冊時間</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600 whitespace-nowrap w-[130px]">操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.map((user, idx) => (
                  <tr key={user.id} className={`border-b transition-colors hover:bg-gray-50 ${idx % 2 === 0 ? "" : "bg-gray-50/40"}`}>
                    <td className="px-4 py-3 font-semibold whitespace-nowrap">{user.name}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground font-mono whitespace-nowrap">{user.employeeId || <span className="text-gray-300">—</span>}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{user.phone || <span className="text-gray-300">—</span>}</td>
                    <td className="px-4 py-3 max-w-[200px]">
                      <span className="block truncate text-xs text-gray-600" title={user.email || ""}>
                        {user.email || <span className="text-gray-300">—</span>}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {editingLineCoachId === user.id ? (
                        <div className="flex flex-col gap-1.5">
                          <Input
                            value={lineIdInput}
                            onChange={e => setLineIdInput(e.target.value)}
                            placeholder="貼上 LINE ID（U...）"
                            className="h-7 text-xs font-mono w-[190px]"
                            autoFocus
                          />
                          <div className="flex gap-1">
                            <Button
                              size="sm"
                              className="h-6 text-xs px-2.5 bg-green-600 hover:bg-green-700"
                              disabled={!lineIdInput.trim() || setLineIdMutation.isPending}
                              onClick={() => setLineIdMutation.mutate({ coachUserId: user.id, lineId: lineIdInput.trim() })}
                            >
                              確認
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 text-xs px-2.5"
                              onClick={() => { setEditingLineCoachId(null); setLineIdInput(""); }}
                            >
                              取消
                            </Button>
                          </div>
                        </div>
                      ) : user.lineId ? (
                        <div className="space-y-1">
                          <div className="flex items-center gap-1.5">
                            <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-50 border border-green-200 rounded px-2 py-0.5 whitespace-nowrap">
                              ✅ 已綁定
                            </span>
                            <button
                              className="text-gray-400 hover:text-blue-600 transition-colors"
                              title="修改 LINE ID"
                              onClick={() => { setEditingLineCoachId(user.id); setLineIdInput(user.lineId || ""); }}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              className="text-gray-400 hover:text-red-500 transition-colors"
                              title="清除綁定"
                              disabled={clearLineIdMutation.isPending}
                              onClick={() => { if (confirm(`確定清除「${user.name}」的 LINE 綁定？`)) clearLineIdMutation.mutate(user.id); }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          <div className="text-[10px] text-gray-400 font-mono truncate max-w-[190px]" title={user.lineId}>
                            {user.lineId}
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <span className="inline-flex items-center text-xs text-gray-400 bg-gray-50 border border-gray-200 rounded px-2 py-0.5 whitespace-nowrap">
                            未綁定
                          </span>
                          <button
                            className="text-xs text-blue-600 hover:text-blue-800 hover:underline transition-colors whitespace-nowrap"
                            onClick={() => { setEditingLineCoachId(user.id); setLineIdInput(""); }}
                          >
                            + 綁定
                          </button>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {venuePrefsMap[user.name]?.length ? (
                        <div className="flex flex-wrap gap-1">
                          {venuePrefsMap[user.name].map(v => (
                            <Badge key={v} variant="outline" className="text-xs px-1.5 py-0 whitespace-nowrap">
                              {v}
                            </Badge>
                          ))}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">未設定</span>
                      )}
                    </td>
                    <td className="px-4 py-3">{statusBadge(user.status)}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                      {user.createdAt ? format(new Date(user.createdAt), "yyyy/MM/dd HH:mm") : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 flex-wrap">
                        <button
                          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 hover:underline transition-colors whitespace-nowrap"
                          onClick={() => { setEditingUser({ id: user.id, name: user.name }); setEditName(user.name); }}
                        >
                          <Pencil className="h-3 w-3" />
                          改名
                        </button>
                        {user.status !== "approved" && (
                          <button
                            className="inline-flex items-center gap-1 text-xs text-green-600 hover:text-green-800 hover:underline transition-colors whitespace-nowrap disabled:opacity-50"
                            onClick={() => approveMutation.mutate({ id: user.id, status: "approved" })}
                            disabled={approveMutation.isPending}
                          >
                            <CheckCircle className="h-3 w-3" />
                            通過
                          </button>
                        )}
                        {user.status !== "rejected" && (
                          <button
                            className="inline-flex items-center gap-1 text-xs text-red-600 hover:text-red-800 hover:underline transition-colors whitespace-nowrap disabled:opacity-50"
                            onClick={() => approveMutation.mutate({ id: user.id, status: "rejected" })}
                            disabled={approveMutation.isPending}
                          >
                            <XCircle className="h-3 w-3" />
                            拒絕
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>

    {/* SWIM-03: 教練填寫狀態 */}
    <Card>
      <CardHeader className="py-3 cursor-pointer" onClick={() => setShowFillRate(v => !v)}>
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Users className="h-4 w-4" />
            教練填寫狀態
          </CardTitle>
          <div className="flex items-center gap-3">
            {fillRateData && (
              <span className="text-xs text-gray-400">
                時段：{fillRateData.summary.filledAvailability}/{fillRateData.summary.total} ·
                LINE：{fillRateData.summary.linkedLine}/{fillRateData.summary.total}
              </span>
            )}
            <span className="text-gray-400 text-sm">{showFillRate ? "▲" : "▼"}</span>
          </div>
        </div>
      </CardHeader>
      {showFillRate && (
        <CardContent className="py-2">
          {fillRateLoading ? (
            <div className="text-center py-4 text-muted-foreground text-sm">載入中...</div>
          ) : fillRateData ? (
            <>
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs text-gray-500">
                  {fillRateData.coaches.filter(c => !c.hasAvailability).length} 位教練尚未填寫可用時段
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 text-xs border-green-200 text-green-700 hover:bg-green-50 h-7"
                  onClick={() => sendReminderMutation.mutate()}
                  disabled={sendReminderMutation.isPending || fillRateData.summary.linkedLine === 0}
                >
                  <Send className="h-3 w-3" />
                  {sendReminderMutation.isPending ? "發送中..." : "發送填寫提醒"}
                </Button>
              </div>
              <div className="space-y-1">
                {fillRateData.coaches.map(coach => (
                  <div key={coach.name} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-gray-50 text-sm">
                    <span className="font-medium min-w-[80px]">{coach.name}</span>
                    <div className="flex items-center gap-2 flex-wrap justify-end">
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-gray-400">時段</span>
                        {coach.hasAvailability
                          ? <span className="text-xs text-green-600 font-medium">✓ {coach.availabilitySlots}/49</span>
                          : <span className="text-xs text-red-500 font-medium">未填</span>
                        }
                      </div>
                      {/* 場館偏好欄位 — 暫時隱藏 */}
                      <span className={`text-xs px-1.5 py-0.5 rounded ${
                        coach.lineId ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-gray-100 text-gray-400'
                      }`}>
                        {coach.lineId ? 'LINE ✓' : 'LINE 未綁'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </CardContent>
      )}
    </Card>

    {editingUser && (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
          <h3 className="font-bold text-lg">修改教練姓名</h3>
          <p className="text-sm text-gray-500">原本姓名：<strong>{editingUser.name}</strong></p>
          <div>
            <label className="text-sm font-medium">新姓名</label>
            <Input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder="請輸入正確的戶籍姓名"
              className="mt-1"
              onKeyDown={(e) => { if (e.key === "Enter" && editName.trim()) editNameMutation.mutate({ id: editingUser.id, name: editName }); }}
              autoFocus
            />
          </div>
          <div className="flex gap-3">
            <Button variant="outline" className="flex-1" onClick={() => setEditingUser(null)} disabled={editNameMutation.isPending}>
              取消
            </Button>
            <Button
              className="flex-1 bg-blue-500 hover:bg-blue-600"
              onClick={() => editNameMutation.mutate({ id: editingUser.id, name: editName })}
              disabled={!editName.trim() || editNameMutation.isPending}
            >
              {editNameMutation.isPending ? "儲存中..." : "確認儲存"}
            </Button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

function CoachRulesSection() {
  const [content, setContent] = useState("");
  const [saved, setSaved] = useState(false);

  const { data, isLoading } = useQuery<{ content: string }>({
    queryKey: ["/api/settings/coach-rules"],
    queryFn: async () => {
      const res = await fetch("/api/settings/coach-rules");
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  useEffect(() => {
    if (data?.content !== undefined) {
      setContent(data.content);
    }
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/settings/coach-rules", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-admin-password": adminPassword() },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    onSuccess: () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      queryClient.invalidateQueries({ queryKey: ["/api/settings/coach-rules"] });
    },
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <BookOpen className="h-4 w-4" />
          教練守則編輯
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          編輯教練守則內容，教練在前台可以查看
        </p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="text-center py-8 text-muted-foreground">載入中...</div>
        ) : (
          <div className="space-y-4">
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="請輸入教練守則內容...&#10;&#10;例如：&#10;1. 請於上課前15分鐘到達場館&#10;2. 穿著整齊的教練服裝&#10;3. 確保學生安全..."
              className="min-h-[300px] font-mono text-sm"
            />
            <div className="flex items-center gap-3">
              <Button
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending}
                className="bg-green-500 hover:bg-green-600"
              >
                <Save className="h-4 w-4 mr-1" />
                {saveMutation.isPending ? "儲存中..." : "儲存守則"}
              </Button>
              {saved && (
                <span className="text-sm text-green-600">已儲存</span>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RagicSyncSection() {
  const { data: syncStatus, refetch: refetchStatus } = useQuery<{
    lastSyncTime: string | null;
    lastSyncResult: {
      venues: { added: string[]; updated: string[]; total: number };
      coaches: { added: number; total: number; lineIdsSynced: number; employeeIdsSynced: number };
    } | null;
    isSyncing: boolean;
  }>({
    queryKey: ["/api/admin/ragic-status"],
    queryFn: async () => {
      const res = await fetch("/api/admin/ragic-status", {
        headers: { "x-admin-password": adminPassword() },
      });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    refetchInterval: 60000,
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/ragic-sync", {
        method: "POST",
        headers: { "x-admin-password": adminPassword() },
      });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    onSuccess: () => {
      refetchStatus();
      queryClient.invalidateQueries({ queryKey: ["/api/venues"] });
      queryClient.invalidateQueries({ queryKey: ["/api/venue-infos"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/coach-users"] });
    },
  });

  const lastSync = syncStatus?.lastSyncTime
    ? format(new Date(syncStatus.lastSyncTime), "yyyy/MM/dd HH:mm:ss")
    : "尚未同步";

  const sr = syncStatus?.lastSyncResult;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Cloud className="h-4 w-4" />
          Ragic 資料同步
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          自動從 Ragic 同步場館和教練資料（每日 03:00），僅新增不存在的資料
        </p>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="text-sm space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">最後同步：</span>
              <span className="font-medium">{lastSync}</span>
            </div>
            {sr && (
              <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                <span>場館 {sr.venues.total} 個</span>
                <span>教練 {sr.coaches.total} 個（在職）</span>
                {sr.venues.added.length > 0 && (
                  <Badge variant="secondary" className="text-xs">
                    新增 {sr.venues.added.length} 場館
                  </Badge>
                )}
                {sr.venues.updated.length > 0 && (
                  <Badge variant="secondary" className="text-xs">
                    更新 {sr.venues.updated.length} 導航連結
                  </Badge>
                )}
                {sr.coaches.added > 0 && (
                  <Badge variant="secondary" className="text-xs">
                    新增 {sr.coaches.added} 教練
                  </Badge>
                )}
                {sr.coaches.lineIdsSynced > 0 && (
                  <Badge variant="secondary" className="text-xs bg-green-100 text-green-800">
                    同步 {sr.coaches.lineIdsSynced} 筆 LINE ID
                  </Badge>
                )}
                {sr.coaches.employeeIdsSynced > 0 && (
                  <Badge variant="secondary" className="text-xs bg-blue-100 text-blue-800">
                    同步 {sr.coaches.employeeIdsSynced} 筆員編
                  </Badge>
                )}
              </div>
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending || syncStatus?.isSyncing}
          >
            <RefreshCw className={`h-3 w-3 mr-1 ${syncMutation.isPending ? "animate-spin" : ""}`} />
            {syncMutation.isPending ? "同步中..." : "手動同步"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function VenueInfoSection() {
  const { data: venues = [] } = useQuery<Venue[]>({
    queryKey: ["/api/venues"],
  });

  const { data: venueInfos = [] } = useQuery<VenueInfo[]>({
    queryKey: ["/api/venue-infos"],
    queryFn: async () => {
      const res = await fetch("/api/venue-infos");
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [newVenueName, setNewVenueName] = useState("");
  const [newVenueColor, setNewVenueColor] = useState("blue");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const baseUrl = window.location.origin;

  const colorOptions = [
    { value: "blue", label: "藍色", hex: "#3b82f6" },
    { value: "green", label: "綠色", hex: "#22c55e" },
    { value: "purple", label: "紫色", hex: "#a855f7" },
    { value: "yellow", label: "黃色", hex: "#eab308" },
    { value: "orange", label: "橘色", hex: "#f97316" },
    { value: "teal", label: "青色", hex: "#14b8a6" },
    { value: "red", label: "紅色", hex: "#ef4444" },
    { value: "pink", label: "粉色", hex: "#ec4899" },
    { value: "indigo", label: "靛色", hex: "#6366f1" },
    { value: "cyan", label: "天藍", hex: "#06b6d4" },
  ];

  const handleCopy = (venue: Venue) => {
    const url = `${baseUrl}/school/${encodeURIComponent(venue.name)}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedId(venue.id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  const addVenueMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/venues", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-password": adminPassword() },
        body: JSON.stringify({ name: newVenueName.trim(), color: newVenueColor }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed");
      }
      return res.json();
    },
    onSuccess: () => {
      setNewVenueName("");
      setNewVenueColor("blue");
      queryClient.invalidateQueries({ queryKey: ["/api/venues"] });
      queryClient.invalidateQueries({ queryKey: ["/api/venue-infos"] });
    },
  });

  const deleteVenueMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/venues/${id}`, {
        method: "DELETE",
        headers: { "x-admin-password": adminPassword() },
      });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    onSuccess: () => {
      setDeletingId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/venues"] });
      queryClient.invalidateQueries({ queryKey: ["/api/venue-infos"] });
    },
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Plus className="h-4 w-4" />
            場館管理
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            新增或刪除場館，新增後會自動產生專屬網址和可編輯的場館資料
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-end gap-2 flex-wrap">
            <div className="flex-1 min-w-[160px]">
              <label className="text-xs text-muted-foreground mb-1 block">場館名稱</label>
              <Input
                value={newVenueName}
                onChange={(e) => setNewVenueName(e.target.value)}
                placeholder="例如：中正國小"
                className="text-sm"
              />
            </div>
            <div className="w-32">
              <label className="text-xs text-muted-foreground mb-1 block">顏色</label>
              <Select value={newVenueColor} onValueChange={setNewVenueColor}>
                <SelectTrigger className="text-sm">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: colorOptions.find(c => c.value === newVenueColor)?.hex }} />
                    <SelectValue />
                  </div>
                </SelectTrigger>
                <SelectContent>
                  {colorOptions.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: c.hex }} />
                        {c.label}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              size="sm"
              onClick={() => addVenueMutation.mutate()}
              disabled={!newVenueName.trim() || addVenueMutation.isPending}
              className="bg-blue-500 hover:bg-blue-600"
            >
              <Plus className="h-3 w-3 mr-1" />
              {addVenueMutation.isPending ? "新增中..." : "新增場館"}
            </Button>
          </div>
          {addVenueMutation.isError && (
            <p className="text-sm text-red-600">{(addVenueMutation.error as Error).message}</p>
          )}

          <div className="space-y-2">
            {venues.map((venue) => {
              const url = `${baseUrl}/school/${encodeURIComponent(venue.name)}`;
              return (
                <div
                  key={venue.id}
                  className="flex items-center gap-3 p-3 border rounded-lg hover:bg-gray-50 transition-colors"
                >
                  <div
                    className="w-3 h-3 rounded-full shrink-0"
                    style={{ backgroundColor: colorOptions.find(c => c.value === venue.color)?.hex || "#888" }}
                  />
                  <span className="font-medium text-sm w-20 shrink-0">{venue.name}</span>
                  <code className="flex-1 text-xs bg-gray-100 px-2 py-1.5 rounded font-mono text-gray-600 truncate">
                    {url}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => handleCopy(venue)}
                  >
                    {copiedId === venue.id ? (
                      <><CheckCircle className="h-3 w-3 mr-1 text-green-500" />已複製</>
                    ) : (
                      <><Copy className="h-3 w-3 mr-1" />複製</>
                    )}
                  </Button>
                  <a
                    href={`/school/${encodeURIComponent(venue.name)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Button variant="ghost" size="sm" className="shrink-0">
                      <ExternalLink className="h-3 w-3" />
                    </Button>
                  </a>
                  {deletingId === venue.id ? (
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => deleteVenueMutation.mutate(venue.id)}
                        disabled={deleteVenueMutation.isPending}
                      >
                        {deleteVenueMutation.isPending ? "刪除中..." : "確認刪除"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setDeletingId(null)}
                      >
                        取消
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-red-400 hover:text-red-600 hover:bg-red-50"
                      onClick={() => setDeletingId(venue.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <RagicSyncSection />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <MapPin className="h-4 w-4" />
            場館資訊管理
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            為每個場館設定進入方式說明、影片連結和導航，教練在前台可以查看
          </p>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {venues.map((venue) => {
              const info = venueInfos.find((v) => v.venueName === venue.name);
              return (
                <VenueInfoEditor
                  key={venue.id}
                  venueName={venue.name}
                  venueColor={venue.color}
                  existingInfo={info}
                />
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function VenueInfoEditor({
  venueName,
  venueColor,
  existingInfo,
}: {
  venueName: string;
  venueColor: string;
  existingInfo?: VenueInfo;
}) {
  const [videoUrl, setVideoUrl] = useState(existingInfo?.videoUrl || "");
  const [description, setDescription] = useState(existingInfo?.description || "");
  const [mapUrl, setMapUrl] = useState(existingInfo?.mapUrl || "");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setVideoUrl(existingInfo?.videoUrl || "");
    setDescription(existingInfo?.description || "");
    setMapUrl(existingInfo?.mapUrl || "");
  }, [existingInfo]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/admin/venue-infos/${encodeURIComponent(venueName)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-admin-password": adminPassword() },
        body: JSON.stringify({ videoUrl, description, mapUrl }),
      });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    onSuccess: () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      queryClient.invalidateQueries({ queryKey: ["/api/venue-infos"] });
    },
  });

  return (
    <div className="border rounded-lg p-4">
      <div className="flex items-center gap-2 mb-3">
        <div
          className="w-3 h-3 rounded-full"
          style={{ backgroundColor: `var(--venue-${venueColor})` }}
        />
        <span className="font-medium text-sm">{venueName}</span>
        {saved && <span className="text-xs text-green-600 ml-auto">已儲存</span>}
      </div>
      <div className="space-y-2">
        <div>
          <label className="text-xs text-muted-foreground">影片連結 (YouTube 等)</label>
          <Input
            value={videoUrl}
            onChange={(e) => setVideoUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=..."
            className="text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Google 導航連結</label>
          <Input
            value={mapUrl}
            onChange={(e) => setMapUrl(e.target.value)}
            placeholder="https://maps.google.com/..."
            className="text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">進入方式說明</label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="例如：從正門進入，右轉到底即可到達游泳池..."
            className="text-sm min-h-[60px]"
          />
        </div>
        <Button
          size="sm"
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
          className="bg-green-500 hover:bg-green-600"
        >
          <Save className="h-3 w-3 mr-1" />
          {saveMutation.isPending ? "儲存中..." : "儲存"}
        </Button>
      </div>
    </div>
  );
}

interface NotifyLogRow {
  scheduleId: string;
  date: string;
  venue: string;
  period: string;
  startTime: string;
  endTime: string;
  className: string | null;
  coachName: string | null;
  coachName2: string | null;
  coach1Log: { sentAt: string; content: string; notifyType: string } | null;
  coach2Log: { sentAt: string; content: string; notifyType: string } | null;
}

interface LogPreview {
  coachName: string;
  sentAt: string;
  content: string;
  notifyType: string;
}

function NotificationSection() {
  const { toast } = useToast();
  const today = format(new Date(), "yyyy-MM-dd");
  const [selectedDate, setSelectedDate] = useState(today);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [logPreview, setLogPreview] = useState<LogPreview | null>(null);
  const [venueFilter, setVenueFilter] = useState("__all__");
  const [coachFilter, setCoachFilter] = useState("__all__");
  const [scheduleModifiedAt, setScheduleModifiedAt] = useState<number>(
    () => parseInt(localStorage.getItem("scheduleLastModified") || "0")
  );

  const notifyLogsKey = `/api/admin/notify-logs?date=${selectedDate}`;

  const { data: rows = [], isFetching, dataUpdatedAt } = useQuery<NotifyLogRow[]>({
    queryKey: [notifyLogsKey],
    queryFn: async () => {
      const res = await fetch(`/api/admin/notify-logs?date=${selectedDate}`, {
        headers: { "x-admin-password": adminPassword() },
      });
      if (!res.ok) return [];
      return res.json();
    },
    refetchInterval: 30000,
  });

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "scheduleLastModified" && e.newValue) {
        setScheduleModifiedAt(parseInt(e.newValue));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const showModifiedBanner = scheduleModifiedAt > 0 && dataUpdatedAt > 0 && scheduleModifiedAt > dataUpdatedAt;

  const handleRefresh = () => {
    setSelectedKeys(new Set());
    queryClient.invalidateQueries({
      predicate: q => typeof q.queryKey[0] === "string" && q.queryKey[0].includes("/api/admin/notify-logs"),
    });
    const latest = parseInt(localStorage.getItem("scheduleLastModified") || "0");
    setScheduleModifiedAt(latest);
  };

  const extractPeriodNum = (period: string) => {
    const m = period.match(/\d+/);
    return m ? parseInt(m[0]) : 0;
  };

  const sortedRows = [...rows].sort((a, b) => {
    const venueCmp = a.venue.localeCompare(b.venue, "zh-TW");
    if (venueCmp !== 0) return venueCmp;
    return extractPeriodNum(a.period) - extractPeriodNum(b.period);
  });

  const venueOptions = Array.from(new Set(rows.map(r => r.venue))).sort((a, b) => a.localeCompare(b, "zh-TW"));
  const coachOptions = Array.from(new Set(rows.flatMap(r => [r.coachName, r.coachName2].filter(Boolean) as string[]))).sort((a, b) => a.localeCompare(b, "zh-TW"));

  const filteredRows = sortedRows.filter(r => {
    if (venueFilter !== "__all__" && r.venue !== venueFilter) return false;
    if (coachFilter !== "__all__") {
      if (r.coachName !== coachFilter && r.coachName2 !== coachFilter) return false;
    }
    return true;
  });

  const allKeys = filteredRows.flatMap(r => {
    const keys: string[] = [];
    if (r.coachName) keys.push(`${r.scheduleId}-1`);
    if (r.coachName2) keys.push(`${r.scheduleId}-2`);
    return keys;
  });
  const allSelected = allKeys.length > 0 && allKeys.every(k => selectedKeys.has(k));

  const toggleAll = () => {
    if (allSelected) setSelectedKeys(new Set());
    else setSelectedKeys(new Set(allKeys));
  };

  const toggleKey = (key: string) => {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const getSelectedCoaches = () => {
    const coaches = new Set<string>();
    filteredRows.forEach(r => {
      if (r.coachName && selectedKeys.has(`${r.scheduleId}-1`)) coaches.add(r.coachName);
      if (r.coachName2 && selectedKeys.has(`${r.scheduleId}-2`)) coaches.add(r.coachName2);
    });
    return Array.from(coaches);
  };

  const sendIndividualMutation = useMutation({
    mutationFn: async (coachNames: string[]) => {
      const res = await fetch("/api/admin/send-notify-individual", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-password": adminPassword() },
        body: JSON.stringify({ coachNames, date: selectedDate }),
      });
      if (!res.ok) throw new Error((await res.json()).message || "發送失敗");
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "推播完成", description: `成功 ${data.sentCount} 筆，失敗 ${data.failCount} 筆` });
      setSelectedKeys(new Set());
      queryClient.invalidateQueries({ predicate: q => typeof q.queryKey[0] === "string" && q.queryKey[0].includes("/api/admin/notify-logs") });
    },
    onError: (e: Error) => {
      toast({ title: "推播失敗", description: e.message, variant: "destructive" });
    },
  });

  const formatSentAt = (sentAt: string) => {
    try {
      const d = new Date(sentAt);
      return format(d, "MM/dd HH:mm");
    } catch {
      return sentAt;
    }
  };

  const notifyTypeLabel = (t: string) => {
    if (t === "daily") return "明日課表";
    if (t === "weekly") return "下週課表";
    if (t === "manual") return "手動補發";
    return t;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Bell className="h-5 w-5" />
          LINE 推播通知
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">

        {/* Top row: 自動排程 (4/5) + 手動群體發送 (1/5) */}
        <div className="flex gap-3 items-stretch">
          {/* 自動推播排程 — 4 parts */}
          <div className="flex-[4] bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm space-y-2">
            <p className="font-semibold text-blue-800">📅 自動推播排程</p>
            <div className="space-y-1 text-blue-700">
              <p>● <span className="font-medium">每週日 20:00</span>（台灣時間）→ 由新版可靠推播佇列發送</p>
              <p>● <span className="font-medium">每日 19:00</span>（台灣時間）→ 發送明日課表給隔日有排課的教練</p>
            </div>
            <p className="text-blue-500 text-xs pt-1">
              推播條件：教練需已核准 ＋ 已綁定 LINE ＋ 已連結排課系統中的教練名稱
            </p>
          </div>

          {/* Weekly sends are managed only from the pg-boss console. */}
          <div className="flex-[1] border rounded-lg p-4 flex flex-col gap-2 min-w-[140px]">
            <p className="font-semibold text-sm">✉️ 手動群體發送</p>
            <Button
              size="sm"
              onClick={() => { window.location.href = "/mgt-x9k7p2/weekly-push"; }}
              className="bg-green-500 hover:bg-green-600 text-xs"
            >
              <Send className="h-3 w-3 mr-1" />
              前往週推播管理
            </Button>
          </div>
        </div>

        {/* Individual notify section */}
        <div className="border rounded-lg p-4 space-y-3">
          {/* Header row */}
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="font-semibold text-sm">📋 個別通知教練</p>
            <div className="flex items-center gap-2 flex-wrap">
              <Select value={venueFilter} onValueChange={v => { setVenueFilter(v); setSelectedKeys(new Set()); }}>
                <SelectTrigger className="h-8 text-sm w-32">
                  <SelectValue placeholder="全部場館" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">全部場館</SelectItem>
                  {venueOptions.map(v => <SelectItem key={v} value={v}>{v}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={coachFilter} onValueChange={v => { setCoachFilter(v); setSelectedKeys(new Set()); }}>
                <SelectTrigger className="h-8 text-sm w-28">
                  <SelectValue placeholder="全部教練" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">全部教練</SelectItem>
                  {coachOptions.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
              <input
                type="date"
                value={selectedDate}
                onChange={e => { setSelectedDate(e.target.value); setSelectedKeys(new Set()); }}
                className="border rounded px-2 py-1 text-sm"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={handleRefresh}
                disabled={isFetching}
              >
                <RotateCcw className={`h-3.5 w-3.5 mr-1 ${isFetching ? "animate-spin" : ""}`} />
                重新整理
              </Button>
            </div>
          </div>

          {/* Modified banner */}
          {showModifiedBanner && (
            <div className="flex items-center gap-2 bg-orange-50 border border-orange-300 rounded px-3 py-2 text-sm text-orange-700">
              <span className="text-base">⚠️</span>
              <span>教練名單有異動調整，請手動點選右側「重新整理」。</span>
            </div>
          )}

          {/* Table */}
          <div className="overflow-x-auto rounded border">
            <Table>
              <TableHeader>
                <TableRow className="bg-gray-50">
                  <TableHead className="w-8 px-2">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={toggleAll}
                    />
                  </TableHead>
                  <TableHead className="text-sm">場館</TableHead>
                  <TableHead className="text-sm">節次</TableHead>
                  <TableHead className="text-sm">時間</TableHead>
                  <TableHead className="text-sm">班級</TableHead>
                  <TableHead className="text-sm">教練</TableHead>
                  <TableHead className="text-sm">推播時間</TableHead>
                  <TableHead className="text-sm">推播內容</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-sm text-muted-foreground py-6">
                      {isFetching ? "載入中..." : rows.length === 0 ? "該日期無排課資料" : "無符合篩選條件的資料"}
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredRows.flatMap(r => {
                    const rowItems: { key: string; coach: string; log: NotifyLogRow["coach1Log"] }[] = [];
                    if (r.coachName) rowItems.push({ key: `${r.scheduleId}-1`, coach: r.coachName, log: r.coach1Log });
                    if (r.coachName2) rowItems.push({ key: `${r.scheduleId}-2`, coach: r.coachName2, log: r.coach2Log });
                    if (rowItems.length === 0) return [];

                    return rowItems.map((item, idx) => (
                      <TableRow key={item.key} className={selectedKeys.has(item.key) ? "bg-blue-50" : ""}>
                        <TableCell className="px-2">
                          <Checkbox
                            checked={selectedKeys.has(item.key)}
                            onCheckedChange={() => toggleKey(item.key)}
                          />
                        </TableCell>
                        <TableCell className="text-sm">{idx === 0 ? r.venue : ""}</TableCell>
                        <TableCell className="text-sm">{idx === 0 ? r.period : ""}</TableCell>
                        <TableCell className="text-sm whitespace-nowrap">{idx === 0 ? `${r.startTime}-${r.endTime}` : ""}</TableCell>
                        <TableCell className="text-sm">{idx === 0 ? r.className : ""}</TableCell>
                        <TableCell className="text-sm font-medium">{item.coach}</TableCell>
                        <TableCell className="text-sm whitespace-nowrap">
                          {item.log ? (
                            <span className="text-green-700">{formatSentAt(item.log.sentAt)}</span>
                          ) : (
                            <span className="text-gray-400">─（尚未推播）</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">
                          {item.log ? (
                            <button
                              onClick={() => setLogPreview({ coachName: item.coach, sentAt: item.log!.sentAt, content: item.log!.content, notifyType: item.log!.notifyType })}
                              className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-800 hover:underline"
                            >
                              <MessageSquare className="h-3 w-3" />
                              {notifyTypeLabel(item.log.notifyType)} →
                            </button>
                          ) : (
                            <span className="text-gray-300">─</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ));
                  })
                )}
              </TableBody>
            </Table>
          </div>

          {/* Footer actions */}
          {selectedKeys.size > 0 && (
            <div className="flex items-center gap-3 pt-1">
              <span className="text-sm text-muted-foreground">已選 {selectedKeys.size} 筆</span>
              <Button
                size="sm"
                onClick={() => sendIndividualMutation.mutate(getSelectedCoaches())}
                disabled={sendIndividualMutation.isPending}
                className="bg-blue-500 hover:bg-blue-600"
              >
                <Send className="h-3.5 w-3.5 mr-1" />
                {sendIndividualMutation.isPending ? "發送中..." : "個別通知教練"}
              </Button>
            </div>
          )}
        </div>
      </CardContent>

      {/* Push content preview dialog */}
      <Dialog open={!!logPreview} onOpenChange={open => !open && setLogPreview(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4" />
              推播內容預覽
            </DialogTitle>
          </DialogHeader>
          {logPreview && (
            <div className="space-y-3">
              <div className="text-sm space-y-1 text-muted-foreground">
                <p><span className="font-medium text-foreground">收件人：</span>{logPreview.coachName}</p>
                <p><span className="font-medium text-foreground">發送時間：</span>{formatSentAt(logPreview.sentAt)}</p>
                <p><span className="font-medium text-foreground">類型：</span>{notifyTypeLabel(logPreview.notifyType)}</p>
              </div>
              <div className="bg-gray-50 border rounded p-3 whitespace-pre-wrap text-sm font-mono leading-relaxed max-h-72 overflow-y-auto">
                {logPreview.content}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default function CoachApproval() {
  return <CoachApprovalContent />;
}
