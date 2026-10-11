async page => {
 const base='http://127.0.0.1:17690',checks=[],errors=[];const assert=(ok,message)=>{if(!ok)throw new Error(message);checks.push(message);};page.on('pageerror',e=>errors.push(e.message));
 const inventory=(await(await page.request.get(base+'/api/sessions')).json()).sessions;
 const alpha=inventory.find(s=>s.name==='workbench-alpha'),beta=inventory.find(s=>s.name==='workbench-beta');
 const current=(await(await page.request.get(base+'/api/groups')).json());
 const seeded=await page.request.put(base+'/api/groups',{headers:{Origin:base},data:{revision:current.revision,groups:[{id:'order-one',name:'Development',collapsed:false},{id:'order-two',name:'Review',collapsed:false}],assignments:{},ungroupedCollapsed:false,sessionOrder:[]}});if(!seeded.ok())throw new Error('Isolated group seed failed');
 await page.setViewportSize({width:1440,height:900});await page.goto(base);await page.evaluate(()=>localStorage.clear());await page.reload();
 const card=id=>page.locator('.session-card[data-session-id="'+id+'"]');const row=id=>card(id).locator('..');
 await card(alpha.id).click();await page.locator('.editor-panel').waitFor();
 let dt=await page.evaluateHandle(()=>new DataTransfer());
 const begin=async id=>{await card(id).dispatchEvent('dragstart',{dataTransfer:dt});await page.waitForTimeout(50);};
 const place=async(id,other,after)=>{await begin(id);const target=row(other);const b=await target.boundingBox();const y=b.y+b.height*(after?.8:.2);await target.dispatchEvent('dragover',{dataTransfer:dt,clientX:b.x+40,clientY:y});await target.dispatchEvent('drop',{dataTransfer:dt,clientX:b.x+40,clientY:y});};
 const state=async()=>(await(await page.request.get(base+'/api/groups')).json());
 try{
  await begin(beta.id);assert(await page.locator('.editor-drop-preview:visible').count()===0,'Starting a sidebar session drag shows no workspace split preview');
  const ab=await row(alpha.id).boundingBox();await row(alpha.id).dispatchEvent('dragover',{dataTransfer:dt,clientX:ab.x+40,clientY:ab.y+4});
  assert(await row(alpha.id).getAttribute('data-drop-position')==='before'&&await page.locator('.editor-drop-preview:visible').count()===0,'Sidebar drag shows only an insertion marker');
  await row(alpha.id).dispatchEvent('drop',{dataTransfer:dt,clientX:ab.x+40,clientY:ab.y+4});
  await page.waitForFunction(async([a,b])=>{const s=await(await fetch('/api/groups')).json();return s.sessionOrder?.indexOf(b)<s.sessionOrder?.indexOf(a);},[alpha.id,beta.id]);
  assert((await state()).sessionOrder.join('|')===beta.id+'|'+alpha.id,'Dragging upward saves the new Untagged session order on the server');
  await page.reload();await dt.dispose();dt=await page.evaluateHandle(()=>new DataTransfer());assert((await page.locator('.workspace-section[data-session-group-id=""] .session-card').evaluateAll(ns=>ns.map(n=>n.dataset.sessionId))).join('|')===beta.id+'|'+alpha.id,'Session order survives reload');
  const other=await page.context().browser().newContext();const second=await other.newPage();await second.goto(base);await second.locator('.session-card').first().waitFor();assert((await second.locator('.workspace-section[data-session-group-id=""] .session-card').evaluateAll(ns=>ns.map(n=>n.dataset.sessionId))).join('|')===beta.id+'|'+alpha.id,'Independent browser displays the server-shared session order');await other.close();
  await begin(beta.id);await page.locator('.workspace-section[data-session-group-id="order-one"]').dispatchEvent('drop',{dataTransfer:dt});
  await page.waitForFunction(async id=>(await(await fetch('/api/groups')).json()).assignments[id]==='order-one',beta.id);
  await place(alpha.id,beta.id,false);await page.waitForFunction(async id=>(await(await fetch('/api/groups')).json()).assignments[id]==='order-one',alpha.id);
  assert((await page.locator('.workspace-section[data-session-group-id="order-one"] .session-card').evaluateAll(ns=>ns.map(n=>n.dataset.sessionId))).join('|')===alpha.id+'|'+beta.id,'Dropping onto a session in another group assigns it and respects the insertion position');
  await place(alpha.id,beta.id,true);await page.waitForFunction(async([a,b])=>{const s=await(await fetch('/api/groups')).json();return s.sessionOrder.indexOf(b)<s.sessionOrder.indexOf(a);},[alpha.id,beta.id]);
  assert((await page.locator('.workspace-section[data-session-group-id="order-one"] .session-card').evaluateAll(ns=>ns.map(n=>n.dataset.sessionId))).join('|')===beta.id+'|'+alpha.id,'Dragging downward reorders within a named group');
  await begin(beta.id);const overlay=page.locator('.editor-drop-overlay').first();const eb=await overlay.boundingBox();
  await overlay.dispatchEvent('dragenter',{dataTransfer:dt,clientX:eb.x+eb.width-15,clientY:eb.y+eb.height/2});assert(await page.locator('.editor-drop-preview:visible').count()===1&&await overlay.locator('.editor-drop-preview').getAttribute('data-position')==='right','Entering the center workspace activates only that pane split preview');
  await row(alpha.id).dispatchEvent('dragover',{dataTransfer:dt,clientX:ab.x+40,clientY:ab.y+4});assert(await page.locator('.editor-drop-preview:visible').count()===0,'Returning to Workspaces hides the split preview');
  await overlay.dispatchEvent('dragover',{dataTransfer:dt,clientX:eb.x+eb.width-15,clientY:eb.y+eb.height/2});await overlay.dispatchEvent('drop',{dataTransfer:dt,clientX:eb.x+eb.width-15,clientY:eb.y+eb.height/2});
  assert(await page.locator('.editor-group').count()===2&&await page.locator('.editor-drop-preview:visible').count()===0,'Workspace drop still creates a deliberate split and clears its preview');
  await begin(alpha.id);await page.keyboard.press('Escape');assert(await page.locator('[data-drop-position]').count()===0&&!await page.locator('body').evaluate(n=>n.classList.contains('workspace-item-dragging')),'Escape clears all session drag state');
  assert(errors.length===0,'No session ordering runtime errors');return{checks,count:checks.length,errors};
 }finally{await dt.dispose();}
}
