async page => {
 const base='http://127.0.0.1:17690',checks=[],errors=[];const assert=(ok,message)=>{if(!ok)throw new Error(message);checks.push(message);};page.on('pageerror',e=>errors.push(e.message));
 await page.setViewportSize({width:1440,height:900});await page.goto(base);await page.evaluate(()=>localStorage.clear());await page.reload();await page.locator('.session-card').first().waitFor();
 const style=async field=>{await page.waitForTimeout(200);return field.evaluate(n=>({border:getComputedStyle(n).borderTopColor,ring:getComputedStyle(n).boxShadow,radius:getComputedStyle(n).borderTopLeftRadius,font:getComputedStyle(n).fontSize,height:n.getBoundingClientRect().height}));};
 for(const theme of ['dark','light']){
  if(await page.locator('html').getAttribute('data-color-scheme')!==theme)await page.locator('#theme-button').click();
  const search=page.locator('#session-search-input');await search.focus();const searchStyle=await style(page.locator('.session-search'));
  assert(searchStyle.ring!=='none'&&searchStyle.border===(theme==='dark'?'rgb(161, 161, 170)':'rgb(113, 113, 122)'),theme+' session search has the shared visible focus state');
  await page.getByRole('button',{name:'Create tmux session',exact:true}).click();
  const path=page.locator('#create-session-path');await path.focus();const pathStyle=await style(path);assert(pathStyle.radius==='6px'&&pathStyle.ring!=='none',theme+' new-session field uses consistent corners and a focus ring');
  await page.locator('#create-session-path-search').fill('workbench-e2e other');assert(await page.locator('.create-session-recent-path').count()===1,theme+' styled path search keeps multi-keyword behavior');
  await page.screenshot({path:'artifacts/workbench-input-controls-'+theme+'.png',animations:'disabled'});
  await page.locator('#create-session-cancel').click();await page.locator('.session-card').filter({hasText:'workbench-alpha'}).click();
  await page.getByRole('button',{name:'Rename session',exact:true}).click();const rename=page.getByRole('textbox',{name:'New session name',exact:true});await rename.focus();const renameStyle=await style(rename);
  assert(renameStyle.radius==='6px'&&renameStyle.ring!=='none',theme+' rename field receives the same focused input style');await page.locator('.rename-cancel').click();
  await page.locator('#right-git-tab').click();const git=page.locator('.git-repository-search');await git.waitFor();await git.focus();const gitStyle=await style(git);assert(gitStyle.radius==='6px'&&gitStyle.ring!=='none',theme+' Git search uses the shared focus styling');await page.locator('#right-files-tab').click();
 }
 await page.setViewportSize({width:390,height:844});await page.locator('#mobile-session-toggle').click();await page.locator('#session-search-input').waitFor();
 assert((await style(page.locator('#session-search-input'))).font==='16px'&&(await style(page.locator('.session-search'))).height>=44,'Phone session search retains readable text and a touch-sized control');
 await page.getByRole('button',{name:'Create tmux session',exact:true}).click();await page.locator('#create-session-path').waitFor();const mobilePath=await style(page.locator('#create-session-path'));assert(mobilePath.font==='16px'&&mobilePath.height>=44&&await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Phone new-session inputs retain touch targets without horizontal overflow');
 await page.screenshot({path:'artifacts/workbench-input-controls-mobile.png',animations:'disabled'});
 assert(errors.length===0,'No input-control runtime errors');return{checks,count:checks.length,errors};
}
