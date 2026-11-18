import puppeteer, { type Browser, type Cookie, type Page } from "@cloudflare/puppeteer";
import { DurableObject } from "cloudflare:workers";
import * as amazon from "./amazon";
import { decryptJson, encryptJson } from "./crypto";

// Browser Run closes an idle session after this long. Ten minutes covers a sign-in with MFA.
const KEEP_ALIVE_MS = 10 * 60 * 1000;
const LIVE_VIEW_TTL_MS = 30 * 60 * 1000;
const AMAZON_COOKIE_DOMAIN = /(^|\.)amazon\.com$/;

export type LiveTask = "sign-in" | "checkout";

export type ShopperStatus = {
  signedIn: boolean;
  checkedAt: string | null;
  hasSavedCookies: boolean;
};

/**
 * One instance per owner. It keeps the Browser Run session id and the encrypted Amazon cookies in
 * its storage, and runs browser work one call at a time so two tool calls never fight over a tab.
 */
export class Shopper extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async openBrowser(): Promise<Browser> {
    const sessionId = this.ctx.storage.kv.get<string>("sessionId");
    if (sessionId) {
      const reused = await puppeteer.connect(this.env.BROWSER, sessionId).catch(() => undefined);
      if (reused) return reused;
    }
    const browser = await puppeteer.launch(this.env.BROWSER, { keep_alive: KEEP_ALIVE_MS });
    this.ctx.storage.kv.put("sessionId", browser.sessionId());
    const saved = await this.savedCookies();
    if (saved.length > 0) await browser.setCookie(...saved);
    return browser;
  }

  private async savedCookies(): Promise<Cookie[]> {
    const sealed = this.ctx.storage.kv.get<string>("cookies");
    if (!sealed) return [];
    return (await decryptJson(this.env.SECRET_KEY, sealed)) as Cookie[];
  }

  /** Amazon rotates session cookies on many requests, so save them after every use. */
  private async saveCookies(browser: Browser): Promise<void> {
    const cookies = (await browser.cookies()).filter((cookie) =>
      AMAZON_COOKIE_DOMAIN.test(cookie.domain.replace(/^\./, "")),
    );
    if (cookies.length === 0) return;
    this.ctx.storage.kv.put("cookies", await encryptJson(this.env.SECRET_KEY, cookies));
  }

  private withPage<T>(work: (page: Page) => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      const browser = await this.openBrowser();
      const page = await browser.newPage();
      await page.setViewport({ width: 1366, height: 900 });
      try {
        return await work(page);
      } finally {
        await this.saveCookies(browser);
        await page.close();
        await browser.disconnect();
      }
    });
  }

  status(): ShopperStatus {
    return {
      signedIn: this.ctx.storage.kv.get<boolean>("signedIn") ?? false,
      checkedAt: this.ctx.storage.kv.get<string>("checkedAt") ?? null,
      hasSavedCookies: this.ctx.storage.kv.get<string>("cookies") !== undefined,
    };
  }

  private recordSignIn(signedIn: boolean): ShopperStatus {
    this.ctx.storage.kv.put("signedIn", signedIn);
    this.ctx.storage.kv.put("checkedAt", new Date().toISOString());
    return this.status();
  }

  verifySignIn(): Promise<ShopperStatus> {
    return this.withPage(async (page) => this.recordSignIn(await amazon.isSignedIn(page)));
  }

  /**
   * Opens a tab for the owner to drive through Live View: the Amazon sign-in page, or the Whole
   * Foods cart to finish checkout. Returns the Live View URL. That URL controls a browser that is
   * signed in to Amazon, so it goes only to the owner's authenticated page, never to an MCP client.
   */
  startLiveSession(task: LiveTask): Promise<string> {
    return this.serialize(async () => {
      const browser = await this.openBrowser();
      for (const open of await browser.pages()) await open.close();
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 860 });
      await page.goto(task === "sign-in" ? amazon.URLS.signIn : amazon.URLS.cart, {
        waitUntil: "domcontentloaded",
      });
      const cdp = await page.createCDPSession();
      const { devtoolsFrontendUrl } = await cdp.send("Cloudflare.getLiveView", {
        mode: "tab",
        expiresInMs: LIVE_VIEW_TTL_MS,
      });
      await browser.disconnect();
      return devtoolsFrontendUrl;
    });
  }

  /** Called when the owner says they are done in Live View: keep the new cookies, close the tab. */
  finishLiveSession(): Promise<ShopperStatus> {
    return this.serialize(async () => {
      const browser = await this.openBrowser();
      for (const open of await browser.pages()) await open.close();
      const page = await browser.newPage();
      try {
        return this.recordSignIn(await amazon.isSignedIn(page));
      } finally {
        await this.saveCookies(browser);
        await page.close();
        await browser.disconnect();
      }
    });
  }

  async forget(): Promise<void> {
    const sessionId = this.ctx.storage.kv.get<string>("sessionId");
    if (sessionId) {
      const browser = await puppeteer.connect(this.env.BROWSER, sessionId).catch(() => undefined);
      await browser?.close();
    }
    await this.ctx.storage.deleteAll();
  }

  private withSignedInPage<T>(work: (page: Page) => Promise<T>): Promise<T> {
    return this.withPage(async (page) => {
      try {
        return await work(page);
      } catch (error) {
        if (error instanceof amazon.NotSignedInError) this.recordSignIn(false);
        throw error;
      }
    });
  }

  searchProducts(query: string, limit: number) {
    return this.withSignedInPage((page) => amazon.searchProducts(page, query, limit));
  }

  getProduct(asin: string) {
    return this.withSignedInPage((page) => amazon.getProduct(page, asin));
  }

  addToCart(asin: string, quantity: number) {
    return this.withSignedInPage((page) => amazon.addToCart(page, asin, quantity));
  }

  readCart() {
    return this.withSignedInPage((page) => amazon.readCart(page));
  }

  setCartQuantity(asin: string, quantity: number) {
    return this.withSignedInPage((page) => amazon.setCartQuantity(page, asin, quantity));
  }

  readDeliveryWindows() {
    return this.withSignedInPage((page) => amazon.readDeliveryWindows(page));
  }
}
