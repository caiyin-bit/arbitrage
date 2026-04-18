"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

function maskCode(code: string): string {
  if (code.length <= 12) return code;
  return `${code.slice(0, 8)}...${code.slice(-4)}`;
}

export function InvitesSection() {
  const utils = trpc.useUtils();
  const { data } = trpc.auth.listInvites.useQuery();
  const [justCreated, setJustCreated] = useState<string | null>(null);

  const create = trpc.auth.createInvite.useMutation({
    onSuccess: (out) => {
      setJustCreated(out.code);
      utils.auth.listInvites.invalidate();
    },
  });
  const revoke = trpc.auth.revokeInvite.useMutation({
    onSuccess: () => utils.auth.listInvites.invalidate(),
    onError: (e) => alert(`撤销失败: ${e.message}`),
  });

  return (
    <div id="invites" className="space-y-4">
      <h2 className="text-base font-semibold text-foreground">邀请码</h2>

      <Card className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-foreground">生成邀请码</div>
            <div className="text-xs text-muted-foreground">默认 7 天有效，单次使用</div>
          </div>
          <Button onClick={() => create.mutate()} disabled={create.isPending}>
            {create.isPending ? "生成中..." : "生成"}
          </Button>
        </div>
        {justCreated && (
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <div className="text-xs text-muted-foreground mb-1">
              邀请码（仅此一次展示，关闭后无法再取回）：
            </div>
            <div className="flex items-center gap-2">
              <code className="font-mono text-sm text-foreground">{justCreated}</code>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => navigator.clipboard.writeText(justCreated)}
              >
                复制
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Card className="p-4 space-y-2">
        <div className="text-sm font-medium text-foreground">未使用邀请码</div>
        {!data?.active.length ? (
          <div className="text-xs text-muted-foreground">（无）</div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground uppercase tracking-wide">
                <th className="text-left py-1.5">code</th>
                <th className="text-left py-1.5">创建者</th>
                <th className="text-left py-1.5">创建时间</th>
                <th className="text-left py-1.5">过期时间</th>
                <th className="text-right py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {data.active.map((inv) => (
                <tr key={inv.code} className="border-t border-border">
                  <td className="py-2 font-mono">{maskCode(inv.code)}</td>
                  <td className="py-2">{inv.creator.username}</td>
                  <td className="py-2 text-muted-foreground">
                    {new Date(inv.createdAt).toLocaleString()}
                  </td>
                  <td className="py-2 text-muted-foreground">
                    {new Date(inv.expiresAt).toLocaleString()}
                  </td>
                  <td className="py-2 text-right">
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => revoke.mutate({ code: inv.code })}
                      disabled={revoke.isPending}
                    >
                      撤销
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card className="p-4 space-y-2">
        <div className="text-sm font-medium text-foreground">已使用记录</div>
        {!data?.used.length ? (
          <div className="text-xs text-muted-foreground">（无）</div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground uppercase tracking-wide">
                <th className="text-left py-1.5">使用者</th>
                <th className="text-left py-1.5">创建者</th>
                <th className="text-left py-1.5">使用时间</th>
              </tr>
            </thead>
            <tbody>
              {data.used.map((inv) => (
                <tr key={inv.code} className="border-t border-border">
                  <td className="py-2">{inv.user?.username ?? "—"}</td>
                  <td className="py-2">{inv.creator.username}</td>
                  <td className="py-2 text-muted-foreground">
                    {inv.usedAt ? new Date(inv.usedAt).toLocaleString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
