// SMART redirect URI: exchanges the code, reads the patient's record, then shows the launch page.
import type { NextRequest } from "next/server";
import { callbackRoute } from "@/smart/next";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  return callbackRoute(req);
}
