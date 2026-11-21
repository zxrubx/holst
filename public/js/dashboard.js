'use strict';
(async () => {
  const app = $('#app');
  const COVERS = ['#ececff', '#e6f6ee', '#fff4d6', '#ffe8e3', '#e3f1ff', '#f6e8ff', '#eef0f3', '#fde7f3'];
  const EMOJI = ['📘', '🇬🇧', '🇪🇸', '🇩🇪', '🇫🇷', '🇮🇹', '🇨🇳', '🇯🇵', '✏️', '🎧', '🗣️', '⭐', '🧩', '📝'];
  let cfg = { appName: 'Доска' }, me = null, boards = [], folder = null, q = '';
  try { cfg = await api('/api/config'); } catch { }
  document.title = cfg.appName;
  const logo = `<div class="logo"><div class="mark"><svg class="i" viewBox="0 0 24 24" style="width:16px;height:16px"><path d="M4 16c3-7 6-9 7-6s3 2 7-5" stroke-width="2.6"/></svg></div>${esc(cfg.appName)}</div>`;

  try { me = (await api('/api/me')).user; } catch { }
  if (!me) return renderAuth(cfg.signup ? 'signup' : 'login');
  load();

  function renderAuth(mode) {
    app.innerHTML = `<div class="auth"><div class="panel">
      ${logo}<h1 style="margin-top:22px">${mode === 'signup' ? 'Создать аккаунт' : 'Вход'}</h1>
      <div class="hint" style="margin-bottom:10px">${mode === 'signup' ? 'Аккаунт преподавателя: создавайте доски и делитесь ими с учениками.' : 'Войдите, чтобы открыть свои доски.'}</div>
      <form>
        ${mode === 'signup' ? '<label class="lbl">Имя</label><input class="field" name="name" required>' : ''}
        <label class="lbl">Email</label><input class="field" name="email" type="email" required autocomplete="username">
        <label class="lbl">Пароль</label><input class="field" name="password" type="password" required minlength="6" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}">
        <div class="err"></div>
        <button class="btn primary" style="width:100%;margin-top:6px">${mode === 'signup' ? 'Зарегистрироваться' : 'Войти'}</button>
      </form>
      ${cfg.signup ? `<div class="hint" style="text-align:center;margin-top:14px"><a href="#" data-sw>${mode === 'signup' ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Регистрация'}</a></div>` : ''}
    </div></div>`;
    const f = $('form', app);
    f.onsubmit = async e => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(f));
      try {
        me = (await api(mode === 'signup' ? '/api/signup' : '/api/login', { body })).user;
        load();
      } catch (err) { $('.err', app).textContent = err.message; }
    };
    const sw = $('[data-sw]', app);
    if (sw) sw.onclick = e => { e.preventDefault(); renderAuth(mode === 'signup' ? 'login' : 'signup'); };
  }

  async function load() {
    try { boards = (await api('/api/boards')).boards; } catch (e) { toast(e.message); boards = []; }
    render();
  }

  function cover(b) {
    const c = b.cover || '';
    const [col, em] = c.split('|');
    const hash = [...b.id].reduce((a, ch) => a + ch.charCodeAt(0), 0);
    return { color: col || COVERS[hash % COVERS.length], emoji: em || '' };
  }
  function fmt(t) {
    const d = new Date(t), n = new Date();
    if (d.toDateString() === n.toDateString()) return 'сегодня, ' + d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('ru', { day: 'numeric', month: 'short', year: d.getFullYear() !== n.getFullYear() ? 'numeric' : undefined });
  }

  function render() {
    const folders = [...new Set(boards.map(b => b.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
    if (folder && !folders.includes(folder)) folder = null;
    const list = boards.filter(b => (!folder || b.folder === folder) && (!q || b.title.toLowerCase().includes(q.toLowerCase())));
    app.innerHTML = `<div class="dash">
      <aside>${logo}
        <button class="navb ${!folder ? 'on' : ''}" data-f="">${icon('grid')}Все доски<span class="cnt">${boards.length}</span></button>
        <div class="mh" style="font-size:12px;color:var(--muted);padding:16px 10px 6px">Папки</div>
        ${folders.map(f => `<button class="navb ${folder === f ? 'on' : ''}" data-f="${esc(f)}">${icon('folder')}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f)}</span><span class="cnt">${boards.filter(b => b.folder === f).length}</span></button>`).join('')}
        ${!folders.length ? '<div class="hint" style="padding:0 10px">Папки появятся, когда вы переместите в них доски.</div>' : ''}
        <div style="margin-top:auto"></div>
        <button class="navb" data-acc>${icon('users')}<span style="overflow:hidden;text-overflow:ellipsis">${esc(me.name)}</span></button>
      </aside>
      <main>
        <header>
          <h1>${folder ? esc(folder) : 'Мои доски'}</h1>
          <input class="field search" placeholder="Поиск…" value="${esc(q)}" id="q">
          <button class="btn" id="imp">${icon('upload')}Импорт</button>
          <button class="btn primary" id="new">${icon('plus')}Новая доска</button>
        </header>
        ${list.length ? `<div class="grid">${list.map(b => {
          const c = cover(b);
          return `<div class="card" data-id="${b.id}">
            <div class="cover" style="background-color:${esc(c.color)}"><span class="em">${esc(c.emoji)}</span></div>
            <button class="ibtn more" data-more="${b.id}">${icon('more')}</button>
            <div class="meta"><div class="t">${esc(b.title)}</div><div class="d">${fmt(b.updatedAt)}${b.folder && !folder ? ' · ' + esc(b.folder) : ''}</div></div>
          </div>`;
        }).join('')}</div>` : `<div class="empty">${boards.length ? 'Ничего не найдено' : 'Пока нет досок. Создайте первую!'}</div>`}
      </main></div>`;

    $$('[data-f]', app).forEach(b => b.onclick = () => { folder = b.dataset.f || null; render(); });
    $('#q').oninput = e => { q = e.target.value; const pos = e.target.selectionStart; render(); const i = $('#q'); i.focus(); i.setSelectionRange(pos, pos); };
    $('#new').onclick = async () => {
      const t = await prompt2('Новая доска', '', { placeholder: 'Например: Present Simple — урок 3', ok: 'Создать' });
      if (t === null) return;
      const { board } = await api('/api/boards', { body: { title: t || 'Новая доска', folder: folder || '' } });
      location.href = '/b/' + board.id;
    };
    $('#imp').onclick = () => {
      const inp = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
      inp.onchange = async () => {
        try {
          const data = JSON.parse(await inp.files[0].text());
          await api('/api/boards/import', { body: { ...data, folder: folder || data.folder || '' } });
          toast('Доска импортирована'); load();
        } catch (e) { toast('Не удалось импортировать: ' + e.message); }
      };
      inp.click();
    };
    $('[data-acc]', app).onclick = e => {
      const r = e.currentTarget.getBoundingClientRect();
      menu(r.left, r.top - 110, [
        { header: me.email },
        { label: 'Сменить пароль', icon: 'key', onClick: changePass },
        { label: 'Выйти', icon: 'logout', onClick: async () => { await api('/api/logout', { body: {} }); location.reload(); } }
      ]);
    };
    $$('.card', app).forEach(c => c.onclick = e => {
      if (e.target.closest('[data-more]')) return;
      location.href = '/b/' + c.dataset.id;
    });
    $$('[data-more]', app).forEach(btn => btn.onclick = e => {
      e.stopPropagation();
      const b = boards.find(x => x.id === btn.dataset.more);
      const r = btn.getBoundingClientRect();
      menu(r.left, r.bottom + 4, [
        { label: 'Открыть в новой вкладке', icon: 'right', onClick: () => open('/b/' + b.id) },
        { label: 'Ссылка для ученика', icon: 'link', onClick: () => copyLink(b) },
        '-',
        { label: 'Переименовать', icon: 'edit', onClick: async () => { const t = await prompt2('Название доски', b.title); if (t) { await api('/api/boards/' + b.id, { method: 'PATCH', body: { title: t } }); load(); } } },
        { label: 'Переместить в папку', icon: 'folder', onClick: async () => { const t = await prompt2('Папка', b.folder, { placeholder: 'Например: Английский A2', hint: 'Оставьте пустым, чтобы убрать из папки. Введите новое имя — папка создастся.' }); if (t !== null) { await api('/api/boards/' + b.id, { method: 'PATCH', body: { folder: t.trim() } }); load(); } } },
        { label: 'Обложка', icon: 'palette', onClick: () => pickCover(b) },
        { label: 'Дублировать (как шаблон)', icon: 'copy', onClick: async () => { await api('/api/boards/' + b.id + '/duplicate', { body: {} }); toast('Копия создана (ответы учеников сброшены)'); load(); } },
        { label: 'Экспорт в файл', icon: 'download', onClick: () => { location.href = '/api/boards/' + b.id + '/export'; } },
        '-',
        { label: 'Удалить', icon: 'trash', danger: true, onClick: async () => { if (await confirm2('Удалить доску?', `«${b.title}» будет удалена без возможности восстановления.`)) { await api('/api/boards/' + b.id, { method: 'DELETE' }); load(); } } }
      ]);
    });
  }

  function copyLink(b) {
    if (b.shareMode === 'off') return toast('Доступ по ссылке выключен — включите его внутри доски');
    const url = location.origin + '/b/' + b.id + '?k=' + b.shareToken;
    navigator.clipboard?.writeText(url).then(() => toast('Ссылка скопирована'), () => prompt2('Ссылка для ученика', url));
  }
  function pickCover(b) {
    const cur = cover(b);
    let col = cur.color, em = cur.emoji;
    const m = modal(`<h2>Обложка</h2><label class="lbl">Цвет</label><div class="row" style="flex-wrap:wrap" id="cc">${COVERS.map(c => `<button class="sw ${c === col ? 'on' : ''}" style="background:${c};width:34px;height:34px" data-c="${c}"></button>`).join('')}</div>
      <label class="lbl">Значок</label><div class="row" style="flex-wrap:wrap;gap:4px" id="ce"><button class="ibtn ${!em ? 'on' : ''}" data-e="">—</button>${EMOJI.map(e => `<button class="ibtn ${e === em ? 'on' : ''}" style="font-size:20px" data-e="${e}">${e}</button>`).join('')}</div>
      <div class="actions"><button class="btn" data-close>Отмена</button><button class="btn primary" id="ok">Сохранить</button></div>`);
    m.el.querySelectorAll('[data-c]').forEach(x => x.onclick = () => { col = x.dataset.c; m.el.querySelectorAll('[data-c]').forEach(y => y.classList.toggle('on', y === x)); });
    m.el.querySelectorAll('[data-e]').forEach(x => x.onclick = () => { em = x.dataset.e; m.el.querySelectorAll('[data-e]').forEach(y => y.classList.toggle('on', y === x)); });
    m.el.querySelector('#ok').onclick = async () => { await api('/api/boards/' + b.id, { method: 'PATCH', body: { cover: col + '|' + em } }); m.close(); load(); };
  }
  function changePass() {
    const m = modal(`<h2>Сменить пароль</h2><form><label class="lbl">Текущий пароль</label><input class="field" type="password" name="oldPassword" required autofocus>
      <label class="lbl">Новый пароль</label><input class="field" type="password" name="newPassword" required minlength="6">
      <div class="actions"><button type="button" class="btn" data-close>Отмена</button><button class="btn primary">Сохранить</button></div></form>`);
    m.el.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      try { await api('/api/password', { body: Object.fromEntries(new FormData(e.target)) }); toast('Пароль изменён'); m.close(); } catch (err) { toast(err.message); }
    };
  }
})();
