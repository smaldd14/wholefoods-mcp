import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { html } from "hono/html";
import type { ShopperStatus } from "./shopper";

const style = html`<style>
  :root { color-scheme: light dark; --fg: #1d1d1b; --muted: #5f6368; --bg: #faf8f4; --card: #fff; --line: #e3ded4; --accent: #00674b; }
  @media (prefers-color-scheme: dark) { :root { --fg: #eceae4; --muted: #a8a49b; --bg: #161614; --card: #201f1c; --line: #34322d; --accent: #4fbf94; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
  main { max-width: 34rem; margin: 3rem auto; padding: 0 1rem; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 1.5rem; }
  h1 { font-size: 1.35rem; margin: 0 0 .75rem; }
  p, li { color: var(--muted); }
  input[type=password] { width: 100%; box-sizing: border-box; padding: .6rem .7rem; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); font: inherit; }
  button { font: inherit; padding: .55rem 1rem; border-radius: 8px; border: 1px solid var(--accent); background: var(--accent); color: #fff; cursor: pointer; }
  button.secondary { background: transparent; color: var(--fg); border-color: var(--line); }
  .row { display: flex; gap: .5rem; flex-wrap: wrap; margin-top: 1rem; }
  code { font-size: .9em; }
</style>`;

function layout(title: string, body: ReturnType<typeof html>) {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        ${style}
      </head>
      <body>
        <main><div class="card">${body}</div></main>
      </body>
    </html>`;
}

export function ownerLoginPage(next: string, failed: boolean) {
  return layout(
    "Sign in",
    html`<h1>Whole Foods MCP</h1>
      <p>Enter the server password to continue.</p>
      ${failed ? html`<p role="alert"><strong>Wrong password.</strong></p>` : ""}
      <form method="post" action="/owner-login">
        <input type="hidden" name="next" value="${next}" />
        <input type="password" name="password" autocomplete="current-password" autofocus required aria-label="Password" />
        <div class="row"><button>Continue</button></div>
      </form>`,
  );
}

export function consentPage(details: ConsentDescription, handle: string) {
  return layout(
    "Allow access",
    html`<h1>Allow ${details.clientName} to shop for you?</h1>
      ${details.clientDomain ? html`<p>Client domain: <strong>${details.clientDomain}</strong></p>` : ""}
      <p>Access will be sent to <strong>${details.redirectHost}</strong>.
        ${details.redirectIsLoopback ? "This is an app on your computer." : ""}</p>
      <p>It will be able to search Whole Foods, read and change your cart, and read delivery windows. It cannot place orders.</p>
      <form method="post" action="/authorize">
        <input type="hidden" name="handle" value="${handle}" />
        <div class="row">
          <button name="decision" value="approve">Allow</button>
          <button class="secondary" name="decision" value="deny">Deny</button>
        </div>
      </form>`,
  );
}

export function sessionPage(task: "sign-in" | "checkout", status: ShopperStatus) {
  const intro =
    task === "checkout"
      ? "Start opens your Whole Foods cart in a remote browser. Pick a delivery window and place the order there, then come back and select Done."
      : "Start opens Amazon's sign-in page in a remote browser. Sign in, including any one-time code, then come back and select Done. The server keeps the session so agents don't need you to sign in again.";
  return layout(
    "Amazon session",
    html`<h1>${task === "checkout" ? "Finish checkout" : "Amazon sign-in"}</h1>
      <p>${intro}</p>
      <ul>
        <li>Signed in: <strong>${status.signedIn ? "yes" : "no"}</strong>${status.checkedAt ? ` (checked ${status.checkedAt})` : ""}</li>
      </ul>
      <form method="post" action="/session/start" target="_blank">
        <input type="hidden" name="task" value="${task}" />
        <div class="row"><button>Start</button></div>
      </form>
      <form method="post" action="/session/finish">
        <div class="row"><button class="secondary">Done</button></div>
      </form>
      <form method="post" action="/session/forget" onsubmit="return confirm('Delete the saved Amazon session?')">
        <div class="row"><button class="secondary">Forget saved Amazon session</button></div>
      </form>`,
  );
}
