"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";

function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const login = trpc.auth.login.useMutation({
    onSuccess: () => {
      const next = search.get("next");
      const safe = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
      router.push(safe);
      router.refresh();
    },
    onError: (e) => setError(e.message),
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        login.mutate({ username, password });
      }}
    >
      <h2 className="text-lg font-semibold text-foreground">登录</h2>

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
        <Label htmlFor="password">密码</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button type="submit" className="w-full" disabled={login.isPending}>
        {login.isPending ? "登录中..." : "登录"}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        还没账号？
        <Link href="/register" className="ml-1 text-primary hover:underline">
          去注册
        </Link>
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
