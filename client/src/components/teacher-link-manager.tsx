import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { addDays, format } from "date-fns";
import { Copy, Link, RefreshCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

type School = { code: string; name: string };
type Teacher = { id: string; teacherName: string; subject: string | null };
type TeacherLink = {
  id: string;
  schoolCode: string;
  teacherId: string;
  permissions: string[];
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

const adminHeaders = (): Record<string, string> => ({
  "x-admin-password": sessionStorage.getItem("admin-password") || "",
});

export default function TeacherLinkManager() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [schoolCode, setSchoolCode] = useState("demo");
  const [teacherId, setTeacherId] = useState("");
  const [expiresDate, setExpiresDate] = useState(() => format(addDays(new Date(), 30), "yyyy-MM-dd"));
  const [latestUrl, setLatestUrl] = useState("");

  const schoolsQuery = useQuery<{ schools: School[] }>({
    queryKey: ["admin-schools"],
    queryFn: async () => {
      const response = await fetch("/api/admin/schools", { headers: adminHeaders() });
      if (!response.ok) throw new Error("無法載入學校");
      return response.json();
    },
  });
  const teachersQuery = useQuery<Teacher[]>({
    queryKey: ["admin-school-teachers", schoolCode],
    queryFn: async () => {
      const response = await fetch(`/api/${schoolCode}/teachers`, { headers: adminHeaders() });
      if (!response.ok) throw new Error("無法載入教師");
      return response.json();
    },
  });
  const linksQuery = useQuery<{ links: TeacherLink[] }>({
    queryKey: ["admin-teacher-links", schoolCode],
    queryFn: async () => {
      const response = await fetch(`/api/admin/${schoolCode}/teacher-links`, { headers: adminHeaders() });
      if (!response.ok) throw new Error("無法載入教師連結");
      return response.json();
    },
  });
  const teachersById = useMemo(
    () => new Map((teachersQuery.data || []).map((teacher) => [teacher.id, teacher])),
    [teachersQuery.data],
  );

  const createLink = useMutation({
    mutationFn: async (targetTeacherId: string) => {
      const expiresAt = new Date(`${expiresDate}T23:59:59+08:00`).toISOString();
      const response = await fetch(`/api/admin/${schoolCode}/teacher-links`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({
          teacherId: targetTeacherId,
          permissions: ["feedback:read", "feedback:write"],
          expiresAt,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "建立連結失敗");
      return data as { url: string };
    },
    onSuccess: ({ url }) => {
      setLatestUrl(url);
      navigator.clipboard.writeText(url).catch(() => undefined);
      queryClient.invalidateQueries({ queryKey: ["admin-teacher-links", schoolCode] });
      toast({ title: "教師連結已建立並複製" });
    },
    onError: (error: Error) => toast({ title: "建立失敗", description: error.message, variant: "destructive" }),
  });

  const revokeLink = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(`/api/admin/${schoolCode}/teacher-links/${id}/revoke`, {
        method: "POST",
        headers: adminHeaders(),
      });
      if (!response.ok) throw new Error("撤銷失敗");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-teacher-links", schoolCode] });
      toast({ title: "連結已撤銷" });
    },
  });

  return (
    <Card className="mb-6">
      <CardHeader><CardTitle className="flex items-center gap-2"><Link className="h-5 w-5" />教師連結管理</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="grid md:grid-cols-[1fr_1fr_180px_auto] gap-2 items-end">
          <label className="space-y-1 text-sm">學校
            <Select value={schoolCode} onValueChange={(value) => { setSchoolCode(value); setTeacherId(""); setLatestUrl(""); }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{(schoolsQuery.data?.schools || []).map((school) => <SelectItem key={school.code} value={school.code}>{school.name}</SelectItem>)}</SelectContent>
            </Select>
          </label>
          <label className="space-y-1 text-sm">教師
            <Select value={teacherId} onValueChange={setTeacherId}>
              <SelectTrigger><SelectValue placeholder="選擇教師" /></SelectTrigger>
              <SelectContent>{(teachersQuery.data || []).map((teacher) => <SelectItem key={teacher.id} value={teacher.id}>{teacher.teacherName}</SelectItem>)}</SelectContent>
            </Select>
          </label>
          <label className="space-y-1 text-sm">有效期限<Input type="date" value={expiresDate} min={format(new Date(), "yyyy-MM-dd")} onChange={(event) => setExpiresDate(event.target.value)} /></label>
          <Button disabled={!teacherId || createLink.isPending} onClick={() => createLink.mutate(teacherId)}>產生連結</Button>
        </div>
        {latestUrl && <div className="flex gap-2"><Input readOnly value={latestUrl} /><Button variant="outline" onClick={() => navigator.clipboard.writeText(latestUrl)}><Copy className="h-4 w-4" /></Button></div>}
        <div className="space-y-2">
          {(linksQuery.data?.links || []).map((link) => {
            const active = !link.revokedAt && new Date(link.expiresAt).getTime() > Date.now();
            return <div key={link.id} className="border rounded p-3 flex flex-wrap gap-3 items-center text-sm">
              <strong>{teachersById.get(link.teacherId)?.teacherName || link.teacherId}</strong>
              <span>到期：{format(new Date(link.expiresAt), "yyyy/MM/dd HH:mm")}</span>
              <span>最後使用：{link.lastUsedAt ? format(new Date(link.lastUsedAt), "yyyy/MM/dd HH:mm") : "尚未使用"}</span>
              <span className={active ? "text-green-600" : "text-gray-500"}>{active ? "有效" : link.revokedAt ? "已撤銷" : "已過期"}</span>
              <div className="ml-auto flex gap-1">
                <Button size="sm" variant="outline" disabled={!active} onClick={() => createLink.mutate(link.teacherId)}><RefreshCw className="h-3.5 w-3.5 mr-1" />重新產生</Button>
                <Button size="sm" variant="destructive" disabled={!active || revokeLink.isPending} onClick={() => revokeLink.mutate(link.id)}><XCircle className="h-3.5 w-3.5 mr-1" />撤銷</Button>
              </div>
            </div>;
          })}
        </div>
      </CardContent>
    </Card>
  );
}
