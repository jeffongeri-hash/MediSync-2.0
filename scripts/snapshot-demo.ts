// Saves a static, script-free copy of the /demo page (CSS inlined) for sharing.
// Usage: pnpm demo:snapshot [baseUrl] [outFile]   (server must be running)
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

async function main() {
  const base = process.argv[2] ?? "http://localhost:3000";
  const out = resolve(process.argv[3] ?? "tmp/demo-snapshot.html");

  const res = await fetch(`${base}/demo`);
  if (!res.ok) throw new Error(`GET /demo returned ${res.status}`);
  const html = await res.text();

  const head = html.match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? "";
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/)?.[1];
  if (!body) throw new Error("No <body> in /demo response");

  const title = head.match(/<title>[\s\S]*?<\/title>/)?.[0] ?? "<title>MediSync Intake Demo</title>";
  const fontLinks = head.match(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/g) ?? [];
  const cssHrefs = [...head.matchAll(/<link rel="stylesheet" href="(\/[^"]+\.css)"/g)].map((m) => m[1]!);
  const css = await Promise.all(cssHrefs.map(async (href) => (await fetch(`${base}${href}`)).text()));

  const content = body
    .replace(/<script\b[\s\S]*?<\/script>/g, "")
    .replace(/<template\b[\s\S]*?<\/template>/g, "")
    .trim();

  const page = [title, ...fontLinks, `<style>${css.join("\n")}</style>`, content].join("\n");
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, page + "\n");
  console.log(`snapshot: ${out} (${Math.round(page.length / 1024)} KB)`);
}

main().catch((err: unknown) => {
  console.error("snapshot failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
