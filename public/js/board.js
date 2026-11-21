'use strict';
(() => {
  // ============================================================
  //  Состояние
  // ============================================================
  const boardId = location.pathname.split('/').pop();
  const KEY = new URLSearchParams(location.search).get('k') || '';
  const vp = $('#viewport'), world = $('#world'), framesL = $('#frames'), itemsL = $('#items');
  const cv = $('#overlay'), cx = cv.getContext('2d');
  const selbox = $('#selbox'), ctxbar = $('#ctxbar'), marqueeEl = $('#marquee');

  const COLORS = ['#1f2328', '#e5484d', '#f76b15', '#f5b400', '#30a46c', '#0090ff', '#6e56cf', '#d6409f', '#8b8d98', '#ffffff'];
  const HL_COLORS = ['#ffe14d', '#7cf29a', '#ff9ccf', '#8fd3ff', '#ffb86b'];
  const STICKY = ['#fff3a8', '#ffd8a8', '#ffc9c9', '#c3fae8', '#d0ebff', '#e5dbff', '#f1f3f5'];
  const FRAME_BG = ['#ffffff', '#f8f9fa', '#fff9db', '#ebfbee', '#e7f5ff', '#f3f0ff', '#fff0f6', '#1f2328'];
  const EX = new Set(['gaps', 'quiz', 'match', 'order']);
  const AUTO_H = new Set(['text', 'gaps', 'quiz', 'match', 'order', 'audio', 'link', 'file']);
  const WIDTH_ONLY = new Set(['text', 'gaps', 'quiz', 'match', 'order', 'audio', 'link', 'file']);
  const ASPECT = new Set(['image', 'video']);
  const PT_SUPPORTED = (() => { const d = document.createElement('div'); d.contentEditable = 'plaintext-only'; return d.contentEditable === 'plaintext-only'; })();

  const items = new Map(), els = new Map(), peers = new Map();
  let me = null, role = 'view', shareToken = '', shareMode = 'edit', title = '';
  let sel = new Set();
  let view = { x: innerWidth / 2, y: innerHeight / 2, z: 1 };
  let tool = 'select', maxZ = 0, minZ = 0;
  let editing = null;
  let undoStack = [], redoStack = [];
  let leader = null, following = true, leading = false;
  let presentIdx = -1;
  let lastPointerWorld = { x: 0, y: 0 };

  const defaultOpts = {
    pen: { c: '#1f2328', s: 4 }, hl: { c: '#ffe14d', s: 22 }, shape: { k: 'rect', c: '#1f2328', fill: 'none', sw: 3 },
    text: { c: '#1f2328', fs: 28 }, sticky: { c: '#fff3a8' }
  };
  let opts = defaultOpts;
  try { opts = Object.assign({}, defaultOpts, JSON.parse(localStorage.getItem('board-opts') || '{}')); } catch { }
  const saveOpts = () => { try { localStorage.setItem('board-opts', JSON.stringify(opts)); } catch { } };

  const canEdit = () => role === 'owner' || role === 'edit';
  const isOwner = () => role === 'owner';
  const canTouch = it => it && (role === 'owner' || (role === 'edit' && !it.locked));
  const isLine = it => it.type === 'shape' && (it.shape === 'line' || it.shape === 'arrow');
  const clone = o => JSON.parse(JSON.stringify(o));
  const r1 = n => Math.round(n * 10) / 10;

  // ============================================================
  //  Сеть
  // ============================================================
  let ws = null, connected = false, retry = 0, outbox = [], myName = '';

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?board=${encodeURIComponent(boardId)}&k=${encodeURIComponent(KEY)}&name=${encodeURIComponent(myName)}`);
    ws.onmessage = e => { try { onMsg(JSON.parse(e.data)); } catch (err) { console.error(err); } };
    ws.onclose = e => {
      connected = false;
      if (e.code === 4003) return fatal('Доступ к доске закрыт владельцем.');
      if (retry === 1) toast('Связь потеряна, переподключаемся…');
      setTimeout(connect, Math.min(8000, 400 * 2 ** retry++));
    };
  }
  function send(m) {
    if (ws && ws.readyState === 1 && connected) ws.send(JSON.stringify(m));
    else if (m.t === 'op') outbox.push(m);
  }
  setInterval(() => send({ t: 'ping' }), 25000);

  function onMsg(m) {
    switch (m.t) {
      case 'init': {
        const wasConnected = retry > 0;
        retry = 0; connected = true;
        me = m.me; role = me.role; title = m.board.title; shareMode = m.board.shareMode;
        if (m.board.shareToken) shareToken = m.board.shareToken;
        for (const el of els.values()) el.remove();
        items.clear(); els.clear(); sel.clear();
        for (const it of Object.values(m.board.items)) { items.set(it.id, it); trackZ(it); }
        // рисуем снизу вверх для правильного порядка DOM
        [...items.values()].sort((a, b) => (a.z || 0) - (b.z || 0)).forEach(renderItem);
        peers.forEach(p => p.el && p.el.remove()); peers.clear();
        m.peers.forEach(p => { if (p.id !== me.id) peers.set(p.id, p); });
        const pending = outbox; outbox = [];
        for (const msg of pending) { msg.ops.forEach(applyOp); send(msg); }
        $('#loading').hidden = true;
        document.body.classList.toggle('viewer', !canEdit());
        document.body.classList.toggle('show-locks', isOwner());
        buildChrome();
        if (!wasConnected) initialView();
        if (tool !== 'select' && !canEdit() && !['hand', 'laser'].includes(tool)) setTool('hand');
        if (!canEdit() && tool === 'select') setTool('hand');
        scheduleUi();
        if (wasConnected) toast('Соединение восстановлено');
        break;
      }
      case 'op':
        m.ops.forEach(applyOp);
        clearInk(m.from);
        scheduleUi();
        break;
      case 'join': peers.set(m.peer.id, m.peer); renderPeers(); break;
      case 'leave': {
        const p = peers.get(m.id); if (p && p.el) p.el.remove(); peers.delete(m.id);
        if (leader && leader.id === m.id) { leader = null; renderFollow(); }
        renderPeers(); break;
      }
      case 'cursor': {
        const p = peers.get(m.id); if (!p) return;
        p.x = m.x; p.y = m.y; drawCursor(p); break;
      }
      case 'laser': {
        const p = peers.get(m.id);
        addTrail('L' + m.id, m.pts, p ? p.color : '#e5484d', true); break;
      }
      case 'ink': addInk(m); break;
      case 'view': {
        if (m.on === false) { if (leader && leader.id === m.id) { leader = null; renderFollow(); } return; }
        if (!leader || leader.id !== m.id) { leader = { id: m.id, name: m.name }; following = true; leading = false; }
        renderFollow();
        if (following) fitRect(m.r, false, true);
        break;
      }
      case 'attention':
        fitRect(m.r, true, true);
        toast(`${m.name} зовёт всех сюда 👋`);
        break;
      case 'meta':
        if (m.title != null) { title = m.title; const t = $('#title'); if (t && document.activeElement !== t) t.textContent = title; document.title = title; }
        if (m.shareMode) shareMode = m.shareMode;
        break;
    }
  }

  // ============================================================
  //  Операции и история
  // ============================================================
  function trackZ(it) { if (it.z != null) { if (it.z > maxZ) maxZ = it.z; if (it.z < minZ) minZ = it.z; } }
  const nextZ = () => ++maxZ;

  function applyOp(op) {
    if (op.o === 'put') {
      const it = clone(op.item);
      items.set(it.id, it); trackZ(it); renderItem(it);
    } else if (op.o === 'patch') {
      const it = items.get(op.id); if (!it) return;
      const keys = Object.keys(op.p);
      for (const k of keys) { if (op.p[k] === null) delete it[k]; else it[k] = clone(op.p[k]); }
      trackZ(it);
      const el = els.get(it.id);
      if (!el) return;
      if (!isLine(it) && keys.every(k => k === 'x' || k === 'y' || k === 'z' || k === 'locked')) setPos(el, it);
      else if (keys.every(k => k === 'state')) renderState(el, it);
      else renderItem(it);
    } else if (op.o === 'del') {
      items.delete(op.id);
      const el = els.get(op.id); if (el) el.remove();
      els.delete(op.id); sel.delete(op.id);
      if (editing && editing.id === op.id) editing = null;
    }
  }
  function commit(ops, inv, hist = true) {
    if (!ops.length) return;
    ops.forEach(applyOp);
    send({ t: 'op', ops });
    if (hist) { undoStack.push({ ops, inv }); if (undoStack.length > 200) undoStack.shift(); redoStack = []; }
    scheduleUi();
  }
  function pushHist(ops, inv) { undoStack.push({ ops, inv }); redoStack = []; updateHistBtns(); }
  function undo() {
    const h = undoStack.pop(); if (!h) return;
    finishEdit();
    commit(h.inv, h.ops, false); redoStack.push(h); updateHistBtns();
  }
  function redo() {
    const h = redoStack.pop(); if (!h) return;
    commit(h.ops, h.inv, false); undoStack.push(h); updateHistBtns();
  }
  function addItems(list, select = true) {
    commit(list.map(item => ({ o: 'put', item })), list.map(i => ({ o: 'del', id: i.id })));
    if (select) setSel(list.map(i => i.id));
  }
  function patchItems(map, hist = true) {
    const ops = [], inv = [];
    for (const id in map) {
      const it = items.get(id); if (!it) continue;
      const before = {};
      for (const k in map[id]) before[k] = it[k] === undefined ? null : clone(it[k]);
      ops.push({ o: 'patch', id, p: map[id] }); inv.push({ o: 'patch', id, p: before });
    }
    commit(ops, inv, hist);
  }
  function delItems(ids) {
    ids = [...ids].filter(id => canTouch(items.get(id)));
    if (!ids.length) return;
    const inv = ids.map(id => ({ o: 'put', item: clone(items.get(id)) }));
    commit(ids.map(id => ({ o: 'del', id })), inv);
    setSel([]);
  }
  // «живые» изменения (без истории) отправляем пачками
  const livePending = new Map(); let liveTimer = 0;
  function livePatch(id, p) {
    livePending.set(id, Object.assign(livePending.get(id) || {}, p));
    if (!liveTimer) liveTimer = setTimeout(flushLive, 50);
  }
  function flushLive() {
    clearTimeout(liveTimer); liveTimer = 0;
    if (!livePending.size) return;
    const ops = [...livePending].map(([id, p]) => ({ o: 'patch', id, p }));
    livePending.clear();
    send({ t: 'op', ops });
  }
  addEventListener('beforeunload', flushLive);

  // ============================================================
  //  Отрисовка объектов
  // ============================================================
  function setPos(el, it) {
    el.style.transform = `translate(${it.x}px,${it.y}px)`;
    el.style.zIndex = it.z || 0;
    el.classList.toggle('locked', !!it.locked);
  }
  function renderItem(it) {
    let el = els.get(it.id);
    if (!el) {
      el = document.createElement('div');
      el.dataset.id = it.id;
      els.set(it.id, el);
      (it.type === 'frame' ? framesL : itemsL).appendChild(el);
    }
    el.className = 'it it-' + it.type;
    let x = it.x, y = it.y;
    if (isLine(it)) { x = Math.min(it.x, it.x + it.w); y = Math.min(it.y, it.y + it.h); }
    setPos(el, { ...it, x, y });
    (R[it.type] || R.unknown)(el, it);
    if (isOwner() && !el.querySelector(':scope>.lockbadge')) el.insertAdjacentHTML('beforeend', `<div class="lockbadge">${icon('lock')}</div>`);
  }
  function size(el, w, h) { el.style.width = w != null ? w + 'px' : ''; el.style.height = h != null ? h + 'px' : ''; }

  function pathD(p) {
    if (p.length < 4) return `M${p[0]} ${p[1]}l.01 0`;
    let d = `M${p[0]} ${p[1]}`;
    for (let i = 2; i < p.length - 2; i += 2) d += `Q${p[i]} ${p[i + 1]} ${r1((p[i] + p[i + 2]) / 2)} ${r1((p[i + 1] + p[i + 3]) / 2)}`;
    return d + `L${p[p.length - 2]} ${p[p.length - 1]}`;
  }
  function shapeSvg(it) {
    const w = Math.abs(it.w), h = Math.abs(it.h), sw = it.sw || 2, hs = sw / 2;
    const st = it.stroke || '#1f2328', fill = it.fill || 'none';
    let inner = '';
    switch (it.shape) {
      case 'ellipse': inner = `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${Math.max(0, w / 2 - hs)}" ry="${Math.max(0, h / 2 - hs)}"/>`; break;
      case 'triangle': inner = `<polygon points="${w / 2},${hs} ${w - hs},${h - hs} ${hs},${h - hs}"/>`; break;
      case 'diamond': inner = `<polygon points="${w / 2},${hs} ${w - hs},${h / 2} ${w / 2},${h - hs} ${hs},${h / 2}"/>`; break;
      case 'line': case 'arrow': {
        const x1 = it.w < 0 ? w : 0, y1 = it.h < 0 ? h : 0, x2 = w - x1, y2 = h - y1;
        inner = `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
        if (it.shape === 'arrow') {
          const a = Math.atan2(y2 - y1, x2 - x1), L = 10 + sw * 3;
          const p = [[x2, y2], [x2 - L * Math.cos(a - .45), y2 - L * Math.sin(a - .45)], [x2 - L * Math.cos(a + .45), y2 - L * Math.sin(a + .45)]];
          inner += `<polygon fill="${st}" points="${p.map(q => q.map(r1).join(',')).join(' ')}"/>`;
        }
        break;
      }
      default: inner = `<rect x="${hs}" y="${hs}" width="${Math.max(0, w - sw)}" height="${Math.max(0, h - sw)}" rx="${Math.min(10, w / 4, h / 4)}"/>`;
    }
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><g fill="${esc(fill)}" stroke="${esc(st)}" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round">${inner}</g></svg>`;
  }
  function txtDiv(el, it, styles) {
    let t = el.querySelector(':scope>.txt');
    if (!t) { t = document.createElement('div'); t.className = 'txt'; el.appendChild(t); }
    if (!(editing && editing.id === it.id)) t.textContent = it.text || '';
    Object.assign(t.style, styles);
    return t;
  }
  const ytId = u => { const m = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/.exec(u || ''); return m && m[1]; };
  const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' МБ' : Math.round(n / 1024) + ' КБ';

  const R = {
    stroke(el, it) {
      size(el, it.w, it.h);
      el.innerHTML = `<svg width="${it.w}" height="${it.h}" viewBox="0 0 ${it.vw} ${it.vh}" preserveAspectRatio="none"><path d="${pathD(it.pts)}" fill="none" stroke="${esc(it.c)}" stroke-width="${it.s}" stroke-linecap="round" stroke-linejoin="round"${it.o ? ` opacity="${it.o}"` : ''}/></svg>`;
    },
    shape(el, it) {
      const line = isLine(it);
      el.classList.toggle('line', line);
      size(el, Math.abs(it.w), Math.abs(it.h));
      const t = el.querySelector(':scope>.txt');
      el.innerHTML = shapeSvg(it);
      if (t) el.appendChild(t);
      if (!line) txtDiv(el, it, { fontSize: (it.fs || 20) + 'px', color: it.tc || '#1f2328' });
    },
    text(el, it) {
      el.classList.toggle('wrap', it.w != null);
      size(el, it.w, null);
      txtDiv(el, it, { fontSize: (it.fs || 24) + 'px', color: it.c || '#1f2328', fontWeight: it.b ? '700' : '400', textAlign: it.al || 'left', fontStyle: it.i ? 'italic' : 'normal', background: it.bg || '' });
    },
    sticky(el, it) {
      size(el, it.w, it.h);
      el.style.background = it.c || '#fff3a8';
      txtDiv(el, it, { fontSize: (it.fs || 18) + 'px', textAlign: it.al || 'left', fontWeight: it.b ? '700' : '400' });
    },
    image(el, it) {
      size(el, it.w, it.h);
      const img = el.querySelector('img');
      if (img && img.getAttribute('src') === it.src) return;
      el.innerHTML = `<img src="${esc(it.src)}" decoding="async" loading="lazy" draggable="false" alt="">`;
    },
    video(el, it) {
      size(el, it.w, it.h);
      if (el.querySelector('iframe,video') && el._src === (it.yt || it.src)) return;
      el._src = it.yt || it.src;
      if (it.yt) {
        el.innerHTML = `<img src="https://i.ytimg.com/vi/${esc(it.yt)}/hqdefault.jpg" loading="lazy" alt=""><button class="play" data-play>${icon('play')}</button>`;
      } else {
        el.innerHTML = `<video src="${esc(it.src)}" controls preload="metadata"></video><div class="bar"></div>`;
      }
    },
    audio(el, it) {
      size(el, it.w || 340, null);
      el.classList.add('card-it');
      if (el._src === it.src && el.querySelector('audio')) { el.querySelector('.nm').textContent = it.name || 'Аудио'; return; }
      el._src = it.src;
      el.innerHTML = `<div class="top"><div class="ic">${icon('music')}</div><div class="grow"><div class="nm">${esc(it.name || 'Аудио')}</div><div class="sub">Аудиозапись</div></div></div><audio src="${esc(it.src)}" controls preload="metadata"></audio>`;
    },
    link(el, it) {
      size(el, it.w || 340, null);
      el.classList.add('card-it');
      let host = ''; try { host = new URL(it.url).hostname; } catch { }
      el.innerHTML = `<div class="ic">${icon('link')}</div><div class="grow"><div class="nm">${esc(it.title || host)}</div><div class="sub">${esc(it.url)}</div></div><a class="ibtn" href="${esc(safeUrl(it.url))}" target="_blank" rel="noopener noreferrer" title="Открыть">${icon('right')}</a>`;
    },
    file(el, it) {
      size(el, it.w || 340, null);
      el.classList.add('card-it');
      el.innerHTML = `<div class="ic">${icon('file')}</div><div class="grow"><div class="nm">${esc(it.name || 'Файл')}</div><div class="sub">${it.size ? fmtSize(it.size) : ''}</div></div><a class="ibtn" href="${esc(it.src)}" target="_blank" rel="noopener" title="Открыть">${icon('download')}</a>`;
    },
    frame(el, it) {
      size(el, it.w, it.h);
      el.style.background = it.bg || '#fff';
      let t = el.querySelector('.ftitle');
      if (!t) { t = document.createElement('div'); t.className = 'ftitle'; el.appendChild(t); }
      t.textContent = it.title || 'Слайд';
    },
    gaps: renderEx, quiz: renderEx, match: renderEx, order: renderEx,
    unknown(el) { el.textContent = '?'; }
  };
  function safeUrl(u) { return /^https?:\/\//i.test(u || '') ? u : '#'; }

  // ============================================================
  //  Упражнения
  // ============================================================
  const EX_LABEL = { gaps: 'Заполните пропуски', quiz: 'Выберите ответ', match: 'Соедините пары', order: 'Составьте предложение' };
  const PAIR_COLORS = ['#5b5bf6', '#f76b15', '#30a46c', '#d6409f', '#0090ff', '#e5484d', '#8e4ec6', '#12a594', '#f5b400', '#3e63dd'];
  const norm = s => String(s || '').toLowerCase().replace(/[’‘`´]/g, "'").replace(/ё/g, 'е').replace(/\s+/g, ' ').trim().replace(/[.!?,;]+$/, '');
  let matchPick = null;

  function parseGaps(text) {
    const parts = [], re = /\[([^\]]*)\]|\{([^}]*)\}/g; let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parts.push({ t: text.slice(last, m.index) });
      if (m[1] != null) parts.push({ g: 'in', ans: m[1].split('/').map(s => s.trim()).filter(Boolean) });
      else {
        const o = m[2].split('|').map(s => s.trim()).filter(Boolean);
        parts.push({ g: 'sel', opts: o.map(s => s.replace(/^\*/, '').trim()), ans: o.filter(s => s.startsWith('*')).map(s => s.slice(1).trim()) });
      }
      last = re.lastIndex;
    }
    if (last < text.length) parts.push({ t: text.slice(last) });
    return parts;
  }
  function renderEx(el, it) {
    size(el, it.w || 460, null);
    el.classList.add('ex');
    el.classList.toggle('multi', it.type === 'quiz' && (it.opts || []).filter(o => o.ok).length > 1);
    let body = '';
    if (it.type === 'gaps') {
      let gi = 0;
      body = parseGaps(it.text || '').map(p => {
        if (p.t != null) return esc(p.t).replace(/\n/g, '<br>');
        const i = gi++;
        if (p.g === 'in') {
          const len = Math.max(4, ...p.ans.map(a => a.length)) + 2;
          return `<input class="gap" data-i="${i}" style="width:${len}ch" autocomplete="off" autocorrect="off" spellcheck="false">`;
        }
        return `<select class="gap" data-i="${i}"><option value=""></option>${p.opts.map(o => `<option>${esc(o)}</option>`).join('')}</select>`;
      }).join('');
    } else if (it.type === 'quiz') {
      body = (it.q ? `<div class="ext">${esc(it.q)}</div>` : '') + (it.opts || []).map((o, i) => `<button class="opt" data-o="${i}"><span class="mk"></span><span>${esc(o.t)}</span></button>`).join('');
    } else if (it.type === 'match') {
      const pairs = it.pairs || [];
      const perm = it.perm || pairs.map((_, i) => i);
      body = `<div class="cols"><div class="col">${pairs.map((p, i) => `<button class="chip" data-l="${i}"><span class="lbl2">${esc(p[0])}</span></button>`).join('')}</div>
        <div class="col">${perm.map(i => `<button class="chip" data-r="${i}"><span class="lbl2">${esc(pairs[i] ? pairs[i][1] : '')}</span></button>`).join('')}</div></div>`;
    } else if (it.type === 'order') {
      body = `<div class="line"></div><div class="pool"></div>`;
    }
    el.innerHTML = `<div class="exh"><span class="dot"></span>${esc(EX_LABEL[it.type])}</div>${it.title ? `<div class="ext">${esc(it.title)}</div>` : ''}
      <div class="exb">${body}</div>
      <div class="exf"><button class="btn small" data-act="check">${icon('check')}Проверить</button><button class="btn small" data-act="reset" title="Сбросить ответы">${icon('refresh')}</button><span class="res"></span></div>`;
    renderState(el, it);
  }
  function renderState(el, it) {
    if (!EX.has(it.type)) return;
    const st = it.state || {};
    const chk = !!st.chk;
    let ok = 0, total = 0;
    if (it.type === 'gaps') {
      const parts = parseGaps(it.text || '').filter(p => p.g);
      el.querySelectorAll('.gap').forEach(inp => {
        const i = +inp.dataset.i, v = (st.v || [])[i] || '';
        if (document.activeElement !== inp && inp.value !== v) inp.value = v;
        const right = parts[i] && parts[i].ans.some(a => norm(a) === norm(inp.value));
        total++; if (right) ok++;
        inp.classList.toggle('ok', chk && right);
        inp.classList.toggle('bad', chk && !right);
      });
    } else if (it.type === 'quiz') {
      const s = st.s || [];
      el.querySelectorAll('.opt').forEach(b => {
        const i = +b.dataset.o, on = s.includes(i), good = !!(it.opts[i] && it.opts[i].ok);
        b.classList.toggle('sel', on && !chk);
        b.classList.toggle('ok', chk && on && good);
        b.classList.toggle('bad', chk && on && !good);
        b.classList.toggle('miss', chk && !on && good);
      });
      total = 1; ok = (it.opts || []).every((o, i) => !!o.ok === s.includes(i)) ? 1 : 0;
    } else if (it.type === 'match') {
      const m = st.m || {};
      const pick = matchPick && matchPick.id === it.id ? matchPick.l : null;
      el.querySelectorAll('[data-l]').forEach(b => {
        const l = +b.dataset.l, r = m[l];
        b.querySelector('.n')?.remove();
        if (r != null) b.insertAdjacentHTML('afterbegin', `<span class="n" style="background:${PAIR_COLORS[l % PAIR_COLORS.length]}">${l + 1}</span>`);
        b.classList.toggle('pick', pick === l);
        total++; if (r === l) ok++;
        b.classList.toggle('ok', chk && r === l);
        b.classList.toggle('bad', chk && r !== l);
      });
      el.querySelectorAll('[data-r]').forEach(b => {
        const r = +b.dataset.r;
        b.querySelector('.n')?.remove();
        const l = Object.keys(m).find(k => m[k] === r);
        if (l != null) b.insertAdjacentHTML('afterbegin', `<span class="n" style="background:${PAIR_COLORS[l % PAIR_COLORS.length]}">${+l + 1}</span>`);
      });
    } else if (it.type === 'order') {
      const words = it.words || [], a = st.a || [];
      const perm = it.perm || words.map((_, i) => i);
      const line = el.querySelector('.line'), pool = el.querySelector('.pool');
      line.innerHTML = a.map((wi, k) => `<button class="chip" data-a="${k}">${esc(words[wi])}</button>`).join('');
      pool.innerHTML = perm.filter(i => !a.includes(i)).map(i => `<button class="chip" data-w="${i}">${esc(words[i])}</button>`).join('');
      total = 1; ok = norm(a.map(i => words[i]).join(' ')) === norm(words.join(' ')) ? 1 : 0;
      line.classList.toggle('ok', chk && !!ok); line.classList.toggle('bad', chk && !ok);
    }
    const res = el.querySelector('.res');
    if (res) res.textContent = chk ? (it.type === 'gaps' || it.type === 'match' ? `Верно: ${ok} из ${total}` : ok ? 'Верно! 🎉' : 'Есть ошибки') : '';
    const cb = el.querySelector('[data-act=check]');
    if (cb) cb.classList.toggle('primary', chk);
  }
  const stateTimers = {};
  function setState(it, st, debounce) {
    it.state = st;
    renderState(els.get(it.id), it);
    clearTimeout(stateTimers[it.id]);
    const go = () => send({ t: 'op', ops: [{ o: 'patch', id: it.id, p: { state: it.state } }] });
    if (debounce) stateTimers[it.id] = setTimeout(go, 250); else go();
  }
  itemsL.addEventListener('input', e => {
    const inp = e.target.closest('input.gap'); if (!inp) return;
    const it = items.get(inp.closest('.it').dataset.id);
    const st = clone(it.state || {}); st.v = st.v || []; st.v[+inp.dataset.i] = inp.value;
    setState(it, st, true);
  });
  itemsL.addEventListener('change', e => {
    const s = e.target.closest('select.gap'); if (!s) return;
    const it = items.get(s.closest('.it').dataset.id);
    const st = clone(it.state || {}); st.v = st.v || []; st.v[+s.dataset.i] = s.value;
    setState(it, st);
  });
  itemsL.addEventListener('keydown', e => {
    // Enter/Tab в пропусках — к следующему полю
    if (e.target.matches('input.gap') && e.key === 'Enter') {
      const all = $$('.gap', e.target.closest('.it')); const i = all.indexOf(e.target);
      if (all[i + 1]) all[i + 1].focus(); else e.target.blur();
    }
  });
  itemsL.addEventListener('click', e => {
    const host = e.target.closest('.it'); if (!host) return;
    const it = items.get(host.dataset.id); if (!it) return;
    const play = e.target.closest('[data-play]');
    if (play && it.yt) {
      host.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(it.yt)}?autoplay=1&rel=0" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe><div class="bar"></div>`;
      return;
    }
    if (!EX.has(it.type)) return;
    const st = clone(it.state || {});
    const act = e.target.closest('[data-act]');
    if (act) {
      if (act.dataset.act === 'check') { st.chk = !st.chk; setState(it, st); }
      else { matchPick = null; setState(it, {}); }
      return;
    }
    const o = e.target.closest('[data-o]');
    if (o) {
      const i = +o.dataset.o, multi = it.opts.filter(x => x.ok).length > 1;
      let s = st.s || [];
      if (multi) s = s.includes(i) ? s.filter(x => x !== i) : [...s, i]; else s = s.includes(i) ? [] : [i];
      st.s = s; st.chk = false; setState(it, st); return;
    }
    const l = e.target.closest('[data-l]'), r = e.target.closest('[data-r]');
    if (l) {
      const li = +l.dataset.l; st.m = st.m || {};
      if (st.m[li] != null && !(matchPick && matchPick.l === li)) { delete st.m[li]; matchPick = { id: it.id, l: li }; st.chk = false; setState(it, st); return; }
      matchPick = matchPick && matchPick.id === it.id && matchPick.l === li ? null : { id: it.id, l: li };
      renderState(host, it); return;
    }
    if (r) {
      if (!matchPick || matchPick.id !== it.id) return toast('Сначала выберите слово слева');
      const ri = +r.dataset.r; st.m = st.m || {};
      for (const k in st.m) if (st.m[k] === ri) delete st.m[k];
      st.m[matchPick.l] = ri; matchPick = null; st.chk = false; setState(it, st); return;
    }
    const w = e.target.closest('[data-w]'), a = e.target.closest('[data-a]');
    if (w) { st.a = [...(st.a || []), +w.dataset.w]; st.chk = false; setState(it, st); return; }
    if (a) { st.a = (st.a || []).filter((_, k) => k !== +a.dataset.a); st.chk = false; setState(it, st); }
  });

  function shuffle(n) {
    const p = [...Array(n).keys()];
    for (let tries = 0; tries < 10; tries++) {
      for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
      if (n < 2 || p.some((v, i) => v !== i)) break;
    }
    return p;
  }
  function openExEditor(type, it, at) {
    const v = it || {};
    let fields = '';
    if (type === 'gaps') fields = `<label class="lbl">Текст с пропусками</label><textarea class="field" name="text" rows="6" autofocus placeholder="I [am] a student. She [doesn't/does not] like coffee. They {is|*are|am} happy.">${esc(v.text || '')}</textarea>
      <div class="hint">Пропуск для ввода: <code>[ответ]</code>, несколько верных: <code>[don't/do not]</code>.<br>Выпадающий список: <code>{вариант|*верный|вариант}</code> — верный отмечается звёздочкой.</div>`;
    if (type === 'quiz') fields = `<label class="lbl">Вопрос</label><input class="field" name="q" value="${esc(v.q || '')}" autofocus placeholder="Choose the correct form">
      <label class="lbl">Варианты ответа — каждый с новой строки</label><textarea class="field" name="opts" rows="5" placeholder="*went&#10;goed&#10;gone">${esc((v.opts || []).map(o => (o.ok ? '*' : '') + o.t).join('\n'))}</textarea>
      <div class="hint">Верные варианты отметьте звёздочкой в начале: <code>*went</code>. Если верных несколько — ученик сможет выбрать несколько.</div>`;
    if (type === 'match') fields = `<label class="lbl">Пары — каждая с новой строки</label><textarea class="field" name="pairs" rows="6" autofocus placeholder="cat = кошка&#10;dog = собака&#10;bird = птица">${esc((v.pairs || []).map(p => p[0] + ' = ' + p[1]).join('\n'))}</textarea>
      <div class="hint">Формат: <code>слово = перевод</code>. Правая колонка перемешивается автоматически.</div>`;
    if (type === 'order') fields = `<label class="lbl">Правильное предложение</label><input class="field" name="sent" autofocus value="${esc(v.words ? (v.split ? v.words.join(' / ') : v.words.join(' ')) : '')}" placeholder="I have never been to London">
      <div class="hint">Слова перемешаются автоматически. Чтобы разбить на группы слов, используйте <code>/</code>: <code>I have / never been / to London</code></div>`;
    const m = modal(`<h2>${it ? 'Редактировать' : 'Новое упражнение'}: ${EX_LABEL[type].toLowerCase()}</h2>
      <form><label class="lbl">Заголовок (необязательно)</label><input class="field" name="title" value="${esc(v.title || '')}" placeholder="Например: Exercise 1">${fields}
      <div class="actions"><button type="button" class="btn" data-close>Отмена</button><button class="btn primary">${it ? 'Сохранить' : 'Добавить'}</button></div></form>`, { width: 560 });
    m.el.querySelector('form').onsubmit = e => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const data = { title: f.title.trim() || null };
      if (type === 'gaps') { data.text = f.text; if (!/\[|\{/.test(f.text)) return toast('Добавьте хотя бы один пропуск в [квадратных скобках]'); }
      if (type === 'quiz') {
        data.q = f.q.trim();
        data.opts = f.opts.split('\n').map(s => s.trim()).filter(Boolean).map(s => ({ t: s.replace(/^\*\s*/, ''), ok: s.startsWith('*') }));
        if (data.opts.length < 2) return toast('Нужно минимум 2 варианта');
        if (!data.opts.some(o => o.ok)) return toast('Отметьте верный вариант звёздочкой *');
      }
      if (type === 'match') {
        data.pairs = f.pairs.split('\n').map(s => s.split(/\s*=\s*/)).filter(p => p.length >= 2 && p[0].trim()).map(p => [p[0].trim(), p.slice(1).join('=').trim()]);
        if (data.pairs.length < 2) return toast('Нужно минимум 2 пары');
        data.perm = shuffle(data.pairs.length);
      }
      if (type === 'order') {
        const s = f.sent.trim(); data.split = s.includes('/');
        data.words = (data.split ? s.split('/') : s.split(/\s+/)).map(x => x.trim()).filter(Boolean);
        if (data.words.length < 2) return toast('Нужно минимум 2 слова');
        data.perm = shuffle(data.words.length);
      }
      m.close();
      if (it) { data.state = null; patchItems({ [it.id]: data }); }
      else {
        const p = at || viewCenter();
        addItems([{ id: uid(), type, x: r1(p.x - 230), y: r1(p.y - 80), z: nextZ(), w: type === 'match' ? 520 : 460, ...data }]);
        setTool('select');
      }
    };
  }

  // ============================================================
  //  Вид (панорама и масштаб)
  // ============================================================
  let viewRaf = 0, viewSaveT = 0, leadT = 0;
  const toWorld = (sx, sy) => ({ x: (sx - view.x) / view.z, y: (sy - view.y) / view.z });
  const toScreen = (wx, wy) => ({ x: wx * view.z + view.x, y: wy * view.z + view.y });
  const viewCenter = () => toWorld(innerWidth / 2, innerHeight / 2);
  function applyView() {
    if (viewRaf) return;
    viewRaf = requestAnimationFrame(() => {
      viewRaf = 0;
      world.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.z})`;
      let s = 24 * view.z; while (s < 12) s *= 2;
      vp.style.backgroundSize = `${s}px ${s}px`;
      vp.style.backgroundPosition = `${view.x}px ${view.y}px`;
      const zv = $('#zoombar .zv'); if (zv) zv.textContent = Math.round(view.z * 100) + '%';
      peers.forEach(drawCursor);
      updateSelBox();
      kickOverlay();
    });
    clearTimeout(viewSaveT);
    viewSaveT = setTimeout(() => { try { localStorage.setItem('view:' + boardId, JSON.stringify(view)); } catch { } }, 400);
    if (leading && !leadT) leadT = setTimeout(() => { leadT = 0; sendLeadView(); }, 80);
  }
  function visibleRect() { const a = toWorld(0, 0), b = toWorld(innerWidth, innerHeight); return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y }; }
  function sendLeadView() { send({ t: 'view', on: true, r: visibleRect() }); }
  setInterval(() => { if (leading) sendLeadView(); }, 3000);

  function zoomAt(sx, sy, f) {
    const z = Math.min(8, Math.max(0.05, view.z * f));
    const k = z / view.z;
    view.x = sx - (sx - view.x) * k; view.y = sy - (sy - view.y) * k; view.z = z;
    applyView();
  }
  let anim = 0;
  function animateTo(t, ms = 320) {
    cancelAnimationFrame(anim);
    const s = { ...view }, t0 = performance.now();
    const step = now => {
      const k = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      view.x = s.x + (t.x - s.x) * e; view.y = s.y + (t.y - s.y) * e; view.z = s.z + (t.z - s.z) * e;
      applyView();
      if (k < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }
  function fitRect(r, animate = true, exact = false) {
    if (!r || !r.w || !r.h) return;
    const pad = exact ? 0 : 60;
    const z = Math.min(8, Math.max(0.05, Math.min((innerWidth - pad * 2) / r.w, (innerHeight - pad * 2) / r.h)));
    const t = { z, x: innerWidth / 2 - (r.x + r.w / 2) * z, y: innerHeight / 2 - (r.y + r.h / 2) * z };
    if (animate) animateTo(t); else { view = t; applyView(); }
  }
  function contentBox(ids) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const id of ids || items.keys()) {
      const it = items.get(id); if (!it) continue;
      const b = getBox(it);
      x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y); x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h);
    }
    return x1 === Infinity ? null : { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  function fitAll(animate = true) {
    const b = contentBox();
    if (!b) { view = { x: innerWidth / 2, y: innerHeight / 2, z: 1 }; applyView(); return; }
    fitRect({ x: b.x, y: b.y, w: Math.max(b.w, 400), h: Math.max(b.h, 300) }, animate);
    if (view.z > 1) { /* не увеличиваем больше 100% при вписывании */ }
  }
  function initialView() {
    let v = null;
    try { v = JSON.parse(localStorage.getItem('view:' + boardId)); } catch { }
    if (v && isFinite(v.x) && isFinite(v.z)) { view = v; applyView(); }
    else {
      const b = contentBox();
      if (b) { const z = Math.min(1, (innerWidth - 160) / b.w, (innerHeight - 160) / b.h); view = { z, x: innerWidth / 2 - (b.x + b.w / 2) * z, y: innerHeight / 2 - (b.y + b.h / 2) * z }; }
      applyView();
    }
  }
  function userMovedView() {
    if (leader && following) { following = false; renderFollow(); }
  }
  addEventListener('resize', () => { cv.width = innerWidth * devicePixelRatio; cv.height = innerHeight * devicePixelRatio; applyView(); });
  cv.width = innerWidth * devicePixelRatio; cv.height = innerHeight * devicePixelRatio;

  function getBox(it) {
    if (isLine(it)) return { x: Math.min(it.x, it.x + it.w), y: Math.min(it.y, it.y + it.h), w: Math.abs(it.w), h: Math.abs(it.h) };
    let w = it.w, h = it.h;
    if (w == null || h == null || AUTO_H.has(it.type)) {
      const el = els.get(it.id);
      if (el) { w = el.offsetWidth; h = el.offsetHeight; }
    }
    return { x: it.x, y: it.y, w: w || 0, h: h || 0 };
  }

  // ============================================================
  //  Оверлей: лазер, живая линия, чужие штрихи
  // ============================================================
  const trails = new Map(); // key -> {pts:[{x,y,t}], color}
  const inks = new Map();   // peerId -> {pts:[], c, s, o, t}
  let live = null;          // текущий штрих {pts, c, s, o}
  let ovRaf = 0;
  function kickOverlay() { if (!ovRaf) ovRaf = requestAnimationFrame(drawOverlay); }
  function addTrail(key, pts, color, remote) {
    let tr = trails.get(key);
    if (!tr) trails.set(key, tr = { pts: [], color });
    const t = performance.now();
    for (let i = 0; i < pts.length; i += 2) tr.pts.push({ x: pts[i], y: pts[i + 1], t: remote ? t : t, brk: pts[i] === null });
    kickOverlay();
  }
  function addInk(m) {
    let ik = inks.get(m.id);
    if (!ik || ik.sid !== m.sid) inks.set(m.id, ik = { pts: [], c: m.c, s: m.s, o: m.o, sid: m.sid });
    ik.pts.push(...m.pts); ik.t = performance.now();
    kickOverlay();
  }
  function clearInk(id) { if (inks.delete(id)) kickOverlay(); }
  function strokePts(pts, c, s, o) {
    if (pts.length < 2) return;
    cx.globalAlpha = o || 1; cx.strokeStyle = c; cx.lineWidth = s * view.z;
    cx.lineCap = 'round'; cx.lineJoin = 'round';
    cx.beginPath();
    let p = toScreen(pts[0], pts[1]); cx.moveTo(p.x, p.y);
    if (pts.length === 2) cx.lineTo(p.x + .01, p.y);
    for (let i = 2; i < pts.length; i += 2) { p = toScreen(pts[i], pts[i + 1]); cx.lineTo(p.x, p.y); }
    cx.stroke(); cx.globalAlpha = 1;
  }
  function drawOverlay() {
    ovRaf = 0;
    const dpr = devicePixelRatio;
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx.clearRect(0, 0, innerWidth, innerHeight);
    const now = performance.now();
    let more = false;
    if (live) strokePts(live.pts, live.c, live.s, live.o);
    for (const [id, ik] of inks) {
      if (now - ik.t > 3000) { inks.delete(id); continue; }
      strokePts(ik.pts, ik.c, ik.s, ik.o);
    }
    for (const [k, tr] of trails) {
      tr.pts = tr.pts.filter(p => now - p.t < 900);
      if (tr.pts.length < 1) { trails.delete(k); continue; }
      more = true;
      cx.lineCap = 'round'; cx.lineJoin = 'round';
      for (let i = 1; i < tr.pts.length; i++) {
        const a = tr.pts[i - 1], b = tr.pts[i];
        if (b.brk || a.brk) continue;
        const age = (now - b.t) / 900;
        const pa = toScreen(a.x, a.y), pb = toScreen(b.x, b.y);
        cx.globalAlpha = Math.max(0, 1 - age);
        cx.strokeStyle = tr.color; cx.lineWidth = 6; cx.shadowColor = tr.color; cx.shadowBlur = 10;
        cx.beginPath(); cx.moveTo(pa.x, pa.y); cx.lineTo(pb.x, pb.y); cx.stroke();
      }
      const last = tr.pts[tr.pts.length - 1], pl = toScreen(last.x, last.y);
      cx.globalAlpha = 1; cx.shadowBlur = 12; cx.fillStyle = tr.color;
      cx.beginPath(); cx.arc(pl.x, pl.y, 4, 0, 7); cx.fill();
      cx.shadowBlur = 0;
    }
    cx.globalAlpha = 1;
    if (more || inks.size) kickOverlay();
  }

  // ============================================================
  //  Курсоры других участников
  // ============================================================
  function drawCursor(p) {
    if (p.x == null) return;
    if (!p.el) {
      p.el = document.createElement('div'); p.el.className = 'cur';
      p.el.innerHTML = `<svg viewBox="0 0 24 24"><path d="M4 3l7 18 2.6-7.4L21 11z" fill="${esc(p.color)}" stroke="#fff" stroke-width="1.5"/></svg><span style="background:${esc(p.color)}">${esc(p.name)}</span>`;
      $('#cursors').appendChild(p.el);
    }
    const s = toScreen(p.x, p.y);
    p.el.style.transform = `translate(${s.x}px,${s.y}px)`;
  }
  let curT = 0;
  function sendCursor(wp) {
    if (!peers.size || curT) return;
    curT = setTimeout(() => { curT = 0; send({ t: 'cursor', x: r1(lastPointerWorld.x), y: r1(lastPointerWorld.y) }); }, 45);
  }

  // ============================================================
  //  Выделение
  // ============================================================
  let uiRaf = 0, ctxKey = '';
  function scheduleUi() { if (!uiRaf) uiRaf = requestAnimationFrame(() => { uiRaf = 0; updateSelBox(); updateHistBtns(); renderFramesPanel(); }); }
  function setSel(ids) {
    sel = new Set(ids.filter(id => items.has(id)));
    ctxKey = '';
    scheduleUi();
  }
  function selectable(it) { return it && canEdit() && (isOwner() || !it.locked); }
  function updateSelBox() {
    for (const id of [...sel]) if (!items.has(id)) sel.delete(id);
    if (!sel.size || (action && (action.type === 'move' || action.type === 'draw'))) {
      selbox.hidden = true; ctxbar.hidden = true;
      if (!sel.size) closePop();
      return;
    }
    const b = contentBox(sel);
    if (!b) return;
    const a = toScreen(b.x, b.y);
    selbox.hidden = false;
    Object.assign(selbox.style, { left: a.x - 4 + 'px', top: a.y - 4 + 'px', width: b.w * view.z + 8 + 'px', height: b.h * view.z + 8 + 'px' });
    const one = sel.size === 1 ? items.get([...sel][0]) : null;
    let hs = '';
    if (one && canTouch(one) && !editing) {
      if (WIDTH_ONLY.has(one.type)) hs = 'e w';
      else hs = 'nw ne sw se';
    }
    if (selbox._hs !== hs) { selbox._hs = hs; selbox.innerHTML = hs ? hs.split(' ').map(h => `<div class="hd ${h}" data-h="${h}"></div>`).join('') : ''; }
    renderCtx(a.x, a.y, b.w * view.z);
  }

  // ============================================================
  //  Контекстная панель
  // ============================================================
  const PROP = {
    color: { stroke: 'c', shape: 'stroke', text: 'c', sticky: 'c', frame: 'bg' },
    size: { stroke: 's', shape: 'sw', text: 'fs', sticky: 'fs' }
  };
  const SIZES = { stroke: [2, 4, 8, 14, 24], shape: [1, 2, 3, 5, 8], text: [14, 18, 24, 32, 48, 72, 96], sticky: [14, 18, 24, 32, 44] };
  function renderCtx(sx, sy, sw) {
    const list = [...sel].map(id => items.get(id)).filter(Boolean);
    if (!list.length || !canEdit()) { ctxbar.hidden = true; return; }
    const types = new Set(list.map(i => i.type));
    const touchable = list.every(canTouch);
    const key = [...sel].join(',') + '|' + list.map(i => i.locked ? 1 : 0).join('') + touchable;
    if (key !== ctxKey) {
      ctxKey = key;
      let h = '';
      if (touchable) {
        const t1 = [...types][0];
        if ([...types].some(t => PROP.color[t])) {
          const cur = list[0][PROP.color[t1]] || (t1 === 'sticky' ? '#fff3a8' : t1 === 'frame' ? '#fff' : '#1f2328');
          h += `<button class="ibtn" data-a="color" title="Цвет"><span class="sw" style="background:${esc(cur)};width:20px;height:20px"></span></button>`;
        }
        if (types.has('shape') && list.some(i => !isLine(i))) h += `<button class="ibtn" data-a="fill" title="Заливка">${icon('palette')}</button>`;
        if (types.size === 1 && PROP.size[t1]) h += `<button class="ibtn txtb" data-a="size" title="Размер">${t1 === 'text' || t1 === 'sticky' ? 'Aa' : '≡'}</button>`;
        if (types.size === 1 && (t1 === 'text' || t1 === 'sticky')) {
          h += `<button class="ibtn txtb ${list[0].b ? 'on' : ''}" data-a="bold" title="Жирный">B</button>`;
          h += `<button class="ibtn" data-a="align" title="Выравнивание">${icon('align')}</button>`;
        }
        if (list.length === 1 && EX.has(t1)) h += `<button class="btn small" data-a="edit">${icon('edit')}Изменить</button>`;
        if (list.length === 1 && (t1 === 'text' || t1 === 'sticky' || (t1 === 'shape' && !isLine(list[0])))) h += `<button class="ibtn" data-a="textedit" title="Редактировать текст">${icon('text')}</button>`;
        if (list.length === 1 && t1 === 'frame') h += `<button class="ibtn" data-a="rename" title="Переименовать">${icon('edit')}</button>`;
        if (list.length === 1 && (t1 === 'audio' || t1 === 'file' || t1 === 'link')) h += `<button class="ibtn" data-a="rename" title="Переименовать">${icon('edit')}</button>`;
        if (h) h += '<span class="sep"></span>';
        h += `<button class="ibtn" data-a="front" title="На передний план">${icon('front')}</button><button class="ibtn" data-a="back" title="На задний план">${icon('back')}</button>`;
        h += `<button class="ibtn" data-a="dup" title="Дублировать (Ctrl+D)">${icon('copy')}</button>`;
      }
      if (isOwner()) {
        const locked = list.every(i => i.locked);
        h += `<button class="ibtn ${locked ? 'on' : ''}" data-a="lock" title="${locked ? 'Разблокировать' : 'Заблокировать для учеников'}">${icon(locked ? 'lock' : 'unlock')}</button>`;
      }
      if (touchable) h += `<button class="ibtn" data-a="del" title="Удалить (Del)">${icon('trash')}</button>`;
      ctxbar.innerHTML = h;
      ctxbar.hidden = !h;
    }
    if (ctxbar.hidden) return;
    const w = ctxbar.offsetWidth, hgt = ctxbar.offsetHeight;
    let top = sy - hgt - 16;
    if (top < 60) top = sy + parseFloat(selbox.style.height) + 8;
    ctxbar.style.left = Math.max(8, Math.min(innerWidth - w - 8, sx + sw / 2 - w / 2)) + 'px';
    ctxbar.style.top = Math.min(innerHeight - hgt - 8, top) + 'px';
  }
  let popEl = null;
  function closePop() { if (popEl) { popEl.remove(); popEl = null; } }
  function pop(anchor, html, onPick) {
    closePop();
    popEl = document.createElement('div'); popEl.className = 'panel pop'; popEl.innerHTML = html;
    document.body.appendChild(popEl);
    const r = anchor.getBoundingClientRect();
    popEl.style.left = Math.max(8, Math.min(innerWidth - popEl.offsetWidth - 8, r.left)) + 'px';
    popEl.style.top = (r.bottom + 6 + popEl.offsetHeight > innerHeight ? r.top - popEl.offsetHeight - 6 : r.bottom + 6) + 'px';
    popEl.onclick = e => { const b = e.target.closest('[data-v]'); if (b) { onPick(b.dataset.v); closePop(); } };
  }
  ctxbar.addEventListener('pointerdown', e => e.stopPropagation());
  ctxbar.addEventListener('click', e => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    const list = [...sel].map(id => items.get(id)).filter(Boolean);
    const a = b.dataset.a;
    const patchAll = fn => { const m = {}; list.forEach(it => { const p = fn(it); if (p) m[it.id] = p; }); patchItems(m); ctxKey = ''; scheduleUi(); };
    if (a === 'color') {
      const t = list[0].type;
      const pal = t === 'sticky' ? STICKY : t === 'frame' ? FRAME_BG : list.every(i => i.type === 'stroke' && i.o) ? HL_COLORS : COLORS;
      pop(b, pal.map(c => `<button class="sw" data-v="${c}" style="background:${c}"></button>`).join(''), v => patchAll(it => PROP.color[it.type] ? { [PROP.color[it.type]]: v } : null));
    } else if (a === 'fill') {
      const opts2 = ['none', '#ffffff', ...COLORS.slice(1, 8).map(c => c + '33'), ...STICKY.slice(0, 5)];
      pop(b, opts2.map(c => `<button class="sw ${c === 'none' ? 'none' : ''}" data-v="${c}" style="background:${c === 'none' ? '' : c}"></button>`).join(''), v => patchAll(it => it.type === 'shape' ? { fill: v } : null));
    } else if (a === 'size') {
      const t = list[0].type;
      pop(b, SIZES[t].map(s => `<button class="btn small" data-v="${s}">${s}</button>`).join(''), v => patchAll(it => ({ [PROP.size[it.type]]: +v })));
    } else if (a === 'bold') patchAll(it => ({ b: !list[0].b || null }));
    else if (a === 'align') {
      const nx = { left: 'center', center: 'right', right: 'left' }[list[0].al || 'left'];
      patchAll(() => ({ al: nx }));
    } else if (a === 'edit') openExEditor(list[0].type, list[0]);
    else if (a === 'textedit') startEdit(list[0].id);
    else if (a === 'rename') renameItem(list[0]);
    else if (a === 'front') { const m = {}; list.sort((x, y) => (x.z || 0) - (y.z || 0)).forEach(it => m[it.id] = { z: nextZ() }); patchItems(m); }
    else if (a === 'back') { const m = {}; list.sort((x, y) => (y.z || 0) - (x.z || 0)).forEach(it => m[it.id] = { z: --minZ }); patchItems(m); }
    else if (a === 'dup') duplicate();
    else if (a === 'lock') { const lock = !list.every(i => i.locked); patchAll(() => ({ locked: lock || null })); }
    else if (a === 'del') delItems(sel);
  });
  async function renameItem(it) {
    const key = it.type === 'frame' ? 'title' : it.type === 'link' ? 'title' : 'name';
    const v = await prompt2('Название', it[key] || '');
    if (v !== null) patchItems({ [it.id]: { [key]: v.trim() || null } });
  }
  function duplicate(list) {
    list = list || [...sel].map(id => items.get(id)).filter(canTouch);
    if (!list.length) return;
    const copies = list.sort((a, b) => (a.z || 0) - (b.z || 0)).map(it => { const c = clone(it); c.id = uid(); c.x += 24; c.y += 24; c.z = nextZ(); delete c.state; delete c.locked; return c; });
    addItems(copies);
  }

  // ============================================================
  //  Редактирование текста
  // ============================================================
  function startEdit(id, isNew) {
    const it = items.get(id), el = els.get(id);
    if (!it || !el || !canTouch(it)) return;
    finishEdit();
    const t = el.querySelector(':scope>.txt'); if (!t) return;
    editing = { id, orig: it.text || '', isNew, t };
    t.contentEditable = PT_SUPPORTED ? 'plaintext-only' : 'true';
    t.classList.add('editing');
    t.focus();
    const rg = document.createRange(); rg.selectNodeContents(t);
    const s = getSelection(); s.removeAllRanges(); s.addRange(rg);
    if (isNew) s.collapseToEnd();
    t.oninput = () => { it.text = t.innerText.replace(/\n$/, ''); livePatch(id, { text: it.text }); scheduleUi(); };
    t.onblur = () => setTimeout(() => { if (editing && editing.id === id && document.activeElement !== t) finishEdit(); }, 0);
    t.onkeydown = e => { if (e.key === 'Escape') { e.preventDefault(); t.blur(); } e.stopPropagation(); };
    t.onpaste = e => { e.preventDefault(); e.stopPropagation(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); };
    setSel([id]);
  }
  function finishEdit() {
    if (!editing) return;
    const { id, orig, isNew, t } = editing;
    editing = null;
    t.contentEditable = 'false'; t.classList.remove('editing');
    t.oninput = t.onblur = t.onkeydown = t.onpaste = null;
    const it = items.get(id);
    getSelection().removeAllRanges();
    if (!it) return;
    flushLive();
    const text = t.innerText.replace(/\n$/, '');
    it.text = text;
    if (!text.trim() && it.type === 'text') {
      commit([{ o: 'del', id }], [], false);
      if (!isNew) pushHist([{ o: 'del', id }], [{ o: 'put', item: { ...clone(it), text: orig } }]);
      setSel([]);
      return;
    }
    send({ t: 'op', ops: [{ o: 'patch', id, p: { text } }] });
    if (isNew) pushHist([{ o: 'put', item: clone(it) }], [{ o: 'del', id }]);
    else if (text !== orig) pushHist([{ o: 'patch', id, p: { text } }], [{ o: 'patch', id, p: { text: orig } }]);
    renderItem(it);
    scheduleUi();
  }

  // ============================================================
  //  Попадание по тонким объектам (линии и штрихи)
  // ============================================================
  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
    let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0; t = Math.max(0, Math.min(1, t));
    const x = ax + t * dx - px, y = ay + t * dy - py; return Math.sqrt(x * x + y * y);
  }
  function hitThin(p, tol, filter) {
    let best = null;
    for (const it of items.values()) {
      if (it.type !== 'stroke' && !isLine(it)) continue;
      if (filter && !filter(it)) continue;
      const b = getBox(it);
      const pad = tol + (it.s || it.sw || 2);
      if (p.x < b.x - pad || p.x > b.x + b.w + pad || p.y < b.y - pad || p.y > b.y + b.h + pad) continue;
      let hit = false;
      if (it.type === 'stroke') {
        const kx = it.w / it.vw, ky = it.h / it.vh, pts = it.pts, t2 = tol + it.s * Math.max(kx, ky) / 2;
        if (pts.length === 2) hit = Math.hypot(it.x + pts[0] * kx - p.x, it.y + pts[1] * ky - p.y) < t2;
        for (let i = 2; i < pts.length && !hit; i += 2)
          if (segDist(p.x, p.y, it.x + pts[i - 2] * kx, it.y + pts[i - 1] * ky, it.x + pts[i] * kx, it.y + pts[i + 1] * ky) < t2) hit = true;
      } else hit = segDist(p.x, p.y, it.x, it.y, it.x + it.w, it.y + it.h) < tol + (it.sw || 2) / 2;
      if (hit && (!best || (it.z || 0) > (best.z || 0))) best = it;
    }
    return best;
  }

  // ============================================================
  //  Ввод: мышь, перо, тач
  // ============================================================
  let action = null, spaceDown = false;
  const pointers = new Map();
  let pinch = null;

  function startPan(e) {
    action = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    vp.classList.add('grabbing', 'panning');
    userMovedView();
  }
  vp.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (!canEdit()) return;
    const el = e.target.closest('.it');
    const wp = toWorld(e.clientX, e.clientY);
    let it = el ? items.get(el.dataset.id) : hitThin(wp, 6 / view.z);
    if (it && selectable(it) && !sel.has(it.id)) setSel([it.id]);
    const list = [...sel].map(id => items.get(id)).filter(Boolean);
    const m = [];
    if (list.length) {
      m.push({ label: 'Дублировать', icon: 'copy', onClick: () => duplicate() });
      m.push({ label: 'На передний план', icon: 'front', onClick: () => { const p = {}; list.forEach(i => p[i.id] = { z: nextZ() }); patchItems(p); } });
      m.push({ label: 'На задний план', icon: 'back', onClick: () => { const p = {}; list.forEach(i => p[i.id] = { z: --minZ }); patchItems(p); } });
      if (isOwner()) m.push({ label: list.every(i => i.locked) ? 'Разблокировать' : 'Заблокировать для учеников', icon: 'lock', onClick: () => { const lock = !list.every(i => i.locked); const p = {}; list.forEach(i => p[i.id] = { locked: lock || null }); patchItems(p); } });
      m.push('-', { label: 'Удалить', icon: 'trash', danger: true, onClick: () => delItems(sel) });
    } else {
      m.push({ label: 'Вставить текст', icon: 'text', onClick: () => createText(wp) });
      m.push({ label: 'Стикер', icon: 'sticky', onClick: () => createSticky(wp) });
      m.push({ label: 'Загрузить файл', icon: 'upload', onClick: () => pickFiles(wp) });
      m.push({ label: 'Вставить ссылку', icon: 'link', onClick: () => askUrl(wp) });
      m.push('-', { label: 'Показать всё', icon: 'fit', onClick: () => fitAll() });
    }
    menu(e.clientX, e.clientY, m);
  });

  vp.addEventListener('pointerdown', e => {
    if (editing && e.target.closest('.editing')) return;
    if (editing) finishEdit();
    closePop();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      cancelAction();
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, view: { ...view } };
      userMovedView();
      return;
    }
    if (pointers.size > 2 || e.button === 2) return;
    const wp = toWorld(e.clientX, e.clientY);
    const interactive = e.target.closest('input,select,textarea,button,a,audio,video,iframe,.bar');
    if (e.button === 1 || (e.button === 0 && (spaceDown || tool === 'hand') && !(interactive && !e.target.closest('.bar')))) {
      e.preventDefault(); return startPan(e);
    }
    if (tool === 'select' || tool === 'hand') {
      const host = e.target.closest('.it');
      if (interactive && host && !e.target.closest('.bar')) return; // кнопки/поля в упражнениях работают сами
      if (!canEdit()) { if (!interactive) startPan(e); return; }
      let it = host ? items.get(host.dataset.id) : null;
      const thin = hitThin(wp, 6 / view.z, selectable);
      if (thin && (!it || (thin.z || 0) > (it.z || 0))) it = thin;
      if (it && !selectable(it)) it = null;
      if (it) {
        if (e.shiftKey) { const s = new Set(sel); s.has(it.id) ? s.delete(it.id) : s.add(it.id); setSel([...s]); }
        else if (!sel.has(it.id)) setSel([it.id]);
        if ([...sel].every(id => canTouch(items.get(id)))) startMove(e, wp);
        return;
      }
      if (!e.shiftKey) setSel([]);
      if (e.pointerType === 'touch') return startPan(e);
      action = { type: 'marquee', sx: e.clientX, sy: e.clientY, base: e.shiftKey ? [...sel] : [] };
      vp.setPointerCapture(e.pointerId);
      return;
    }
    if (!canEdit() && tool !== 'laser') return;
    vp.setPointerCapture(e.pointerId);
    if (tool === 'pen' || tool === 'hl') {
      const o = opts[tool];
      live = { pts: [r1(wp.x), r1(wp.y)], c: o.c, s: o.s, o: tool === 'hl' ? 0.4 : 0, sid: uid(), sent: 0 };
      action = { type: 'draw' };
      setSel([]);
      kickOverlay();
    } else if (tool === 'eraser') {
      action = { type: 'erase', hit: new Map() };
      eraseAt(wp);
    } else if (tool === 'laser') {
      action = { type: 'laser', buf: [] };
      addTrail('me', [wp.x, wp.y], '#e5484d');
      action.buf.push(r1(wp.x), r1(wp.y));
    } else if (tool === 'text') {
      const host = e.target.closest('.it-text,.it-sticky');
      if (host && canTouch(items.get(host.dataset.id))) { e.preventDefault(); startEdit(host.dataset.id); return; }
      e.preventDefault();
      createText(wp);
    } else if (tool === 'sticky') {
      e.preventDefault();
      createSticky(wp);
    } else if (tool === 'shape' || tool === 'frame') {
      const id = uid();
      const it = tool === 'frame'
        ? { id, type: 'frame', x: r1(wp.x), y: r1(wp.y), w: 1, h: 1, z: nextZ(), title: 'Слайд ' + ([...items.values()].filter(i => i.type === 'frame').length + 1) }
        : { id, type: 'shape', shape: opts.shape.k, x: r1(wp.x), y: r1(wp.y), w: 1, h: 1, z: nextZ(), stroke: opts.shape.c, fill: opts.shape.fill, sw: opts.shape.sw };
      action = { type: 'create', id, sx: wp.x, sy: wp.y, started: false, item: it };
    }
  });

  function cancelAction() {
    if (!action) return;
    if (action.type === 'draw') { live = null; kickOverlay(); }
    if (action.type === 'move') {
      for (const [id, o] of action.orig) { const it = items.get(id); if (it) { it.x = o.x; it.y = o.y; renderItem(it); livePatch(id, { x: o.x, y: o.y }); } }
    }
    if (action.type === 'erase') for (const id of action.hit.keys()) { const el = els.get(id); if (el) el.style.opacity = ''; }
    marqueeEl.hidden = true;
    vp.classList.remove('grabbing', 'panning');
    action = null;
  }

  function startMove(e, wp) {
    const ids = new Set(sel);
    // рамка тянет за собой объекты внутри
    for (const id of sel) {
      const f = items.get(id);
      if (f.type !== 'frame') continue;
      for (const it of items.values()) {
        if (ids.has(it.id) || !canTouch(it) || it.type === 'frame') continue;
        const b = getBox(it);
        if (b.x >= f.x && b.y >= f.y && b.x + b.w <= f.x + f.w && b.y + b.h <= f.y + f.h) ids.add(it.id);
      }
    }
    const orig = new Map(); ids.forEach(id => { const it = items.get(id); orig.set(id, { x: it.x, y: it.y }); });
    action = { type: 'move', sx: wp.x, sy: wp.y, orig, moved: false, pid: e.pointerId };
    vp.setPointerCapture(e.pointerId);
  }

  function eraseAt(wp) {
    const it = hitThin(wp, 8 / view.z, x => canTouch(x) && !action.hit.has(x.id));
    if (it) { action.hit.set(it.id, true); const el = els.get(it.id); if (el) el.style.opacity = '0.15'; }
  }

  addEventListener('pointermove', e => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const wp = toWorld(e.clientX, e.clientY);
    lastPointerWorld = wp;
    if (e.target === vp || vp.contains(e.target)) sendCursor(wp);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const z = Math.min(8, Math.max(0.05, pinch.view.z * d / pinch.d));
      const wx = (pinch.mx - pinch.view.x) / pinch.view.z, wy = (pinch.my - pinch.view.y) / pinch.view.z;
      view = { z, x: mx - wx * z, y: my - wy * z };
      applyView(); return;
    }
    if (!action) return;
    switch (action.type) {
      case 'pan':
        view.x = action.vx + e.clientX - action.sx; view.y = action.vy + e.clientY - action.sy; applyView(); break;
      case 'move': {
        const dx = wp.x - action.sx, dy = wp.y - action.sy;
        if (!action.moved && Math.hypot(dx, dy) * view.z < 3) return;
        if (!action.moved) { action.moved = true; selbox.hidden = true; ctxbar.hidden = true; closePop(); }
        for (const [id, o] of action.orig) {
          const it = items.get(id); if (!it) continue;
          it.x = r1(o.x + dx); it.y = r1(o.y + dy);
          const el = els.get(id);
          if (isLine(it)) setPos(el, { ...it, x: Math.min(it.x, it.x + it.w), y: Math.min(it.y, it.y + it.h) }); else setPos(el, it);
          livePatch(id, { x: it.x, y: it.y });
        }
        break;
      }
      case 'marquee': {
        const x = Math.min(action.sx, e.clientX), y = Math.min(action.sy, e.clientY), w = Math.abs(e.clientX - action.sx), h = Math.abs(e.clientY - action.sy);
        Object.assign(marqueeEl.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
        marqueeEl.hidden = w + h < 4;
        action.rect = { x, y, w, h };
        break;
      }
      case 'draw': {
        const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        for (const ev of evs) {
          const p = toWorld(ev.clientX, ev.clientY), pts = live.pts;
          const lx = pts[pts.length - 2], ly = pts[pts.length - 1];
          if (Math.hypot(p.x - lx, p.y - ly) * view.z < 1.5) continue;
          pts.push(r1(p.x), r1(p.y));
        }
        if (peers.size && !action.inkT) action.inkT = setTimeout(() => {
          if (!action || action.type !== 'draw' || !live) return;
          action.inkT = 0;
          send({ t: 'ink', sid: live.sid, c: live.c, s: live.s, o: live.o, pts: live.pts.slice(live.sent) });
          live.sent = live.pts.length;
        }, 60);
        kickOverlay();
        break;
      }
      case 'erase': eraseAt(wp); break;
      case 'laser':
        addTrail('me', [wp.x, wp.y], '#e5484d');
        action.buf.push(r1(wp.x), r1(wp.y));
        if (!action.t) action.t = setTimeout(() => { if (!action || action.type !== 'laser') return; action.t = 0; send({ t: 'laser', pts: action.buf }); action.buf = []; }, 50);
        break;
      case 'create': {
        const it = action.item;
        let x = action.sx, y = action.sy, w = wp.x - x, h = wp.y - y;
        if (!action.started) {
          if (Math.hypot(w, h) * view.z < 4) return;
          action.started = true; it.w = w; it.h = h;
          commit([{ o: 'put', item: it }], [], false);
        }
        if (isLine(it)) {
          if (e.shiftKey) { const a = Math.round(Math.atan2(h, w) / (Math.PI / 4)) * Math.PI / 4, L = Math.hypot(w, h); w = L * Math.cos(a); h = L * Math.sin(a); }
          Object.assign(it, { w: r1(w), h: r1(h) });
        } else {
          if (e.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w) * m; h = Math.sign(h) * m; }
          Object.assign(it, { x: r1(Math.min(x, x + w)), y: r1(Math.min(y, y + h)), w: r1(Math.abs(w)), h: r1(Math.abs(h)) });
        }
        const cur = items.get(it.id); Object.assign(cur, it); renderItem(cur);
        livePatch(it.id, { x: it.x, y: it.y, w: it.w, h: it.h });
        break;
      }
      case 'resize': doResize(e, wp); break;
    }
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pinch) { if (pointers.size < 2) pinch = null; return; }
    if (!action) return;
    const a = action; action = null;
    vp.classList.remove('grabbing', 'panning');
    switch (a.type) {
      case 'move': {
        if (!a.moved) { scheduleUi(); break; }
        flushLive();
        const ops = [], inv = [];
        for (const [id, o] of a.orig) { const it = items.get(id); if (!it) continue; ops.push({ o: 'patch', id, p: { x: it.x, y: it.y } }); inv.push({ o: 'patch', id, p: { x: o.x, y: o.y } }); }
        pushHist(ops, inv); scheduleUi();
        break;
      }
      case 'marquee': {
        marqueeEl.hidden = true;
        if (!a.rect) break;
        const p1 = toWorld(a.rect.x, a.rect.y), p2 = toWorld(a.rect.x + a.rect.w, a.rect.y + a.rect.h);
        const ids = new Set(a.base);
        for (const it of items.values()) {
          if (!selectable(it)) continue;
          const b = getBox(it);
          const inside = b.x >= p1.x && b.y >= p1.y && b.x + b.w <= p2.x && b.y + b.h <= p2.y;
          const inter = b.x < p2.x && b.x + b.w > p1.x && b.y < p2.y && b.y + b.h > p1.y;
          if (it.type === 'frame' ? inside : inter) ids.add(it.id);
        }
        setSel([...ids]);
        break;
      }
      case 'draw': finishStroke(); clearTimeout(a.inkT); break;
      case 'erase':
        if (a.hit.size) delItems([...a.hit.keys()]);
        break;
      case 'laser': if (a.buf.length) send({ t: 'laser', pts: a.buf }); break;
      case 'create': {
        const it = items.get(a.id);
        if (!a.started) {
          const d = a.item;
          if (d.type === 'frame') Object.assign(d, { x: r1(a.sx - 400), y: r1(a.sy - 225), w: 800, h: 450 });
          else if (isLine(d)) Object.assign(d, { w: 160, h: 0 });
          else Object.assign(d, { x: r1(a.sx - 80), y: r1(a.sy - 55), w: 160, h: 110 });
          addItems([d]);
        } else {
          flushLive();
          if (!isLine(it) && (it.w < 4 || it.h < 4)) { it.w = Math.max(it.w, 20); it.h = Math.max(it.h, 20); }
          send({ t: 'op', ops: [{ o: 'patch', id: it.id, p: { x: it.x, y: it.y, w: it.w, h: it.h } }] });
          renderItem(it);
          pushHist([{ o: 'put', item: clone(it) }], [{ o: 'del', id: it.id }]);
          setSel([it.id]);
        }
        setTool('select');
        break;
      }
      case 'resize': {
        flushLive();
        const it = items.get(a.id); if (!it) break;
        const p = {}; for (const k in a.orig) p[k] = it[k] === undefined ? null : it[k];
        pushHist([{ o: 'patch', id: a.id, p }], [{ o: 'patch', id: a.id, p: a.orig }]);
        scheduleUi();
        break;
      }
    }
  }
  addEventListener('pointerup', endPointer);
  addEventListener('pointercancel', e => { if (action && action.type === 'draw') { live = null; kickOverlay(); action = null; } endPointer(e); });

  // упрощение линии (Рамер — Дуглас — Пекер)
  function simplify(pts, eps) {
    const n = pts.length / 2; if (n < 3) return pts;
    const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length) {
      const [s, e] = stack.pop(); let md = 0, mi = -1;
      for (let i = s + 1; i < e; i++) { const d = segDist(pts[i * 2], pts[i * 2 + 1], pts[s * 2], pts[s * 2 + 1], pts[e * 2], pts[e * 2 + 1]); if (d > md) { md = d; mi = i; } }
      if (md > eps) { keep[mi] = 1; stack.push([s, mi], [mi, e]); }
    }
    const out = []; for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
    return out;
  }
  function finishStroke() {
    if (!live) return;
    const raw = simplify(live.pts, 0.6 / view.z);
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (let i = 0; i < raw.length; i += 2) { x1 = Math.min(x1, raw[i]); x2 = Math.max(x2, raw[i]); y1 = Math.min(y1, raw[i + 1]); y2 = Math.max(y2, raw[i + 1]); }
    const pad = live.s / 2 + 1;
    x1 -= pad; y1 -= pad; x2 += pad; y2 += pad;
    const pts = raw.map((v, i) => r1(v - (i % 2 ? y1 : x1)));
    const w = r1(x2 - x1), h = r1(y2 - y1);
    const it = { id: uid(), type: 'stroke', x: r1(x1), y: r1(y1), w, h, vw: w, vh: h, pts, c: live.c, s: live.s, z: nextZ() };
    if (live.o) it.o = live.o;
    live = null;
    commit([{ o: 'put', item: it }], [{ o: 'del', id: it.id }]);
    kickOverlay();
  }

  // ресайз
  selbox.addEventListener('pointerdown', e => {
    const hd = e.target.closest('[data-h]'); if (!hd) return;
    e.stopPropagation(); e.preventDefault();
    const it = items.get([...sel][0]); if (!it || !canTouch(it)) return;
    const b = getBox(it);
    const orig = {}; ['x', 'y', 'w', 'h'].forEach(k => orig[k] = it[k] === undefined ? null : it[k]);
    action = { type: 'resize', id: it.id, h: hd.dataset.h, b, sx: toWorld(e.clientX, e.clientY).x, sy: toWorld(e.clientX, e.clientY).y, orig, ratio: b.h / (b.w || 1) };
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    selbox.setPointerCapture(e.pointerId);
  });
  function doResize(e, wp) {
    const a = action, it = items.get(a.id); if (!it) return;
    const dx = wp.x - a.sx, dy = wp.y - a.sy, b = a.b, hh = a.h;
    let x = b.x, y = b.y, w = b.w, h = b.h;
    if (hh.includes('e')) w = b.w + dx;
    if (hh.includes('w')) { w = b.w - dx; x = b.x + dx; }
    if (hh.includes('s')) h = b.h + dy;
    if (hh.includes('n')) { h = b.h - dy; y = b.y + dy; }
    const min = 16;
    if (w < min) { if (hh.includes('w')) x -= min - w; w = min; }
    if (h < min && !isLine(it)) { if (hh.includes('n')) y -= min - h; h = min; }
    if (hh.length === 2 && (ASPECT.has(it.type) || it.type === 'stroke') !== e.shiftKey) {
      const nh = w * a.ratio; if (hh.includes('n')) y = b.y + b.h - nh; h = nh;
    }
    const p = {};
    if (WIDTH_ONLY.has(it.type)) { p.x = r1(x); p.w = r1(w); }
    else if (isLine(it)) {
      if (a.orig.w < 0) { p.x = r1(x + w); p.w = -r1(w); } else { p.x = r1(x); p.w = r1(w); }
      if (a.orig.h < 0) { p.y = r1(y + h); p.h = -r1(h); } else { p.y = r1(y); p.h = r1(h); }
      if (b.h === 0) { p.y = it.y; p.h = it.h; }
    } else { p.x = r1(x); p.y = r1(y); p.w = r1(w); p.h = r1(h); }
    Object.assign(it, p); renderItem(it); livePatch(it.id, p); scheduleUi();
  }

  vp.addEventListener('wheel', e => {
    e.preventDefault();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
    if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * k * 0.01));
    else { view.x -= e.deltaX * k; view.y -= e.deltaY * k; if (e.shiftKey && !e.deltaX) { view.y += e.deltaY * k; view.x -= e.deltaY * k; } applyView(); }
    userMovedView();
  }, { passive: false });
  // жесты Safari
  vp.addEventListener('gesturestart', e => e.preventDefault());

  vp.addEventListener('dblclick', e => {
    if (!canEdit()) return;
    const host = e.target.closest('.it');
    const wp = toWorld(e.clientX, e.clientY);
    if (!host) { if (tool === 'select' && !hitThin(wp, 6 / view.z)) createText(wp); return; }
    const it = items.get(host.dataset.id);
    if (!it || !canTouch(it)) return;
    if (e.target.closest('input,select,button,a,audio,video')) return;
    if (it.type === 'text' || it.type === 'sticky' || (it.type === 'shape' && !isLine(it))) startEdit(it.id);
    else if (EX.has(it.type)) openExEditor(it.type, it);
    else if (it.type === 'frame') renameItem(it);
  });

  function createText(wp) {
    const it = { id: uid(), type: 'text', x: r1(wp.x), y: r1(wp.y - opts.text.fs * 0.7), z: nextZ(), text: '', fs: opts.text.fs, c: opts.text.c };
    commit([{ o: 'put', item: it }], [], false);
    setTool('select');
    startEdit(it.id, true);
  }
  function createSticky(wp) {
    const it = { id: uid(), type: 'sticky', x: r1(wp.x - 100), y: r1(wp.y - 100), w: 200, h: 200, z: nextZ(), text: '', c: opts.sticky.c };
    commit([{ o: 'put', item: it }], [], false);
    setTool('select');
    startEdit(it.id, true);
  }

  // ============================================================
  //  Клавиатура и буфер обмена
  // ============================================================
  const typing = e => e.target.closest && e.target.closest('input,textarea,select,[contenteditable=true],[contenteditable=plaintext-only]');
  addEventListener('keydown', e => {
    if (typing(e) || $('.modal-bg')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.code === 'Space' && !spaceDown) { spaceDown = true; vp.style.cursor = 'grab'; e.preventDefault(); return; }
    if (presentIdx >= 0) {
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); return gotoFrame(presentIdx + 1); }
      if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) { e.preventDefault(); return gotoFrame(presentIdx - 1); }
      if (e.key === 'Escape') return stopPresent();
    }
    if (mod && e.code === 'KeyZ') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
    if (mod && e.code === 'KeyY') { e.preventDefault(); return redo(); }
    if (mod && e.code === 'KeyD') { e.preventDefault(); return duplicate(); }
    if (mod && e.code === 'KeyA') { e.preventDefault(); return setSel([...items.values()].filter(selectable).map(i => i.id)); }
    if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); return zoomAt(innerWidth / 2, innerHeight / 2, 1.2); }
    if (mod && e.key === '-') { e.preventDefault(); return zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.2); }
    if (mod && e.key === '0') { e.preventDefault(); return fitAll(); }
    if (mod) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel.size) { e.preventDefault(); return delItems(sel); }
    if (e.key === 'Escape') { setSel([]); setTool(canEdit() ? 'select' : 'hand'); return; }
    if (e.key === 'Enter' && sel.size === 1) { const it = items.get([...sel][0]); if (it && ['text', 'sticky', 'shape'].includes(it.type) && !isLine(it)) { e.preventDefault(); startEdit(it.id); } return; }
    if (e.key.startsWith('Arrow') && sel.size) {
      e.preventDefault();
      const d = e.shiftKey ? 10 : 1, dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
      const m = {}; for (const id of sel) { const it = items.get(id); if (canTouch(it)) m[id] = { x: it.x + dx, y: it.y + dy }; }
      return patchItems(m);
    }
    const map = { KeyV: 'select', KeyH: 'hand', KeyP: 'pen', KeyM: 'hl', KeyE: 'eraser', KeyT: 'text', KeyN: 'sticky', KeyS: 'shape', KeyF: 'frame', KeyL: 'laser' };
    if (map[e.code] && (canEdit() || ['hand', 'laser'].includes(map[e.code]))) setTool(map[e.code]);
    if (e.shiftKey && e.code === 'Digit1') fitAll();
  });
  addEventListener('keyup', e => { if (e.code === 'Space') { spaceDown = false; vp.style.cursor = ''; } });
  addEventListener('blur', () => { spaceDown = false; vp.style.cursor = ''; });

  const CLIP = 'board-clip';
  function copySel(e, cut) {
    if (typing(e) || !sel.size || !canEdit()) return;
    const list = [...sel].map(id => clone(items.get(id)));
    const ts = Date.now();
    try { localStorage.setItem(CLIP, JSON.stringify({ ts, items: list })); } catch { }
    e.clipboardData.setData('text/plain', 'board-clip:' + ts);
    e.preventDefault();
    if (cut) delItems(sel);
  }
  addEventListener('copy', e => copySel(e));
  addEventListener('cut', e => copySel(e, true));
  addEventListener('paste', async e => {
    if (typing(e) || !canEdit() || $('.modal-bg')) return;
    const dt = e.clipboardData;
    const files = [...dt.files];
    const at = lastPointerWorld && isFinite(lastPointerWorld.x) ? lastPointerWorld : viewCenter();
    if (files.length) { e.preventDefault(); return uploadMany(files, at); }
    const text = dt.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    if (text.startsWith('board-clip:')) {
      let data; try { data = JSON.parse(localStorage.getItem(CLIP)); } catch { }
      if (!data || !data.items.length) return;
      const box = { x: Math.min(...data.items.map(i => i.x)), y: Math.min(...data.items.map(i => i.y)) };
      const copies = data.items.sort((a, b) => (a.z || 0) - (b.z || 0)).map(it => { const c = clone(it); c.id = uid(); c.x = r1(at.x + (it.x - box.x)); c.y = r1(at.y + (it.y - box.y)); c.z = nextZ(); delete c.state; if (!isOwner()) delete c.locked; return c; });
      return addItems(copies);
    }
    if (/^https?:\/\/\S+$/.test(text.trim())) return addUrl(text.trim(), at);
    addItems([{ id: uid(), type: 'text', x: r1(at.x), y: r1(at.y), z: nextZ(), text: text.slice(0, 20000), fs: opts.text.fs, c: opts.text.c, w: text.length > 60 ? 600 : undefined }]);
  });

  // ============================================================
  //  Загрузка файлов и медиа
  // ============================================================
  vp.addEventListener('dragover', e => { if (canEdit()) e.preventDefault(); });
  vp.addEventListener('drop', e => {
    if (!canEdit()) return;
    e.preventDefault();
    const at = toWorld(e.clientX, e.clientY);
    const files = [...e.dataTransfer.files];
    if (files.length) return uploadMany(files, at);
    const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (url && /^https?:/.test(url)) addUrl(url.trim(), at);
  });
  function pickFiles(at) {
    const inp = Object.assign(document.createElement('input'), { type: 'file', multiple: true, accept: 'image/*,audio/*,video/*,application/pdf,.pdf,.doc,.docx,.ppt,.pptx,.txt' });
    inp.onchange = () => uploadMany([...inp.files], at || viewCenter());
    inp.click();
  }
  async function upload(blob, name) {
    const r = await fetch(`/api/upload?board=${encodeURIComponent(boardId)}&k=${encodeURIComponent(KEY)}`, {
      method: 'POST', body: blob, headers: { 'x-filename': encodeURIComponent(name), 'Content-Type': blob.type || 'application/octet-stream' }, credentials: 'same-origin'
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Ошибка загрузки');
    return d;
  }
  function loadImg(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; }); }
  // уменьшаем большие картинки перед загрузкой — меньше трафика и быстрее отрисовка
  async function prepImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImg(url);
      let w = img.naturalWidth, h = img.naturalHeight;
      const MAX = 2000;
      if ((w > MAX || h > MAX || file.size > 1.5e6) && file.type !== 'image/gif') {
        const k = Math.min(1, MAX / Math.max(w, h)); w = Math.round(w * k); h = Math.round(h * k);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        const blob = await new Promise(r => c.toBlob(r, 'image/webp', 0.86));
        if (blob) return { blob, w, h, name: file.name.replace(/\.\w+$/, '') + '.webp' };
      }
      return { blob: file, w, h, name: file.name };
    } finally { URL.revokeObjectURL(url); }
  }
  function fitSize(w, h, max = 640) { const k = Math.min(1, max / Math.max(w, h)); return { w: r1(w * k), h: r1(h * k) }; }
  async function uploadMany(files, at) {
    let y = at.y;
    for (const f of files) {
      const t = toast.bind(null);
      try {
        if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
          const asPages = await choosePdf(f.name);
          if (asPages === null) continue;
          if (asPages) { await pdfPages(f, { x: at.x, y }); continue; }
        }
        t(`Загрузка: ${f.name}…`, 1500);
        if (f.type.startsWith('image/')) {
          const p = await prepImage(f);
          const d = await upload(p.blob, p.name);
          const s = fitSize(p.w, p.h);
          addItems([{ id: uid(), type: 'image', x: r1(at.x - s.w / 2), y: r1(y - s.h / 2), z: nextZ(), w: s.w, h: s.h, src: d.url }]);
          y += s.h + 20;
        } else if (f.type.startsWith('audio/')) {
          const d = await upload(f, f.name);
          addItems([{ id: uid(), type: 'audio', x: r1(at.x - 170), y: r1(y), z: nextZ(), w: 340, src: d.url, name: f.name.replace(/\.\w+$/, '') }]);
          y += 120;
        } else if (f.type.startsWith('video/')) {
          const d = await upload(f, f.name);
          addItems([{ id: uid(), type: 'video', x: r1(at.x - 320), y: r1(y), z: nextZ(), w: 640, h: 360, src: d.url }]);
          y += 380;
        } else {
          const d = await upload(f, f.name);
          addItems([{ id: uid(), type: 'file', x: r1(at.x - 170), y: r1(y), z: nextZ(), w: 340, src: d.url, name: f.name, size: d.size }]);
          y += 90;
        }
      } catch (err) { toast(`${f.name}: ${err.message}`); }
    }
    setTool('select');
  }
  function choosePdf(name) {
    return new Promise(res => {
      let done = false;
      const m = modal(`<h2>PDF: ${esc(name)}</h2><p style="color:var(--muted)">Как добавить файл на доску?</p>
        <div class="actions" style="flex-wrap:wrap"><button class="btn" data-close>Отмена</button><button class="btn" data-v="0">Файлом (скачать)</button><button class="btn primary" data-v="1">Страницами-картинками</button></div>`,
        { onClose: () => { if (!done) res(null); } });
      m.el.querySelectorAll('[data-v]').forEach(b => b.onclick = () => { done = true; res(b.dataset.v === '1'); m.close(); });
    });
  }
  let pdfjs = null;
  async function loadPdfJs() {
    if (pdfjs) return pdfjs;
    const base = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
    await new Promise((res, rej) => { const s = document.createElement('script'); s.src = base + 'pdf.min.js'; s.onload = res; s.onerror = () => rej(new Error('не удалось загрузить pdf.js')); document.head.appendChild(s); });
    pdfjs = window.pdfjsLib; pdfjs.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.js';
    return pdfjs;
  }
  async function pdfPages(file, at) {
    toast('Обработка PDF…');
    const lib = await loadPdfJs();
    const doc = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    const n = Math.min(doc.numPages, 80);
    const list = []; let y = at.y;
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const v1 = page.getViewport({ scale: 1 });
      const scale = 1600 / v1.width;
      const vpp = page.getViewport({ scale });
      const c = document.createElement('canvas'); c.width = vpp.width; c.height = vpp.height;
      await page.render({ canvasContext: c.getContext('2d'), viewport: vpp }).promise;
      const blob = await new Promise(r => c.toBlob(r, 'image/webp', 0.85));
      const d = await upload(blob, `${file.name}-p${i}.webp`);
      const w = 800, h = r1(800 * vpp.height / vpp.width);
      list.push({ id: uid(), type: 'image', x: r1(at.x - w / 2), y: r1(y), z: nextZ(), w, h, src: d.url });
      y += h + 40;
      if (i % 5 === 0) toast(`PDF: ${i} из ${n} страниц`);
    }
    addItems(list);
    toast(`Добавлено страниц: ${n}`);
  }
  async function askUrl(at) {
    const u = await prompt2('Вставить ссылку', '', { placeholder: 'https://youtube.com/watch?v=… или любая ссылка', ok: 'Добавить', hint: 'YouTube-видео встроится в доску. Ссылка на картинку или mp3 — добавится как картинка/аудио.' });
    if (u && u.trim()) addUrl(u.trim(), at || viewCenter());
  }
  async function addUrl(url, at) {
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    const yt = ytId(url);
    if (yt) return addItems([{ id: uid(), type: 'video', x: r1(at.x - 320), y: r1(at.y - 180), z: nextZ(), w: 640, h: 360, yt }]);
    if (/\.(png|jpe?g|gif|webp)(\?|$)/i.test(url)) {
      try { const img = await loadImg(url); const s = fitSize(img.naturalWidth, img.naturalHeight); return addItems([{ id: uid(), type: 'image', x: r1(at.x - s.w / 2), y: r1(at.y - s.h / 2), z: nextZ(), w: s.w, h: s.h, src: url }]); } catch { }
    }
    if (/\.(mp3|ogg|wav|m4a)(\?|$)/i.test(url)) return addItems([{ id: uid(), type: 'audio', x: r1(at.x - 170), y: r1(at.y), z: nextZ(), w: 340, src: url, name: decodeURIComponent(url.split('/').pop().split('?')[0]) }]);
    let host = url; try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { }
    addItems([{ id: uid(), type: 'link', x: r1(at.x - 170), y: r1(at.y), z: nextZ(), w: 340, url, title: host }]);
  }

  // ============================================================
  //  Интерфейс: панели
  // ============================================================
  const TOOLS = [
    { id: 'select', icon: 'select', t: 'Выделение', k: 'V', ed: 1 },
    { id: 'hand', icon: 'hand', t: 'Рука', k: 'H' },
    '-',
    { id: 'pen', icon: 'pen', t: 'Ручка', k: 'P', ed: 1 },
    { id: 'hl', icon: 'hl', t: 'Маркер', k: 'M', ed: 1 },
    { id: 'eraser', icon: 'eraser', t: 'Ластик', k: 'E', ed: 1 },
    '-',
    { id: 'text', icon: 'text', t: 'Текст', k: 'T', ed: 1 },
    { id: 'sticky', icon: 'sticky', t: 'Стикер', k: 'N', ed: 1 },
    { id: 'shape', icon: 'shape', t: 'Фигуры', k: 'S', ed: 1 },
    { id: 'frame', icon: 'frame', t: 'Слайд (рамка)', k: 'F', ed: 1 },
    '-',
    { id: 'ex', icon: 'ex', t: 'Упражнения', ed: 1, menu: true },
    { id: 'media', icon: 'image', t: 'Картинки, файлы, видео', ed: 1, menu: true },
    '-',
    { id: 'laser', icon: 'laser', t: 'Лазерная указка', k: 'L' }
  ];
  function buildChrome() {
    // toolbar
    $('#toolbar').innerHTML = TOOLS.map(t => t === '-' ? '<div class="hsep ed"></div>' : `<button class="ibtn ${t.ed ? 'ed' : ''}" data-tool="${t.id}" title="${t.t}${t.k ? ' (' + t.k + ')' : ''}">${icon(t.icon)}${t.k ? `<span class="k">${t.k}</span>` : ''}</button>`).join('');
    $('#toolbar').onclick = e => {
      const b = e.target.closest('[data-tool]'); if (!b) return;
      const id = b.dataset.tool;
      if (id === 'ex') {
        const r = b.getBoundingClientRect();
        return menu(r.right + 8, r.top, [
          { header: 'Интерактивные упражнения' },
          { label: 'Заполнить пропуски', icon: 'edit', onClick: () => openExEditor('gaps') },
          { label: 'Тест (выбор ответа)', icon: 'check', onClick: () => openExEditor('quiz') },
          { label: 'Соединить пары', icon: 'link', onClick: () => openExEditor('match') },
          { label: 'Составить предложение', icon: 'shuffle', onClick: () => openExEditor('order') }
        ]);
      }
      if (id === 'media') {
        const r = b.getBoundingClientRect();
        return menu(r.right + 8, r.top, [
          { label: 'Загрузить с компьютера', icon: 'upload', onClick: () => pickFiles() },
          { label: 'Видео YouTube / ссылка', icon: 'video', onClick: () => askUrl() },
          { header: 'Картинки, PDF, аудио и видео можно также перетащить на доску или вставить Ctrl+V' }
        ]);
      }
      setTool(id);
    };
    // top left
    const back = isOwner() ? `<a class="ibtn" href="/" title="Мои доски">${icon('left')}</a>` : '';
    $('#topleft').innerHTML = `${back}<div id="title" ${isOwner() ? 'contenteditable="true" spellcheck="false"' : ''}>${esc(title)}</div>`;
    document.title = title;
    const tEl = $('#title');
    if (isOwner()) {
      tEl.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); tEl.blur(); } e.stopPropagation(); };
      tEl.onblur = () => { const v = tEl.textContent.trim() || 'Без названия'; tEl.textContent = v; if (v !== title) { title = v; document.title = v; send({ t: 'title', title: v }); } tEl.scrollLeft = 0; };
    }
    // top right
    $('#topright').innerHTML = `<div id="peers"></div><div class="panel">
      ${canEdit() ? `<button class="ibtn" id="b-attn" title="Собрать всех здесь">${icon('megaphone')}</button><button class="ibtn" id="b-lead" title="Вести за собой (ученики видят то же, что и вы)">${icon('eye')}</button>` : ''}
      <button class="ibtn" id="b-frames" title="Слайды и презентация">${icon('slides')}</button>
      ${isOwner() ? `<button class="btn primary small" id="b-share" style="margin-left:4px">${icon('link')}Поделиться</button>` : ''}
    </div>`;
    const on = (id, fn) => { const el = $('#' + id); if (el) el.onclick = fn; };
    on('b-attn', () => { send({ t: 'attention', r: visibleRect() }); toast('Все участники перенесены к вам'); });
    on('b-lead', () => toggleLead());
    on('b-frames', () => { $('#framespanel').hidden = !$('#framespanel').hidden; renderFramesPanel(); });
    on('b-share', shareDialog);
    renderPeers();
    // zoom
    $('#zoombar').innerHTML = `<button class="ibtn" data-z="out" title="Уменьшить">${icon('minus')}</button><button class="zv" data-z="100" title="100%">100%</button><button class="ibtn" data-z="in" title="Увеличить">${icon('plus')}</button><button class="ibtn" data-z="fit" title="Показать всё (Shift+1)">${icon('fit')}</button>`;
    $('#zoombar').onclick = e => {
      const z = e.target.closest('[data-z]'); if (!z) return;
      userMovedView();
      const c = [innerWidth / 2, innerHeight / 2];
      if (z.dataset.z === 'in') zoomAt(...c, 1.25);
      else if (z.dataset.z === 'out') zoomAt(...c, 0.8);
      else if (z.dataset.z === '100') zoomAt(...c, 1 / view.z);
      else fitAll();
    };
    $('#histbar').innerHTML = `<button class="ibtn" id="b-undo" title="Отменить (Ctrl+Z)">${icon('undo')}</button><button class="ibtn" id="b-redo" title="Повторить (Ctrl+Shift+Z)">${icon('redo')}</button>`;
    on('b-undo', undo); on('b-redo', redo);
    updateHistBtns();
    setTool(tool);
    applyView();
  }
  function updateHistBtns() {
    const u = $('#b-undo'), r = $('#b-redo');
    if (u) u.disabled = !undoStack.length; if (r) r.disabled = !redoStack.length;
  }
  function renderPeers() {
    const box = $('#peers'); if (!box) return;
    const list = [...peers.values()];
    box.innerHTML = list.slice(0, 6).map(p => `<div class="av" style="background:${esc(p.color)}" title="${esc(p.name)}${p.role === 'owner' ? ' (владелец)' : ''}" data-p="${p.id}">${esc(initials(p.name))}</div>`).join('') +
      (list.length > 6 ? `<div class="av" style="background:#8b8d98">+${list.length - 6}</div>` : '');
    box.onclick = e => {
      const a = e.target.closest('[data-p]'); const p = a && peers.get(a.dataset.p);
      if (p && p.x != null) { userMovedView(); animateTo({ z: view.z, x: innerWidth / 2 - p.x * view.z, y: innerHeight / 2 - p.y * view.z }); }
    };
  }
  function setTool(t) {
    tool = t;
    document.body.className = document.body.className.replace(/\btool-\w+/g, '') + ' tool-' + t;
    $$('#toolbar [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
    if (t !== 'select' && t !== 'hand') setSel([]);
    renderToolOpts();
  }
  function renderToolOpts() {
    const box = $('#toolopts');
    const o = opts[tool];
    if (!o || !canEdit()) { box.hidden = true; return; }
    let h = '';
    if (tool === 'shape') {
      h += ['rect', 'ellipse', 'triangle', 'diamond', 'line', 'arrow'].map(k => `<button class="ibtn ${o.k === k ? 'on' : ''}" data-k="${k}">${icon(k)}</button>`).join('') + '<div class="hsep" style="width:100%"></div>';
    }
    const pal = tool === 'sticky' ? STICKY : tool === 'hl' ? HL_COLORS : COLORS.filter(c => c !== '#ffffff');
    h += pal.map(c => `<button class="sw ${o.c === c ? 'on' : ''}" data-c="${c}" style="background:${c}"></button>`).join('');
    const sizes = tool === 'pen' ? [2, 4, 8, 14] : tool === 'hl' ? [14, 22, 34] : tool === 'shape' ? [1, 3, 6] : tool === 'text' ? [18, 28, 44, 72] : null;
    if (sizes) {
      const key = tool === 'shape' ? 'sw' : tool === 'text' ? 'fs' : 's';
      h += '<div class="hsep" style="width:100%"></div>' + sizes.map(s => {
        const dot = tool === 'text' ? `<b style="font-size:${10 + sizes.indexOf(s) * 4}px">A</b>` : `<i style="width:${Math.min(22, s + 2)}px;height:${Math.min(22, s + 2)}px"></i>`;
        return `<button class="szb ${o[key] === s ? 'on' : ''}" data-s="${s}" data-key="${key}">${dot}</button>`;
      }).join('');
    }
    if (tool === 'shape') h += '<div class="hsep" style="width:100%"></div>' + ['none', '#ffffff', 'soft'].map(f => `<button class="sw ${f === 'none' ? 'none' : ''} ${(o.fill === f || (f === 'soft' && o.fill !== 'none' && o.fill !== '#ffffff')) ? 'on' : ''}" data-f="${f}" title="Заливка" style="${f === 'soft' ? 'background:' + o.c + '33' : f === '#ffffff' ? 'background:#fff' : ''}"></button>`).join('');
    box.innerHTML = h; box.hidden = false;
    box.onclick = e => {
      const c = e.target.closest('[data-c]'), s = e.target.closest('[data-s]'), k = e.target.closest('[data-k]'), f = e.target.closest('[data-f]');
      if (c) { o.c = c.dataset.c; if (tool === 'shape' && o.fill !== 'none' && o.fill !== '#ffffff') o.fill = o.c + '33'; }
      if (s) o[s.dataset.key] = +s.dataset.s;
      if (k) o.k = k.dataset.k;
      if (f) o.fill = f.dataset.f === 'soft' ? o.c + '33' : f.dataset.f;
      saveOpts(); renderToolOpts();
    };
  }

  // ---------- поделиться ----------
  function shareDialog() {
    const link = () => location.origin + '/b/' + boardId + '?k=' + shareToken;
    const m = modal(`<h2>Поделиться доской</h2><p class="hint" style="font-size:14px">Отправьте ссылку ученику — регистрация не нужна, достаточно ввести имя.</p>
      <label class="lbl">Доступ по ссылке</label>
      <div class="seg" id="sm"><button data-m="edit">Редактирование</button><button data-m="view">Просмотр и ответы</button><button data-m="off">Выключен</button></div>
      <div class="hint" id="smh"></div>
      <label class="lbl">Ссылка</label>
      <div class="share-link"><input class="field" readonly id="sl"><button class="btn primary" id="cp">${icon('copy')}Копировать</button></div>
      <div class="hint">Совет: заблокируйте (${icon('lock').replace('class="i ', 'style="width:12px;height:12px;display:inline;vertical-align:-1px" class="i ')}) фон, картинки и задания, чтобы ученик случайно их не сдвинул — отвечать на упражнения он всё равно сможет.</div>
      <div class="actions" style="justify-content:space-between"><button class="btn" id="rot">${icon('refresh')}Новая ссылка</button><button class="btn" data-close>Готово</button></div>`);
    const upd = () => {
      m.el.querySelectorAll('[data-m]').forEach(b => b.classList.toggle('on', b.dataset.m === shareMode));
      $('#smh', m.el).textContent = { edit: 'Ученик может рисовать, писать и двигать незаблокированные объекты.', view: 'Ученик видит доску, курсоры и указку, может отвечать на упражнения, но не может ничего менять.', off: 'Ссылка не работает. Подключённые ученики будут отключены.' }[shareMode];
      $('#sl', m.el).value = shareMode === 'off' ? '' : link();
      $('#cp', m.el).disabled = shareMode === 'off';
    };
    upd();
    m.el.querySelector('#sm').onclick = async e => {
      const b = e.target.closest('[data-m]'); if (!b) return;
      try { const r = await api('/api/boards/' + boardId, { method: 'PATCH', body: { shareMode: b.dataset.m } }); shareMode = r.board.shareMode; upd(); } catch (err) { toast(err.message); }
    };
    m.el.querySelector('#cp').onclick = () => { const i = $('#sl', m.el); i.select(); navigator.clipboard?.writeText(i.value).then(() => toast('Ссылка скопирована'), () => document.execCommand('copy')); };
    m.el.querySelector('#rot').onclick = async () => {
      if (!await confirm2('Создать новую ссылку?', 'Старая ссылка перестанет работать, подключённые ученики будут отключены.', 'Создать')) return;
      const r = await api('/api/boards/' + boardId + '/rotate-link', { body: {} }); shareToken = r.board.shareToken; upd(); toast('Новая ссылка создана');
    };
  }

  // ---------- ведение и внимание ----------
  function toggleLead(force) {
    leading = force != null ? force : !leading;
    if (leading) { sendLeadView(); toast('Ученики теперь видят то же, что и вы'); }
    else send({ t: 'view', on: false });
    $('#b-lead')?.classList.toggle('on', leading);
    renderFollow();
  }
  function renderFollow() {
    const p = $('#followpill');
    if (leading) {
      p.hidden = false; p.className = 'panel leading';
      p.innerHTML = `<span class="recdot"></span>Вы ведёте — ученики следуют за вашим экраном<button class="btn small" id="fp">Остановить</button>`;
      $('#fp').onclick = () => toggleLead(false);
    } else if (leader && peers.has(leader.id)) {
      p.hidden = false; p.className = 'panel';
      p.innerHTML = following ? `${icon('eye')}Вы следуете за: <b>${esc(leader.name)}</b><button class="btn small" id="fp">Свободно</button>`
        : `Ведущий: <b>${esc(leader.name)}</b><button class="btn small primary" id="fp">Вернуться к ведущему</button>`;
      $('#fp').onclick = () => { following = !following; renderFollow(); };
    } else p.hidden = true;
  }

  // ---------- слайды / презентация ----------
  const frameList = () => [...items.values()].filter(i => i.type === 'frame').sort((a, b) => (Math.abs(a.y - b.y) > 200 ? a.y - b.y : a.x - b.x));
  function renderFramesPanel() {
    const p = $('#framespanel'); if (p.hidden) return;
    const fl = frameList();
    p.innerHTML = `<h3>Слайды <button class="ibtn" data-x>${icon('x')}</button></h3>
      <div class="list">${fl.map((f, i) => `<button class="fi" data-i="${i}"><b>${i + 1}</b><span>${esc(f.title || 'Слайд')}</span></button>`).join('') || `<div class="hint">Слайдов пока нет. Инструментом «Слайд» (F) нарисуйте рамку — она станет слайдом презентации.</div>`}</div>
      ${fl.length ? `<button class="btn primary" data-pr style="margin-top:10px">${icon('play')}Показ слайдов</button>` : ''}`;
    p.onclick = e => {
      if (e.target.closest('[data-x]')) { p.hidden = true; return; }
      const fi = e.target.closest('[data-i]'); if (fi) { userMovedView(); const f = fl[+fi.dataset.i]; fitRect({ x: f.x, y: f.y, w: f.w, h: f.h }); }
      if (e.target.closest('[data-pr]')) startPresent();
    };
  }
  function startPresent() {
    if (!frameList().length) return;
    document.body.classList.add('presenting');
    presentIdx = 0; setSel([]);
    if (canEdit() && !leading) { toggleLead(true); action = null; presentLed = true; }
    gotoFrame(0);
    document.documentElement.requestFullscreen?.().catch(() => { });
  }
  let presentLed = false;
  function gotoFrame(i) {
    const fl = frameList(); if (!fl.length) return;
    presentIdx = Math.max(0, Math.min(fl.length - 1, i));
    const f = fl[presentIdx];
    fitRect({ x: f.x, y: f.y, w: f.w, h: f.h });
    const bar = $('#presentbar');
    bar.hidden = false;
    bar.innerHTML = `<button class="ibtn" data-p="-1">${icon('left')}</button><span class="num">${presentIdx + 1} / ${fl.length}</span><button class="ibtn" data-p="1">${icon('right')}</button><span class="sep"></span><button class="ibtn" data-p="laser" title="Указка" style="${tool === 'laser' ? 'color:var(--accent)' : ''}">${icon('laser')}</button><button class="btn small" data-p="x">Выйти</button>`;
    bar.onclick = e => {
      const b = e.target.closest('[data-p]'); if (!b) return;
      const v = b.dataset.p;
      if (v === 'x') stopPresent(); else if (v === 'laser') { setTool(tool === 'laser' ? 'hand' : 'laser'); gotoFrame(presentIdx); } else gotoFrame(presentIdx + +v);
    };
  }
  function stopPresent() {
    presentIdx = -1;
    document.body.classList.remove('presenting');
    $('#presentbar').hidden = true;
    if (presentLed) { toggleLead(false); presentLed = false; }
    if (document.fullscreenElement) document.exitFullscreen?.();
    setTool(canEdit() ? 'select' : 'hand');
  }

  function fatal(msg) {
    const l = $('#loading'); l.hidden = false;
    l.innerHTML = `<div style="text-align:center"><div style="font-size:40px">🔒</div><p style="font-size:16px;color:var(--text)">${esc(msg)}</p><a href="/" class="btn">На главную</a></div>`;
  }

  // ============================================================
  //  Старт
  // ============================================================
  (async () => {
    let info;
    try { info = await api(`/api/boards/${encodeURIComponent(boardId)}/info?k=${encodeURIComponent(KEY)}`); }
    catch (e) {
      if (e.status === 403) return fatal(KEY ? 'Ссылка недействительна или доступ закрыт.' : 'Нет доступа. Войдите в аккаунт или попросите ссылку у преподавателя.');
      return fatal('Не удалось загрузить доску: ' + e.message);
    }
    if (info.user) { myName = info.user.name; return connect(); }
    try { myName = localStorage.getItem('guest-name') || ''; } catch { }
    if (myName) return connect();
    $('#loading').hidden = true;
    const m = modal(`<h2>${esc(info.board.title)}</h2><p class="hint" style="font-size:14px">Как вас зовут? Имя увидят другие участники доски.</p>
      <form><input class="field" autofocus required maxlength="40" placeholder="Ваше имя"><div class="actions"><button class="btn primary">Войти на доску</button></div></form>`);
    m.el.querySelector('form').onsubmit = e => {
      e.preventDefault();
      myName = m.el.querySelector('input').value.trim() || 'Гость';
      try { localStorage.setItem('guest-name', myName); } catch { }
      m.close(); $('#loading').hidden = false; connect();
    };
  })();
})();
