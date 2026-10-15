// Next.js server start-up hook. In production, every console call on the server goes through the allowlist logger
// (src/log.ts): framework and database errors can carry patient values in their messages, and none may reach a log.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "production") {
    const { redactConsole } = await import("./src/log");
    redactConsole();
  }
}
