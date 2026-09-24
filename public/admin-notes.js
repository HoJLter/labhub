// Раздел «Заметки» админ-панели: список vault, редактор markdown с живым предпросмотром,
// автодополнение [[wiki-ссылок]], drag&drop картинок, переименование и мягкое удаление.
//
// Файл оформлен фабрикой: admin.js передаёт сюда свои хелперы (el/api/toast/modal/field),
// чтобы не дублировать их и не плодить циклические импорты.

export function makeNotesSection(H) {
  const { el, api, toast, modal, field } = H;

  // Состояние раздела живёт между перерисовками nav()
  const state = {
    notes: [],
    assets: [],
    stats: null,
    vault: '',
    tags: [],
    current: null,       // путь открытой заметки
    dirty: false,
    previewTimer: null,
    suggestTimer: null,
  };

  const slugOf = path => {
    const n = state.notes.find(x => x.path === path);
    return n ? n.slug : null;
  };

  // ——— Загрузка списка ———
  async function load() {
    const data = await api('/api/admin/notes');
    state.notes = data.notes || [];
    state.assets = data.assets || [];
    state.stats = data.stats || {};
    state.vault = data.vault || '';
    state.tags = data.tags || [];
  }

  function noteList(filter, container) {
    const q = String(filter || '').toLowerCase();
    const items = state.notes.filter(n => !q
      || n.title.toLowerCase().includes(q)
      || n.path.toLowerCase().includes(q)
      || (n.tags || []).some(t => t.toLowerCase().includes(q)));
    if (!items.length) return el('div', { class: 'empty-mini' }, q ? 'Ничего не найдено' : 'Заметок пока нет');

    const list = el('div', { class: 'notes-admin-list' });
    for (const n of items) {
      const row = el('div', {
        class: 'notes-admin-item' + (n.path === state.current ? ' active' : ''),
        onclick: () => openNote(n.path, container),
      },
        el('div', { class: 'nai-title' }, n.title),
        el('div', { class: 'nai-meta' },
          n.path !== n.title ? el('span', { class: 'nai-path' }, n.path) : null,
          (n.tags || []).slice(0, 3).map(t => el('span', { class: 'tag-mini' }, '#' + t))));
      list.append(row);
    }
    return list;
  }

  // ——— Открытие заметки в редакторе ———
  async function openNote(path, container) {
    const data = await api('/api/admin/notes/raw?path=' + encodeURIComponent(path));
    state.current = path;
    state.dirty = false;
    render(container);
  }

  function newNoteDialog(container) {
    const titleInput = el('input', { type: 'text', placeholder: 'Например: Конспект по БЖД', maxlength: '120' });
    const folderInput = el('input', { type: 'text', placeholder: 'Папка (необязательно), например Методички' });
    const m = modal('Новая заметка', [
      el('p', { class: 'muted' }, 'Имя файла в vault создастся из названия — так же, как это делает Obsidian.'),
      field('Название', titleInput),
      field('Папка', folderInput),
    ], [
      el('button', { class: 'btn btn-secondary', onclick: () => m.close() }, 'Отмена'),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          try {
            const r = await api('/api/admin/notes/create', {
              method: 'POST',
              body: JSON.stringify({ title: titleInput.value, folder: folderInput.value }),
            });
            m.close();
            await load();
            state.current = r.path;
            toast('Заметка создана');
            render(container);
          } catch (e) { toast(e.message, true); }
        },
      }, 'Создать'),
    ]);
    titleInput.addEventListener('keydown', e => { if (e.key === 'Enter') m.root.querySelector('.btn-primary').click(); });
  }

  function renameDialog(container, path) {
    const input = el('input', { type: 'text', value: path, maxlength: '300' });
    const m = modal('Переименовать заметку', [
      el('p', { class: 'muted' }, 'Адрес страницы (slug) при переименовании сохраняется — внешние ссылки не сломаются.'),
      field('Новое имя или путь', input),
    ], [
      el('button', { class: 'btn btn-secondary', onclick: () => m.close() }, 'Отмена'),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          try {
            const r = await api('/api/admin/notes/rename', { method: 'POST', body: JSON.stringify({ path, to: input.value }) });
            m.close();
            await load();
            state.current = r.path;
            toast('Переименовано');
            render(container);
          } catch (e) { toast(e.message, true); }
        },
      }, 'Переименовать'),
    ]);
  }

  function deleteDialog(container, path) {
    const m = modal('Удалить заметку?', [
      el('p', {}, 'Заметка «' + path + '» будет перемещена в .trash внутри vault — файл не пропадёт и его можно вернуть вручную.'),
    ], [
      el('button', { class: 'btn btn-secondary', onclick: () => m.close() }, 'Отмена'),
      el('button', {
        class: 'btn btn-danger',
        onclick: async () => {
          try {
            await api('/api/admin/notes/delete', { method: 'POST', body: JSON.stringify({ path }) });
            m.close();
            state.current = null;
            await load();
            toast('Заметка убрана в .trash');
            render(container);
          } catch (e) { toast(e.message, true); }
        },
      }, 'Удалить'),
    ]);
  }

  // ——— Автодополнение [[ссылок]] ———
  function attachSuggest(textarea, box) {
    const hide = () => { box.classList.remove('open'); box.innerHTML = ''; };
    const pick = item => {
      const pos = textarea.selectionStart;
      const before = textarea.value.slice(0, pos);
      const open = before.lastIndexOf('[[');
      if (open < 0) return;
      const insert = item.path + ']]';
      textarea.value = before.slice(0, open + 2) + insert + textarea.value.slice(pos);
      textarea.selectionStart = textarea.selectionEnd = open + 2 + insert.length;
      textarea.dispatchEvent(new Event('input'));
      hide();
      textarea.focus();
    };

    textarea.addEventListener('input', () => {
      const pos = textarea.selectionStart;
      const before = textarea.value.slice(0, pos);
      const open = before.lastIndexOf('[[');
      if (open < 0 || before.slice(open).includes(']]') || before.slice(open).length > 60) return hide();
      const q = before.slice(open + 2);
      if (state.suggestTimer) clearTimeout(state.suggestTimer);
      state.suggestTimer = setTimeout(async () => {
        try {
          const r = await api('/api/admin/notes/suggest?q=' + encodeURIComponent(q));
          const items = r.items || [];
          if (!items.length) return hide();
          box.innerHTML = '';
          for (const it of items) {
            box.append(el('div', {
              class: 'suggest-item',
              onmousedown: e => { e.preventDefault(); pick(it); },
            }, el('b', {}, it.title), el('span', {}, it.path)));
          }
          box.classList.add('open');
        } catch { hide(); }
      }, 120);
    });

    textarea.addEventListener('blur', () => setTimeout(hide, 150));
    textarea.addEventListener('keydown', e => {
      if (e.key === 'Escape') hide();
    });
  }

  // ——— Drag&drop картинок ———
  function attachDropzone(zone, textarea, container) {
    const upload = async files => {
      for (const f of files) {
        try {
          const buf = await f.arrayBuffer();
          const r = await api('/api/admin/notes/attach', {
            method: 'POST',
            body: buf,
            headers: { 'X-File-Name': encodeURIComponent(f.name) },
          });
          // вставляем ![[вложение]] в позицию курсора
          const pos = textarea.selectionStart;
          const link = (pos > 0 && textarea.value[pos - 1] !== '\n' ? '\n\n' : '') + '![[' + r.path + ']]\n';
          textarea.value = textarea.value.slice(0, pos) + link + textarea.value.slice(pos);
          textarea.selectionStart = textarea.selectionEnd = pos + link.length;
          textarea.dispatchEvent(new Event('input'));
          toast('Вложение загружено: ' + r.path);
          await load();
        } catch (e) { toast(e.message, true); }
      }
    };

    ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, e => {
      e.preventDefault();
      zone.classList.add('dragging');
    }));
    ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, e => {
      e.preventDefault();
      zone.classList.remove('dragging');
    }));
    zone.addEventListener('drop', e => {
      const files = e.dataTransfer?.files;
      if (files && files.length) upload([...files]);
    });
    textarea.addEventListener('paste', e => {
      const items = [...(e.clipboardData?.items || [])].filter(i => i.type.startsWith('image/'));
      if (!items.length) return;
      e.preventDefault();
      upload(items.map(i => i.getAsFile()).filter(Boolean));
    });
  }

  // ——— Редактор открытой заметки ———
  function editor(container) {
    const wrap = el('div', { class: 'notes-editor' });

    if (!state.current) {
      wrap.append(el('div', { class: 'empty-mini' }, 'Выберите заметку слева или создайте новую. Заметки — обычные .md-файлы в vault, их можно править и в Obsidian.'));
      return wrap;
    }

    const path = state.current;
    const textarea = el('textarea', { class: 'notes-textarea', spellcheck: 'false', 'aria-label': 'Markdown заметки' });
    const preview = el('div', { class: 'note-article markdown-body notes-preview', style: 'min-height:120px' });
    const suggestBox = el('div', { class: 'notes-suggest' });
    const status = el('span', { class: 'notes-status' });

    // содержимое подгружаем сразу
    api('/api/admin/notes/raw?path=' + encodeURIComponent(path)).then(d => {
      textarea.value = d.content;
      schedulePreview();
    }).catch(e => toast(e.message, true));

    const refreshPreview = async () => {
      if (state.previewTimer) clearTimeout(state.previewTimer);
      state.previewTimer = setTimeout(async () => {
        try {
          const r = await api('/api/admin/notes/preview', {
            method: 'POST',
            body: JSON.stringify({ path, content: textarea.value }),
          });
          preview.innerHTML = r.html || '';
        } catch (e) { preview.textContent = 'Предпросмотр недоступен: ' + e.message; }
      }, 350);
    };
    function schedulePreview() { refreshPreview(); }

    const save = async () => {
      try {
        const r = await api('/api/admin/notes', { method: 'PUT', body: JSON.stringify({ path, content: textarea.value }) });
        state.dirty = false;
        status.textContent = 'сохранено ' + new Date().toLocaleTimeString('ru-RU');
        toast('Сохранено' + (r.created ? ' (новая заметка)' : ''));
        await load();
        render(container);
      } catch (e) { toast(e.message, true); }
    };

    textarea.addEventListener('input', () => {
      state.dirty = true;
      status.textContent = 'не сохранено';
      schedulePreview();
    });

    textarea.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    });

    attachSuggest(textarea, suggestBox);
    attachDropzone(wrap, textarea, container);

    const slug = slugOf(path);
    const bar = el('div', { class: 'notes-editor-bar' },
      el('button', { class: 'btn btn-primary', onclick: save }, 'Сохранить'),
      status,
      el('span', { class: 'spacer', style: 'flex:1' }),
      slug ? el('a', { class: 'btn btn-secondary', href: '/notes/' + encodeURIComponent(slug), target: '_blank', rel: 'noopener' }, '↗ Открыть на сайте') : null,
      el('button', { class: 'btn btn-secondary', onclick: () => renameDialog(container, path) }, 'Переименовать'),
      el('button', { class: 'btn btn-secondary', onclick: () => deleteDialog(container, path) }, 'Удалить'));

    const panes = el('div', { class: 'notes-panes' },
      el('div', { class: 'notes-pane' },
        el('div', { class: 'notes-pane-head' }, 'Markdown', el('span', { class: 'muted' }, '[[ — ссылка, # — тег, Ctrl+S — сохранить')),
        suggestBox,
        textarea),
      el('div', { class: 'notes-pane' },
        el('div', { class: 'notes-pane-head' }, 'Предпросмотр', el('span', { class: 'muted' }, 'точно как на сайте')),
        preview));

    wrap.append(el('div', { class: 'notes-path muted' }, path + '.md'), bar, panes);
    return wrap;
  }

  // ——— Сборка раздела ———
  async function render(container) {
    container.innerHTML = '';
    const head = el('div', { class: 'page-head-admin' },
      el('h1', {}, 'Заметки'),
      el('div', { class: 'row-actions' },
        el('button', { class: 'btn btn-primary', onclick: () => newNoteDialog(container) }, 'Новая заметка'),
        el('a', { class: 'btn btn-secondary', href: '/notes/graph', target: '_blank', rel: 'noopener' }, '↗ Граф'),
        el('button', {
          class: 'btn btn-secondary',
          title: 'Переслучайнить цвета тегов на графе связей',
          onclick: async e => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
              const r = await api('/api/admin/notes/graph-colors', { method: 'POST', body: '{}' });
              toast('Цвета графа обновлены: ' + Object.keys(r.colors || {}).length + ' тегов');
            } catch (err) { toast(err.message, true); }
            btn.disabled = false;
          },
        }, '🎨 Переделать цвета графа'),
        el('button', {
          class: 'btn btn-secondary',
          onclick: async e => {
            e.currentTarget.disabled = true;
            try {
              const r = await api('/api/admin/notes/reindex', { method: 'POST', body: '{}' });
              await load();
              toast('Переиндексировано: файлов ' + r.stats.scanned + ', заметок ' + r.stats.notes);
              render(container);
            } catch (err) { toast(err.message, true); e.currentTarget.disabled = false; }
          },
        }, 'Переиндексировать')));

    const st = state.stats || {};
    const stats = el('div', { class: 'notes-stats' },
      el('span', {}, 'Заметок: ', el('b', {}, String(st.notes || 0))),
      el('span', {}, 'Ссылок: ', el('b', {}, String(st.links || 0))),
      st.broken ? el('span', { class: 'warn' }, 'Битых ссылок: ', el('b', {}, String(st.broken))) : null,
      el('span', {}, 'Тегов: ', el('b', {}, String(st.tags || 0))),
      el('span', {}, 'Одиночных: ', el('b', {}, String(st.orphans || 0))),
      el('span', { class: 'muted notes-vault' }, 'vault: ' + (state.vault || '—')));

    const filter = el('input', { type: 'search', class: 'notes-filter', placeholder: 'Фильтр по названию, пути или тегу…' });
    const listHost = el('div', {}, noteList('', container));
    filter.addEventListener('input', () => {
      listHost.innerHTML = '';
      listHost.append(noteList(filter.value, container));
    });

    const left = el('div', { class: 'notes-admin-side' }, filter, listHost);
    const right = editor(container);

    container.append(head, stats, el('div', { class: 'notes-admin-layout' }, left, right));
  }

  // Раздел вызывается из hash-роутера админки: (content, params) => Promise
  return async function notesSection(content) {
    content.innerHTML = '<div class="empty-mini">Загрузка…</div>';
    try {
      await load();
      await render(content);
    } catch (e) {
      content.innerHTML = '';
      content.append(el('div', { class: 'alert alert-err' }, 'Не удалось загрузить заметки: ' + e.message));
    }
  };
}