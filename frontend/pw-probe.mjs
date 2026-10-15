import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE || "http://localhost:5199";
const OUT = "C:/Users/DELL/AppData/Local/Temp/opencode";

async function run(label, { width, platformRole, grants, active }) {
  const browser = await chromium.launch({
    executablePath: "C:/Users/DELL/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe",
  });
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  await ctx.addInitScript(([pr]) => {
    localStorage.setItem("zoiko_billing_access", "test-token");
    localStorage.setItem(
      "zoiko_billing_user",
      JSON.stringify({
        id: 1,
        email: "sec@zoiko.com",
        role: "super_admin",
        platform_role: pr,
        first_name: "Sec",
        last_name: "Ops",
        organization_id: null,
      })
    );
  }, [platformRole]);
  const page = await ctx.newPage();
  await page.route((url) => new URL(url).pathname.startsWith("/api/"), async (route) => {
    const url = route.request().url();
    let body = "{}";
    if (url.includes("/privileged-access/active")) body = JSON.stringify(active || null);
    else if (url.includes("/privileged-access/mine")) body = JSON.stringify({ grants: grants || [] });
    else if (url.includes("privileged-access/")) body = JSON.stringify({ grants: [] });
    await route.fulfill({ status: 200, contentType: "application/json", body });
  });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

  await page.goto(BASE + "/super-admin/support-access", { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(2000);

  const buttons = await page.$$eval("button", (els) =>
    els.map((e) => e.textContent.trim()).filter(Boolean)
  );
  const heading = await page.locator("h1").first().textContent().catch(() => null);
  const text = (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 800);

  await page.screenshot({ path: `${OUT}/support-access-${label}.png`, fullPage: true });
  await browser.close();
  return { label, width, platformRole, url: page.url(), heading, buttons, errors, text };
}

const results = [];
results.push(await run("desktop-operator", { width: 1440, platformRole: "security_operator" }));
results.push(await run("desktop-no-role", { width: 1440, platformRole: null }));
results.push(await run("narrow-operator", { width: 700, platformRole: "security_operator" }));

fs.writeFileSync(`${OUT}/pw-out.json`, JSON.stringify(results, null, 2));
console.log("WROTE", results.length);
