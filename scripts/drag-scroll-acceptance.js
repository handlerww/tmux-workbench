async page => {
  const base = 'http://127.0.0.1:17690';
  const checks = [];
  const errors = [];
  const assert = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(base);
  await page.evaluate(async () => {
    for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
    for (const key of await caches.keys()) if (key.startsWith('workbench-shell-')) await caches.delete(key);
    localStorage.clear();
  });
  const sessions = (await (await page.request.get(base + '/api/sessions')).json()).sessions;
  const alpha = sessions.find(session => session.name === 'workbench-alpha').id;
  const state = await (await page.request.get(base + '/api/groups')).json();
  const groups = Array.from({ length: 28 }, (_, index) => ({ id: `scroll-fixture-${index}`, name: `Scroll group ${String(index + 1).padStart(2, '0')}`, collapsed: false }));
  const response = await page.request.put(base + '/api/groups', { headers: { Origin: base }, data: { groups, assignments: { [alpha]: groups[0].id }, ungroupedCollapsed: false, revision: state.revision } });
  if (!response.ok()) throw new Error('Cannot prepare isolated scroll groups');
  await page.reload();
  await page.locator('.session-card').filter({ hasText: 'workbench-alpha' }).waitFor();
  assert(await page.locator('#session-list').evaluate(el => el.scrollHeight > el.clientHeight), 'Workspaces contains off-screen groups in a scrollable list');
  await page.evaluate(() => {
    const list = document.querySelector('#session-list');
    list.scrollTop = 0;
    window.scrollFixtureSource = [...list.querySelectorAll('.session-card')].find(el => el.textContent.includes('workbench-alpha'));
    window.scrollFixtureTransfer = new DataTransfer();
    window.scrollFixtureSource.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: window.scrollFixtureTransfer }));
    const bounds = list.getBoundingClientRect();
    list.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.scrollFixtureTransfer, clientX: bounds.left + 50, clientY: bounds.bottom - 4 }));
  });
  await page.waitForFunction(() => document.querySelector('#session-list').scrollTop > 120);
  assert(true, 'Holding a session at the bottom edge continuously scrolls Workspaces down');
  await page.evaluate(() => {
    const list = document.querySelector('#session-list');
    const bounds = list.getBoundingClientRect();
    list.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.scrollFixtureTransfer, clientX: bounds.left + 50, clientY: bounds.top + bounds.height / 2 }));
  });
  const center = await page.locator('#session-list').evaluate(el => el.scrollTop);
  await page.waitForTimeout(160);
  assert(await page.locator('#session-list').evaluate(el => el.scrollTop) === center, 'Moving away from the edge stops automatic scrolling');
  await page.evaluate(() => {
    const list = document.querySelector('#session-list');
    const bounds = list.getBoundingClientRect();
    list.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.scrollFixtureTransfer, clientX: bounds.left + 50, clientY: bounds.top + 4 }));
  });
  await page.waitForFunction(previous => document.querySelector('#session-list').scrollTop < previous - 40, center);
  assert(true, 'Holding a session at the top edge scrolls Workspaces up');
  await page.keyboard.press('Escape');
  const canceled = await page.locator('#session-list').evaluate(el => el.scrollTop);
  await page.waitForTimeout(160);
  assert(await page.locator('#session-list').evaluate(el => el.scrollTop) === canceled && !await page.evaluate(() => document.body.classList.contains('workspace-item-dragging')), 'Escape stops scrolling and clears the drag state');
  // Use a native browser drag to reach a group below the initial viewport.
  await page.locator('#session-list').evaluate(el => { el.scrollTop = 0; });
  const source = page.locator('.session-card').filter({ hasText: 'workbench-alpha' });
  const sourceBounds = await source.boundingBox();
  const listBounds = await page.locator('#session-list').boundingBox();
  await page.mouse.move(sourceBounds.x + 50, sourceBounds.y + sourceBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceBounds.x + 60, sourceBounds.y + sourceBounds.height / 2 + 12, { steps: 4 });
  await page.mouse.move(listBounds.x + 70, listBounds.y + listBounds.height - 6, { steps: 12 });
  await page.waitForFunction(() => { const list = document.querySelector('#session-list'); return list.scrollTop > list.scrollHeight - list.clientHeight - 90; }, null, { timeout: 10000 });
  const target = page.locator(`.workspace-section[data-session-group-id="${groups.at(-1).id}"] .workspace-section-heading`);
  const targetBounds = await target.boundingBox();
  await page.mouse.move(targetBounds.x + 90, targetBounds.y + targetBounds.height / 2, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(async ({ session, group }) => (await (await fetch('/api/groups')).json()).assignments[session] === group, { session: alpha, group: groups.at(-1).id });
  assert(true, 'A native session drag scrolls to an initially off-screen group and persists the drop');
  const dropped = await page.locator('#session-list').evaluate(el => el.scrollTop);
  await page.waitForTimeout(200);
  assert(await page.locator('#session-list').evaluate(el => el.scrollTop) === dropped && !await page.evaluate(() => document.body.classList.contains('workspace-item-dragging')), 'Dropping a session stops automatic scrolling');
  assert(errors.length === 0, 'No drag-scroll browser runtime errors');
  await page.screenshot({ path: 'artifacts/workbench-drag-scroll.png', animations: 'disabled' });
  return { checks, count: checks.length, errors };
}
