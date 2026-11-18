import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { NOT_SIGNED_IN } from "./amazon";

export type OwnerProps = { userId: string; origin: string };

const asin = z
  .string()
  .regex(/^[A-Z0-9]{10}$/, "An ASIN is 10 uppercase letters or digits, for example B07FZ8S74R.")
  .describe("Amazon product id (ASIN) from search_products.");

function owner(): OwnerProps {
  const props = getMcpAuthContext()?.props as OwnerProps | undefined;
  if (!props?.userId) throw new Error("No authenticated owner on this request.");
  return props;
}

const shopper = () => env.SHOPPER.getByName(owner().userId);

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/** Turns a missing Amazon sign-in into a result the model can act on, instead of a stack trace. */
async function run(work: () => Promise<unknown>) {
  try {
    return json(await work());
  } catch (error) {
    if (error instanceof Error && error.message.includes(NOT_SIGNED_IN)) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Amazon is not signed in. Ask the user to open ${owner().origin}/session and sign in to Amazon, then try again.`,
          },
        ],
      };
    }
    throw error;
  }
}

const readOnly = { readOnlyHint: true, openWorldHint: true };
const changesCart = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

function createServer() {
  const server = new McpServer({ name: "wholefoods-mcp", version: "0.1.0" });

  server.registerTool(
    "amazon_session_status",
    {
      title: "Amazon session status",
      description:
        "Whether this server holds a signed-in Amazon session. Set verify to load amazon.com and check now (about 5 seconds); otherwise it returns the last known state. If not signed in, the user must sign in at the URL in the result.",
      inputSchema: z.object({ verify: z.boolean().default(false) }),
      annotations: readOnly,
    },
    async ({ verify }) => {
      const stub = shopper();
      const status = verify ? await stub.verifySignIn() : await stub.status();
      return json({ ...status, signInPage: `${owner().origin}/session` });
    },
  );

  server.registerTool(
    "search_products",
    {
      title: "Search Whole Foods",
      description:
        "Search Whole Foods Market products on Amazon. Returns ASIN, title, price, and unit price. If `results` is empty and `pageText` is present, read the page text instead.",
      inputSchema: z.object({
        query: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(30).default(10),
      }),
      annotations: readOnly,
    },
    ({ query, limit }) => run(() => shopper().searchProducts(query, limit)),
  );

  server.registerTool(
    "get_product",
    {
      title: "Get product details",
      description: "Title, price, availability, and details of one Whole Foods product.",
      inputSchema: z.object({ asin }),
      annotations: readOnly,
    },
    ({ asin }) => run(() => shopper().getProduct(asin)),
  );

  server.registerTool(
    "add_to_cart",
    {
      title: "Add to Whole Foods cart",
      description:
        "Add a product to the Whole Foods cart. Returns the cart after the change so you can confirm it.",
      inputSchema: z.object({ asin, quantity: z.number().int().min(1).max(30).default(1) }),
      annotations: changesCart,
    },
    ({ asin, quantity }) => run(() => shopper().addToCart(asin, quantity)),
  );

  server.registerTool(
    "view_cart",
    {
      title: "View Whole Foods cart",
      description: "Items, quantities, prices, and subtotal of the Whole Foods cart.",
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    () => run(() => shopper().readCart()),
  );

  server.registerTool(
    "update_cart_item",
    {
      title: "Change cart quantity",
      description: "Set the quantity of a product already in the Whole Foods cart. Quantity 0 removes it.",
      inputSchema: z.object({ asin, quantity: z.number().int().min(0).max(30) }),
      annotations: { ...changesCart, destructiveHint: true, idempotentHint: true },
    },
    ({ asin, quantity }) => run(() => shopper().setCartQuantity(asin, quantity)),
  );

  server.registerTool(
    "get_delivery_windows",
    {
      title: "Get delivery windows",
      description:
        "Go from the Whole Foods cart to the delivery step of checkout and return the delivery windows Amazon offers, as page text. It never selects a window and never places an order. Takes 15 to 40 seconds.",
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    () => run(() => shopper().readDeliveryWindows()),
  );

  server.registerTool(
    "checkout",
    {
      title: "Hand checkout to the user",
      description:
        "This server does not place orders. Returns a link where the user opens the cart in a live remote browser, picks a delivery window, and places the order themselves. Give the link to the user.",
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    async () =>
      json({
        checkoutPage: `${owner().origin}/session?task=checkout`,
        instructions:
          "Open the link, sign in with the server password if asked, and select Start. Pick a delivery window and place the order in the live browser.",
      }),
  );

  return server;
}

export const mcpHandler = createMcpHandler(createServer, { route: "/mcp" });
