async page => {
  const base = 'http://127.0.0.1:17690';
  const checks = [];
  const errors = [];
  const contexts = [];
  const assert = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  const snapshot = async () => (await page.request.get(base + '/api/groups')).json();
  const reset = async () => {
    const current = await snapshot();
    const result = await page.request.put(base + '/api/groups', { headers: { Origin: base }, data: { groups: [], assignments: {}, ungroupedCollapsed: false, revision: current.revision } });
    if (!result.ok()) throw new Error('Could not reset the isolated group fixture');
  };
  const makePage = async () => {
    const context = await page.context().browser().newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => { Date.now = () => 1791400000000; });
    contexts.push(context);
    const tab = await context.newPage();
    tab.on('pageerror', error => errors.push(error.message));
    return tab;
  };
  try {
    await reset();
    assert(/^[0-9a-f]{64}$/.test((await snapshot()).revision), 'Group state has a revision for concurrent writes');
    const sessions = await (await page.request.get(base + '/api/sessions')).json();
    const alpha = sessions.sessions.find(session => session.name === 'workbench-alpha');
    const legacy = await makePage();
    await legacy.addInitScript(({ session }) => {
      localStorage.setItem('workbench.sessionGroups.v1', JSON.stringify({ groups: [{ id: 'legacy-fixture', name: 'Legacy fixture', collapsed: false }], assignments: { [session]: 'legacy-fixture' }, ungroupedCollapsed: false }));
    }, { session: alpha.id });
    await legacy.goto(base);
    await legacy.getByRole('button', { name: 'Manage Legacy fixture', exact: true }).waitFor();
    await legacy.waitForFunction(async () => (await (await fetch('/api/groups')).json()).assignments[document.querySelector('.session-card[data-session-id]')?.dataset.sessionId] === 'legacy-fixture');
    assert((await snapshot()).assignments[alpha.id] === 'legacy-fixture', 'Existing browser groups migrate into an empty server');
    assert(await legacy.evaluate(() => localStorage.getItem('workbench.sessionGroups.v1') === null), 'Migration retires browser-local group authority');
    await contexts.pop().close();
    await reset();
    const a = await makePage();
    await a.goto(base);
    await a.locator('.session-card').first().waitFor();
    await a.evaluate(() => { window.prompt = () => 'Shared fixture'; });
    await a.getByRole('button', { name: 'Create session group', exact: true }).click();
    await a.waitForFunction(async () => (await (await fetch('/api/groups')).json()).groups.some(group => group.name === 'Shared fixture'));
    const group = (await snapshot()).groups.find(group => group.name === 'Shared fixture');
    await a.locator('.session-card').filter({ hasText: 'workbench-alpha' }).dragTo(a.locator(`.workspace-section[data-session-group-id="${group.id}"] .workspace-section-heading`));
    await a.waitForFunction(async ({ id, group }) => (await (await fetch('/api/groups')).json()).assignments[id] === group, { id: alpha.id, group: group.id });
    const b = await makePage();
    await b.goto(base);
    await b.getByRole('button', { name: 'Manage Shared fixture', exact: true }).waitFor();
    assert(await b.locator(`.workspace-section[data-session-group-id="${group.id}"] .session-card[data-session-id="${alpha.id}"]`).count() === 1, 'An independent browser receives the server group and session assignment');
    let arrived = 0;
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    const holdFirstWrites = async route => {
      if (route.request().method() === 'PUT') {
        arrived += 1;
        if (arrived >= 2) release();
        await barrier;
      }
      await route.continue();
    };
    await a.route('**/api/groups', holdFirstWrites);
    await b.route('**/api/groups', holdFirstWrites);
    await a.evaluate(() => { window.prompt = () => 'Concurrent A'; });
    await b.evaluate(() => { window.prompt = () => 'Concurrent B'; });
    await Promise.all([a.getByRole('button', { name: 'Create session group', exact: true }).click(), b.getByRole('button', { name: 'Create session group', exact: true }).click()]);
    await a.waitForFunction(async () => { const state = await (await fetch('/api/groups')).json(); return state.groups.some(group => group.name === 'Concurrent A') && state.groups.some(group => group.name === 'Concurrent B'); });
    assert((await snapshot()).groups.length === 3, 'Concurrent browser changes rebase without overwriting another group');
    await a.unroute('**/api/groups', holdFirstWrites);
    await b.unroute('**/api/groups', holdFirstWrites);
    await b.reload();
    await b.getByRole('button', { name: 'Manage Concurrent A', exact: true }).waitFor();
    await b.getByRole('button', { name: 'Manage Concurrent B', exact: true }).waitFor();
    await b.locator(`.workspace-section[data-session-group-id="${group.id}"] .section-fold`).click();
    await b.waitForFunction(async id => (await (await fetch('/api/groups')).json()).groups.find(group => group.id === id)?.collapsed === true, group.id);
    await a.waitForFunction(id => document.querySelector(`.workspace-section[data-session-group-id="${id}"] .section-fold`)?.getAttribute('aria-expanded') === 'false', group.id);
    assert(true, 'Server-persisted collapse changes synchronize to another open browser');
    assert((await snapshot()).assignments[alpha.id] === group.id, 'Concurrent operations retain the original session assignment');
    assert(errors.length === 0, `No shared-group runtime errors (${errors.join('; ')})`);
    return { checks, errors, count: checks.length, state: await snapshot() };
  } finally {
    for (const context of contexts) await context.close();
  }
}
