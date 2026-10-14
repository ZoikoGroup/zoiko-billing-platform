import { chromium } from 'playwright';

const SIZES = [
  [1440, 900], [1440, 560], [1440, 300], [1280, 720],
  [768, 1024], [390, 844], [320, 568],
];

const out = process.env.TEMP + '\\opencode';
const browser = await chromium.launch();
for (const [w, h] of SIZES) {
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const launcher = page.getByRole('button', { name: 'Open the Zoiko Billing assistant' });
  await launcher.waitFor({ state: 'visible', timeout: 15000 });
  await launcher.click();
  const panel = page.locator('.ab-panel');
  await panel.waitFor({ state: 'visible' });
  await page.waitForTimeout(600);
  if (w === 1440 && h === 900) await panel.screenshot({ path: `${out}\\web-panel-1440x900.png` });
  const m = await page.evaluate(() => {
    const p = document.querySelector('.ab-panel');
    if (!p) return { error: 'no panel' };
    const q = (s) => p.querySelector(s);
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), w: Math.round(b.width), h: Math.round(b.height) }; };
    const cs = (el) => { if (!el) return null; const c = getComputedStyle(el); return { flexShrink: c.flexShrink, minHeight: c.minHeight, overflowY: c.overflowY, border: c.borderTopWidth + ' ' + c.borderTopColor }; };
    const footer = q('.ab-panel__composer');
    const box = q('.ab-composer');
    const ta = q('.ab-input');
    const send = q('.ab-send');
    const disc = q('.ab-disclosure');
    const priv = q('.ab-privacy');
    return {
      innerH: window.innerHeight,
      panel: r(p), panelCss: cs(p),
      header: r(q('.ab-panel__header')),
      body: r(q('.ab-panel__body')), bodyCss: cs(q('.ab-panel__body')),
      footer: r(footer), footerCss: cs(footer),
      box: r(box), boxCss: cs(box),
      input: r(ta), inputCss: cs(ta),
      send: r(send), sendCss: cs(send),
      disc: r(disc), priv: r(priv),
      heightsMatch: ta && send ? Math.abs(r(ta).h - r(send).h) <= 1 : null,
      footerVisible: footer ? r(footer).bottom <= window.innerHeight + 1 && r(footer).top >= 0 : false,
      privOnScreen: priv ? r(priv).bottom <= window.innerHeight + 1 : false,
    };
  });
  console.log(`\n=== ${w}x${h} ===`);
  console.log(JSON.stringify(m));
  await context.close();
}
await browser.close();
