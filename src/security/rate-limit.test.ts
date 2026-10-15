import { describe, expect, it } from "vitest";
import { rateLimit, resetRateLimits } from "@/security/rate-limit";

describe("rateLimit", () => {
  it("allows a window, then says how long to wait", () => {
    resetRateLimits();
    expect(rateLimit("k", 2, 10_000, 1_000)).toEqual({ ok: true });
    expect(rateLimit("k", 2, 10_000, 1_100)).toEqual({ ok: true });
    expect(rateLimit("k", 2, 10_000, 1_200)).toEqual({ ok: false, retryAfter: 10 });
    expect(rateLimit("k", 2, 10_000, 11_000)).toEqual({ ok: true });
  });
});
