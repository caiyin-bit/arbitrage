import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "arb_session";

const PROTECTED_PREFIXES = ["/", "/opportunities", "/positions", "/backtest", "/settings"];
const PUBLIC_PATHS = ["/login", "/register"];
const PUBLIC_PREFIXES = ["/api/trpc", "/api/health", "/_next", "/favicon"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Always allow public paths and prefixes
  if (PUBLIC_PATHS.includes(pathname)) return NextResponse.next();
  for (const p of PUBLIC_PREFIXES) {
    if (pathname === p || pathname.startsWith(`${p}/`)) return NextResponse.next();
  }

  // Check if this is a protected route
  const isProtected =
    pathname === "/" ||
    PROTECTED_PREFIXES.some((p) => p !== "/" && (pathname === p || pathname.startsWith(`${p}/`)));
  if (!isProtected) return NextResponse.next();

  // If protected, check for session cookie
  if (req.cookies.get(SESSION_COOKIE)?.value) {
    return NextResponse.next();
  }

  // No session cookie on protected route - redirect to login
  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = `?next=${encodeURIComponent(pathname + req.nextUrl.search)}`;
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
