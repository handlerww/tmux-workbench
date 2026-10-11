try {
  const saved = localStorage.getItem('workbench.theme');
  const setting = ['system', 'light', 'dark'].includes(saved) ? saved : 'dark';
  const resolved = setting === 'system'
    ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : setting;
  document.documentElement.dataset.theme = setting;
  document.documentElement.dataset.colorScheme = resolved;
  document.querySelector('meta[name="theme-color"]').content = resolved === 'dark' ? '#18181b' : '#fafafa';
} catch {
  document.documentElement.dataset.theme = 'dark';
  document.documentElement.dataset.colorScheme = 'dark';
}

try {
  document.documentElement.classList.toggle('workspaces-collapsed', localStorage.getItem('workbench.sidebarCollapsed') === 'true');
} catch { /* Keep Workspaces expanded when storage is unavailable. */ }
