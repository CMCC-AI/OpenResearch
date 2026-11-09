import { test, expect } from '@playwright/test';

// Full app/router with synthetic APIs: never send questions to a real agent.
for (const prefix of ['', '/mobilesci']) {
  test(`project plus submits exactly once before opening the conversation (${prefix || 'root'})`, async ({ page, baseURL }) => {
    const project = { id: 'handoff', name: 'Handoff fixture', repoPath: '/tmp/handoff', path: '/tmp/handoff', artifactsDir: '/tmp/handoff/files', slug: 'handoff', updatedAt: 1, createdAt: 1, baselineBranch: 'main' };
    const session = { id: 'fresh', projectId: project.id, harness: 'opencode', model: null, createdAt: 1, updatedAt: 1 };
    let creates = 0, sends = [], accepted = false, deploymentChanged = false, release;
    const delivery = new Promise(resolve => { release = resolve; });
    const question = '你好';
    await page.addInitScript(() => { localStorage.setItem('orx:locale', 'zh-CN'); localStorage.setItem('sidebar-grouping', 'projects'); });
    await page.route('**/*', async route => {
      const p = new URL(route.request().url()).pathname.replace(/^\/mobilesci/, '');
      if (p === '/index.html' && deploymentChanged) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><script type="module" src="./assets/index-next.js"></script>' });
      if (!p.startsWith('/api/') && !p.startsWith('/_orx/')) return route.continue();
      let data = {};
      if (p === '/_orx/runtime') data = { kind: 'local', version: 'test', accountUrl: baseURL };
      else if (p === '/api/platform/catalog-session') data = { user: { id: 'fixture', name: 'fixture', email: 'test@example.invalid' }, canAccessResearch: true };
      else if (p === '/api/platform/cases') data = { cases: [] };
      else if (p.endsWith('/starter-prompts')) data = { prompts: [], blank: true };
      else if (p === '/api/projects') data = { projects: [project] };
      else if (p === '/api/settings/ui-state') data = { tourCompleted: true, preferredAgent: { harness: 'opencode', model: null }, workspace: { railOpen: true } };
      else if (p === '/api/projects/handoff/ui-state') data = { version: 1, lastTaskId: null, lastLocation: null, tasks: {} };
      else if (p === '/api/harnesses') data = { harnesses: [{ id: 'opencode', name: 'OpenCode', agentReady: true, available: true, models: [], options: {} }] };
      else if (p === '/api/chat/sessions' && route.request().method() === 'POST') { creates++; data = { session }; }
      else if (p === '/api/chat/sessions') data = { sessions: creates ? [session] : [] };
      else if (p.endsWith('/message')) {
        sends.push(route.request().postDataJSON());
        if (sends.length === 1) return route.fulfill({ status: 503, json: { error: 'Synthetic send failure' } });
        await delivery; accepted = true; data = { ok: true };
      }
      else if (p.includes('/submissions/')) data = { sessionId: session.id, clientTurnId: sends[0]?.clientTurnId, submission: null };
      else if (p.endsWith('/messages')) data = { messages: accepted ? [{ id: 'user', sessionId: session.id, role: 'user', createdAt: 1, parts: [{ id: 'text', type: 'text', text: question }] }] : [], queued: [], activeLeafId: accepted ? 'user' : null };
      else if (p.endsWith('/experiments')) data = { experiments: [] };
      else if (p.endsWith('/runs')) data = { runs: [] };
      else if (p.includes('/research/sessions/')) data = { study: null, runs: [], metrics: null };
      else if (p.includes('activity')) data = { activity: [] };
      else if (p.includes('skills')) data = { skills: [] };
      else if (p.includes('events')) return route.fulfill({ contentType: 'text/event-stream', body: '' });
      await route.fulfill({ json: data });
    });
    try {
      await page.goto(`${prefix}/projects/handoff/tasks/new`);
      await expect(page).toHaveURL(url => url.pathname === `${prefix}/projects` && url.searchParams.get('project') === project.id);
      await expect(page.getByRole('heading', { name: '我们应该研究什么？' })).toHaveCount(0);
      await page.goto(`${prefix}/projects`);
      const devtools = page.getByRole('button', { name: 'Close tanstack query devtools', exact: true });
      if (await devtools.isVisible()) await devtools.click();
      await page.locator('.product-sidebar').getByRole('button', { name: /对话 · Handoff fixture$/ }).click();
      await expect(page).toHaveURL(url => url.pathname === `${prefix}/projects` && url.searchParams.get('project') === project.id);
      const input = page.locator('#research-objective');
      await input.fill(question); await input.press('Enter');
      await expect(page.getByText('Synthetic send failure', { exact: true })).toBeVisible();
      await expect(input).toHaveValue(question);
      expect(new URL(page.url()).pathname).toBe(`${prefix}/projects`);
      await expect(page.getByText('页面已更新，请保存当前输入后刷新，以使用最新版本。', { exact: true })).toHaveCount(0);
      deploymentChanged = true;
      await page.clock.setFixedTime(Date.now() + 20000);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(page.getByText('页面已更新，请保存当前输入后刷新，以使用最新版本。', { exact: true })).toBeVisible();
      await expect(input).toHaveValue(question);
      expect(new URL(page.url()).pathname).toBe(`${prefix}/projects`);
      await input.press('Enter');
      await expect.poll(() => sends.length).toBe(2);
      expect(creates).toBe(1);
      expect(sends[1]).toEqual(sends[0]);
      expect(new URL(page.url()).pathname).toBe(`${prefix}/projects`);
      release();
      await expect(page).toHaveURL(url => url.pathname === `${prefix}/projects/handoff/tasks/fresh`);
      await expect(page.locator('.chat-pane').getByText(question, { exact: true })).toBeVisible();
      expect(sends).toHaveLength(2);
    } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
  });
}
