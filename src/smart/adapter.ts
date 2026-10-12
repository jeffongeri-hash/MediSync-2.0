// fhirclient adapter for Next.js App Router route handlers. fhirclient 3 ships adapters for the browser, Node's
// req/res and hapi only; this one works on a plain URL and records the redirect instead of writing a response.
// The caller passes a URL holding only the parameters it has validated, so fhirclient never sees a clientId,
// fhirServiceUrl or patientId taken from the query string.
import Client from "fhirclient/Client";
import * as security from "fhirclient/security/server";
import { authorize, ready } from "fhirclient/smart";
import type { SessionStorage } from "@/smart/session";

export type AuthorizeOptions = {
  clientId: string;
  scope: string;
  redirectUri: string;
  iss: string;
  launch?: string;
};

export class RouteAdapter {
  readonly security = security;
  readonly options: Record<string, unknown> = {};
  redirectedTo: string | null = null;

  constructor(
    private readonly url: URL,
    private readonly storage: SessionStorage,
  ) {}

  getUrl(): URL {
    return new URL(this.url.href);
  }
  relative(path: string): string {
    return new URL(path, this.url.href).href;
  }
  redirect(location: string): void {
    this.redirectedTo = location;
  }
  getStorage(): SessionStorage {
    return this.storage;
  }
  btoa(str: string): string {
    return Buffer.from(str).toString("base64");
  }
  atob(str: string): string {
    return Buffer.from(str, "base64").toString("ascii");
  }
  base64urlencode(input: string | Uint8Array): string {
    return Buffer.from(input).toString("base64url");
  }
  base64urldecode(input: string): string {
    return Buffer.from(input, "base64url").toString();
  }
  getSmartApi() {
    return {
      ready: (...args: unknown[]) => ready(this as never, ...(args as [])),
      authorize: (o: Record<string, unknown>) => authorize(this as never, o),
      client: (state: unknown) => new Client(this as never, state as never),
      options: this.options,
    };
  }
}

/** Discovers the server's endpoints and returns the authorization URL (PKCE S256 required; state saved in storage). */
export async function authorizeUrl(
  url: URL,
  storage: SessionStorage,
  o: AuthorizeOptions,
): Promise<string> {
  const adapter = new RouteAdapter(url, storage);
  const params: Record<string, unknown> = {
    clientId: o.clientId,
    scope: o.scope,
    redirectUri: o.redirectUri,
    iss: o.iss,
    pkceMode: "required",
    completeInTarget: true,
  };
  if (o.launch) params.launch = o.launch;
  await authorize(adapter as never, params as never);
  if (!adapter.redirectedTo)
    throw new Error("fhirclient did not produce an authorization redirect");
  return adapter.redirectedTo;
}

/** Completes the code flow (state check, code + verifier for a token) and returns the authorized client. */
export async function completeAuthorization(url: URL, storage: SessionStorage): Promise<Client> {
  const adapter = new RouteAdapter(url, storage);
  return (await ready(adapter as never)) as Client;
}
