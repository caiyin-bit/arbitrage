import { describe, it, expect } from "vitest";
import { parseCookie, serializeSessionCookie, SESSION_COOKIE } from "@/server/services/auth/cookie";

describe("cookie", () => {
  it("parses a single cookie", () => {
    expect(parseCookie("a=1")).toEqual({ a: "1" });
  });

  it("parses multiple cookies", () => {
    expect(parseCookie("a=1; b=hello")).toEqual({ a: "1", b: "hello" });
  });

  it("returns {} for empty / undefined input", () => {
    expect(parseCookie("")).toEqual({});
    expect(parseCookie(undefined)).toEqual({});
  });

  it("url-decodes values", () => {
    expect(parseCookie("x=hello%20world")).toEqual({ x: "hello world" });
  });

  it("serializeSessionCookie emits HttpOnly + Lax + Path + Max-Age, no Secure in dev", () => {
    const s = serializeSessionCookie("tok123", 604800, false);
    expect(s).toContain(`${SESSION_COOKIE}=tok123`);
    expect(s).toContain("HttpOnly");
    expect(s).toContain("SameSite=Lax");
    expect(s).toContain("Path=/");
    expect(s).toContain("Max-Age=604800");
    expect(s).not.toContain("Secure");
  });

  it("serializeSessionCookie adds Secure in prod", () => {
    expect(serializeSessionCookie("tok", 604800, true)).toContain("Secure");
  });

  it("serializeSessionCookie with maxAge=0 clears cookie", () => {
    const s = serializeSessionCookie("", 0, false);
    expect(s).toContain("Max-Age=0");
  });
});
