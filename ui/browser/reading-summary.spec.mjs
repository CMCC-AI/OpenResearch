import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
let fixture;
test.beforeAll(() => { fixture = JSON.parse(readFileSync(process.env.ORX_BROWSER_FIXTURE_FILE, 'utf8')); });
test.beforeEach(async ({ page }) => { await page.addInitScript(() => localStorage.setItem('orx:locale', 'en')); });
async function closeDevtools(page) {
  const close = page.getByRole('button', { name: 'Close tanstack query devtools', exact: true });
  if (await close.isVisible()) await close.click();
}
test('real uploaded material shows stable CLI unions and case copies never fall back to private ranges', async ({ page }, info) => {
  const project = fixture.readingProject;
  await page.goto(`/projects/${project.id}/tasks/${project.main}?pane=${encodeURIComponent(JSON.stringify({ kind:'home',view:'materials' }))}`);
  await expect(page.getByRole('navigation', { name:'材料视图' })).toBeVisible(); await closeDevtools(page);
  await page.getByRole('button', { name:'读取范围', exact:true }).click();
  const section = page.getByRole('region', { name:'读取范围记录' });
  await expect(section).toContainText('检查 2 条回执');
  await expect(section).toContainText('已确认输出 3 / 4 行');
  await expect(section).toContainText('行范围：1–3');
  await section.getByRole('checkbox', { name:'仅当前会话' }).check();
  await expect(section).toContainText('检查 2 条回执');
  await section.getByRole('button', { name:'刷新读取范围', exact:true }).click();
  await expect(section).toContainText('检查 2 条回执');
  await section.getByRole('combobox', { name:'筛选读取记录的文件' }).selectOption(fixture.readingManifest.files[0].id);
  await expect(section).toContainText('已确认输出 3 / 4 行');
  await page.screenshot({ path:info.outputPath('reading-summary-wide.png'),fullPage:true });
  let privateRequests = 0;
  await page.route('**/api/materials/**/coverage*', route => { privateRequests++; return route.abort(); });
  await page.goto('/cases/browser-reading-case?pane='+encodeURIComponent(JSON.stringify({ kind:'home',view:'materials' })));
  await expect(page.getByRole('navigation', { name:'材料视图' })).toBeVisible(); await closeDevtools(page);
  await page.getByRole('button', { name:'读取范围', exact:true }).click();
  await expect(section).toContainText('案例发布时保存的记录');
  await expect(section).toContainText('已确认输出 3 / 4 行');
  await section.getByRole('combobox', { name:'筛选读取记录的文件' }).selectOption(fixture.readingManifest.files[0].id);
  await expect(section).toContainText('检查 2 条回执');
  await page.setViewportSize({ width:390,height:844 });
  await expect(section).toBeInViewport();
  await expect.poll(async () => {
    const box = await section.boundingBox();
    return box ? Math.ceil(box.x + box.width) : Infinity;
  }).toBeLessThanOrEqual(391);
  await expect.poll(() => page.locator('body').evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(391);
  await page.screenshot({ path:info.outputPath('reading-summary-case-narrow.png'),fullPage:true });
  const confirmedRange = section.getByText('文本解析视图：已确认输出 3 / 4 行', { exact:true });
  await confirmedRange.scrollIntoViewIfNeeded();
  await expect(confirmedRange).toBeInViewport({ ratio:1 });
  await page.screenshot({ path:info.outputPath('reading-summary-case-narrow-range.png'),fullPage:true });
  expect(privateRequests).toBe(0);
  await page.unrouteAll({ behavior:'wait' });
});
