// SMART standalone launch: the app starts the flow itself; the server picks (or asks for) the patient.
import type { NextRequest } from "next/server";
import { launchRoute } from "@/smart/next";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  return launchRoute(req, "standalone");
}
