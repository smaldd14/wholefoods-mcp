# wholefoods-mcp

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/smaldd14/wholefoods-mcp)

A remote MCP server on Cloudflare Workers that shops Whole Foods Market on Amazon for you: search products, read and change the cart, and read delivery windows. It uses [Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/) to drive a real browser.

It does not place orders. The `checkout` tool gives you a link where you finish checkout yourself in a live remote browser.

## How it works

- **MCP over Streamable HTTP** at `/mcp`, protected by OAuth 2.1 (`@cloudflare/workers-oauth-provider`). Any MCP client that supports remote servers with OAuth can connect: Claude, Claude Code, Cursor, ChatGPT, and others. Clients register with Client ID Metadata Documents or Dynamic Client Registration.
- **One owner.** Approving an MCP client asks for `OWNER_PASSWORD`. Every client you approve acts on your Amazon account.
- **Amazon sign-in through Live View.** Open `/session` and select Start. Amazon's sign-in page opens in the remote browser through Browser Run [Live View](https://developers.cloudflare.com/browser-run/features/live-view/). You sign in, including MFA, and select Done. The server never sees your Amazon password.
- **Saved login.** The `Shopper` Durable Object keeps the Amazon cookies encrypted with AES-GCM under a key derived from `SECRET_KEY`. It saves them after every browser call, because Amazon rotates them, and restores them into each new browser session. It keeps a Browser Run session alive for up to 10 idle minutes and runs browser calls one at a time.
- **Live View links stay with you.** A Live View URL controls a signed-in browser, so it is shown only on your password-protected `/session` page and never sent to an MCP client.

## Tools

| Tool | What it does |
| --- | --- |
| `amazon_session_status` | Whether the server holds a signed-in Amazon session (`verify: true` checks it now) |
| `search_products` | Search Whole Foods products: ASIN, title, price, and unit price |
| `get_product` | Details for one ASIN |
| `add_to_cart` | Add an ASIN to the Whole Foods cart, then return the cart |
| `view_cart` | Cart items and subtotal |
| `update_cart_item` | Set an item's quantity (0 removes it) |
| `get_delivery_windows` | Go from the cart to the delivery step and return the windows as text. It never selects one. |
| `checkout` | Link for you to finish checkout yourself in Live View |

When a selector no longer matches Amazon's markup, a tool returns `pageText` (the visible text of the page) instead of failing, so the model can still read the page. All selectors are in `SELECTORS` in `src/amazon.ts`.

## Deploy

Requires a Workers Paid plan for Browser Run and Durable Objects.

The repo holds nothing specific to one deployment:

- The `OAUTH_KV` binding has no `id`. Wrangler creates the namespace in your account on the first deploy and keeps it linked.
- The OAuth issuer and the MCP URL are the origin each request arrives on, so a workers.dev URL and a custom domain both work with no config.
- Secrets live in your account, never in the repo.

**One click:** use the Deploy to Cloudflare button above. It copies this repo to your GitHub account, creates the resources, asks for the two secrets, and sets up Workers Builds so pushes to your copy deploy.

**From a clone:**

```sh
npm install
npx wrangler secret put OWNER_PASSWORD
openssl rand -base64 32 | npx wrangler secret put SECRET_KEY
npm run deploy
```

Then open `https://<your-worker>/session`, sign in to Amazon, and add `https://<your-worker>/mcp` to your MCP client as a remote server.

To use a custom domain, add a `routes` entry to `wrangler.jsonc` in your own copy, or add the domain in the dashboard under the Worker's Settings, Domains & Routes.

## Local development

```sh
cp .dev.vars.example .dev.vars   # fill in the values
npm run dev                      # http://localhost:8787
npm run typecheck
```

## Caveats

- **Amazon's Conditions of Use do not allow robots.** Browser Run identifies itself as a bot, so Amazon may show CAPTCHAs or block sessions. Use this only with your own account and at your own risk.
- The selectors were written without access to a signed-in Whole Foods cart. Expect to adjust them.

## License

MIT
