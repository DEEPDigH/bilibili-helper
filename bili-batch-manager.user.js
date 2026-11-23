// ==UserScript==
// @name         B站原生批量管理
// @namespace    local.bili.batch
// @version      0.1.5
// @description  关注页批量移动/取关，动态页独立游标分页管理转发；执行前预览，串行核实
// @match        https://space.bilibili.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      api.bilibili.com
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  // Core rules are also exported for isolated tests; webpage text is data only.
  const validId = value => typeof value === 'string' && /^[1-9]\d*$/.test(value);
  function relationState(data, fid) {
    if (String(data?.mid) === fid && [2, 6].includes(data.attribute)) return true;
    if (data?.attribute === 0 && (String(data.mid) === fid ||
      (data.mid === 0 && data.mtime === 0 && data.tag === null && data.special === 0))) return false;
    throw Error('关注状态无法核实');
  }
  function membership(data) {
    if (!data || Array.isArray(data) || typeof data !== 'object' ||
      Object.entries(data).some(([id, name]) => !/^(?:0|-10|[1-9]\d*)$/.test(id) || typeof name !== 'string'))
      throw Error('分组信息不完整');
    return Object.keys(data).filter(id => id !== '0').sort();
  }
  function movedGroups(current, target) {
    if (!/^(?:0|[1-9]\d*)$/.test(target)) throw Error('目标分组无效');
    return [...(current.includes('-10') ? ['-10'] : []), ...(target === '0' ? [] : [target])].sort();
  }
  function ownForward(item, mid, id = item?.id_str) {
    return validId(id) && item?.id_str === id && item.type === 'DYNAMIC_TYPE_FORWARD' &&
      String(item.modules?.module_author?.mid) === mid;
  }
  function desc(item) { return item?.modules?.module_dynamic?.desc?.text || ''; }
  function originalText(item) {
    const major = item?.modules?.module_dynamic?.major;
    if (major?.opus) return [major.opus.title, major.opus.summary?.text].filter(Boolean).join('\n');
    return desc(item) || major?.archive?.title || major?.article?.title || '';
  }
  function publishedTime(item) {
    const value = Number(item?.modules?.module_author?.pub_ts) * 1000;
    return value > 0 && value <= 8640000000000000 ? value : 0;
  }
  function feedPage(data, mid, offset, seen) {
    if (!Array.isArray(data?.items) || ![true, false, 0, 1].includes(data.has_more)) throw Error('动态分页格式无法核实');
    if (data.items.some(item => !validId(item?.id_str) || typeof item.type !== 'string' || String(item.modules?.module_author?.mid) !== mid))
      throw Error('动态ID或作者身份异常，已停止读取');
    const next = typeof data.offset === 'string' ? data.offset : '';
    if (data.has_more && (!next || next === offset || seen.has(next))) throw Error('动态游标未前进，已停止；未认定已到末尾');
    return {items: data.items, next, ended: !data.has_more};
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {relationState, membership, movedGroups, ownForward, feedPage}; return;
  }

  const page = unsafeWindow, API = 'https://api.bilibili.com';
  const key = 'bili-batch:v1:';
  const cookie = name => document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1) || '';
  const account = () => cookie('DedeUserID');
  const owner = () => location.pathname.split('/')[1];
  const mode = () => /^\/\d+\/relation\/follow\/?$/.test(location.pathname) ? 'follow' : /^\/\d+\/dynamic\/?$/.test(location.pathname) ? 'dynamic' : '';
  const allowed = () => validId(account()) && owner() === account() && !!mode();
  let halted = false, running = false, paused = false, dynamicBatch = false;
  let toolbar, feedback, status, log, dialog, scheduled = false, state, stateMid, lastMessage = '';
  let readOffset = '', readRequest = null, pageEnded = false, sequence = 0;
  let currentPage = 1, pageSize = 12, timeOrder = 'newest', loadingHistory = false, stopHistory = false;
  let topPager, bottomPager, viewHost, renderedKey = '', feedVersion = 0;
  const feedItems = new Map(), seenOffsets = new Set(), deferredReads = new Set();
  const selected = new Map();
  let orderedFeed = null, logDirty = true;
  const publishedFormat = new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Shanghai', hour12: false,
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'});
  const own = el => el instanceof Element && !!el.closest('[data-bbm]');
  const needAccount = mid => { if (!allowed() || account() !== mid) throw Error('账号或页面已切换，请停止后刷新'); };
  const stamp = () => new Date().toISOString();
  function api(path, data, json = false) {
    if (halted) return Promise.reject(Error('请求已暂停，请处理后刷新页面'));
    return new Promise((resolve, reject) => {
      const csrf = data ? cookie('bili_jct') : '';
      if (data && !csrf) { reject(Error('登录已失效')); return; }
      const url = API + path + (path.includes('?') ? '&' : '?') + (json ? 'csrf=' + encodeURIComponent(csrf) + '&' : '') + '_t=' + Date.now() + '-' + (++sequence);
      GM_xmlhttpRequest({method: data ? 'POST' : 'GET', url, nocache: !data, timeout: 20000,
        ...(data ? {headers: {'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded'},
          data: json ? JSON.stringify(data) : new URLSearchParams({...data, csrf}).toString()} : {}),
        onload(response) {
          try {
            if (response.status !== 200) throw Error('接口HTTP ' + response.status);
            const result = JSON.parse(response.responseText);
            if (result.code !== 0) throw Error('接口返回 ' + result.code + '，请检查登录或平台限制');
            resolve(result.data);
          } catch (error) { halted = true; reject(error); }
        },
        onerror() { halted = true; reject(Error('网络失败，已暂停')); },
        ontimeout() { halted = true; reject(Error('请求超时，已暂停')); }
      });
    });
  }
  async function checkAccount(mid) {
    needAccount(mid);
    const nav = await api('/x/web-interface/nav');
    needAccount(mid);
    if (!nav?.isLogin || String(nav.mid) !== mid) { halted = true; throw Error('登录状态变化，已暂停'); }
  }
  function loadState() {
    const mid = account(); if (stateMid === mid) return;
    if (stateMid) { restorePages(); selected.clear(); feedItems.clear(); seenOffsets.clear();
      readOffset = ''; pageEnded = false; dynamicBatch = false; currentPage = 1; orderedFeed = null; feedVersion++; }
    const saved = GM_getValue(key + mid, null);
    state = saved?.version === 1 && saved.mid === mid && Array.isArray(saved.tasks) ? saved : {version: 1, mid, tasks: []};
    for (const task of state.tasks) if (task.status === 'running') { task.status = 'uncertain'; task.reason = '上次执行中断，需先核实结果'; }
    stateMid = mid;
  }
  function persist() { GM_setValue(key + stateMid, state); }
  function el(tag, text, parent) {
    const node = document.createElement(tag); if (text) node.textContent = text;
    parent?.append(node); return node;
  }
  function button(text, parent, action, danger = false) {
    const node = el('button', text, parent); node.type = 'button'; node.className = 'bbm-button' + (danger ? ' bbm-danger' : '');
    node.onclick = () => { Promise.resolve().then(action).catch(error => say(error.message)); }; return node;
  }
  function say(text) { lastMessage = text; if (status && status.textContent !== text) status.textContent = text; }
  const labels = {move: '移动分组', unfollow: '取消关注', delete: '删除转发'};
  const results = {pending: '待执行', running: '执行中', done: '已核实', uncertain: '待核实', failed: '已停止', abandoned: '已放弃'};
  function renderLog() {
    logDirty = true;
    flushLog();
  }
  function flushLog() {
    if (!log || log.parentElement.hidden || !logDirty) return;
    log.replaceChildren();
    for (const task of state.tasks.slice(-100).reverse()) {
      const row = el('div', '', log); row.className = 'bbm-log-row';
      el('span', labels[task.action] + ' · ' + task.name + ' · ' + (results[task.status] || '状态未知'), row);
      if (task.reason) el('small', task.reason, row);
      if (task.action === 'delete' && task.status === 'uncertain' && task.acceptedAt) {
        const link = el('a', '打开转发核对', row); link.href = 'https://t.bilibili.com/' + task.id;
        link.target = '_blank'; link.rel = 'noopener noreferrer';
        button('我已核实删除', row, async () => {
          if (running) throw Error('请等待本批任务结束');
          if (!confirm('你已在B站核实转发 ' + task.id + ' 已删除？此按钮只更新本地记录。')) return;
          await navigator.locks.request('bili-batch:' + stateMid, {ifAvailable: true}, lock => {
            if (!lock) throw Error('另一个页面正在执行');
            needAccount(stateMid); state = GM_getValue(key + stateMid, state);
            const current = state.tasks.find(t => t.id === task.id && t.createdAt === task.createdAt && t.action === 'delete');
            if (!current || current.status !== 'uncertain') throw Error('记录已变化，请刷新查看');
            current.status = 'done'; current.reason = '用户在原页面核实删除'; current.finishedAt = stamp();
            persist(); renderLog();
          });
        });
      }
    }
    if (!state.tasks.length) el('span', '暂无操作记录', log);
    logDirty = false;
  }
  function exportLog() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], {type: 'application/json'}));
    const link = el('a'); link.href = url; link.download = 'bili-batch-' + stateMid + '-' + Date.now() + '.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  // During the managed view, defer only native reads of this account's feed.
  // Resume the untouched request on exit; never fabricate a response for Vue.
  function spaceRead(url, method = 'GET') {
    try { const u = new URL(url, location.href); return method.toUpperCase() === 'GET' && u.origin === API &&
      u.pathname === '/x/polymer/web-dynamic/v1/feed/space' && u.searchParams.get('host_mid') === account(); } catch { return false; }
  }
  function deferRead(action, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => { deferredReads.delete(release); reject(new DOMException('Read aborted', 'AbortError')); };
      const release = () => { signal?.removeEventListener('abort', abort); deferredReads.delete(release); Promise.resolve().then(action).then(resolve, reject); };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, {once: true}); deferredReads.add(release);
    });
  }
  const originalFetch = page.fetch;
  page.fetch = function(input, init) {
    const request = input instanceof page.Request, args = arguments;
    if (dynamicBatch && allowed() && spaceRead(request ? input.url : String(input), init?.method || (request ? input.method : 'GET')))
      return deferRead(() => originalFetch.apply(this, args), init?.signal || (request ? input.signal : undefined));
    return originalFetch.apply(this, args);
  };
  const xhr = page.XMLHttpRequest.prototype, open = xhr.open, send = xhr.send, reads = new WeakMap();
  xhr.open = function(method, url) {
    reads.get(this)?.cancel?.();
    if (spaceRead(url, method)) reads.set(this, {}); else reads.delete(this);
    return open.apply(this, arguments);
  };
  xhr.send = function() {
    const request = reads.get(this);
    if (dynamicBatch && allowed() && request) {
      const args = arguments;
      const cleanup = () => { deferredReads.delete(release); this.removeEventListener('abort', cleanup); delete request.cancel; };
      const release = () => { cleanup(); if (reads.get(this) === request && this.readyState === 1) send.apply(this, args); };
      request.cancel = cleanup; this.addEventListener('abort', cleanup, {once: true});
      deferredReads.add(release); return;
    }
    return send.apply(this, arguments);
  };
  async function readPage() {
    if (readRequest) return readRequest;
    if (pageEnded || !dynamicBatch || !allowed() || mode() !== 'dynamic') return;
    const mid = account(), offset = readOffset;
    readRequest = (async () => {
      await checkAccount(mid);
      const data = await api('/x/polymer/web-dynamic/v1/feed/space?features=itemOpusStyle&host_mid=' + mid + '&offset=' + encodeURIComponent(offset));
      needAccount(mid);
      if (!dynamicBatch) return;
      const parsed = feedPage(data, mid, offset, seenOffsets);
      if (!parsed.ended && parsed.items.every(item => feedItems.has(item.id_str))) throw Error('分页没有新增动态，已停止；未认定已到末尾');
      // Commit cursor and data together only after validation.
      seenOffsets.add(offset);
      for (const item of parsed.items) feedItems.set(item.id_str, item);
      readOffset = parsed.next; pageEnded = parsed.ended; feedVersion++;
      dynamicChecks();
    })().finally(() => { readRequest = null; });
    return readRequest;
  }
  function relationSelection() {
    const result = new Map();
    for (const card of document.querySelectorAll('.relation-card')) {
      if (!card.querySelector('input[type=checkbox]')?.checked) continue;
      const link = card.querySelector('.relation-card-info__uname');
      let fid; try { const u = new URL(link.href, location.href); if (u.hostname === 'space.bilibili.com') fid = u.pathname.split('/')[1]; } catch {}
      const avatarId = card.querySelector('.relation-card-avatar')?.getAttribute('data-user-profile-id');
      if (!validId(fid) || (avatarId && avatarId !== fid)) throw Error('所选UP主身份冲突，未执行');
      result.set(fid, {id: fid, name: link.textContent.trim() || 'UID ' + fid});
    }
    return [...result.values()];
  }
  function restorePages() {
    stopHistory = true; viewHost?.remove(); viewHost = null; renderedKey = '';
    topPager?.remove(); bottomPager?.remove(); topPager = bottomPager = null;
    document.querySelectorAll('.bbm-native-hidden').forEach(list => list.classList.remove('bbm-native-hidden'));
    for (const release of [...deferredReads]) release();
  }
  function mediaURL(value) {
    try { const url = new URL(value); if (['http:', 'https:'].includes(url.protocol) && url.hostname.endsWith('.hdslb.com')) { url.protocol = 'https:'; return url.href; } } catch {}
    return null;
  }
  function profileLink(author, parent) {
    const id = String(author?.mid || '');
    const name = validId(id) ? el('a', author.name || 'UID ' + id, parent) : el('span', author?.name || '作者信息未提供', parent);
    if (validId(id)) { name.href = 'https://space.bilibili.com/' + id; name.target = '_blank'; name.rel = 'noopener noreferrer'; }
    return name;
  }
  function postContent(item, parent) {
    const text = originalText(item);
    if (text) {
      const block = el('div', text, parent); block.className = 'bbm-post-text';
      if (text.length > 350) {
        block.classList.add('bbm-folded');
        const toggle = button('展开全文', parent, () => {
          const folded = block.classList.toggle('bbm-folded'); toggle.textContent = folded ? '展开全文' : '收起';
        }); toggle.classList.add('bbm-text-toggle');
      }
    } else el('p', '原文未提供，可打开动态查看', parent);
    const major = item?.modules?.module_dynamic?.major;
    const pictures = major?.opus?.pics || major?.draw?.items || [];
    const sources = pictures.slice(0, 9).map(pic => mediaURL(pic.url || pic.src)).filter(Boolean);
    if (sources.length) {
      const grid = el('div', '', parent); grid.className = 'bbm-pictures' + (sources.length === 1 ? ' bbm-single-picture' : '');
      for (const source of sources) { const img = el('img', '', grid); img.src = source; img.alt = '动态图片'; img.loading = 'lazy'; }
    }
    if (validId(item?.id_str)) {
      const link = el('a', '查看动态', parent); link.href = 'https://t.bilibili.com/' + item.id_str; link.target = '_blank'; link.rel = 'noopener noreferrer';
    }
  }
  function renderCard(item, parent) {
    const card = el('article', '', parent); card.className = 'bbm-dynamic-card'; card.dataset.dynamicId = item.id_str;
    const author = item.modules.module_author, header = el('header', '', card); header.className = 'bbm-post-header';
    const face = mediaURL(author.face);
    if (face) { const img = el('img', '', header); img.src = face; img.alt = ''; img.className = 'bbm-avatar'; img.loading = 'lazy'; }
    const info = el('div', '', header); profileLink(author, info);
    const ts = publishedTime(item);
    const published = ts ? publishedFormat.format(ts) : '发布时间未知';
    el('small', published, info);
    const forward = ownForward(item, account());
    if (forward) {
      const label = el('label', '', card); label.dataset.bbm = 'check'; label.dataset.id = item.id_str; label.className = 'bbm-check';
      const input = el('input', '', label); input.type = 'checkbox'; input.setAttribute('aria-label', '选择这条转发'); input.checked = selected.has(item.id_str);
      input.onchange = () => { if (input.checked) selected.set(item.id_str, item); else selected.delete(item.id_str); updateCount(); };
      el('span', '选择转发', label);
    }
    const body = el('div', '', card); body.className = 'bbm-post-body';
    if (forward) {
      if (desc(item)) { const text = el('div', desc(item), body); text.className = 'bbm-post-text'; }
      if (item.orig) { const original = el('div', '', body); original.className = 'bbm-original'; profileLink(item.orig.modules?.module_author, original); postContent(item.orig, original); }
      else el('p', '原动态不可见；可打开自己的转发核对', body);
      const link = el('a', '打开我的转发', body); link.href = 'https://t.bilibili.com/' + item.id_str; link.target = '_blank'; link.rel = 'noopener noreferrer';
    } else { el('small', '原创动态，不参与批量删除', body); postContent(item, body); }
  }
  function sortedFeed() {
    if (orderedFeed?.version === feedVersion && orderedFeed.order === timeOrder) return orderedFeed.rows;
    const rows = [...feedItems.values()];
    if (timeOrder !== 'native') rows.sort((a, b) => {
      const at = publishedTime(a), bt = publishedTime(b);
      if (!at || !bt) return at ? -1 : bt ? 1 : 0;
      return timeOrder === 'oldest' ? at - bt : bt - at;
    });
    orderedFeed = {version: feedVersion, order: timeOrder, rows};
    return rows;
  }
  function dynamicChecks() {
    if (!dynamicBatch || !allowed()) { restorePages(); return; }
    const native = document.querySelector('.bili-dyn-list'); if (!native) return;
    if (!native.classList.contains('bbm-native-hidden')) native.classList.add('bbm-native-hidden');
    if (!viewHost?.isConnected) { viewHost = el('section'); viewHost.dataset.bbm = 'list'; viewHost.className = 'bbm-managed-list'; native.before(viewHost); renderedKey = ''; }
    const rows = sortedFeed();
    const pages = Math.max(1, Math.ceil(rows.length / pageSize)); currentPage = Math.max(1, Math.min(currentPage, pages));
    const renderKey = [feedVersion, currentPage, pageSize, timeOrder].join(':');
    if (renderedKey !== renderKey) {
      viewHost.replaceChildren();
      for (const item of rows.slice((currentPage - 1) * pageSize, currentPage * pageSize)) renderCard(item, viewHost);
      if (!rows.length) el('p', loadingHistory ? '正在读取动态…' : pageEnded ? '没有接口可见动态' : '尚未读取动态', viewHost);
      renderedKey = renderKey;
    }
    updateCount();
    if (!topPager?.isConnected) { topPager = el('div'); topPager.dataset.bbm = 'pager'; topPager.className = 'bbm-pager'; viewHost.before(topPager); }
    if (!bottomPager?.isConnected) { bottomPager = el('div'); bottomPager.dataset.bbm = 'pager'; bottomPager.className = 'bbm-pager'; viewHost.after(bottomPager); }
    for (const host of [topPager, bottomPager]) {
      const pagerKey = [renderKey, rows.length, pageEnded, loadingHistory].join(':');
      if (host.dataset.renderKey === pagerKey) continue;
      host.dataset.renderKey = pagerKey; host.replaceChildren();
      const first = button('首页', host, () => { currentPage = 1; dynamicChecks(); }); first.disabled = loadingHistory || currentPage === 1;
      const prev = button('上一页', host, () => { currentPage--; dynamicChecks(); }); prev.disabled = first.disabled;
      el('span', '第 ' + currentPage + ' / ' + pages + ' 页 · 已读取 ' + rows.length + ' 条 · ' + (pageEnded ? '已到可见末尾' : '未读完'), host);
      const next = button('下一页', host, () => loadHistory(false)); next.disabled = loadingHistory || pageEnded && currentPage === pages;
      const last = button('末页', host, () => loadHistory(true)); last.disabled = loadingHistory || pageEnded && currentPage === pages;
      const size = el('select', '', host); size.setAttribute('aria-label', '每页条数'); size.disabled = loadingHistory;
      for (const count of [12, 24, 48]) { const option = el('option', count + ' 条/页', size); option.value = String(count); }
      size.value = String(pageSize); size.onchange = () => { pageSize = Number(size.value); currentPage = 1; void loadHistory(false, true).catch(error => say(error.message)); };
      const order = el('select', '', host); order.setAttribute('aria-label', '动态时间排序'); order.disabled = loadingHistory;
      for (const [value, name] of [['newest', '时间：新到旧'], ['oldest', '时间：旧到新'], ['native', '接口返回顺序']]) { const option = el('option', name, order); option.value = value; }
      order.value = timeOrder; order.onchange = () => { timeOrder = order.value; currentPage = 1; dynamicChecks(); };
      if (loadingHistory) button('停止加载', host, () => { stopHistory = true; });
    }
  }
  async function loadHistory(toEnd, initial = false) {
    if (halted) throw Error('请求已暂停，请处理后刷新页面');
    if (loadingHistory || running) throw Error('请等待当前操作结束');
    if (!dynamicBatch || !allowed()) return;
    const mid = account(), requestedPage = initial ? currentPage : currentPage + 1;
    loadingHistory = true; stopHistory = false; dynamicChecks();
    try {
      while (!pageEnded && !stopHistory && dynamicBatch && (toEnd || feedItems.size < requestedPage * pageSize)) {
        needAccount(mid); say(toEnd ? '正在按游标读取历史，可停止…' : '正在读取下一页…');
        await readPage();
        if (!pageEnded && !stopHistory && (toEnd || feedItems.size < requestedPage * pageSize)) await new Promise(resolve => setTimeout(resolve, 1200));
      }
      currentPage = toEnd ? Math.max(1, Math.ceil(feedItems.size / pageSize)) : requestedPage;
      say(stopHistory ? '已停止，保留已读取动态' : pageEnded ? '已到接口可见末尾' : '已读取 ' + feedItems.size + ' 条；排序范围为已读取动态');
    } catch (error) { say(error.message); }
    finally { loadingHistory = false; if (dynamicBatch && allowed()) dynamicChecks(); }
  }
  function updateCount() {
    const node = toolbar?.querySelector('[data-bbm-count]'), text = '已选 ' + selected.size + ' 条转发';
    if (node && node.textContent !== text) node.textContent = text;
    for (const input of viewHost?.querySelectorAll('[data-bbm="check"] input') || []) {
      const checked = selected.has(input.parentElement.dataset.id);
      if (input.checked !== checked) input.checked = checked;
    }
  }
  async function groups() {
    const data = await api('/x/relation/tags');
    if (!Array.isArray(data) || data.some(g => !/^(?:-\d+|\d+)$/.test(String(g.tagid)) || typeof g.name !== 'string')) throw Error('分组列表无法核实');
    return [{id: '0', name: '默认分组'}, ...data.filter(g => g.tagid > 0).map(g => ({id: String(g.tagid), name: g.name}))];
  }
  function closeDialog() { dialog?.remove(); dialog = null; }
  async function preview(action, resume = false) {
    if (!allowed() || running) throw Error('请在自己的页面等待当前任务完成');
    loadState();
    if (state.tasks.some(t => t.status === 'pending' || t.status === 'uncertain') && !resume) throw Error('请先处理未完成任务，或放弃剩余任务');
    const mid = account();
    const list = resume ? state.tasks.filter(t => t.status === 'pending' || t.status === 'uncertain') : action === 'delete' ?
      [...selected.values()].map(item => ({id: item.id_str, name: originalText(item.orig).slice(0, 80) || '转发动态', evidence: item})) : relationSelection();
    if (!list.length) throw Error('请先勾选项目');
    closeDialog();
    const veil = el('div', '', document.documentElement); dialog = veil; veil.dataset.bbm = 'dialog'; veil.className = 'bbm-veil';
    const box = el('section', '', veil); box.className = 'bbm-dialog'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', '确认批量操作');
    el('h3', (resume ? '继续未完成任务' : labels[action]) + ' · ' + list.length + ' 项', box);
    el('p', resume ? '已提交但未确认的项目只核实，不重复提交。待执行项将在确认后继续。' : action === 'delete' ?
      '将从B站删除以下转发。未核实到恢复入口，请按不可恢复操作处理。本地文字备份不能恢复原动态。' :
      action === 'move' ? '将所选UP主的普通分组改为目标组，保留特别关注；不同于复制。' : '将取消以下UP主的关注，本地保留执行前的分组记录。', box);
    const rows = el('div', '', box); rows.className = 'bbm-preview';
    for (const item of list) el('div', (resume ? labels[item.action] + ' · ' : '') + item.name + ' · ' + item.id, rows);
    const actions = el('div', '', box); actions.className = 'bbm-actions';
    const cancel = button('取消', actions, closeDialog);
    let select;
    if (!resume && action === 'move') {
      select = el('select', '', box); box.insertBefore(select, actions); select.setAttribute('aria-label', '目标分组');
      const loading = el('option', '正在读取分组…', select); loading.value = ''; select.disabled = true;
    }
    const confirm = button(resume ? '确认继续' : '确认执行', actions, async () => {
      if (dialog !== veil) return;
      needAccount(mid);
      if (select && (!select.value || select.disabled)) throw Error('请选择有效分组');
      if (!resume) {
        const at = stamp();
        if (!navigator.locks?.request) throw Error('浏览器不支持任务互斥，已禁用批量写入');
        await navigator.locks.request('bili-batch:' + mid, {ifAvailable: true}, lock => {
          if (!lock) throw Error('另一个页面正在执行，请稍后再试');
          needAccount(mid);
          const latest = GM_getValue(key + mid, null);
          if (latest?.version === 1 && latest.mid === mid && Array.isArray(latest.tasks)) state = latest;
          if (state.tasks.some(t => ['pending', 'running', 'uncertain'].includes(t.status))) throw Error('另一个页面有未完成任务，请刷新后处理');
          state.tasks.push(...list.map(item => ({action, id: item.id, name: item.name, mid, target: select?.value,
            status: 'pending', createdAt: at, ...(item.evidence ? {evidence: item.evidence} : {})})));
          persist();
        });
      }
      closeDialog(); renderLog(); await run();
    }, action !== 'move');
    if (select) {
      confirm.disabled = true;
      try {
        await checkAccount(mid); const options = await groups(); needAccount(mid);
        if (dialog !== veil) return;
        select.replaceChildren();
        const hint = el('option', '请选择目标分组', select); hint.value = '';
        for (const group of options) { const opt = el('option', group.name, select); opt.value = group.id; }
        select.disabled = false; confirm.disabled = false;
      } catch (error) { if (dialog === veil) el('p', error.message, box); }
    }
    cancel.focus();
  }
  async function detail(id) {
    const data = await api('/x/polymer/web-dynamic/v1/detail?id=' + id);
    if (data?.item?.id_str !== id) throw Error('动态身份无法核实');
    return data.item;
  }
  function targetGroups(task) { return movedGroups(task.before, task.target); }
  async function verify(task) {
    if (task.action === 'delete') {
      // Generic read errors, hidden/deleted-looking items and empty lists are not deletion proof.
      // The removal API acknowledgement is retained separately; native list refresh is needed.
      throw Error('删除请求结果待人工核实：请刷新原页面查看；不会自动重发');
    }
    if (task.action === 'unfollow') return !relationState(await api('/x/relation?fid=' + task.id), task.id);
    const actual = membership(await api('/x/relation/tag/user?fid=' + task.id));
    return Array.isArray(task.before) && JSON.stringify(actual) === JSON.stringify(targetGroups(task));
  }
  async function execute(task) {
    const mid = task.mid;
    if (!validId(task.id) || !validId(mid) || !['delete', 'move', 'unfollow'].includes(task.action)) throw Error('任务记录无效，禁止提交');
    await checkAccount(mid);
    if (task.status === 'uncertain') {
      const confirmed = await verify(task); needAccount(mid);
      if (!confirmed) throw Error('结果仍未核实，不自动重发；核对后放弃此任务再重新勾选');
      task.status = 'done'; task.reason = ''; task.finishedAt = stamp(); persist(); return;
    }
    if (task.action === 'delete') {
      const item = await detail(task.id); needAccount(mid);
      if (!ownForward(item, mid, task.id)) throw Error('不是自己的转发，禁止删除');
      task.evidence = item;
    } else {
      const following = relationState(await api('/x/relation?fid=' + task.id), task.id); needAccount(mid);
      if (!following) {
        if (task.action === 'move') throw Error('当前未关注此UP主，未修改分组');
        task.status = 'done'; task.reason = '执行前已确认未关注，无需重复取关'; task.finishedAt = stamp(); persist(); return;
      }
      task.before = membership(await api('/x/relation/tag/user?fid=' + task.id)); needAccount(mid);
      if (task.action === 'move') {
        const options = await groups(); needAccount(mid);
        if (!options.some(g => g.id === task.target)) throw Error('目标分组已不存在');
        if (JSON.stringify(task.before) === JSON.stringify(targetGroups(task))) {
          task.status = 'done'; task.reason = '已在目标分组，无需重复提交'; task.finishedAt = stamp(); persist(); return;
        }
      }
    }
    needAccount(mid);
    task.status = 'running'; task.startedAt = stamp(); persist(); // Durable evidence before irreversible writes.
    if (task.action === 'delete') {
      await api('/x/dynamic/feed/operate/remove?platform=web', {dyn_id_str: task.id}, true);
      task.status = 'uncertain'; task.reason = 'B站已接受删除请求；请刷新原列表核实，不自动重复删除';
      task.acceptedAt = stamp(); selected.delete(task.id);
    } else {
      if (task.action === 'unfollow') await api('/x/relation/modify', {fid: task.id, act: '2', re_src: '11'});
      else await api('/x/relation/tags/addUsers', {fids: task.id, tagids: targetGroups(task).join(',') || '0'});
      let confirmed = false;
      for (let i = 0; i < 3; i++) {
        if (i) await new Promise(resolve => setTimeout(resolve, i * 500));
        needAccount(mid); confirmed = await verify(task); needAccount(mid); if (confirmed) break;
      }
      if (!confirmed) throw Error('写入已提交，但结果尚未核实；不会自动重发');
      task.status = 'done'; task.reason = ''; task.finishedAt = stamp();
    }
    needAccount(mid); persist();
  }
  async function run() {
    if (running) return;
    if (!navigator.locks?.request) throw Error('浏览器不支持任务互斥，已禁用批量写入');
    const mid = account(); running = true; paused = false;
    try {
      await navigator.locks.request('bili-batch:' + mid, {ifAvailable: true}, async lock => {
        if (!lock) throw Error('另一个页面正在执行，请稍后再试');
        const snapshot = GM_getValue(key + mid, null);
        if (!snapshot || snapshot.mid !== mid) throw Error('任务存储不可用');
        state = snapshot;
        for (const task of state.tasks) if (task.status === 'running') task.status = 'uncertain';
        for (const task of state.tasks) {
          if (paused || halted) break;
          if (!['pending', 'uncertain'].includes(task.status)) continue;
          try { await execute(task); }
          catch (error) {
            task.status = task.status === 'running' || task.status === 'uncertain' ? 'uncertain' : 'failed';
            task.reason = error.message; persist(); paused = true;
          }
          renderLog(); updateCount();
          if (!paused && !halted) await new Promise(resolve => setTimeout(resolve, 1200));
        }
      });
      say(paused || halted ? '已暂停，请查看操作记录' : '本批处理结束，请刷新列表');
    } finally { running = false; renderLog(); }
  }
  async function abandon() {
    if (running) throw Error('请先暂停并等待当前项目结束');
    if (!confirm('放弃剩余任务？已发生的取关、移动或删除不会撤销，记录仍保留。')) return;
    if (!navigator.locks?.request) throw Error('浏览器不支持任务互斥');
    await navigator.locks.request('bili-batch:' + account(), {ifAvailable: true}, lock => {
      if (!lock) throw Error('另一个页面正在执行，不能放弃');
      needAccount(stateMid);
      state = GM_getValue(key + stateMid, state);
      for (const task of state.tasks) if (['pending', 'running', 'uncertain', 'failed'].includes(task.status)) task.status = 'abandoned';
      persist(); renderLog(); say('已放弃剩余任务，记录已保留');
    });
  }
  function syncButtonStyle(parent) {
    const reference = parent.querySelector('button:not(.bbm-button)');
    if (!reference) return;
    const native = getComputedStyle(reference);
    for (const node of [toolbar, feedback]) for (const [key, value] of [
      ['--bbm-button-bg', native.backgroundColor], ['--bbm-button-border', native.borderColor], ['--bbm-button-font', native.font]
    ]) if (node.style.getPropertyValue(key) !== value) node.style.setProperty(key, value);
  }
  function attach() {
    scheduled = false;
    if (!allowed()) { restorePages(); toolbar?.remove(); feedback?.remove(); toolbar = null; closeDialog(); return; }
    loadState();
    const currentMode = mode(), parent = currentMode === 'follow' ? document.querySelector('.relation-content-header__right') : document.querySelector('.bili-dyn-list');
    if (!parent) return;
    const batch = currentMode === 'follow' && !!document.querySelector('.relation-card input[type=checkbox]');
    if (currentMode === 'follow' && !batch) { toolbar?.remove(); feedback?.remove(); toolbar = null; return; }
    if (toolbar?.isConnected && toolbar.dataset.mode === currentMode && toolbar.dataset.batch === String(batch)) {
      if (currentMode === 'follow') syncButtonStyle(parent);
      if (currentMode === 'dynamic' && dynamicBatch) dynamicChecks(); return;
    }
    toolbar?.remove(); feedback?.remove(); toolbar = el('div'); toolbar.dataset.bbm = 'toolbar'; toolbar.dataset.mode = currentMode; toolbar.dataset.batch = String(batch); toolbar.className = 'bbm-toolbar';
    feedback = el('div'); feedback.dataset.bbm = 'feedback'; feedback.className = 'bbm-feedback';
    if (currentMode === 'follow') {
      const header = parent.closest('.relation-content-header') || parent;
      parent.append(toolbar); header.after(feedback);
      syncButtonStyle(parent);
    } else {
      const start = topPager?.isConnected ? topPager : viewHost?.isConnected ? viewHost : parent;
      start.before(toolbar); toolbar.after(feedback);
    }
    const controls = el('div', '', toolbar); controls.className = 'bbm-actions';
    if (currentMode === 'follow' && batch) {
      button('移动至', controls, () => preview('move'));
      button('取消关注', controls, () => preview('unfollow'), true);
    } else if (currentMode === 'dynamic') {
      button(dynamicBatch ? '退出批量管理' : '批量管理转发', controls, async () => {
        dynamicBatch = !dynamicBatch;
        if (!dynamicBatch) { selected.clear(); restorePages(); }
        toolbar.remove(); schedule();
        if (dynamicBatch) await loadHistory(false, true);
      });
      if (dynamicBatch) {
        button('全选可选', controls, () => {
          const mid = account();
          for (const input of viewHost?.querySelectorAll('[data-bbm="check"] input:not(:disabled)') || []) {
            const item = feedItems.get(input.parentElement.dataset.id);
            if (ownForward(item, mid)) selected.set(item.id_str, item);
          }
          updateCount();
        });
        button('清空选择', controls, () => { selected.clear(); updateCount(); });
        button('删除所选转发', controls, () => preview('delete'), true);
        el('span', '', controls).setAttribute('data-bbm-count', ''); updateCount();
      }
    }
    const history = el('div', '', feedback); history.className = 'bbm-history'; history.hidden = true;
    const historyButton = button('操作记录', toolbar, () => {
      history.hidden = !history.hidden; historyButton.setAttribute('aria-expanded', String(!history.hidden));
      if (history.hidden) { log.replaceChildren(); logDirty = true; } else flushLog();
    });
    historyButton.setAttribute('aria-expanded', 'false');
    const historyActions = el('div', '', history); historyActions.className = 'bbm-actions';
    button('继续未完成任务', historyActions, () => preview(null, true));
    button('暂停', historyActions, () => { paused = true; say('正在暂停；当前请求结束后停止'); });
    button('放弃剩余任务', historyActions, abandon);
    button('导出记录与文字备份', historyActions, exportLog);
    log = el('div', '', history); log.className = 'bbm-log';
    status = el('span', lastMessage, feedback); status.setAttribute('role', 'status'); status.className = 'bbm-status';
    renderLog(); if (currentMode === 'dynamic') dynamicChecks();
  }
  function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(attach); } }
  function start() {
    const style = el('style', '', document.documentElement); style.dataset.bbm = 'style';
    style.textContent = `
      [data-bbm]{--bbm-blue:var(--brand_blue,#00aeec);--bbm-bg:var(--bg1,#fff);--bbm-text:var(--text1,#18191c);--bbm-muted:var(--text2,#9499a0);--bbm-line:var(--line_regular,#e3e5e7);font-family:inherit;font-size:14px;line-height:1.4;color:var(--bbm-text);box-sizing:border-box}
      .bbm-toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.bbm-toolbar[data-mode=dynamic]{padding:0 0 12px;margin-bottom:12px;border-bottom:1px solid var(--bbm-line)}.relation-content-header:has(.bbm-toolbar){flex-wrap:wrap;gap:12px}.relation-content-header__right:has(.bbm-toolbar){align-items:center;flex-wrap:wrap}
      .bbm-actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.bbm-toolbar[data-mode=follow],.bbm-toolbar[data-mode=follow]>.bbm-actions{gap:24px}.bbm-button{box-sizing:border-box!important;font:var(--bbm-button-font,inherit)!important;width:auto!important;min-width:80px!important;height:34px!important;padding:0 12px!important;border:1px solid var(--bbm-button-border,var(--bbm-line))!important;border-radius:8px!important;background:var(--bbm-button-bg,var(--graph_bg_regular,#f1f2f3))!important;color:var(--bbm-text)!important;cursor:pointer;white-space:nowrap;display:inline-flex!important;align-items:center!important;justify-content:center!important}.bbm-toolbar[data-mode=follow] .bbm-button{min-width:100px!important}.bbm-button:hover{color:var(--bbm-blue)!important;border-color:var(--bbm-blue)!important}.bbm-button:disabled{opacity:.5;cursor:default}.bbm-button.bbm-danger{color:var(--stress_red,#f25d8e)!important}
      .bbm-history[hidden]{display:none!important}.bbm-history{padding:12px 0;border-bottom:1px solid var(--bbm-line);margin-bottom:12px}.bbm-log{max-height:240px;overflow:auto;margin:8px 0}.bbm-log-row{padding:6px 0;border-bottom:1px solid var(--bbm-line)}.bbm-log-row small{display:block;color:var(--bbm-muted)}.bbm-status{display:block;font-size:12px;color:var(--bbm-muted);margin:8px 0 12px;overflow-wrap:anywhere}.bbm-status:empty{display:none}
      .bili-dyn-list.bbm-native-hidden{display:none!important}.bbm-pager{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:12px 0;padding:8px 0}.bbm-pager .bbm-button{min-width:64px!important}.bbm-pager>span{color:var(--bbm-muted);font-size:13px}.bbm-pager select{box-sizing:border-box;font:inherit;height:34px;max-width:100%;padding:0 8px;color:var(--bbm-text);background:var(--bbm-bg);border:1px solid var(--bbm-line);border-radius:8px}
      .bbm-managed-list{min-width:0}.bbm-dynamic-card{padding:20px;margin-bottom:12px;border:1px solid var(--bbm-line);border-radius:6px;background:var(--bbm-bg);overflow-wrap:anywhere}.bbm-post-header{display:flex;align-items:center;gap:12px;margin-bottom:12px}.bbm-avatar{width:48px;height:48px;object-fit:cover;border-radius:50%}.bbm-post-header small{display:block;font-size:12px;color:var(--bbm-muted);margin-top:4px}.bbm-managed-list a{color:var(--bbm-blue);text-decoration:none}.bbm-managed-list a:hover{text-decoration:underline}.bbm-post-text{white-space:pre-wrap;line-height:1.8;margin:8px 0}.bbm-post-text.bbm-folded{display:-webkit-box;-webkit-line-clamp:8;-webkit-box-orient:vertical;overflow:hidden}.bbm-original{padding:16px;margin:12px 0;border-radius:6px;background:var(--bg2,#f6f7f8)}.bbm-pictures{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;max-width:600px;margin:12px 0}.bbm-pictures img{width:100%;height:160px;object-fit:cover;border-radius:4px}.bbm-pictures.bbm-single-picture{display:block;max-width:320px}.bbm-single-picture img{width:auto;max-width:100%;height:auto;max-height:420px;object-fit:contain}.bbm-text-toggle{min-width:0!important;height:26px!important;padding:0 6px!important;font-size:12px!important}
      .bbm-check{position:relative!important;display:flex!important;align-items:center;gap:8px;width:fit-content;min-height:20px;margin:8px 0 12px!important;cursor:pointer;color:var(--bbm-muted);font-size:13px;line-height:20px;isolation:isolate}.bbm-check input{appearance:none!important;position:relative!important;display:inline-grid!important;place-content:center;flex:0 0 16px;box-sizing:border-box!important;width:16px!important;height:16px!important;margin:0!important;padding:0!important;opacity:1!important;border:1px solid var(--bbm-muted)!important;border-radius:4px!important;background:var(--bbm-bg)!important;cursor:inherit}.bbm-check input:checked{border-color:var(--bbm-blue)!important;background:var(--bbm-blue)!important}.bbm-check input:checked::after{content:'';width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;transform:translateY(-1px) rotate(45deg)}.bbm-check input:disabled{cursor:not-allowed;border-style:dashed!important}.bbm-check input:focus-visible{outline:2px solid var(--bbm-blue);outline-offset:2px}
      .bbm-veil{position:fixed;inset:0;z-index:2147483647;background:#0006;display:grid;place-items:center;padding:16px}.bbm-dialog{width:min(460px,100%);max-height:85vh;overflow:auto;padding:24px;border-radius:10px;background:var(--bbm-bg);box-shadow:0 8px 32px #0003}.bbm-dialog h3{font-size:18px;margin:0 0 12px}.bbm-dialog p{color:var(--bbm-muted)}.bbm-preview{max-height:220px;overflow:auto;padding:8px 0;margin-bottom:12px}.bbm-preview>div{padding:6px 0;overflow-wrap:anywhere}.bbm-dialog select{width:100%;box-sizing:border-box;background:var(--bbm-bg);color:var(--bbm-text);border:1px solid var(--bbm-line);border-radius:6px;padding:8px;margin-top:12px}
      @media(prefers-color-scheme:dark){[data-bbm]{--bbm-bg:var(--bg1,#18191c);--bbm-text:var(--text1,#e3e5e7);--bbm-line:var(--line_regular,#36383b);--bbm-button-bg:var(--graph_bg_regular,#242628)}}`;
    new MutationObserver(records => {
      if (records.some(r => !own(r.target) && [...r.addedNodes, ...r.removedNodes].some(n => n instanceof Element && !own(n) &&
        (r.target instanceof Element && r.target.closest('.relation-content,.bili-dyn-list') ||
          n.matches('.relation-content,.bili-dyn-list') || n.querySelector('.relation-content,.bili-dyn-list'))))) schedule();
    }).observe(document.documentElement, {childList: true, subtree: true});
    const themeObserver = new MutationObserver(schedule);
    for (const node of [document.documentElement, document.body]) if (node)
      themeObserver.observe(node, {attributes: true, attributeFilter: ['class', 'style', 'data-theme']});
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', schedule);
    window.addEventListener('popstate', schedule);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDialog(); });
    schedule();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true}); else start();
})();
