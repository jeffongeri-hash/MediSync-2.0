"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { accessConfigured, authorizeToken, SESSION_COOKIE } from "@/access";

export async function signIn(formData: FormData) {
  if (!accessConfigured()) redirect("/");
  const token = formData.get("token");
  const access = authorizeToken(typeof token === "string" ? token : undefined, "transfer.dryRun");
  if (typeof token !== "string" || !access.ok)
    redirect("/sign-in?error=That token cannot open the review pages.");
  const jar = await cookies();
  // Not Secure: `pnpm start` on localhost is http. Mark Secure when the site is HTTPS only.
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 8,
  });
  redirect("/reconcile");
}

export async function signOut() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/");
}
