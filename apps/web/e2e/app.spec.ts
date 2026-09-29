import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const PASSWORD = process.env.SEED_PASSWORD ?? 'demo-password-2026';
const uid = () => Math.random().toString(36).slice(2, 8);

/** Mock social accounts need SOCIAL_MOCK_MODE=true on the server; tests that connect them skip otherwise. */
let mockMode: boolean | undefined;
async function serverMockMode(request: APIRequestContext): Promise<boolean> {
  if (mockMode !== undefined) return mockMode;
  const login = await request.post('/api/v1/auth/login', { data: { email: 'owner@demo.local', password: PASSWORD } });
  if (!login.ok()) return (mockMode = false);
  const me = await (await request.get('/api/v1/auth/me')).json();
  const org = await (await request.get('/api/v1/organizations/current', { headers: { 'x-organization-id': me.organizations[0].id } })).json();
  return (mockMode = Boolean(org.mockMode));
}

async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/dashboard');
}

test('new agency: register, onboard a client, connect a mock account, generate, approve and schedule a post', async ({ page, request }) => {
  test.skip(!(await serverMockMode(request)), 'Needs the server running with SOCIAL_MOCK_MODE=true');
  await page.goto('/register');
  await page.getByLabel('Your name').fill('E2E Tester');
  await page.getByLabel('Work email').fill(`e2e-${uid()}@example.com`);
  await page.getByLabel('Password').fill('password-12345');
  await page.getByLabel('Agency or company name').fill('E2E Agency');
  await page.getByRole('button', { name: 'Create account' }).click();

  await page.waitForURL('**/onboarding');
  await page.getByLabel('Client or brand name').fill("Maple's Cafe");
  await page.getByRole('button', { name: 'Create client' }).click();

  await page.getByLabel('What the business does').fill('Neighbourhood cafe serving espresso and fresh pastries.');
  await page.getByLabel('Default call to action').fill('Visit us today');
  await page.getByRole('button', { name: 'Save brand' }).click();

  await expect(page.getByRole('heading', { name: 'Connect social accounts' })).toBeVisible();
  const facebookRow = page.locator('li', { hasText: 'Facebook' });
  await facebookRow.getByRole('button', { name: 'Add mock account' }).click();
  await expect(facebookRow).toContainText('MockFacebook');
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByRole('button', { name: 'Save settings' }).click();
  await page.getByLabel('What should the post be about?').fill('Our new autumn pastry menu');
  await page.getByRole('button', { name: 'Generate post' }).click();

  await expect(page.getByRole('heading', { name: 'Review and approve' })).toBeVisible();
  await page.getByRole('button', { name: 'Approve post' }).click();
  await expect(page.getByRole('heading', { name: 'Schedule it' })).toBeVisible();
  await page.getByRole('button', { name: /Schedule and finish/ }).click();

  await page.waitForURL('**/dashboard');
  await expect(page.getByRole('heading', { name: 'Going out next' })).toBeVisible();
  await expect(page.getByText('Our new autumn pastry menu').first()).toBeVisible();
});

test('inbox: a simulated customer message gets an AI draft that a person sends', async ({ page, request }) => {
  test.skip(!(await serverMockMode(request)), 'Needs the server running with SOCIAL_MOCK_MODE=true');
  await signIn(page, 'owner@demo.local');
  await page.goto('/inbox');
  await page.getByRole('button', { name: 'Simulate message' }).click();
  const dialog = page.getByRole('dialog');
  const accountSelect = dialog.getByLabel('Mock account');
  await expect(accountSelect.locator('option', { hasText: "Facebook: Bella's Bakery" })).toHaveCount(1);
  await accountSelect.selectOption({ label: "Facebook: Bella's Bakery (Facebook)" });
  const name = `Visitor ${uid()}`;
  await dialog.getByLabel('From').fill(name);
  await dialog.getByLabel('Message').fill('Do you deliver to Kentish Town?');
  await dialog.getByRole('button', { name: 'Send test message' }).click();

  const row = page.locator('section[aria-label="Conversations"] li', { hasText: name });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole('button').click();
  // Real AI providers take 15-30 seconds for triage, lead extraction and the draft; the mock is instant.
  await expect(page.getByLabel('Reply')).not.toHaveValue('', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Sent by your team')).toBeVisible();
});

test('permissions: a viewer sees content but cannot create it', async ({ page }) => {
  await signIn(page, 'viewer@demo.local');
  await page.goto('/content');
  await expect(page.getByRole('heading', { name: 'Content' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'New post' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Automation' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'AI content' })).toHaveCount(0);
});

test('platform admin: a super admin without memberships lands on the platform console', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('admin@socialpilot.local');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/platform-admin');
  await expect(page.getByRole('heading', { name: 'Platform admin' })).toBeVisible();
  await expect(page.getByText(/System (ok|degraded)/)).toBeVisible();
});
