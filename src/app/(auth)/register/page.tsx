"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";

export default function RegisterPage() {
  const router = useRouter();
  const { data: boot, isLoading: bootLoading } = trpc.auth.isBootstrap.useQuery();
  const isBootstrap = boot?.isBootstrap ?? false;

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const register = trpc.auth.register.useMutation({
    onSuccess: () => {
      router.push("/");
      router.refresh();
    },
    onError: (e) => setError(e.message),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (username.length < 3) return setError("用户名至少 3 个字符");
    if (password.length < 8) return setError("密码至少 8 个字符");
    if (password !== confirm) return setError("两次密码不一致");
    if (!isBootstrap && !inviteCode) return setError("请输入邀请码");
    register.mutate({
      username,
      password,
      inviteCode: isBootstrap ? undefined : inviteCode,
    });
  }

  if (bootLoading) {
    return <p className="text-sm text-muted-foreground text-center">加载中...</p>;
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <h2 className="text-lg font-semibold text-foreground">注册</h2>

      {isBootstrap && (
        <p className="text-sm text-muted-foreground">你将成为首个管理员。</p>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="username">用户名</Label>
        <Input
          id="username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="password">密码（≥ 8 位）</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="confirm">确认密码</Label>
        <Input
          id="confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
      </div>

      {!isBootstrap && (
        <div className="space-y-1.5">
          <Label htmlFor="invite">邀请码</Label>
          <Input
            id="invite"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
            required
          />
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button type="submit" className="w-full" disabled={register.isPending}>
        {register.isPending ? "注册中..." : "注册"}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        已有账号？
        <Link href="/login" className="ml-1 text-primary hover:underline">
          去登录
        </Link>
      </p>
    </form>
  );
}
