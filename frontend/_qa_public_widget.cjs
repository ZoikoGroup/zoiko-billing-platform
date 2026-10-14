/* eslint-disable */
// Public Billing Assistant browser QA — ZB-PUBCHAT-WF-001.
// Runs against the built Next.js marketing app on :3123 (proxies to backend :8001).
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = process.env.QA_BASE || 'http://127.0.0.1:3123/';
const OUT = process.env.TEMP + '\\opencode';
const SIZES = [[1440, 900], [768, 900], [440, 800], [390, 800], [320, 700]];

const results = { viewports: [], functional: {}, consoleErrors: [], requestsFailed: [] };

async function openPanel(page) {
  const launcher = page.locator('button[aria-label="Open the Zoiko Billing assistant"]');
  await launcher.waitFor({ state: 'visible', timeout: 20000 });
  await launcher.click();
  await page.locator('.ab-panel').waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForTimeout(500);
}

(async () => {
  const browser = await chromium.launch();

  for (const [w, h] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') results.consoleErrors.push(`${w}x${h}: ${m.text()}`); });
    page.on('requestfailed', (r) => results.requestsFailed.push(`${w}x${h}: ${r.url()} ${r.failure()?.errorText}`));

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await openPanel(page);

    const m = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const qa = (s) => Array.from(document.querySelectorAll(s));
      const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: Math.round(b.top), left: Math.round(b.left), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom), right: Math.round(b.right) }; };
      const panel = q('.ab-panel');
      const body = q('.ab-panel__body');
      const logo = q('.ab-logo');
      const de = document.documentElement;
      return {
        panel: r(panel),
        panelRadius: panel ? getComputedStyle(panel).borderTopLeftRadius : null,
        panelBorder: panel ? getComputedStyle(panel).borderTopWidth + ' ' + getComputedStyle(panel).borderTopColor : null,
        header: r(q('.ab-panel__header')),
        title: q('.ab-title')?.textContent?.trim() || null,
        status: q('.ab-status')?.textContent?.trim() || null,
        logo: logo ? { w: Math.round(r(logo).w), h: Math.round(r(logo).h), naturalW: logo.naturalWidth, naturalH: logo.naturalHeight, complete: logo.complete, alt: logo.alt } : null,
        greetingTitle: q('.ab-greeting__title')?.textContent?.trim() || null,
        greetingBody: q('.ab-greeting__body')?.textContent?.trim() || null,
        tileCount: qa('.ab-tile').length,
        tileLabels: qa('.ab-tile__label').map((e) => e.textContent.trim()),
        tileDisabled: qa('.ab-tile').every((e) => e.disabled === false),
        humanBtn: r(q('.ab-human-btn')),
        composerFooter: r(q('.ab-panel__composer')),
        composer: r(q('.ab-composer')),
        input: r(q('.ab-input')),
        send: r(q('.ab-send')),
        sendDisabled: q('.ab-send')?.disabled,
        composerFooterH: q('.ab-panel__composer') ? Math.round(q('.ab-panel__composer').getBoundingClientRect().height) : null,
        disclosure: q('.ab-disclosure')?.textContent?.trim() || null,
        privacyHref: q('.ab-privacy a')?.getAttribute('href') || null,
        placeholder: q('.ab-input')?.getAttribute('placeholder') || null,
        docOverflow: de.scrollWidth - window.innerWidth,
        panelOverflow: panel ? panel.scrollWidth - panel.clientWidth : null,
        bodyScroll: body ? { overflowY: getComputedStyle(body).overflowY, scrollable: body.scrollHeight > body.clientHeight + 2 } : null,
        footerInView: (() => { const f = q('.ab-panel__composer'); if (!f) return null; const b = f.getBoundingClientRect(); return b.bottom <= window.innerHeight + 1 && b.top >= 0; })(),
        launcherCount: qa('.ab-launcher').length,
        panelCount: qa('.ab-panel').length,
        duplicateTitle: qa('.ab-title').length,
        lang: document.documentElement.lang,
      };
    });
    m.viewport = `${w}x${h}`;
    results.viewports.push(m);
    if (w === 1440 && h === 900) await page.locator('.ab-panel').screenshot({ path: `${OUT}\\qa-panel-1440x900.png` });
    if (w === 390 && h === 800) await page.locator('.ab-panel').screenshot({ path: `${OUT}\\qa-panel-390x800.png` });
    await ctx.close();
  }

  // ── Functional suite @1440x900 ────────────────────────────────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') results.consoleErrors.push(`fn: ${m.text()}`); });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const f = {};

    await openPanel(page);
    f.headingFocusedOnOpen = await page.evaluate(() => document.activeElement?.id === 'ab-panel-title');
    f.focusVisibleOutline = await page.evaluate(() => {
      const el = document.querySelector('.ab-tile');
      el.focus();
      const s = getComputedStyle(el);
      return s.outlineStyle !== 'none' && s.outlineWidth !== '0px';
    });

    // minimize -> restore returns to prior scroll position (greeting body scrolls)
    await page.evaluate(() => { document.querySelector('.ab-panel__body').scrollTop = 40; });
    await page.waitForTimeout(150);
    const s1 = await page.evaluate(() => document.querySelector('.ab-panel__body').scrollTop);
    await page.locator('button[aria-label="Minimize assistant"]').click();
    await page.waitForTimeout(250);
    f.minimizeHidden = (await page.locator('.ab-panel').count()) === 0;
    await page.locator('.ab-launcher').click();
    await page.waitForTimeout(400);
    const s2 = await page.evaluate(() => document.querySelector('.ab-panel__body').scrollTop);
    f.greetingScrollRestore = { saved: s1, restored: s2, ok: Math.abs(s2 - s1) <= 5 };

    // overflow menu
    await page.locator('button[aria-label="More options"]').click();
    await page.waitForTimeout(150);
    f.menuItems = await page.locator('[role="menuitem"]').allInnerTexts();
    f.menuOpenCount = await page.locator('[role="menuitem"]').count();
    await page.locator('button[aria-label="More options"]').focus();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    f.menuClosedByEscape = (await page.locator('[role="menuitem"]').count()) === 0;
    f.panelStillOpenAfterMenuEscape = (await page.locator('.ab-panel').count()) === 1;
    await page.locator('button[aria-label="More options"]').click();
    await page.waitForTimeout(150);
    await page.mouse.click(20, 400);
    await page.waitForTimeout(150);
    f.menuClosedByOutside = (await page.locator('[role="menuitem"]').count()) === 0;

    // support modal (no conversation yet)
    await page.locator('.ab-human-btn').first().click();
    await page.waitForTimeout(250);
    f.supportTitle = await page.locator('#ab-support-title').textContent();
    f.supportDialogModal = await page.locator('[role="dialog"][aria-modal="true"]').count();
    f.supportLiveChatCopy = (await page.locator('.ab-modal__body > p').first().textContent()).trim();
    f.supportIssueOptions = await page.locator('.ab-field select option').allInnerTexts();
    f.submitDisabledWhenEmpty = await page.locator('button[type="submit"]').isDisabled();
    await page.locator('.ab-field input[type="email"]').fill('not-an-email');
    await page.locator('.ab-field input[type="text"]').fill('a');
    await page.locator('.ab-field input[type="text"]').blur();
    await page.waitForTimeout(250);
    f.validationErrorsShown = (await page.locator('#ab-email-error').count()) > 0 && (await page.locator('#ab-summary-error').count()) > 0;
    f.submitDisabledWhenInvalid = await page.locator('button[type="submit"]').isDisabled();
    f.ariaInvalidSet = (await page.locator('.ab-field [aria-invalid="true"]').count()) >= 2;
    f.consentShownNoConversation = (await page.locator('.ab-consent').count()) > 0;
    await page.screenshot({ path: `${OUT}\\qa-support-modal.png` });
    await page.locator('button[aria-label="Close support dialog"]').click();
    await page.waitForTimeout(200);
    f.supportClosed = (await page.locator('#ab-support-title').count()) === 0;

    // Escape guard: focus outside panel -> Escape keeps panel open
    await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
    await page.waitForTimeout(100);
    f.focusOutsidePanel = await page.evaluate(() => {
      const p = document.querySelector('.ab-panel');
      return !p || !p.contains(document.activeElement);
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    f.escapeWhenFocusOutsideKeptOpen = (await page.locator('.ab-panel').count()) === 1;
    await page.locator('button[aria-label="More options"]').focus();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    f.escapeWhenFocusInsideClosed = (await page.locator('.ab-panel').count()) === 0;
    f.launcherVisibleAfterClose = (await page.locator('.ab-launcher').count()) === 1;

    // ── Conversation phase ──
    await openPanel(page);
    await page.locator('.ab-input').fill('line1');
    await page.locator('.ab-input').press('Shift+Enter');
    await page.locator('.ab-input').type('line2');
    await page.waitForTimeout(150);
    f.shiftEnterNewline = (await page.locator('.ab-input').inputValue()).includes('\n');
    f.shiftEnterDidNotSend = (await page.locator('.ab-bubble--user').count()) === 0;
    await page.locator('.ab-input').fill('x'.repeat(2100));
    f.maxCharsEnforced = (await page.locator('.ab-input').inputValue()).length === 2000;
    await page.locator('.ab-input').fill('');

    // tile click sends the approved starter prompt
    await page.locator('.ab-tile').first().click();
    await page.waitForSelector('.ab-bubble--user', { timeout: 10000 });
    f.tileUserText = (await page.locator('.ab-bubble--user').first().textContent()).trim();
    await page.waitForFunction(() => {
      const els = document.querySelectorAll('.ab-bubble--assistant');
      return els.length >= 1 && els[els.length - 1].textContent.trim().length > 40;
    }, { timeout: 60000 });
    await page.waitForSelector('.ab-feedback button', { timeout: 30000 });
    await page.waitForTimeout(300);
    f.feedbackVisible = (await page.locator('.ab-feedback button').count()) >= 2;
    f.assistantAnswered = (await page.locator('.ab-bubble--assistant').count()) >= 1;
    f.userBubbleCount = await page.locator('.ab-bubble--user').count();
    f.assistantBubbleCount = await page.locator('.ab-bubble--assistant').count();
    f.sourcePills = await page.locator('.ab-source').count();
    f.sourceLinks = await page.locator('a.ab-source--link').count();
    f.timestampCount = await page.locator('.ab-ts').count();
    f.messageOrder = await page.evaluate(() => Array.from(document.querySelectorAll('.ab-row')).map((x) => (x.className.includes('ab-row--user') ? 'user' : 'assistant')));
    await page.locator('.ab-feedback button').first().click();
    await page.waitForTimeout(300);
    f.feedbackAck = (await page.locator('.ab-feedback--done').count()) > 0;

    // minimize / restore preserves messages + scroll
    const msgBeforeMin = await page.locator('.ab-bubble--assistant').count();
    await page.locator('button[aria-label="Minimize assistant"]').click();
    await page.waitForTimeout(250);
    f.minimizedHidden = (await page.locator('.ab-panel').count()) === 0;
    await page.locator('.ab-launcher').click();
    await page.waitForTimeout(500);
    f.restoredMsgPreserved = (await page.locator('.ab-bubble--assistant').count()) === msgBeforeMin && msgBeforeMin > 0;

    // consent appears once a conversation exists
    await page.locator('.ab-human-btn').first().click();
    await page.waitForTimeout(250);
    f.consentShownWithConversation = (await page.locator('.ab-consent').count()) > 0;
    await page.locator('button[aria-label="Close support dialog"]').click();
    await page.waitForTimeout(200);
    await page.locator('.ab-panel').screenshot({ path: `${OUT}\\qa-panel-answered.png` });

    // close (×) preserves messages on reopen
    const msgBeforeClose = await page.locator('.ab-bubble--assistant').count();
    await page.locator('button[aria-label="Close assistant"]').click();
    await page.waitForTimeout(250);
    f.closedHidden = (await page.locator('.ab-panel').count()) === 0;
    await page.locator('.ab-launcher').click();
    await page.waitForTimeout(300);
    f.closePreservesMessages = (await page.locator('.ab-bubble--assistant').count()) === msgBeforeClose;

    // new conversation resets
    await page.locator('button[aria-label="More options"]').click();
    await page.waitForTimeout(150);
    await page.locator('[role="menuitem"]', { hasText: 'New conversation' }).click();
    await page.waitForTimeout(300);
    f.newConversationResetsMessages = (await page.locator('.ab-bubble').count()) === 0;
    f.newConversationShowsTiles = (await page.locator('.ab-tile').count()) === 8;

    results.functional = f;
    await ctx.close();
  }

  // ── Keyboard-only traversal @1440x900 (staffs A09 evidence, no pointer) ────
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const k = {};
    await page.evaluate(() => document.querySelector('.ab-launcher')?.focus());
    k.launcherFocusLabel = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    k.openedByKeyboard = (await page.locator('.ab-panel').count()) === 1;
    k.headingFocused = await page.evaluate(() => document.activeElement?.id === 'ab-panel-title');
    let reachedTile = false;
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(() => document.activeElement?.classList.contains('ab-tile'))) { reachedTile = true; break; }
    }
    k.tabReachesTiles = reachedTile;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    k.escapeClosed = (await page.locator('.ab-panel').count()) === 0;
    k.focusReturnedToLauncher = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Open the Zoiko Billing assistant');
    results.keyboard = k;
    await ctx.close();
  }

  await browser.close();
  fs.writeFileSync(`${OUT}\\qa-results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
})().catch((e) => { console.error('QA FAILED:', e); process.exit(1); });
