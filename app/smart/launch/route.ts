// SMART EHR launch: the EHR opens this URL with `iss` and `launch`.
import type { NextRequest } from "next/server";
import { launchRoute } from "@/smart/next";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  return launchRoute(req, "ehr");
}
