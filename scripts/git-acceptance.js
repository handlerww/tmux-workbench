async page => {
  const base = 'http://127.0.0.1:17690';
  const repositoryPath = '/tmp/workbench-e2e/project/repos/other';
  const checks = [];
  const errors = [];
  const contexts = [];
  const assert = (value, message) => {
    if (!value) throw new Error(message);
    checks.push(message);
  };
  const gitStatus = async (targetPage, sessionId) => (await targetPage.request.get(
    `${base}/api/git?session=${encodeURIComponent(sessionId)}`,
  )).json();
  const waitForAssociation = async (targetPage, sessionId, expectedPath) => targetPage.waitForFunction(
    async ({ baseURL, id, path }) => {
      const response = await fetch(`${baseURL}/api/git?session=${encodeURIComponent(id)}`);
      if (!response.ok) return false;
      const body = await response.json();
      return body.association?.path === path && body.repository?.path === path;
    },
    { baseURL: base, id: sessionId, path: expectedPath },
  );
  const clearBrowserState = async targetPage => targetPage.evaluate(async () => {
    for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
    for (const key of await caches.keys()) if (key.startsWith('workbench-shell-')) await caches.delete(key);
    localStorage.clear();
  });
  const selectFileDiff = async (targetPage, path, kind, contentNeedle) => {
    const exactButton = targetPage.locator(`[data-change-path="${path}"][data-change-kind="${kind}"]`);
    await exactButton.click();
    await targetPage.locator('.git-diff-tab-editor .original-in-monaco-diff-editor').waitFor();
    if (contentNeedle) {
      await targetPage.waitForFunction(needle => [...document.querySelectorAll('.git-diff-tab-editor .view-lines')]
        .some(line => line.textContent.replace(/\u00a0/g, ' ').includes(needle)), contentNeedle);
    }
  };
  const checkDiffAPI = async (targetPage, sessionId, change, kind, expectedOriginal, expectedModified) => {
    const parameters = [
      ['session', sessionId],
      ['repository', repositoryPath],
      ['path', change.path],
      ['kind', kind],
    ];
    if (change.oldPath) parameters.push(['oldPath', change.oldPath]);
    const query = parameters.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
    const response = await targetPage.request.get(`${base}/api/git/diff?${query}`);
    assert(response.ok(), `${kind} diff API accepts ${change.path}`);
    const body = await response.json();
    assert(body.original === expectedOriginal && body.modified === expectedModified && !body.binary,
      `${kind} diff returns the expected original and modified content for ${change.path}`);
    return body;
  };
  const makePage = async viewport => {
    const context = await page.context().browser().newContext({ viewport });
    contexts.push(context);
    const result = await context.newPage();
    result.on('pageerror', error => errors.push(error.message));
    return result;
  };

  try {
    const setup = await page.request.get(`${base}/api/sessions`);
    if (!setup.ok()) throw new Error(`Session API unavailable: HTTP ${setup.status()}`);
    const sessionList = (await setup.json()).sessions ?? [];
    const alpha = sessionList.find(session => session.name === 'workbench-alpha');
    const beta = sessionList.find(session => session.name === 'workbench-beta');
    if (!alpha || !beta) throw new Error('Git acceptance requires isolated workbench-alpha and workbench-beta sessions');
    assert(alpha.path === '/tmp/workbench-e2e/project', 'The alpha session remains a non-Git session at its original file root');
    assert(beta.path === '/tmp/workbench-e2e/other', 'The beta session remains a separate non-Git session');

    let initialAlpha = await gitStatus(page, alpha.id);
    if (initialAlpha.association?.path) {
      const reset = await page.request.put(`${base}/api/git/association`, {
        headers: { Origin: base },
        data: { session: alpha.id, path: null, revision: initialAlpha.association.revision },
      });
      if (!reset.ok()) throw new Error(`Could not reset isolated alpha association: HTTP ${reset.status()}`);
    }
    initialAlpha = await gitStatus(page, alpha.id);
    assert(initialAlpha.repository === null, 'A non-Git tmux session reports no automatic repository');
    const beforeFiles = await (await page.request.get(`${base}/api/files?session=${encodeURIComponent(alpha.id)}`)).json();

    const first = await makePage({ width: 1440, height: 900 });
    await first.goto(`${base}/`);
    await clearBrowserState(first);
    await first.reload();
    const alphaCard = first.locator('.session-card').filter({ hasText: 'workbench-alpha' });
    await alphaCard.click();
    await first.locator('#right-git-tab').click();
    await first.locator('.git-panel').waitFor();
    await first.waitForFunction(async id => {
      const response = await fetch(`/api/git?session=${encodeURIComponent(id)}`);
      if (!response.ok) return false;
      const body = await response.json();
      return body.repository === null;
    }, alpha.id);
    assert(await first.locator('.git-association-note:not(#git-search-scope)').textContent().then(text => text.includes('Choose a repository')),
      'Git panel clearly identifies the unassociated non-Git session');

    await first.locator('.git-repository-search').fill('project repos other');
    const recommendation = first.locator(`.git-recommendation[data-repository-path="${repositoryPath}"]`);
    await recommendation.waitFor();
    await recommendation.click();
    await waitForAssociation(first, alpha.id, repositoryPath);
    await first.locator('.git-repository-picker').waitFor({ state: 'hidden' });
    await first.locator('.git-pr-card').filter({ hasText: '#4242' }).waitFor();
    assert(!await first.locator('.git-repository-search').isVisible() && !await first.locator('.git-recommendations').isVisible(), 'Binding hides the search and recommendation picker');
    assert(await first.getByRole('button', { name: 'Unbind', exact: true }).isVisible(), 'The bound repository exposes Unbind');
    const associated = await gitStatus(first, alpha.id);
    assert(associated.association.manual && associated.association.path === repositoryPath,
      'A repository nested under the current session root can be manually associated with that session');
    assert(associated.repository?.path === repositoryPath && associated.repository.branch === 'workbench-fixture',
      'The manual repository association exposes branch and repository metadata');
    assert(associated.pr.status === 'ready' && associated.pr.data.number === 4242,
      'The deterministic GitHub CLI fixture returns pull request metadata');
    assert(await first.locator('.git-pr-card').textContent().then(text => text.includes('#4242') && text.includes('Workbench Git browser fixture')),
      'The associated repository pull request renders in the Git panel');
    assert(await first.locator('.editor-tab').count() === 1, 'Associating a repository only populates the Changes tree');

    const changes = new Map(associated.changes.map(change => [change.path, change]));
    const staged = changes.get('git-staged.txt');
    const unstaged = changes.get('git-unstaged.txt');
    const untracked = changes.get('git-untracked.txt');
    const deletedStaged = changes.get('git-deleted-staged.txt');
    const deletedUnstaged = changes.get('git-deleted-unstaged.txt');
    const renamed = changes.get('git-rename-new.txt');
    const both = changes.get('git-both.txt');
    assert(staged?.staged && !staged.unstaged, 'Staged-only changes are distinguished');
    assert(unstaged?.unstaged && !unstaged.staged, 'Unstaged-only changes are distinguished');
    assert(untracked?.untracked && !untracked.staged && !untracked.unstaged, 'Untracked files are distinguished');
    assert(deletedStaged?.staged && deletedStaged.status.includes('D'), 'Staged deletion remains visible');
    assert(deletedUnstaged?.unstaged && deletedUnstaged.status.includes('D'), 'Unstaged deletion remains visible');
    assert(renamed?.oldPath === 'git-rename-old.txt' && renamed.staged && renamed.unstaged,
      'A staged rename with further working-tree edits retains old and new paths');
    assert(both?.staged && both.unstaged, 'The same path can show staged and unstaged variants');

    await checkDiffAPI(first, alpha.id, staged, 'staged', 'staged baseline\n', 'staged change visible in the index\n');
    await selectFileDiff(first, 'git-staged.txt', 'staged', 'staged change visible');
    await checkDiffAPI(first, alpha.id, unstaged, 'unstaged', 'unstaged baseline\n', 'unstaged change visible in the working tree\n');
    await selectFileDiff(first, 'git-unstaged.txt', 'unstaged', 'unstaged change visible');
    await checkDiffAPI(first, alpha.id, untracked, 'untracked', '', 'untracked content visible in Monaco diff\n');
    await selectFileDiff(first, 'git-untracked.txt', 'untracked', 'untracked content visible');
    await checkDiffAPI(first, alpha.id, deletedStaged, 'staged', 'staged deletion baseline\n', '');
    await selectFileDiff(first, 'git-deleted-staged.txt', 'staged');
    await checkDiffAPI(first, alpha.id, deletedUnstaged, 'unstaged', 'unstaged deletion baseline\n', '');
    await selectFileDiff(first, 'git-deleted-unstaged.txt', 'unstaged');
    const renameContext = 'keep identical context line two\nkeep identical context line three\n';
    await checkDiffAPI(first, alpha.id, renamed, 'staged', `rename baseline content line\n${renameContext}`, `rename staged content line\n${renameContext}`);
    await selectFileDiff(first, 'git-rename-new.txt', 'staged', 'rename staged content');
    await checkDiffAPI(first, alpha.id, renamed, 'unstaged', `rename staged content line\n${renameContext}`, `rename final content line\n${renameContext}`);
    await selectFileDiff(first, 'git-rename-new.txt', 'unstaged', 'rename final content');
    await checkDiffAPI(first, alpha.id, both, 'staged', 'both baseline\n', 'staged version\n');
    await checkDiffAPI(first, alpha.id, both, 'unstaged', 'staged version\n', 'unstaged version after staging\n');
    await selectFileDiff(first, 'git-both.txt', 'staged', 'staged version');
    await selectFileDiff(first, 'git-both.txt', 'unstaged', 'unstaged version after staging');
    assert(await first.locator('.git-diff-tab-editor').getAttribute('aria-label') === 'Read-only Git diff'
      && await first.locator('.git-diff-tab-editor textarea').evaluateAll(nodes => nodes.length > 0 && nodes.every(node => node.readOnly)),
    'Git changes render in a read-only Monaco diff editor');

    const afterFiles = await (await first.request.get(`${base}/api/files?session=${encodeURIComponent(alpha.id)}`)).json();
    assert(afterFiles.root === beforeFiles.root && afterFiles.root === alpha.path,
      'Manual Git association leaves the session file-browser root unchanged');
    assert(await first.locator('.editor-tab').count() === 2 && await first.locator('.editor-tab.diff-tab').count() === 1, 'Different diff selections reuse one preview tab beside the session tab');

    const second = await makePage({ width: 1280, height: 800 });
    await second.goto(`${base}/`);
    await second.locator('.session-card').filter({ hasText: 'workbench-alpha' }).click();
    await second.locator('#right-git-tab').click();
    await waitForAssociation(second, alpha.id, repositoryPath);
    await second.locator('.git-repository-card').waitFor();
    assert(await second.locator('.git-association-mode').textContent() === 'Manual',
      'A second browser receives the shared manual association');
    await second.reload();
    await second.locator('.session-card').filter({ hasText: 'workbench-alpha' }).click();
    await second.locator('#right-git-tab').click();
    await waitForAssociation(second, alpha.id, repositoryPath);
    assert(await second.locator('.git-repo-path').textContent() === repositoryPath,
      'The repository association survives a page reload');

    await second.setViewportSize({ width: 390, height: 844 });
    await second.locator('#mobile-files-toggle').click();
    await second.locator('#files-sidebar.mobile-open').waitFor();
    await second.locator('#right-git-tab').click();
    await second.locator('.git-panel').waitFor();
    assert(await second.locator('#git-content').isVisible(), 'Git panel opens in the mobile files drawer');
    assert(await second.locator('.git-pr-card').textContent().then(text => text.includes('#4242')),
      'Pull request state remains readable on mobile');
    await second.getByRole('button', { name: 'Unbind', exact: true }).click();
    await second.locator('.git-repository-search').waitFor();
    await second.locator('.git-recommendation').first().waitFor();
    const unbound = await gitStatus(second, alpha.id);
    assert(unbound.association.path === null && unbound.repository === null, 'Mobile Unbind removes the server association');
    assert(!await second.locator('.git-pr-card').isVisible() && await second.locator('.git-diff-tab-editor .view-lines').count() === 0, 'Unbind removes PR and diff content');
    assert(errors.length === 0, `No Git panel runtime errors (${errors.join('; ')})`);
    return { checks, errors, count: checks.length, repository: repositoryPath };
  } finally {
    for (const context of contexts) await context.close();
  }
}
