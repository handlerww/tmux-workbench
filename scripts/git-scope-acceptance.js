async page => {
  const base = 'http://127.0.0.1:17690';
  const sessionRoot = '/tmp/workbench-e2e/project';
  const repositoryPath = `${sessionRoot}/repos/other`;
  const deepRepositoryPath = `${repositoryPath}/deep/leaf`;
  const outsidePath = '/tmp/workbench-git-e2e/outside';
  const dependencyPath = `${repositoryPath}/node_modules/ignored-fixture`;
  const checks = [];
  const errors = [];
  const assert = (value, message) => {
    if (!value) throw new Error(message);
    checks.push(message);
  };
  const recommendations = async (sessionId, query = '') => {
    const response = await page.request.get(
      `${base}/api/git/recommendations?session=${encodeURIComponent(sessionId)}&q=${encodeURIComponent(query)}`,
    );
    if (!response.ok()) throw new Error(`Recommendations failed: HTTP ${response.status()}`);
    return response.json();
  };
  const gitStatus = async sessionId => {
    const response = await page.request.get(`${base}/api/git?session=${encodeURIComponent(sessionId)}`);
    if (!response.ok()) throw new Error(`Git status failed: HTTP ${response.status()}`);
    return response.json();
  };
  const saveAssociation = async (sessionId, path, revision) => page.request.put(`${base}/api/git/association`, {
    headers: { Origin: base },
    data: { session: sessionId, path, revision },
  });
  const paths = body => body.repositories.map(repository => repository.path);

  page.on('pageerror', error => errors.push(error.message));
  let alpha;
  try {
    const response = await page.request.get(`${base}/api/sessions`);
    if (!response.ok()) throw new Error(`Session API unavailable: HTTP ${response.status()}`);
    const sessions = (await response.json()).sessions ?? [];
    alpha = sessions.find(session => session.name === 'workbench-alpha');
    const beta = sessions.find(session => session.name === 'workbench-beta');
    if (!alpha || !beta) throw new Error('Scope acceptance requires isolated alpha and beta sessions');
    assert(alpha.path === sessionRoot, 'Search is scoped to the non-Git alpha session cwd');
    assert(beta.path === '/tmp/workbench-e2e/other', 'The second live session keeps its separate non-Git cwd');
    let betaStatus = await gitStatus(beta.id);
    if (betaStatus.association?.path) {
      const clearedBeta = await saveAssociation(beta.id, null, betaStatus.association.revision);
      if (!clearedBeta.ok()) throw new Error(`Could not clear prior beta fixture pin: HTTP ${clearedBeta.status()}`);
      betaStatus = await gitStatus(beta.id);
    }
    assert(betaStatus.repository === null, 'No repository discovery relies on another live session');

    const all = await recommendations(alpha.id);
    const allPaths = paths(all);
    assert(all.root === sessionRoot, 'Recommendations identify the current session cwd as their search root');
    assert(allPaths.includes(repositoryPath) && allPaths.includes(deepRepositoryPath),
      'Current-session search discovers both a child repository and a deeper nested repository');
    assert(!allPaths.includes('/tmp/workbench-e2e/other') && !allPaths.includes(outsidePath),
      'Current-session search excludes other session roots and outside repositories');
    assert(!allPaths.includes(dependencyPath) && !allPaths.includes(`${repositoryPath}/unsafe-external-link`),
      'Scoped search skips dependency repositories and symlinked external repositories');

    const allWords = await recommendations(alpha.id, 'project repos other leaf');
    assert(paths(allWords).length === 1 && paths(allWords)[0] === deepRepositoryPath,
      'Search requires every query word and returns only the matching nested repository');
    const outsideAbsolute = await recommendations(alpha.id, outsidePath);
    assert(paths(outsideAbsolute).length === 0,
      'Absolute path search cannot suggest a repository outside the session root');
    const recentOnly = await recommendations(alpha.id, 'workbench-git-e2e outside');
    assert(paths(recentOnly).length === 0,
      'Previously known repositories outside the session root are not global search results');

    let current = await gitStatus(alpha.id);
    if (current.association?.path) {
      const cleared = await saveAssociation(alpha.id, null, current.association.revision);
      if (!cleared.ok()) throw new Error(`Could not clear prior alpha pin: HTTP ${cleared.status()}`);
      current = await gitStatus(alpha.id);
    }
    const pinned = await saveAssociation(alpha.id, outsidePath, current.association.revision);
    if (!pinned.ok()) throw new Error(`Could not seed outside manual pin: HTTP ${pinned.status()}`);
    current = await gitStatus(alpha.id);
    assert(current.association.manual && current.association.path === outsidePath,
      'An existing manual association outside cwd remains pinned');
    const whilePinned = await recommendations(alpha.id, 'outside');
    assert(paths(whilePinned).length === 0 && (await gitStatus(alpha.id)).association.path === outsidePath,
      'An outside manual pin is retained without becoming a search suggestion');

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/`);
    await page.evaluate(async () => {
      for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
      for (const key of await caches.keys()) if (key.startsWith('workbench-shell-')) await caches.delete(key);
      localStorage.clear();
    });
    await page.reload();
    const alphaCard = page.locator('.session-card').filter({ hasText: 'workbench-alpha' });
    await alphaCard.click();
    await page.locator('#right-git-tab').click();
    await page.locator('.git-repo-path').waitFor();
    assert(await page.locator('.git-repo-path').textContent() === outsidePath,
      'Git panel continues to display the existing outside manual pin');
    assert(!await page.locator('.git-repository-search').isVisible(), 'An existing manual pin hides the repository picker');
    await page.getByRole('button', { name: 'Unbind', exact: true }).click();
    await page.locator('.git-repository-search').waitFor();
    assert(await page.locator('#git-search-scope').textContent()
      .then(text => text.includes('this session') && text.includes('subfolders')),
    'Git search visibly explains that results are scoped to this session directory');

    const input = page.locator('.git-repository-search');
    await input.fill('outside');
    await page.waitForFunction(() => document.querySelector('#git-recommendations')?.textContent
      .includes('No matching repositories in the session directory or its subfolders.'));
    assert(await page.locator('.git-recommendation').count() === 0
      && await page.locator('#git-recommendations').textContent().then(text => text.includes('No matching repositories')),
    'After unbinding, scoped search offers no outside result');

    await input.fill('project repos other');
    const childRecommendation = page.locator(`.git-recommendation[data-repository-path="${repositoryPath}"]`);
    const deepRecommendation = page.locator(`.git-recommendation[data-repository-path="${deepRepositoryPath}"]`);
    await childRecommendation.waitFor();
    await deepRecommendation.waitFor();
    assert(await page.locator('.git-recommendation').evaluateAll((nodes, prefix) => nodes.every(node =>
      node.dataset.repositoryPath.startsWith(prefix)), `${sessionRoot}/`),
    'The interactive search list contains only repositories below the current session root');
    await childRecommendation.click();
    await page.waitForFunction(async ({ sessionId, expectedPath }) => {
      const response = await fetch(`/api/git?session=${encodeURIComponent(sessionId)}`);
      if (!response.ok) return false;
      const body = await response.json();
      return body.association?.path === expectedPath && body.repository?.path === expectedPath;
    }, { sessionId: alpha.id, expectedPath: repositoryPath });
    const associated = await gitStatus(alpha.id);
    assert(associated.association.manual && associated.repository.path === repositoryPath,
      'A child repository can be manually associated from a cwd-scoped search');

    const diff = await page.request.get(`${base}/api/git/diff?session=${encodeURIComponent(alpha.id)}&repository=${encodeURIComponent(repositoryPath)}&path=git-staged.txt&kind=staged`);
    assert(diff.ok() && (await diff.json()).modified === 'staged change visible in the index\n',
      'The manually associated child repository supplies its Git diff');
    const beforeFiles = await (await page.request.get(`${base}/api/files?session=${encodeURIComponent(alpha.id)}`)).json();
    assert(beforeFiles.root === sessionRoot,
      'Associating a child repository leaves the session file-browser root unchanged');
    assert(await page.locator('.editor-tab').count() === 1,
      'Repository search and Git diff do not create workspace tabs');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#mobile-files-toggle').click();
    await page.locator('.files-sidebar.mobile-open').waitFor();
    await page.locator('#right-git-tab').click();
    await page.locator('.git-panel').waitFor();
    await page.getByRole('button', { name: 'Unbind', exact: true }).click();
    await input.waitFor();
    await input.fill('project repos other leaf');
    await page.locator(`.git-recommendation[data-repository-path="${deepRepositoryPath}"]`).waitFor();
    assert(await page.locator('.git-recommendation').evaluateAll((nodes, prefix) => nodes.every(node =>
      node.dataset.repositoryPath.startsWith(prefix)), `${sessionRoot}/`)
      && await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    'Mobile Git search stays cwd-scoped without horizontal overflow');
    assert(errors.length === 0, `No scope browser runtime errors (${errors.join('; ')})`);
    return { checks, errors, count: checks.length, root: sessionRoot, repository: repositoryPath };
  } finally {
    if (alpha) {
      const status = await gitStatus(alpha.id).catch(() => null);
      if (status?.association?.path) {
        await saveAssociation(alpha.id, null, status.association.revision).catch(() => {});
      }
    }
  }
}
