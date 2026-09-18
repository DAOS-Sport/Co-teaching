import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";

interface PasswordProtectProps {
  children: React.ReactNode;
}

const PERSISTED_ADMIN_KEY = "admin-session";
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function persistAdminSession(password: string) {
  sessionStorage.setItem("admin_authorized", "true");
  sessionStorage.setItem("admin-password", password);
  localStorage.setItem(PERSISTED_ADMIN_KEY, JSON.stringify({
    password,
    expiresAt: Date.now() + ADMIN_SESSION_TTL_MS,
  }));
}

function restoreAdminSession(): string | null {
  const currentPassword = sessionStorage.getItem("admin-password");
  if (sessionStorage.getItem("admin_authorized") === "true" && currentPassword) {
    return currentPassword;
  }
  try {
    const raw = localStorage.getItem(PERSISTED_ADMIN_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as { password?: unknown; expiresAt?: unknown };
    if (typeof saved.password !== "string" || typeof saved.expiresAt !== "number" || saved.expiresAt <= Date.now()) {
      localStorage.removeItem(PERSISTED_ADMIN_KEY);
      return null;
    }
    return saved.password;
  } catch {
    localStorage.removeItem(PERSISTED_ADMIN_KEY);
    return null;
  }
}

export default function PasswordProtect({ children }: PasswordProtectProps) {
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  useEffect(() => {
    const savedPassword = restoreAdminSession();
    if (!savedPassword) {
      setIsLoading(false);
      return;
    }
    fetch("/api/admin/verify-password", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-password": savedPassword },
      body: JSON.stringify({}),
    }).then((res) => {
      if (!res.ok) throw new Error("expired");
      persistAdminSession(savedPassword);
      setIsAuthorized(true);
    }).catch(() => {
      sessionStorage.removeItem("admin_authorized");
      sessionStorage.removeItem("admin-password");
      localStorage.removeItem(PERSISTED_ADMIN_KEY);
    }).finally(() => setIsLoading(false));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/verify-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-password": password,
        },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        setIsAuthorized(true);
        persistAdminSession(password);
        toast({
          title: "驗證成功",
          description: "歡迎使用管理功能",
        });
      } else {
        toast({
          title: "密碼錯誤",
          description: "請輸入正確的管理密碼",
          variant: "destructive",
        });
        setPassword("");
      }
    } catch {
      toast({
        title: "連線失敗",
        description: "無法連到伺服器，請稍後再試",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-primary">載入中...</div>
      </div>
    );
  }

  if (!isAuthorized) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-center">管理功能驗證</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <Input
                  type="password"
                  placeholder="請輸入管理密碼"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  data-testid="input-password"
                />
              </div>
              <div className="space-y-2">
                <Button
                  type="submit"
                  className="w-full"
                  disabled={submitting}
                  data-testid="button-submit"
                >
                  {submitting ? "驗證中…" : "驗證"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => setLocation('/coach')}
                  data-testid="button-back-to-coach"
                >
                  返回教練視圖
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <>{children}</>;
}
