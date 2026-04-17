import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/server/db/client";

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(
  userId: string,
  userAgent?: string | null,
  ipAddress?: string | null,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await prisma.session.create({
    data: {
      tokenHash,
      userId,
      expiresAt,
      userAgent: userAgent ?? null,
      ipAddress: ipAddress ?? null,
    },
  });
  return { token, expiresAt };
}

export interface SessionUser {
  id: string;
  username: string;
  displayName: string | null;
}

export async function getSessionUser(token: string): Promise<SessionUser | null> {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const row = await prisma.session.findUnique({
    where: { tokenHash },
    include: { user: { select: { id: true, username: true, displayName: true } } },
  });
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    await prisma.session.deleteMany({ where: { tokenHash } });
    return null;
  }
  const updated = await prisma.session.updateMany({
    where: { tokenHash, expiresAt: { gt: new Date() } },
    data: {
      expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
      lastSeenAt: new Date(),
    },
  });
  if (updated.count === 0) return null;
  return row.user;
}

export async function destroySession(token: string): Promise<void> {
  if (!token) return;
  const tokenHash = hashToken(token);
  await prisma.session.deleteMany({ where: { tokenHash } });
}
