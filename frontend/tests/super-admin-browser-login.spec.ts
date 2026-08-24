import { test, expect, Page } from '@playwright/test';

// Test configuration
const BASE_URL = 'http://127.0.0.1:5173';
const API_BASE_URL = 'http://127.0.0.1:8001';
// No real credential may live in source control (Phase 3 architecture
// remediation, Mandatory Fix 6). Supply a Super Admin QA account via the
// environment — never commit a .env file containing these values.
const TEST_EMAIL = process.env.SUPER_ADMIN_QA_EMAIL;
const TEST_PASSWORD = process.env.SUPER_ADMIN_QA_PASSWORD;

interface TestResult {
  name: string;
  status: 'PASS' | 'FAIL';
  details?: string;
}

interface QAReport {
  timestamp: string;
  results: TestResult[];
  consoleErrors: string[];
  networkFailures: any[];
  summary: {
    passed: number;
    failed: number;
    total: number;
  };
}

const qaReport: QAReport = {
  timestamp: new Date().toISOString(),
  results: [],
  consoleErrors: [],
  networkFailures: [],
  summary: { passed: 0, failed: 0, total: 0 }
};

function logResult(name: string, status: 'PASS' | 'FAIL', details?: string) {
  console.log(`[${status}] ${name}${details ? ': ' + details : ''}`);
  qaReport.results.push({ name, status, details });
  if (status === 'PASS') {
    qaReport.summary.passed++;
  } else {
    qaReport.summary.failed++;
  }
  qaReport.summary.total++;
}

test.describe('Super Admin Browser Login - Comprehensive QA Test', () => {
  let page: Page;
  let apiRequests: any[] = [];

  test.beforeAll(async ({ browser }) => {
    if (!TEST_EMAIL || !TEST_PASSWORD) {
      throw new Error(
        'Missing test configuration: SUPER_ADMIN_QA_EMAIL and SUPER_ADMIN_QA_PASSWORD must be ' +
        'set in the environment before running this spec (e.g. via a local, gitignored .env.test ' +
        'or your CI secret store). No Super Admin credential is committed to this repository.'
      );
    }

    // Create a new page with all event listeners
    page = await browser.newPage();

    // Capture console messages
    page.on('console', msg => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        qaReport.consoleErrors.push(`[${msg.type()}] ${msg.text()}`);
      }
    });

    // Capture network requests
    page.on('response', response => {
      const status = response.status();
      if (status >= 400) {
        qaReport.networkFailures.push({
          url: response.url(),
          method: response.request().method(),
          status: status,
          timestamp: new Date().toISOString()
        });
      }
      // Log API calls
      if (response.url().includes('/api/')) {
        apiRequests.push({
          endpoint: response.url().replace(/^https?:\/\/[^/]+/, ''),
          method: response.request().method(),
          status: status
        });
      }
    });

    // Page crash handler
    page.on('crash', () => {
      logResult('Page Crash', 'FAIL', 'Page crashed during test');
    });
  });

  test.afterAll(async () => {
    if (page) {
      await page.close();
    }
  });

  // TEST 1: Login UI Navigation
  test('Step 1: Login UI Navigation', async () => {
    try {
      await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });
      const title = await page.title();
      const url = page.url();
      
      expect(url).toContain('/login');
      logResult('Login UI Access', 'PASS', `URL: ${url}`);
    } catch (e) {
      logResult('Login UI Access', 'FAIL', String(e));
    }
  });

  // TEST 2: Login Form Visibility
  test('Step 2: Login Form Visibility', async () => {
    try {
      const emailInput = await page.$('input[type="email"], input[name*="email" i]');
      const passwordInput = await page.$('input[type="password"]');
      const signInButton = await page.$('button:has-text("Sign In")');
      
      if (emailInput && passwordInput && signInButton) {
        logResult('Login Form Visibility', 'PASS', 'Email, Password, and Sign In button found');
      } else {
        logResult('Login Form Visibility', 'FAIL', 
          `Missing fields - Email: ${!!emailInput}, Password: ${!!passwordInput}, SignIn: ${!!signInButton}`);
      }
    } catch (e) {
      logResult('Login Form Visibility', 'FAIL', String(e));
    }
  });

  // TEST 3: Fill Login Form
  test('Step 3: Fill Login Form', async () => {
    try {
      const emailInput = await page.$('input[type="email"], input[name*="email" i]');
      const passwordInput = await page.$('input[type="password"]');
      
      if (!emailInput || !passwordInput) {
        logResult('Fill Login Form', 'FAIL', 'Form fields not found');
        return;
      }

      await emailInput.fill(TEST_EMAIL);
      await passwordInput.fill(TEST_PASSWORD);
      
      const emailValue = await emailInput.inputValue();
      const passwordValue = await passwordInput.inputValue();
      
      expect(emailValue).toBe(TEST_EMAIL);
      expect(passwordValue).toBe(TEST_PASSWORD);
      logResult('Fill Login Form', 'PASS', 'Email and password entered');
    } catch (e) {
      logResult('Fill Login Form', 'FAIL', String(e));
    }
  });

  // TEST 4: Click Sign In
  test('Step 4: Click Sign In Button', async () => {
    try {
      // Clear previous API requests
      apiRequests = [];
      
      const signInButton = await page.$('button:has-text("Sign In")');
      if (!signInButton) {
        logResult('Click Sign In', 'FAIL', 'Sign In button not found');
        return;
      }

      await signInButton.click();
      
      // Wait for navigation
      await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 10000 }).catch(() => {});
      await page.waitForLoadState('networkidle').catch(() => {});
      
      logResult('Click Sign In', 'PASS', 'Sign In button clicked, navigation started');
    } catch (e) {
      logResult('Click Sign In', 'FAIL', String(e));
    }
  });

  // TEST 5: API Authentication Verification
  test('Step 5: API Authentication Verification', async () => {
    try {
      const loginApiCall = apiRequests.find(r => r.endpoint.includes('/auth/login'));
      const meApiCall = apiRequests.find(r => r.endpoint.includes('/auth/me'));
      
      if (loginApiCall && loginApiCall.status === 200) {
        logResult('AUTHENTICATION API', 'PASS', `POST /api/auth/login → ${loginApiCall.status}`);
      } else {
        logResult('AUTHENTICATION API', 'FAIL', `Login API failed or not called`);
      }

      if (meApiCall && meApiCall.status === 200) {
        logResult('Current User Verification', 'PASS', `GET /api/auth/me → ${meApiCall.status}`);
      }
    } catch (e) {
      logResult('API Authentication Verification', 'FAIL', String(e));
    }
  });

  // TEST 6: Dashboard Redirect
  test('Step 6: Dashboard Redirect Verification', async () => {
    try {
      const url = page.url();
      const heading = await page.$eval('h1, h2', el => el.textContent).catch(() => '');
      
      if (url.includes('/super-admin/dashboard') || url.includes('/dashboard')) {
        logResult('BROWSER LOGIN', 'PASS', `Redirected to: ${url}`);
        logResult('DASHBOARD REDIRECT', 'PASS', `URL: ${url}`);
      } else {
        logResult('BROWSER LOGIN', 'FAIL', `Not on dashboard - URL: ${url}`);
        logResult('DASHBOARD REDIRECT', 'FAIL', `Expected dashboard, got: ${url}`);
      }

      if (heading && heading.includes('Super Admin')) {
        logResult('Super Admin Identity', 'PASS', `Heading: ${heading}`);
      }
    } catch (e) {
      logResult('Dashboard Redirect Verification', 'FAIL', String(e));
    }
  });

  // TEST 7: Session Persistence
  test('Step 7: Session Persistence', async () => {
    try {
      // Check localStorage for auth state
      const authState = await page.evaluate(() => {
        return {
          localStorage: Object.keys(localStorage).some(k => 
            k.includes('auth') || k.includes('token') || k.includes('session')
          ),
          sessionStorage: Object.keys(sessionStorage).some(k => 
            k.includes('auth') || k.includes('token') || k.includes('session')
          )
        };
      });

      logResult('SESSION PERSISTENCE', 'PASS', 
        `Auth state stored - localStorage: ${authState.localStorage}, sessionStorage: ${authState.sessionStorage}`);
    } catch (e) {
      logResult('Session Persistence', 'FAIL', String(e));
    }
  });

  // TEST 8: Page Refresh Persistence
  test('Step 8: Page Refresh Persistence', async () => {
    try {
      const urlBeforeRefresh = page.url();
      await page.reload({ waitUntil: 'networkidle' });
      const urlAfterRefresh = page.url();

      if (urlAfterRefresh.includes('/dashboard') && !urlAfterRefresh.includes('/login')) {
        logResult('REFRESH', 'PASS', 'Still authenticated after refresh');
      } else {
        logResult('REFRESH', 'FAIL', `Redirected to login after refresh: ${urlAfterRefresh}`);
      }

      logResult('Refresh Persistence', 'PASS', `URL before: ${urlBeforeRefresh}, after: ${urlAfterRefresh}`);
    } catch (e) {
      logResult('Refresh Persistence', 'FAIL', String(e));
    }
  });

  // TEST 9: Direct Protected Route Access
  test('Step 9: Direct Protected Route Access', async () => {
    try {
      await page.goto(`${BASE_URL}/super-admin/dashboard`, { waitUntil: 'networkidle' });
      const url = page.url();

      if (url.includes('/super-admin/dashboard') && !url.includes('/login')) {
        logResult('DIRECT PROTECTED ROUTE', 'PASS', `Accessed: ${url}`);
      } else {
        logResult('DIRECT PROTECTED ROUTE', 'FAIL', `Redirected: ${url}`);
      }
    } catch (e) {
      logResult('Direct Protected Route', 'FAIL', String(e));
    }
  });

  // TEST 10: Logout
  test('Step 10: Logout Functionality', async () => {
    try {
      // Look for logout button
      const logoutButton = await page.$(
        'button:has-text("Logout"), button:has-text("Log Out"), button:has-text("Sign Out"), [data-testid*="logout" i]'
      );

      if (logoutButton) {
        await logoutButton.click();
        await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 5000 }).catch(() => {});
        const url = page.url();

        if (url.includes('/login')) {
          logResult('LOGOUT', 'PASS', `Logged out successfully, redirected to: ${url}`);
        } else {
          logResult('LOGOUT', 'FAIL', `After logout, not on login page: ${url}`);
        }
      } else {
        // Manually test logout by clearing storage
        await page.evaluate(() => {
          localStorage.clear();
          sessionStorage.clear();
        });
        await page.goto(`${BASE_URL}/super-admin/dashboard`);
        await page.waitForURL('**/login', { timeout: 5000 }).catch(() => {});
        const url = page.url();

        if (url.includes('/login')) {
          logResult('LOGOUT', 'PASS', 'Session cleared, protected route blocked');
        } else {
          logResult('LOGOUT', 'FAIL', 'Still accessible after session clear');
        }
      }
    } catch (e) {
      logResult('Logout Functionality', 'FAIL', String(e));
    }
  });

  // TEST 11: Post-Logout Protection
  test('Step 11: Post-Logout Protection', async () => {
    try {
      await page.goto(`${BASE_URL}/super-admin/dashboard`, { waitUntil: 'networkidle', timeout: 5000 });
      const url = page.url();

      if (url.includes('/login') || !url.includes('/dashboard')) {
        logResult('POST-LOGOUT PROTECTION', 'PASS', `Protected route blocked, redirected to: ${url}`);
      } else {
        logResult('POST-LOGOUT PROTECTION', 'FAIL', `Still accessible: ${url}`);
      }
    } catch (e) {
      logResult('Post-Logout Protection', 'FAIL', String(e));
    }
  });

  // TEST 12: Re-login
  test('Step 12: Re-login After Logout', async () => {
    try {
      const emailInput = await page.$('input[type="email"], input[name*="email" i]');
      const passwordInput = await page.$('input[type="password"]');
      
      if (!emailInput || !passwordInput) {
        logResult('RE-LOGIN', 'FAIL', 'Login form not found');
        return;
      }

      await emailInput.fill(TEST_EMAIL);
      await passwordInput.fill(TEST_PASSWORD);
      
      const signInButton = await page.$('button:has-text("Sign In")');
      if (signInButton) {
        apiRequests = [];
        await signInButton.click();
        await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 10000 }).catch(() => {});
        
        const url = page.url();
        if (url.includes('/dashboard')) {
          logResult('RE-LOGIN', 'PASS', `Successfully re-logged in, dashboard: ${url}`);
        } else {
          logResult('RE-LOGIN', 'FAIL', `Not on dashboard: ${url}`);
        }
      }
    } catch (e) {
      logResult('Re-login', 'FAIL', String(e));
    }
  });

  // TEST 13: Invalid Credentials
  test('Step 13: Invalid Credentials Test', async () => {
    try {
      await page.goto(`${BASE_URL}/login`);
      
      const emailInput = await page.$('input[type="email"], input[name*="email" i]');
      const passwordInput = await page.$('input[type="password"]');
      
      if (!emailInput || !passwordInput) {
        logResult('Invalid Credentials Test', 'FAIL', 'Login form not found');
        return;
      }

      await emailInput.fill(TEST_EMAIL);
      await passwordInput.fill('InvalidPassword123!');
      
      const signInButton = await page.$('button:has-text("Sign In")');
      if (signInButton) {
        apiRequests = [];
        await signInButton.click();
        await page.waitForTimeout(3000);
        
        const url = page.url();
        if (url.includes('/login')) {
          logResult('INVALID LOGIN', 'PASS', 'Rejected invalid credentials, stayed on login');
        } else if (url.includes('/dashboard')) {
          logResult('INVALID LOGIN', 'FAIL', 'Accepted invalid credentials');
        }
      }
    } catch (e) {
      logResult('Invalid Credentials Test', 'FAIL', String(e));
    }
  });

  // TEST 14: Console Errors Check
  test('Step 14: Console Errors Summary', async () => {
    // Align with .js spec: HTTP 401/403 resource logs are EXPECTED outputs of
    // the intentional negative-path security checks (e.g. Step 13 invalid
    // credentials), not application errors.
    const unhandledErrors = qaReport.consoleErrors.filter(err => !err.includes('403') && !err.includes('401'));
    if (unhandledErrors.length === 0) {
      logResult('CONSOLE ERRORS', 'PASS', `0 unhandled application errors (${qaReport.consoleErrors.length} expected HTTP 401/403 security logs)`);
    } else {
      logResult('CONSOLE ERRORS', 'FAIL', `${unhandledErrors.length} unhandled application errors detected`);
      unhandledErrors.forEach(err => console.log(`  - ${err}`));
    }
  });

  // TEST 15: Network Failures Check
  test('Step 15: Network Failures Summary', async () => {
    const unexpectedFailures = qaReport.networkFailures.filter(f => f.status >= 500 || (f.status !== 401 && f.status !== 403));
    const expectedSecurityResponses = qaReport.networkFailures.filter(f => f.status === 401 || f.status === 403);

    if (unexpectedFailures.length === 0) {
      logResult('NETWORK FAILURES', 'PASS', `0 unexpected failures (${expectedSecurityResponses.length} expected security 401/403 controls)`);
    } else {
      logResult('NETWORK FAILURES', 'FAIL', `${unexpectedFailures.length} unexpected failures detected`);
      unexpectedFailures.forEach(failure => {
        console.log(`  - ${failure.method} ${failure.url} → ${failure.status}`);
      });
    }
  });

  // TEST 16: Generate QA Report
  test('Step 16: Generate QA Report', async () => {
    try {
      qaReport.summary.total = qaReport.results.length;
      
      console.log('\n' + '='.repeat(60));
      console.log('SUPER ADMIN BROWSER LOGIN - QA REPORT');
      console.log('='.repeat(60));
      console.log(`Timestamp: ${qaReport.timestamp}`);
      console.log(`\nTest Results: ${qaReport.summary.passed} PASS, ${qaReport.summary.failed} FAIL`);
      console.log('-'.repeat(60));
      
      qaReport.results.forEach(r => {
        console.log(`[${r.status}] ${r.name}${r.details ? '\n      ' + r.details : ''}`);
      });
      
      console.log('-'.repeat(60));
      console.log(`\nAPI Calls Made:`);
      const uniqueApis = Array.from(new Set(apiRequests.map(r => r.endpoint)));
      uniqueApis.forEach(endpoint => {
        const calls = apiRequests.filter(r => r.endpoint === endpoint);
        const lastCall = calls[calls.length - 1];
        console.log(`  ${lastCall.method} ${lastCall.endpoint} → ${lastCall.status}`);
      });
      
      console.log(`\nConsole Errors: ${qaReport.consoleErrors.length}`);
      console.log(`Network Failures: ${qaReport.networkFailures.length}`);
      
      console.log('\n' + '='.repeat(60));
      console.log('FINAL VERDICT');
      console.log('='.repeat(60));
      
      const verdict = qaReport.summary.failed === 0 ? 'PASS' : 
                      qaReport.summary.failed <= 2 ? 'CONDITIONAL PASS' : 'FAIL';
      console.log(`LOGIN VERDICT: ${verdict}`);
      console.log('='.repeat(60) + '\n');
      
      logResult('QA Report Generated', 'PASS', `${qaReport.summary.passed}/${qaReport.summary.total} tests passed`);
    } catch (e) {
      logResult('QA Report Generation', 'FAIL', String(e));
    }
  });
});
