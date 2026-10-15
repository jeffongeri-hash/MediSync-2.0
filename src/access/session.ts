import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authorizeToken, type Permission } from "@/access";

export type PageActor = {
  actor: string;
  role: "open" | "reviewer" | "exporter" | "auditor";
  key: string;
};

/** Reviewer session for server pages and actions. Open when no tokens are configured. */
export const pageActor = cache(async (permission: Permission): Promise<PageActor> => {
  const token = (await cookies()).get("medisync_session")?.value;
  const access = authorizeToken(token, permission);
  if (!access.ok) {
    const q = access.status === 403 ? "?error=This token cannot open the review pages." : "";
    redirect(`/sign-in${q}`);
  }
  if (access.role === "open") return { actor: "demo:provider", role: "open", key: "open" };
  return { actor: access.role, role: access.role, key: access.key };
});
