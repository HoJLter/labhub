// Раннее применение темы и акцента (внешний файл — CSP запрещает инлайн-скрипты).
// Подключается в <head> всех страниц до отрисовки, чтобы не было «белой вспышки».
(function () {
  try {
    var root = document.documentElement;
    var saved = localStorage.getItem('lh-theme');
    var sys = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    // Если saved не является 'light' или 'dark' (например, 'system' или null), используем системную тему
    var theme = (saved === 'light' || saved === 'dark') ? saved : sys;
    root.dataset.theme = theme;
    var meta = document.querySelector('meta[name="lh-accent"]');
    var accent = meta && meta.content;
    if (accent && accent[0] === '#' && accent.length === 7) root.style.setProperty('--accent', accent);
  } catch (e) { /* приватный режим и т.п. */ }
})();
