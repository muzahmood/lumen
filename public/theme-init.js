// Applies the saved theme before first paint to avoid a flash. Kept as a file (not inline)
// so the Content Security Policy can forbid inline scripts entirely.
(function () {
  try {
    var s = JSON.parse(localStorage.getItem('kb.settings') || '{}');
    var t = s.theme || 'system';
    if (t === 'system') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
