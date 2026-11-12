import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

let fixture;
test.beforeAll(() => { fixture = JSON.parse(readFileSync(process.env.ORX_BROWSER_FIXTURE_FILE, 'utf8')); });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('orx:locale', 'en'); localStorage.setItem('sidebar-grouping', 'projects'); });
});
const paneOf = page => { const value = new URL(page.url()).searchParams.get('pane'); return value ? JSON.parse(value) : null; };
const pathFor = (project, pane) => `/projects/${project.id}/tasks/${project.main}${pane ? `?pane=${encodeURIComponent(JSON.stringify(pane))}` : ''}`;
async function openSession(page, index) {
  const row = page.getByRole('button', { name: new RegExp(fixture.projects[index].title) }).first();
  const history = page.getByRole('button', { name: '展开历史项目', exact: true });
  const sidebar = page.getByRole('button', { name: 'Show sidebar', exact: true });
  // Auth and sidebar loading are asynchronous. Wait for a usable navigation
  // control before deciding whether the narrow/collapsed sidebar needs opening.
  await expect.poll(async () => await row.isVisible() || await history.isVisible() || await sidebar.isVisible()).toBe(true);
  // Vite intentionally opens query devtools. Close it through its actual UI;
  // forcing the row click would hide an interception failure and skip the user flow.
  const devtools = page.getByRole('button', { name: 'Close tanstack query devtools', exact: true });
  if (await devtools.isVisible()) await devtools.click({ timeout: 5000 }).catch(async error => {
    // The panel may finish closing while Playwright retries a detached button.
    if (await devtools.isVisible()) throw error;
  });
  if (!await row.isVisible()) {
    if (await history.isVisible()) await history.click();
    if (await sidebar.isVisible()) await sidebar.click();
  }
  await expect(row).toBeVisible();
  await row.click();
}
async function expectSession(page, index, pane) {
  const project = fixture.projects[index];
  await expect(page).toHaveURL(url => url.pathname === `/projects/${project.id}/tasks/${project.main}`);
  await expect.poll(() => paneOf(page)).toEqual(pane);
  const panel = page.locator('.right-pane');
  if (pane === null) await expect(panel).toHaveCount(0);
  else {
    await expect(panel).toBeVisible();
    await expect(panel.locator('.tab.active')).toBeVisible();
    if (pane.kind === 'side') await expect(panel.locator('.tab.active')).toHaveAttribute('aria-label', 'Browser side A');
    if (pane.kind === 'home' && pane.view === 'materials') await expect(panel.getByText('当前对话暂无上传材料。', { exact: true })).toBeVisible();
  }
}
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

test('actual app restores warm/cold workspaces, history, case boundaries and unsaved protection', async ({ page }, info) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const side = { kind: 'side', sessionId: 'browser-a-side' };
  const materials = { kind: 'home', view: 'materials' };
  await test.step('home cold entry and cross-project sidebar restore', async () => {
    await page.goto('/projects');
    await openSession(page, 0); await expectSession(page, 0, side);
    await openSession(page, 1); await expectSession(page, 1, materials);
    await openSession(page, 0); await expectSession(page, 0, side);
    await page.screenshot({ path: info.outputPath('warm-side-restored.png'), fullPage: true });
  });
  await test.step('back, forward and cold refresh retain the selected pane', async () => {
    await page.goBack(); await expectSession(page, 1, materials);
    await page.goForward(); await expectSession(page, 0, side);
    await page.reload(); await expectSession(page, 0, side);
  });
  await test.step('a later home click cancels a slow old read', async () => {
    await page.goto('/projects');
    const pending = deferred(), release = deferred(), completed = deferred();
    const pattern = `**/api/projects/${fixture.projects[0].id}/ui-state`;
    await page.route(pattern, async route => {
      pending.resolve(); await release.promise;
      // Even an aborted request must finish its Playwright route handler.
      // Skipping it leaves unrouteAll(wait) waiting for an unresolved route.
      try { await route.continue(); }
      finally { completed.resolve(); }
    });
    try {
      await openSession(page, 0); await pending.promise;
      await openSession(page, 1); await expectSession(page, 1, materials);
      release.resolve(); await completed.promise;
      await expectSession(page, 1, materials);
    } finally { release.resolve(); await page.unrouteAll({ behavior: 'wait' }); }
  });
  await test.step('a failed cold read stays on home and a new click retries', async () => {
    await page.goto('/projects');
    let first = true;
    const pattern = `**/api/projects/${fixture.projects[0].id}/ui-state`;
    await page.route(pattern, route => {
      if (first) { first = false; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic workspace read failure' }) }); }
      return route.continue();
    });
    try {
      await openSession(page, 0);
      await expect(page.getByText('Synthetic workspace read failure', { exact: true })).toBeVisible();
      expect(new URL(page.url()).pathname).toBe('/projects');
      await openSession(page, 0); await expectSession(page, 0, side);
    } finally { await page.unrouteAll({ behavior: 'wait' }); }
  });
  await test.step('closed and research panes retain their distinct states', async () => {
    await openSession(page, 2); await expectSession(page, 2, null);
    await openSession(page, 3); await expectSession(page, 3, { kind: 'home', view: 'research' });
  });
  await test.step('same project ID in a case cannot contaminate personal restoration', async () => {
    const research = { kind: 'home', view: 'research' };
    await page.goto(`/cases/browser-case?pane=${encodeURIComponent(JSON.stringify(research))}`);
    await expect(page.locator('.right-pane')).toBeVisible();
    const stored = await page.request.get(`${fixture.backend}/api/projects/${fixture.projects[0].id}/ui-state`);
    expect(stored.ok()).toBe(true);
    expect((await stored.json()).tasks[fixture.projects[0].main].active).toEqual(side);
    await openSession(page, 0); await expectSession(page, 0, side);
    await page.goto(`/cases/browser-case?pane=${encodeURIComponent(JSON.stringify(research))}`);
    await expect(page.locator('.right-pane')).toBeVisible();
    expect(paneOf(page)).toEqual(research);
    await page.screenshot({ path: info.outputPath('case-workspace-isolated.png'), fullPage: true });
  });
  await test.step('an unsaved file can block a cross-project restore', async () => {
    const project = fixture.projects[0];
    const file = { kind: 'file', path: 'README.md', source: 'repo' };
    await page.goto(pathFor(project, file));
    const source = page.getByRole('button', { name: 'View source', exact: true });
    await expect(source).toBeVisible();
    await source.click();
    const editor = page.locator('.file-view-editarea');
    await expect(editor).toBeVisible();
    const release = deferred();
    const pattern = `**/api/projects/${project.id}/file`;
    await page.route(pattern, async route => {
      if (route.request().method() === 'PUT') await release.promise;
      await route.continue();
    });
    try {
      await editor.fill('Synthetic unsaved browser draft\n');
      await expect(page.locator('.file-view-save-status')).toContainText(/Unsaved|未保存/i);
      const dialogEvent = page.waitForEvent('dialog');
      const navigation = openSession(page, 1);
      const dialog = await dialogEvent;
      expect(dialog.type()).toBe('confirm'); await dialog.dismiss(); await navigation;
      await expect(page).toHaveURL(url => url.pathname === `/projects/${project.id}/tasks/${project.main}`);
      await expect(editor).toHaveValue('Synthetic unsaved browser draft\n');
      await page.screenshot({ path: info.outputPath('unsaved-navigation-cancelled.png'), fullPage: true });
    } finally {
      release.resolve();
      await page.unrouteAll({ behavior: 'wait' });
    }
    await expect(page.locator('.file-view-save-status')).toHaveCount(0);
  });
  expect(errors).toEqual([]);
});

test('narrow home navigation restores the material pane and supports a collapsed sidebar', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/projects');
  await openSession(page, 1);
  await expectSession(page, 1, { kind: 'home', view: 'materials' });
  const collapse = page.getByRole('button', { name: '收起导航', exact: true });
  if (await collapse.isVisible()) await collapse.click();
  await expect(page.locator('.right-pane')).toBeVisible();
  await expect(page.locator('.right-pane').getByText('当前对话暂无上传材料。', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('narrow-collapsed-materials.png'), fullPage: true });
});
