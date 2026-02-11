import { chromium } from "playwright";
import { ProxyManager } from "./proxyManager.js";
import dotenv from "dotenv";

dotenv.config()

function parseProxyUrl(u) {
  // u = http://user:pass@ip:port
  const url = new URL(u);
  return {
    server: `${url.protocol}//${url.hostname}:${url.port}`,
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

const proxyManager = new ProxyManager(
  (process.env.PROXIES || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(parseProxyUrl)
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

function parseProductUrl(productUrl) {
  const m = productUrl.match(
    /^https?:\/\/smartstore\.naver\.com\/([^/]+)\/products\/(\d+)(?:\?.*)?$/i
  );
  if (!m) throw new Error("Bad productUrl format");
  return { storeName: m[1], productId: m[2] };
}

function looksLikeVerification(url, title) {
  if (/captcha|security|verify/i.test(url)) return true;
  if (/보안|인증|확인|captcha|security/i.test(title)) return true;
  if (!/naver\.com|smartstore\.naver\.com/i.test(url)) return true;
  return false;
}

async function tryClosePopups(page) {
  const candidates = [
    'button:has-text("닫기")',
    'a:has-text("닫기")',
    'button[aria-label*="닫기"]',
    'button[aria-label*="close"]',
    'button:has-text("Close")',
  ];
  for (const sel of candidates) {
    const btn = page.locator(sel).first();
    if ((await btn.count().catch(() => 0)) > 0) {
      try {
        await btn.click({ timeout: 800 });
        await page.waitForTimeout(150);
      } catch {}
    }
  }
}

async function naverSearch(page, text) {
  const input = page.locator("#query, input[name='query']");
  await input.first().waitFor({ state: "visible", timeout: 30_000 });
  await input.first().click({ timeout: 10_000 });
  await page.waitForTimeout(200);
  await input.first().fill(text);
  await page.keyboard.press("Enter");
}

async function clickSmartstoreResult(page, storeName) {
  const exact = page.locator(`a[href*="smartstore.naver.com/${storeName}"]`).first();
  if ((await exact.count().catch(() => 0)) > 0) {
    const [popup] = await Promise.all([
      page.waitForEvent("popup").catch(() => null),
      exact.click({ delay: 50 }).catch(() => null),
    ]);
    return popup ?? page;
  }

  const anySmartstore = page.locator('a:has-text("smartstore.naver.com")').first();
  await anySmartstore.waitFor({ timeout: 20_000 });

  const [popup] = await Promise.all([
    page.waitForEvent("popup").catch(() => null),
    anySmartstore.click({ delay: 50 }).catch(() => null),
  ]);

  return popup ?? page;
}

function armCapture(productPage, { productId, onStatus }) {
  const detailsRe = new RegExp(`/i/v2/channels/([^/]+)/products/${productId}(?:\\?|$)`, "i");
  const productBenefitsRe = new RegExp(`/i/v2/channels/([^/]+)/product-benefits/${productId}(?:\\?|$)`, "i");

  let channelUid = null;
  let detailsJson = null;
  let detailsApiUrl = null;
  let detailsStatus = null;
  let fallbackBenefitsJson = null;
  let fallbackBenefitsUrl = null;
  let fallbackBenefitsStatus = null;

  productPage.on("response", async (res) => {
    const url = res.url();

    if (!detailsJson) {
      const m = url.match(detailsRe);
      if (m) {
        detailsStatus = res.status();
        if (res.ok()) {
          try {
            detailsJson = await res.json();
            detailsApiUrl = url;
            channelUid = m[1];
            onStatus?.({ status: "running", message: "Captured product details JSON" });
          } catch {}
        }
      }
    }

    if (!fallbackBenefitsJson) {
      const m = url.match(productBenefitsRe);
      if (m) {
        fallbackBenefitsStatus = res.status();
        if (res.ok()) {
          try {
            fallbackBenefitsJson = await res.json();
            fallbackBenefitsUrl = url;
            channelUid = channelUid ?? m[1];
            onStatus?.({ status: "running", message: "Captured fallback product-benefits JSON" });
          } catch {}
        }
      }
    }
  });

  return {
    hasDetails: () => !!detailsJson,
    getDetails: () => ({ channelUid, url: detailsApiUrl, status: detailsStatus, json: detailsJson }),
    getFallbackBenefits: () => ({ url: fallbackBenefitsUrl, status: fallbackBenefitsStatus, json: fallbackBenefitsJson }),
  };
}

async function waitUntil(pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(250);
  }
  return false;
}

async function fetchJsonWithRetries(requestContext, url, { tries = 3, onStatus } = {}) {
  let lastErr = null;

  for (let i = 1; i <= tries; i++) {
    try {
      const res = await requestContext.get(url, {
        headers: {
          accept: "application/json, text/plain, */*",
          "accept-language": "ko-KR,ko;q=0.9,en;q=0.8",
        },
      });

      const status = res.status();
      onStatus?.({ status: "running", message: `benefits/by-products attempt ${i}/${tries} status=${status}` });

      if (status >= 200 && status < 300) {
        const json = await res.json().catch(() => null);
        if (json) return { ok: true, status, json };
        return { ok: false, status, json: null, error: "JSON parse failed" };
      }

      lastErr = `HTTP ${status}`;
    } catch (e) {
      lastErr = String(e?.message ?? e);
    }

    await sleep(400 * i + randInt(100, 400));
  }

  return { ok: false, status: null, json: null, error: lastErr ?? "unknown" };
}


function isLikelyNetworkOrProxyError(err) {
  const s = String(err?.message ?? err);
  return (
    s.includes("Timeout") ||
    s.includes("net::") ||
    s.includes("ERR_PROXY") ||
    s.includes("Target closed") ||
    s.includes("Navigation") ||
    s.includes("page.goto")
  );
}

async function waitUntilNotVerification(page, onStatus, timeoutMs = 8 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const url = page.url();
    const title = await page.title().catch(() => "");

    if (!looksLikeVerification(url, title)) return true;

    onStatus?.({
      status: "needs_manual",
      message: "Waiting for manual captcha. Solve it in the browser and refresh (Cmd+R).",
    });

    await page.waitForTimeout(1000);
  }

  return false;
}

class Worker {
  constructor({ headless }) {
    this.headless = headless;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.busy = false;
    this.proxy = null;
  }

  async start() {
    try{
      const proxy = proxyManager.next();
      this.proxy = proxy ?? null;

      this.browser = await chromium.launch({ headless: this.headless });
      this.context = await this.browser.newContext({
        ...(proxy ? { proxy } : {}),
        locale: "ko-KR",
        timezoneId: "Asia/Seoul",
        viewport: { width: 1280, height: 800 },
      });

      this.page = await this.context.newPage();
    } catch(err) {
      console.error("Worker start failed: ", err);
      throw err;
    }
  }

  async run({ productUrl, onStatus }) {
    try{
      const { storeName, productId } = parseProductUrl(productUrl);

      onStatus?.({ status: "running", message: "Open naver.com" });
      await this.page.goto("https://www.naver.com", { waitUntil: "domcontentloaded", timeout: 60_000 });
      await tryClosePopups(this.page);
      await sleep(randInt(200, 700));

      onStatus?.({ status: "running", message: `Search store: ${storeName}` });
      await naverSearch(this.page, storeName);
      await this.page.waitForSelector('text=/smartstore/i', { timeout: 30_000 });

      onStatus?.({ status: "running", message: "Open smartstore result" });
      const storePage = await clickSmartstoreResult(this.page, storeName);
      await storePage.waitForLoadState("domcontentloaded");

      const productPage = storePage;
      const cap = armCapture(productPage, { productId, onStatus });

      onStatus?.({ status: "running", message: "Go to product page" });
      await productPage.goto(`https://smartstore.naver.com/${storeName}/products/${productId}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });

      const title = await productPage.title().catch(() => "");
      if (looksLikeVerification(productPage.url(), title)) {
        onStatus?.({
          status: "needs_manual",
          message: "Captcha detected. Solve it and refresh page.",
        });

        const ok = await waitUntilNotVerification(productPage, onStatus, 8 * 60 * 1000);
        if (!ok) throw new Error("Manual captcha timeout");
      }

      await sleep(randInt(400, 900));
      await productPage.mouse.wheel(0, randInt(800, 1600)).catch(() => {});
      await sleep(randInt(400, 900));

      const gotDetails = await waitUntil(() => cap.hasDetails(), 8 * 60 * 1000);
      if (!gotDetails) {
        const d = cap.getDetails();
        throw new Error(`Details capture timeout. lastStatus=${d.status ?? "none"}`);
      }

      const details = cap.getDetails();
      const detailsJson = details.json;

      const channelUid = detailsJson?.channel?.channelUid || details.channelUid;
      const productNo = detailsJson?.productNo;
      const categoryId = detailsJson?.category?.categoryId;

      let benefits = { kind: null, url: null, status: null, json: null };

      if (channelUid && productNo && categoryId) {
        const byProductsUrl = `https://smartstore.naver.com/i/v2/channels/${channelUid}/benefits/by-products/${productNo}?categoryId=${categoryId}`;

        await sleep(randInt(250, 800));

        const r = await fetchJsonWithRetries(productPage.request, byProductsUrl, {
          tries: 3,
          onStatus,
        });

        if (r.ok) {
          benefits = { kind: "benefits/by-products", url: byProductsUrl, status: r.status, json: r.json };
        }
      }

      if (!benefits.json) {
        const okFallback = await waitUntil(() => cap.getFallbackBenefits()?.json, 4 * 60 * 1000);
        const fb = cap.getFallbackBenefits();
        if (okFallback && fb?.json) {
          benefits = { kind: "product-benefits", url: fb.url, status: fb.status, json: fb.json };
        } else {
          throw new Error("Benefits capture failed");
        }
      }

      try { proxyManager.markOk(this.proxy); } catch {}

      return {
        input: { productUrl, storeName, productId },
        channelUid: channelUid ?? details.channelUid ?? null,
        apis: {
          productDetails: details,
          benefits,
        },
        capturedAt: new Date().toISOString(),
      };
    } catch(err) {
      onStatus?.({ status: "error", message: String(err?.message ?? err) });

      if (isLikelyNetworkOrProxyError(err)) {
        try { proxyManager.markFail(this.proxy, 120_000); } catch {}
        try { await this._safeRestart(); } catch (restartErr) {
          console.error("Worker restart failed:", restartErr);
        }
      }

      throw err;
    }
  }

  async _safeRestart() {
    try { await this.page?.close(); } catch {}
    try { await this.context?.close(); } catch {}
    try { await this.browser?.close(); } catch {}

    const proxy = proxyManager.next();
    this.proxy = proxy ?? null;
    
    this.browser = await chromium.launch({ headless: this.headless });
    this.context = await this.browser.newContext({
      ...(proxy ? { proxy } : {}),
      locale: "ko-KR",
      timezoneId: "Asia/Seoul",
      viewport: { width: 1280, height: 800 },
    });

    this.page = await this.context.newPage();
  }
}

export class WorkerPool {
  constructor({ size = 1, headless = true }) {
    this.size = size;
    this.headless = headless;
    this.workers = [];
    this.queue = [];
  }

  async start() {
    for (let i = 0; i < this.size; i++) {
      const w = new Worker({ headless: this.headless });
      await w.start();
      this.workers.push(w);
    }
  }

  submitJob(input, onStatus) {
    return new Promise((resolve, reject) => {
      this.queue.push({ input, onStatus, resolve, reject });
      this._pump();
    });
  }

  _pump() {
    const free = this.workers.find((w) => !w.busy);
    if (!free) return;

    const item = this.queue.shift();
    if (!item) return;

    free.busy = true;

    item.onStatus?.({ status: "running", message: "Worker acquired" });

    free
      .run({ ...item.input, onStatus: item.onStatus })
      .then(item.resolve)
      .catch(item.reject)
      .finally(() => {
        free.busy = false;
        this._pump();
      });
  }
}