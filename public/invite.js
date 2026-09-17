// Обработчик формы инвайт-кода (внешний файл — CSP запрещает инлайн-скрипты).
document.getElementById('f').addEventListener('submit', async function (e) {
  e.preventDefault();
  var code = document.getElementById('code').value.trim();
  var err = document.getElementById('err');
  err.textContent = '';
  try {
    var r = await fetch('/api/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code }),
    });
    if (!r.ok) throw new Error();
    location.href = '/';
  } catch (_) {
    err.textContent = 'Неверный инвайт-код';
  }
});
