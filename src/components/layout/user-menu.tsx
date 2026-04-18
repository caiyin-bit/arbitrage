"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

export function UserMenu() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data: me } = trpc.auth.me.useQuery();
  const logout = trpc.auth.logout.useMutation({
    onSuccess: () => {
      router.push("/login");
      router.refresh();
    },
  });

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open]);

  if (!me) return null;

  const label = (me.displayName ?? me.username).slice(0, 1).toUpperCase();

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-semibold text-foreground hover:bg-accent transition-colors"
        aria-label="User menu"
      >
        {label}
      </button>
      {open && (
        <div
          className={cn(
            "absolute right-0 top-full mt-2 w-56 rounded-lg border border-border bg-card shadow-lg",
            "text-sm",
          )}
        >
          <div className="px-3 py-2 border-b border-border">
            <div className="font-medium text-foreground">
              {me.displayName ?? me.username}
            </div>
            <div className="text-xs text-muted-foreground">@{me.username}</div>
          </div>
          <Link
            href="/settings?tab=invites"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 hover:bg-accent text-foreground"
          >
            邀请码管理
          </Link>
          <button
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
            className="w-full text-left px-3 py-2 hover:bg-accent text-destructive disabled:opacity-50"
          >
            {logout.isPending ? "登出中..." : "退出登录"}
          </button>
        </div>
      )}
    </div>
  );
}
