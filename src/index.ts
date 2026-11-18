import {
  AuthorizationError,
  OAuthAuthorizationServer,
  OAuthResourceServer,
} from "@cloudflare/workers-oauth-provider";
import { env } from "cloudflare:workers";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { passwordMatches, signOwnerSession, verifyOwnerSession } from "./crypto";
import { mcpHandler, type OwnerProps } from "./mcp";
import { consentPage, ownerLoginPage, sessionPage } from "./pages";
import type { LiveTask } from "./shopper";

export { Shopper } from "./shopper";

// This server has one user: whoever knows OWNER_PASSWORD. Every MCP client acts for that owner.
const OWNER_ID = "owner";
const OWNER_COOKIE = "wfmcp_owner";
const OWNER_SESSION_MS = 12 * 60 * 60 * 1000;
const SCOPES = ["shop", "offline_access"];

const authorizationServer = new OAuthAuthorizationServer<Env>({
  issuer: env.PUBLIC_URL,
  resources: [`${env.PUBLIC_URL}/mcp`],
  scopesSupported: SCOPES,
  clientIdMetadataDocumentEnabled: true,
  // Dynamic Client Registration, for MCP clients that do not support Client ID Metadata Documents yet.
  clientRegistrationEndpoint: "/oauth/register",
});

const mcpResource = new OAuthResourceServer<Env, OwnerProps>({
  resourceMetadata: {
    resource: `${env.PUBLIC_URL}/mcp`,
    authorization_servers: [env.PUBLIC_URL],
    resource_name: "Whole Foods MCP",
  },
  requiredScopes: ["shop"],
  validateToken: (env) => (resource, token) => authorizationServer.validateToken(resource, token, env),
  handler: { fetch: (request, env, ctx) => mcpHandler(request, env, ctx) },
});

const app = new Hono<{ Bindings: Env }>();

async function isOwner(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const token = getCookie(c, OWNER_COOKIE);
  return token !== undefined && verifyOwnerSession(c.env.SECRET_KEY, token);
}

function toOwnerLogin(c: Context<{ Bindings: Env }>) {
  const url = new URL(c.req.url);
  return c.redirect(`/owner-login?next=${encodeURIComponent(url.pathname + url.search)}`);
}

app.get("/owner-login", (c) =>
  c.html(ownerLoginPage(c.req.query("next") ?? "/session", c.req.query("failed") === "1")),
);

app.post("/owner-login", async (c) => {
  const form = await c.req.formData();
  const next = String(form.get("next") ?? "/session");
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/session";
  if (!(await passwordMatches(c.env.OWNER_PASSWORD, String(form.get("password") ?? "")))) {
    return c.redirect(`/owner-login?failed=1&next=${encodeURIComponent(safeNext)}`);
  }
  const expiresAt = Date.now() + OWNER_SESSION_MS;
  setCookie(c, OWNER_COOKIE, await signOwnerSession(c.env.SECRET_KEY, expiresAt), {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    expires: new Date(expiresAt),
  });
  return c.redirect(safeNext);
});

app.on(["GET", "POST"], "/authorize", async (c) => {
  if (!(await isOwner(c))) return toOwnerLogin(c);
  const oauth = authorizationServer.getOAuthApi(c.env);
  try {
    if (c.req.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(c.req.raw);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      consent.headers.set("Content-Type", "text/html; charset=utf-8");
      return new Response(await consentPage(details, consent.handle), { headers: consent.headers });
    }
    const form = await c.req.raw.clone().formData();
    const handle = String(form.get("handle"));
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(c.req.raw, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await oauth.approveConsent(c.req.raw, handle);
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: OWNER_ID,
      metadata: {},
      scope: approved.request.scope.filter((scope) => SCOPES.includes(scope)).concat("shop"),
      props: { userId: OWNER_ID } satisfies OwnerProps,
    });
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    if (error.redirectTo) return c.redirect(error.redirectTo);
    return c.text(error.description, 400);
  }
});

const shopper = (c: Context<{ Bindings: Env }>) => c.env.SHOPPER.getByName(OWNER_ID);

app.get("/session", async (c) => {
  if (!(await isOwner(c))) return toOwnerLogin(c);
  const task: LiveTask = c.req.query("task") === "checkout" ? "checkout" : "sign-in";
  return c.html(sessionPage(task, await shopper(c).status()));
});

app.post("/session/start", async (c) => {
  if (!(await isOwner(c))) return toOwnerLogin(c);
  const form = await c.req.formData();
  const task: LiveTask = form.get("task") === "checkout" ? "checkout" : "sign-in";
  // The Live View URL controls a browser signed in to Amazon. Only the owner's browser sees it.
  return c.redirect(await shopper(c).startLiveSession(task));
});

app.post("/session/finish", async (c) => {
  if (!(await isOwner(c))) return toOwnerLogin(c);
  await shopper(c).finishLiveSession();
  return c.redirect("/session");
});

app.post("/session/forget", async (c) => {
  if (!(await isOwner(c))) return toOwnerLogin(c);
  await shopper(c).forget();
  deleteCookie(c, OWNER_COOKIE, { path: "/" });
  return c.redirect("/owner-login");
});

app.get("/", (c) => c.text(`Whole Foods MCP. Connect an MCP client to ${c.env.PUBLIC_URL}/mcp`));

const OWNER_PAGES = ["/", "/owner-login", "/authorize", "/session"];

export default {
  fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/mcp" || pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return mcpResource.fetch(request, env, ctx);
    }
    if (OWNER_PAGES.includes(pathname) || pathname.startsWith("/session/")) {
      return app.fetch(request, env, ctx);
    }
    // Discovery, client registration, and the token endpoint.
    return authorizationServer.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
