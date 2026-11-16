import { test, expect } from '@playwright/test';

test('case manager requires a main conversation and explicit result selection at wide and narrow widths', async ({page}, info) => {
  test.setTimeout(45000);
  const requested = [];
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    requested.push(path);
    const json = value => route.fulfill({json:value});
    if(path.endsWith('/catalog-session')) return json({user:{id:'admin',name:'Fixture',email:'fixture@example.invalid',isAdmin:true},canAccessResearch:true,privateResearch:false});
    if(path.endsWith('/admin/cases')) return json({cases:[]});
    if(path === '/api/projects') return json({projects:[{id:'p',name:'Selected study',repoPath:'/fixture',updatedAt:1}]});
    if(path === '/api/chat/sessions') return json({sessions:[{id:'s',projectId:'p',title:'Main conversation'},{id:'other',projectId:'p',title:'Other conversation'},{id:'expert',projectId:'p',title:'Hidden expert',parentSessionId:'s'}]});
    if(path === '/api/projects/p/case-artifacts') {
      const root = 'research/study_s';
      const selected = url.searchParams.get('path');
      const paper = {name:'paper',path:root+'/paper',isDir:true,size:0,children:selected?[{name:'report.md',path:root+'/paper/report.md',isDir:false,size:100,children:[]}]:[]};
      return json({scope:'conversation-results',sessionId:'s',dir:'/results',truncated:false,roots:[{path:root,title:'Selected study'}],entries:selected?[paper]:[{name:'study_s',path:root,isDir:true,size:0,children:[paper,{name:'features',path:root+'/features',isDir:true,size:0,children:[]}]}]});
    }
    return json({});
  });
  await page.goto('/admin/cases?project=p');
  await expect(page.getByRole('heading',{name:'精选案例管理'})).toBeVisible();
  const devtools = page.getByRole('button',{name:'Close tanstack query devtools',exact:true});
  await expect(devtools).toBeVisible();
  await devtools.click();
  await expect(devtools).toBeHidden();
  await expect(page.getByRole('heading',{name:'精选案例管理'})).toBeVisible();
  await expect(page.locator('button[type=submit]')).toBeDisabled();
  const select = page.getByRole('combobox',{name:'选择主对话',exact:true});
  await expect(select.locator('option')).toHaveText(['请选择一个主对话','Main conversation','Other conversation']);
  await select.selectOption('s');
  await expect(page.getByRole('button',{name:'仅发布对话记录',exact:true})).toBeEnabled();
  const paper = page.getByRole('checkbox',{name:'公开 research/study_s/paper',exact:true});
  const features = page.getByRole('checkbox',{name:'公开 research/study_s/features',exact:true});
  await expect(paper).not.toBeChecked(); await expect(features).not.toBeChecked();
  if (await devtools.isVisible()) await devtools.click();
  await expect(devtools).toBeHidden();
  await paper.check();
  await expect(page.getByText(/将复制 1 个成果文件/)).toBeVisible();
  await expect(features).not.toBeChecked();
  await expect(page.getByRole('button',{name:'加入案例集',exact:true})).toBeEnabled();
  for(const width of [1280,390]) {
    await page.setViewportSize({width,height:900});
    await expect(paper).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({path:info.outputPath(`case-selection-${width}.png`),fullPage:true});
  }
  expect(requested).not.toContain('/api/projects/p/files');
  expect(requested).not.toContain('/api/projects/p/code-tree');
});
