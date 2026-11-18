import type { ElementHandle, Page } from "@cloudflare/puppeteer";

export const AMAZON = "https://www.amazon.com";
// The Whole Foods Market storefront id on amazon.com (base64 of "UFG Whole Foods").
export const WHOLE_FOODS_BRAND_ID = "VUZHIFdob2xlIEZvb2Rz";

export const URLS = {
  home: AMAZON,
  signIn: `${AMAZON}/ap/signin?openid.pape.max_auth_age=0&openid.return_to=${encodeURIComponent(`${AMAZON}/`)}&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=usflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0`,
  search: (query: string) => `${AMAZON}/s?k=${encodeURIComponent(query)}&i=wholefoods`,
  product: (asin: string) =>
    `${AMAZON}/dp/${encodeURIComponent(asin)}?almBrandId=${WHOLE_FOODS_BRAND_ID}&fpw=alm`,
  cart: `${AMAZON}/cart/localmarket?almBrandId=${WHOLE_FOODS_BRAND_ID}`,
};

/**
 * Every selector the automation depends on. Amazon changes its markup without notice; when a tool
 * starts returning `pageText` instead of structured data, this is the object to update.
 */
export const SELECTORS = {
  accountGreeting: "#nav-link-accountList-nav-line-1",
  searchResult: '[data-component-type="s-search-result"][data-asin]',
  searchResultTitle: "h2",
  price: ".a-price .a-offscreen",
  unitPrice: ".a-price[data-a-size='mini'] .a-offscreen, .a-size-base.a-color-secondary",
  image: "img.s-image",
  productTitle: "#productTitle",
  productPrice: "#corePrice_feature_div .a-offscreen, #corePriceDisplay_desktop_feature_div .a-offscreen, .a-price .a-offscreen",
  productAvailability: "#availability",
  productBullets: "#feature-bullets li",
  quantitySelect: "select#quantity, select[name='quantity']",
  addToCartButtons: [
    "#freshAddToCartButton input",
    "#freshAddToCartButton button",
    "input#add-to-cart-button",
    "input[name='submit.add-to-cart']",
  ],
  cartItem: ".sc-list-item[data-asin]",
  cartItemTitle: ".sc-product-title, .a-truncate-full",
  cartSubtotal: "#sc-subtotal-amount-activecart, #sc-subtotal-amount-buybox",
  cartItemDelete: "input[value='Delete'], [data-action='delete'] input",
  cartItemQuantity: "select[name='quantity']",
  checkoutButtons: [
    `input[name='proceedToALMCheckout-${WHOLE_FOODS_BRAND_ID}']`,
    "input[name^='proceedToALMCheckout']",
    "[data-feature-id='proceed-to-checkout-action'] input",
  ],
};

// Errors lose their class across Durable Object RPC, so callers match on this message.
export const NOT_SIGNED_IN = "Amazon is not signed in.";

export class NotSignedInError extends Error {
  constructor() {
    super(NOT_SIGNED_IN);
  }
}

const PAGE_TEXT_LIMIT = 6000;
const TIME_OF_DAY = /\b\d{1,2}(:\d{2})?\s?(AM|PM)\b/i;

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  if (page.url().includes("/ap/signin")) throw new NotSignedInError();
}

/** Visible text of the main content, for the model to read when structured extraction fails. */
export async function pageText(page: Page): Promise<string> {
  const text = await page.evaluate(() => {
    const main = document.querySelector("main, #dp, #search, #sc-active-cart, #a-page") ?? document.body;
    return (main as HTMLElement).innerText;
  });
  return text.replace(/\n{3,}/g, "\n\n").slice(0, PAGE_TEXT_LIMIT);
}

export async function isSignedIn(page: Page): Promise<boolean> {
  await page.goto(URLS.home, { waitUntil: "domcontentloaded", timeout: 45_000 });
  const greeting = await page
    .$eval(SELECTORS.accountGreeting, (element) => element.textContent ?? "")
    .catch(() => "");
  return greeting !== "" && !/sign in/i.test(greeting);
}

async function clickFirst(page: Page, selectors: string[]): Promise<string | undefined> {
  for (const selector of selectors) {
    const element = await page.$(selector);
    if (element) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined),
        element.click(),
      ]);
      return selector;
    }
  }
  return undefined;
}

/** Clicks the first button or link whose visible text matches, for pages without stable ids. */
async function clickByText(page: Page, pattern: RegExp): Promise<boolean> {
  const handle = await page.evaluateHandle((source) => {
    const regex = new RegExp(source, "i");
    const candidates = document.querySelectorAll<HTMLElement>(
      "button, a, input[type='submit'], span.a-button-inner",
    );
    return [...candidates].find((element) => {
      const label = element instanceof HTMLInputElement ? element.value : element.innerText;
      return regex.test(label?.trim() ?? "") && element.offsetParent !== null;
    });
  }, pattern.source);
  const element = handle.asElement() as ElementHandle<Element> | null;
  if (!element) return false;
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined),
    element.click(),
  ]);
  return true;
}

export type SearchResult = {
  asin: string;
  title: string;
  price: string | null;
  unitPrice: string | null;
  imageUrl: string | null;
  url: string;
};

export async function searchProducts(page: Page, query: string, limit: number) {
  await open(page, URLS.search(query));
  const results: SearchResult[] = await page.evaluate(
    (selectors, max, base) =>
      [...document.querySelectorAll<HTMLElement>(selectors.searchResult)]
        .filter((element) => element.dataset.asin)
        .slice(0, max)
        .map((element) => ({
          asin: element.dataset.asin as string,
          title: element.querySelector(selectors.searchResultTitle)?.textContent?.trim() ?? "",
          price: element.querySelector(selectors.price)?.textContent?.trim() ?? null,
          unitPrice: element.querySelector(selectors.unitPrice)?.textContent?.trim() ?? null,
          imageUrl: element.querySelector<HTMLImageElement>(selectors.image)?.src ?? null,
          url: `${base}/dp/${element.dataset.asin}`,
        })),
    SELECTORS,
    limit,
    AMAZON,
  );
  return results.length > 0 ? { results } : { results, pageText: await pageText(page) };
}

export async function getProduct(page: Page, asin: string) {
  await open(page, URLS.product(asin));
  const product = await page.evaluate((selectors) => {
    const text = (selector: string) => document.querySelector(selector)?.textContent?.trim() ?? null;
    return {
      title: text(selectors.productTitle),
      price: text(selectors.productPrice),
      availability: text(selectors.productAvailability),
      details: [...document.querySelectorAll(selectors.productBullets)]
        .map((element) => element.textContent?.trim() ?? "")
        .filter(Boolean),
      canAddToCart: selectors.addToCartButtons.some((selector) => document.querySelector(selector)),
    };
  }, SELECTORS);
  return product.title
    ? { asin, url: URLS.product(asin), ...product }
    : { asin, url: URLS.product(asin), pageText: await pageText(page) };
}

export type CartItem = { asin: string; title: string; quantity: number; price: string | null };

export async function readCart(page: Page) {
  await open(page, URLS.cart);
  const cart = await page.evaluate((selectors) => {
    const items = [...document.querySelectorAll<HTMLElement>(selectors.cartItem)].map((element) => ({
      asin: element.dataset.asin as string,
      title: element.querySelector(selectors.cartItemTitle)?.textContent?.trim() ?? "",
      quantity: Number(element.dataset.quantity ?? "0"),
      price: element.dataset.price ? `$${element.dataset.price}` : null,
    }));
    const subtotal = document.querySelector(selectors.cartSubtotal)?.textContent?.trim() ?? null;
    return { items, subtotal };
  }, SELECTORS);
  return cart.items.length > 0 || cart.subtotal
    ? { url: URLS.cart, ...cart }
    : { url: URLS.cart, ...cart, pageText: await pageText(page) };
}

export async function addToCart(page: Page, asin: string, quantity: number) {
  await open(page, URLS.product(asin));
  if (quantity > 1 && (await page.$(SELECTORS.quantitySelect))) {
    await page.select(SELECTORS.quantitySelect, String(quantity));
  }
  const clicked = await clickFirst(page, SELECTORS.addToCartButtons);
  if (!clicked) {
    return { added: false, reason: "No add-to-cart button found on the product page.", pageText: await pageText(page) };
  }
  const cart = await readCart(page);
  const line = cart.items.find((item) => item.asin === asin);
  return { added: Boolean(line), cartLine: line ?? null, cart };
}

export async function setCartQuantity(page: Page, asin: string, quantity: number) {
  await open(page, URLS.cart);
  const row = await page.$(`${SELECTORS.cartItem}[data-asin="${asin}"]`);
  if (!row) return { updated: false, reason: `ASIN ${asin} is not in the Whole Foods cart.`, cart: await readCart(page) };

  if (quantity === 0) {
    const deleteButton = await row.$(SELECTORS.cartItemDelete);
    if (!deleteButton) return { updated: false, reason: "No delete control found.", pageText: await pageText(page) };
    await deleteButton.click();
  } else {
    const select = await row.$(SELECTORS.cartItemQuantity);
    if (!select) return { updated: false, reason: "No quantity control found.", pageText: await pageText(page) };
    await select.select(String(quantity));
  }
  await page.waitForNetworkIdle({ idleTime: 750, timeout: 15_000 }).catch(() => undefined);
  const cart = await readCart(page);
  const line = cart.items.find((item) => item.asin === asin);
  return { updated: quantity === 0 ? !line : line?.quantity === quantity, cart };
}

/**
 * Walks from the Whole Foods cart to the delivery-window step and returns what the page shows.
 * It never selects a window and never places an order.
 */
export async function readDeliveryWindows(page: Page) {
  await open(page, URLS.cart);
  if (!(await clickFirst(page, SELECTORS.checkoutButtons)) && !(await clickByText(page, /check ?out whole foods/))) {
    return { reachedDeliveryStep: false, reason: "No Whole Foods checkout button in the cart.", pageText: await pageText(page) };
  }
  // Amazon shows one to three interstitials ("Before you checkout", substitutions) before the slots.
  for (let step = 0; step < 3; step++) {
    if (TIME_OF_DAY.test(await pageText(page))) break;
    if (!(await clickByText(page, /^continue/))) break;
  }
  const text = await pageText(page);
  return {
    reachedDeliveryStep: TIME_OF_DAY.test(text),
    url: page.url(),
    pageText: text,
  };
}
