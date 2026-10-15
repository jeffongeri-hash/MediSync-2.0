// Every page and API response gets the security headers from src/security/headers.ts. The CSP nonce is fresh per
// request; Next.js reads it from the request's CSP header and puts it on its own scripts.
import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy, frameAncestors, securityHeaders } from "@/security/headers";

export function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy({
    nonce,
    dev: process.env.NODE_ENV === "development",
    ancestors: frameAncestors(),
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  const https =
    request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  for (const [k, v] of Object.entries(securityHeaders({ csp, https }))) response.headers.set(k, v);
  return response;
}

export const config = {
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico).*)" }],
};
