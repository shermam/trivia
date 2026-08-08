// Applied before Angular bootstraps so there's no flash of the wrong
// theme — kept in sync with ThemeService (src/app/services/theme.service.ts),
// which reads this same class/localStorage key back on startup.
(function () {
  var stored = localStorage.getItem('trivia-theme');
  var isDark = stored ? stored === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.toggle('dark', isDark);
})();
