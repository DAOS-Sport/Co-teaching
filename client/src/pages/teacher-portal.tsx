import { useEffect, useMemo, useState } from "react";
import { useParams } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { addDays, addWeeks, format, startOfWeek } from "date-fns";
import { zhTW } from "date-fns/locale";
import { ChevronLeft, ChevronRight, CheckCircle, Link2Off, RotateCcw, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import type { Schedule, TimeSlot, Venue } from "@shared/schema";

type TeacherIdentity = {
  schoolCode: string;
  teacherId: string;
  teacherName: string;
  permissions: string[];
  expiresAt: string;
};

type Feedback = {
  id: string;
  schedule_id: string;
  teacher_id: string;
  teacher_name: string;
  status: "need_coop" | "no_coop" | "reschedule";
  reschedule_date: string | null;
  reschedule_period: string | null;
  comment: string | null;
};

function consumeUrlToken(): string {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    sessionStorage.setItem("teacher_identity_token", fromUrl);
    url.searchParams.delete("token");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    return fromUrl;
  }
  return sessionStorage.getItem("teacher_identity_token") || "";
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || `HTTP ${response.status}`) as Error & { status?: number; code?: string };
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data as T;
}

export default function TeacherPortal() {
  const params = useParams<{ schoolCode?: string }>();
  const schoolCode = params.schoolCode || "";
  const [token] = useState(consumeUrlToken);
  const [currentWeek, setCurrentWeek] = useState(() => startOfWeek(new Date(), { weekStartsOn: 1 }));
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const headers = useMemo<Record<string, string>>(
    () => {
      const result: Record<string, string> = {};
      if (token) result["x-teacher-token"] = token;
      return result;
    },
    [token],
  );
  const weekStart = format(currentWeek, "yyyy-MM-dd");
  const weekEnd = format(addDays(currentWeek, 6), "yyyy-MM-dd");

  const identityQuery = useQuery<TeacherIdentity>({
    queryKey: ["teacher-identity", schoolCode, token],
    queryFn: async () => readJsonResponse(await fetch(`/api/${schoolCode}/teacher/me`, { headers })),
    enabled: !!schoolCode && !!token,
    retry: false,
  });
  const schoolQuery = useQuery<{ code: string; name: string }>({
    queryKey: ["school-public-info", schoolCode],
    queryFn: async () => readJsonResponse(await fetch(`/api/${schoolCode}/public-info`)),
    enabled: !!schoolCode,
    retry: false,
  });
  const schedulesQuery = useQuery<Schedule[]>({
    queryKey: ["teacher-schedules", schoolCode, identityQuery.data?.teacherId, weekStart, weekEnd],
    queryFn: async () => readJsonResponse(await fetch(
      `/api/${schoolCode}/teacher/schedules?startDate=${weekStart}&endDate=${weekEnd}`,
      { headers },
    )),
    enabled: !!identityQuery.data,
    retry: false,
  });
  const feedbacksQuery = useQuery<Feedback[]>({
    queryKey: ["teacher-feedbacks", schoolCode, identityQuery.data?.teacherId],
    queryFn: async () => readJsonResponse(await fetch(`/api/${schoolCode}/feedbacks`, { headers })),
    enabled: !!identityQuery.data,
    retry: false,
  });
  const timeSlotsQuery = useQuery<TimeSlot[]>({
    queryKey: [`/api/${schoolCode}/time-slots`],
    enabled: !!identityQuery.data,
  });
  const venuesQuery = useQuery<Venue[]>({
    queryKey: [`/api/${schoolCode}/venues`],
    enabled: !!identityQuery.data,
  });

  const submitFeedback = useMutation({
    mutationFn: async (data: {
      scheduleId: string;
      status: Feedback["status"];
      comment: string | null;
      rescheduleDate: string | null;
      reschedulePeriod: string | null;
    }) => readJsonResponse(await fetch(`/api/${schoolCode}/feedbacks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(data),
    })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["teacher-feedbacks", schoolCode] });
      toast({ title: "回覆已儲存" });
    },
    onError: (error: Error) => toast({ title: "儲存失敗", description: error.message, variant: "destructive" }),
  });

  useEffect(() => {
    if (identityQuery.error) sessionStorage.removeItem("teacher_identity_token");
  }, [identityQuery.error]);

  if (!schoolCode) return <InvalidLink message="教師連結缺少學校代碼" />;
  if (!token) return <InvalidLink message="連結已失效，請向管理員重新取得" />;
  if (identityQuery.isPending) return <div className="min-h-screen grid place-items-center">正在驗證教師身分…</div>;
  if (identityQuery.isError || !identityQuery.data) return <InvalidLink message="連結已失效，請向管理員重新取得" />;

  const identity = identityQuery.data;
  const feedbackBySchedule = new Map(
    (feedbacksQuery.data || [])
      .filter((feedback) => feedback.teacher_id === identity.teacherId)
      .map((feedback) => [feedback.schedule_id, feedback]),
  );
  const slots = new Map((timeSlotsQuery.data || []).map((slot) => [slot.id, slot]));
  const venues = new Map((venuesQuery.data || []).map((venue) => [venue.id, venue]));
  const schedules = [...(schedulesQuery.data || [])].sort((a, b) =>
    a.date.localeCompare(b.date) || (slots.get(a.timeSlotId)?.order || 0) - (slots.get(b.timeSlotId)?.order || 0),
  );

  return (
    <div className="min-h-screen bg-gray-50">
      <main className="max-w-4xl mx-auto p-4 sm:p-6 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>{schoolQuery.data?.name || schoolCode}｜教師協作回覆</CardTitle>
            <p className="text-muted-foreground">
              {identity.teacherName} 老師 · 連結有效至 {format(new Date(identity.expiresAt), "yyyy/MM/dd HH:mm")}
            </p>
          </CardHeader>
        </Card>

        <div className="flex items-center justify-between rounded-lg bg-white border p-3">
          <Button variant="outline" size="icon" onClick={() => setCurrentWeek((week) => addWeeks(week, -1))}><ChevronLeft /></Button>
          <div className="text-center">
            <div className="font-medium">{format(currentWeek, "yyyy/MM/dd", { locale: zhTW })}－{format(addDays(currentWeek, 6), "MM/dd", { locale: zhTW })}</div>
            <Button variant="link" size="sm" onClick={() => setCurrentWeek(startOfWeek(new Date(), { weekStartsOn: 1 }))}>回到本週</Button>
          </div>
          <Button variant="outline" size="icon" onClick={() => setCurrentWeek((week) => addWeeks(week, 1))}><ChevronRight /></Button>
        </div>

        {schedulesQuery.isPending ? (
          <div className="text-center py-12">載入課表中…</div>
        ) : schedules.length === 0 ? (
          <Card><CardContent className="py-12 text-center text-muted-foreground">本週沒有需要您處理的課程</CardContent></Card>
        ) : schedules.map((schedule) => {
          const slot = slots.get(schedule.timeSlotId);
          const venue = venues.get(schedule.venueId);
          return (
            <Card key={schedule.id}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex flex-wrap justify-between gap-2">
                  <span>{format(new Date(`${schedule.date}T00:00:00`), "M/d（EEE）", { locale: zhTW })} {slot?.period}</span>
                  <span>{schedule.className || "未命名課程"}</span>
                </CardTitle>
                <p className="text-sm text-muted-foreground">{venue?.name || ""} {slot ? `${slot.startTime}–${slot.endTime}` : ""}</p>
              </CardHeader>
              <CardContent>
                <FeedbackEditor
                  existing={feedbackBySchedule.get(schedule.id)}
                  disabled={!identity.permissions.includes("feedback:write") || submitFeedback.isPending}
                  onSubmit={(data) => submitFeedback.mutate({ scheduleId: schedule.id, ...data })}
                />
              </CardContent>
            </Card>
          );
        })}
      </main>
    </div>
  );
}

function InvalidLink({ message }: { message: string }) {
  return (
    <div className="min-h-screen bg-gray-50 grid place-items-center p-4">
      <Card className="max-w-md w-full"><CardContent className="py-10 text-center space-y-3">
        <Link2Off className="h-10 w-10 mx-auto text-red-500" />
        <h1 className="text-xl font-semibold">教師連結無法使用</h1><p className="text-muted-foreground">{message}</p>
      </CardContent></Card>
    </div>
  );
}

function FeedbackEditor({
  existing,
  disabled,
  onSubmit,
}: {
  existing?: Feedback;
  disabled: boolean;
  onSubmit: (data: { status: Feedback["status"]; comment: string | null; rescheduleDate: string | null; reschedulePeriod: string | null }) => void;
}) {
  const [status, setStatus] = useState<Feedback["status"] | "">(existing?.status || "");
  const [comment, setComment] = useState(existing?.comment || "");
  const [rescheduleDate, setRescheduleDate] = useState(existing?.reschedule_date || "");
  const [reschedulePeriod, setReschedulePeriod] = useState(existing?.reschedule_period || "");
  useEffect(() => {
    setStatus(existing?.status || "");
    setComment(existing?.comment || "");
    setRescheduleDate(existing?.reschedule_date || "");
    setReschedulePeriod(existing?.reschedule_period || "");
  }, [existing]);
  return (
    <div className="space-y-3">
      {existing && <Badge variant="outline">已有回覆，可再次修改</Badge>}
      <RadioGroup value={status} onValueChange={(value) => setStatus(value as Feedback["status"])} className="grid sm:grid-cols-3 gap-2">
        <Label className="flex items-center gap-2 border rounded p-2"><RadioGroupItem value="need_coop" /><CheckCircle className="h-4 w-4 text-blue-500" />需要協同</Label>
        <Label className="flex items-center gap-2 border rounded p-2"><RadioGroupItem value="no_coop" /><XCircle className="h-4 w-4 text-green-500" />不需要協同</Label>
        <Label className="flex items-center gap-2 border rounded p-2"><RadioGroupItem value="reschedule" /><RotateCcw className="h-4 w-4 text-orange-500" />需要調課</Label>
      </RadioGroup>
      {status === "reschedule" && <div className="grid sm:grid-cols-2 gap-2">
        <Input type="date" value={rescheduleDate} onChange={(event) => setRescheduleDate(event.target.value)} />
        <Input placeholder="調課節次，例如第3節" value={reschedulePeriod} onChange={(event) => setReschedulePeriod(event.target.value)} />
      </div>}
      <Textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="備註（選填）" maxLength={2000} />
      <Button
        disabled={disabled || !status || (status === "reschedule" && (!rescheduleDate || !reschedulePeriod))}
        onClick={() => status && onSubmit({
          status,
          comment: comment || null,
          rescheduleDate: status === "reschedule" ? rescheduleDate : null,
          reschedulePeriod: status === "reschedule" ? reschedulePeriod : null,
        })}
      >儲存回覆</Button>
    </div>
  );
}
