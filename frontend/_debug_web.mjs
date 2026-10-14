import { chromium } from 'playwright';

const out = process.env.TEMP + '\\opencode';
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await page.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle' }).catch(() => {});
await page.waitForTimeout(4000);
console.log('before click panel', await page.locator('.ab-panel').count());
await page.evaluate(() => document.querySelector('.ab-launcher')?.click());
await page.waitForTimeout(2000);
const n = await page.locator('.ab-panel').count();
console.log('after dom click panel', n);
if (!n) {
  const ob = await page.locator('.ab-launcher').boundingBox();
  console.log('launcher box', JSON.stringify(ob));
  if (ob) {
    const top = await page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return el ? el.className + ' | ' + el.tagName : 'none';
    }, [ob.x + ob.width / 2, ob.y + ob.height / 2]);
    console.log('elementFromPoint at launcher', top);
  }
}
const state = await page.evaluate(() => ({ body: document.body.getAttribute('class') }));
console.log(JSON.stringify(state));
await page.screenshot({ path: `${out}\\web-debug2.png` });
await browser.close();
