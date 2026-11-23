// ==UserScript==
// @name         B站关注分组助手
// @namespace    local.bili.follow-groups
// @version      0.3.10
// @description  自己点击关注成功后选择B站分组；可为后续关注设置默认分组
// @match        https://www.bilibili.com/*
// @match        https://space.bilibili.com/*
// @match        https://t.bilibili.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      api.bilibili.com
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  const page = unsafeWindow;
  const queue = [];
  const queued = new Set();
  let intent = null, showing = false, halted = false;
  let activeMenu = null;
  let repositionFloating = () => {};
  const apiRoot = 'https://api.bilibili.com';
  const vueFollow = '.bili-user-profile-view__info__button.follow';
  const inlineFollow = '.dyn-orig-author__following';
  const followControls = '.space-follow-btn,button,' + vueFollow + ',' + inlineFollow;
  const inlineBindings = new WeakMap(), inlineAttempts = new WeakMap();
  const uid = value => /^[1-9]\d*$/.test(String(value)) ? String(value) : null;
  const groupId = value => /^(?:0|-10|[1-9]\d*)$/.test(String(value));
  const cookie = name => document.cookie.split('; ').find(s => s.startsWith(name + '='))?.slice(name.length + 1) || '';
  const account = () => uid(cookie('DedeUserID'));
  const prefKey = mid => 'follow-groups:default:' + mid;
  const fail = message => { halted = true; throw new Error(message); };

  function api(path, data) {
    if (halted) return Promise.reject(new Error('请求已暂停，请刷新页面后再试'));
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: data ? 'POST' : 'GET', url: apiRoot + path + (data ? '' : (path.includes('?') ? '&' : '?') + '_t=' + Date.now() + '-' + (++readSequence)),
        nocache: !data,
        ...(data ? { headers: {'Content-Type': 'application/x-www-form-urlencoded'}, data: new URLSearchParams(data).toString() } : {}),
        timeout: 20000,
        onload(r) {
          try {
            if (r.status !== 200) fail('接口异常（HTTP ' + r.status + '），已暂停');
            const json = JSON.parse(r.responseText);
            if (json.code !== 0) fail('B站接口返回 ' + json.code + '，请检查登录或限制，已暂停');
            resolve(json.data);
          } catch (e) { halted = true; reject(e); }
        },
        onerror() { halted = true; reject(new Error('网络读取失败，已暂停')); },
        ontimeout() { halted = true; reject(new Error('网络超时，已暂停')); }
      });
    });
  }
  let readSequence = 0;

  let accountRequest = null;
  async function checkAccount(mid) {
    if (account() !== mid) throw new Error('账号已切换，请刷新页面');
    if (accountRequest?.mid !== mid) {
      const request = {mid};
      request.promise = api('/x/web-interface/nav').finally(() => {
        if (accountRequest === request) accountRequest = null;
      });
      accountRequest = request;
    }
    const nav = await accountRequest.promise;
    if (account() !== mid) throw new Error('账号已切换，请刷新页面');
    if (!nav?.isLogin || String(nav.mid) !== mid) fail('登录状态变化，已暂停');
  }

  function parseGroups(data) {
    if (!Array.isArray(data) || data.some(g => !groupId(g.tagid) || typeof g.name !== 'string'))
      throw new Error('分组列表格式变化，未修改任何分组');
    return data.filter(g => Number(g.tagid) > 0).map(g => ({id: String(g.tagid), name: g.name}));
  }

  let groupCache = null, groupRequest = null;
  async function loadGroups(mid){
    if(account()!==mid)throw new Error('账号已切换，请刷新页面');
    if(halted)throw new Error('请求已暂停，请刷新页面后再试');
    if(groupCache?.mid===mid && Date.now()-groupCache.at<60000)return groupCache.groups;
    if(groupRequest?.mid===mid)return groupRequest.promise;
    const request={mid};
    request.promise=(async()=>{
      await checkAccount(mid);
      const groups=parseGroups(await api('/x/relation/tags'));
      if(account()!==mid)throw new Error('账号已切换，请刷新页面');
      groupCache={mid,at:Date.now(),groups};
      return groups;
    })().finally(()=>{if(groupRequest===request)groupRequest=null;});
    groupRequest=request;
    return request.promise;
  }

  function parseMembership(data) {
    if (!data || Array.isArray(data) || typeof data !== 'object' || Object.entries(data).some(([id, name]) => !groupId(id) || typeof name !== 'string'))
      throw new Error('当前分组读取不完整，已停止保存');
    return Object.keys(data).filter(id => id !== '0');
  }

  let writeTail=Promise.resolve();
  function serialWrite(action){
    const result=writeTail.then(action);
    writeTail=result.catch(()=>{});
    return result;
  }
  function addGroup(job,selected){return serialWrite(()=>applyGroup(job,selected));}
  async function applyGroup(job, selected) {
    if (!job.groups.some(g => g.id === selected)) throw new Error('请选择有效分组');
    await checkAccount(job.mid);
    const relation = await api('/x/relation?fid=' + job.fid);
    if (String(relation?.mid) !== job.fid || ![2, 6].includes(relation.attribute))
      throw new Error('未确认仍在关注此UP主，没有修改分组');
    const current = parseMembership(await api('/x/relation/tag/user?fid=' + job.fid));
    if(account()!==job.mid)throw new Error('账号已切换，请刷新页面');
    if(current.includes(selected))return;
    const csrf = cookie('bili_jct');
    if (!csrf || account() !== job.mid) throw new Error('登录状态变化，请刷新页面');
    await api('/x/relation/tags/addUsers', {fids: job.fid, tagids: [...current, selected].join(','), csrf});
    // Only repeat reads, never repeat a write after an uncertain outcome.
    for(let attempt=0;attempt<3;attempt++){
      if(attempt)await new Promise(resolve=>setTimeout(resolve,attempt*500));
      if(account()!==job.mid)throw new Error('账号已切换，请刷新页面');
      const result = parseMembership(await api('/x/relation/tag/user?fid=' + job.fid));
      if(account()!==job.mid)throw new Error('账号已切换，请刷新页面');
      if([selected,...current].every(id=>result.includes(id)))return;
    }
    throw new Error('分组待核实：保存请求已接受，但未读到完整结果，请到原生分组窗口核实');
  }

  function element(tag, text, parent) {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    parent?.append(el);
    return el;
  }

  let notice, noticeTimer;
  function message(text,detail='') {
    notice?.remove();
    clearTimeout(noticeTimer);
    notice = element('div', text);
    notice.className = 'bfg-toast'; notice.setAttribute('role','status');
    notice.title=detail;
    document.documentElement.append(notice);
    const current = notice;
    noticeTimer=setTimeout(() => current.remove(), 8000);
  }

  function errorText(error){
    return /^(分组|关注)待核实/.test(error.message)?'待核实':halted?'请求已暂停':
      /账号|登录/.test(error.message)?'请检查账号':'读取失败';
  }
  function showError(state,error){
    state.hidden=false;state.title=error.message;state.textContent=errorText(error);
    state.classList.add('bfg-error');
  }
  function menuRows(list,groups,selected,onSelect){
    const items=element('div','',list);items.className='bfg-items';
    for(const group of groups){
      const button=element('button','',items);button.type='button';
      button.className='bfg-item';button.dataset.group=group.id;
      const active=selected.includes(group.id);
      button.classList.toggle('is-selected',active);button.setAttribute('aria-pressed',String(active));
      element('span',group.name,button);
      button.onclick=event=>{event.stopPropagation();void onSelect(group,items);};
    }
    return items;
  }

  async function drain() {
    if (showing || !document.documentElement) return;
    showing = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        try {
          job.groups = await loadGroups(job.mid);
          const saved = String(GM_getValue(prefKey(job.mid), '') || '');
          const group=job.groups.find(g=>g.id===saved);
          if (group) {
            await addGroup(job, saved);
            message('UID ' + job.fid + ' 已加入「' + group.name + '」');
          } else await dropdown(job);
        } catch (e) { message(errorText(e),e.message); }
        finally { queued.delete(job.mid + ':' + job.fid); }
        if (halted) { queue.length = 0; queued.clear(); break; }
      }
    } finally { showing = false; }
  }

  // Capture intent only: do not cancel, replace or synthesize the user's follow click.
  document.addEventListener('click', event => {
    if (!event.isTrusted) return;
    const target = event.composedPath().find(el => el instanceof Element &&
      (!el.childElementCount || el.matches('.space-follow-btn,button,[role="button"]') || (el.childElementCount<=2 && el.matches('[class*="follow"]'))) &&
      /^(?:\+\s*)?关注$/.test((el.textContent || '').replace(/[\uE000-\uF8FF]/g,'').trim()));
    if (target) intent = {at:Date.now(), anchor:target.closest(followControls) || target};
  }, true);

  function isFollowRequest(url,method){
    if(String(method).toUpperCase()!=='POST')return false;
    try{const endpoint=new URL(url,location.href);return endpoint.origin===apiRoot && endpoint.pathname==='/x/relation/modify';}
    catch{return false;}
  }
  function requestInfo(body) {
    try {
      const fields = typeof body === 'string' ? new URLSearchParams(body) : body;
      if (!fields?.get || fields.get('act') !== '1') return null;
      const fid = uid(fields.get('fid')), mid = account();
      if (!fid || !mid || !intent || Date.now() - intent.at > 5000) return null;
      const anchor = intent.anchor;
      intent = null;
      const surface = surfaceFor(anchor);
      if (surface && surface.fid !== fid) return null;
      return {fid, mid, anchor, inline:anchor.matches(inlineFollow)?inlineContext(anchor):null};
    } catch { return null; }
  }

  function completed(job, response) {
    if (!job || halted || account() !== job.mid || response?.code !== 0) return;
    if(job.inline){
      const current=inlineContext(job.anchor);
      if(!sameInline(job.inline,current))return;
      // The UID comes from the successful request, never from the page author/name.
      inlineBindings.set(job.anchor,{...current,fid:job.fid});
      pendingRoots.add(document);schedule();
    }
    const key = job.mid + ':' + job.fid;
    if (queued.has(key)) return;
    queued.add(key); queue.push(job); void drain();
  }

  const originalFetch = page.fetch;
  page.fetch = function(input, init) {
    const isRequest=input instanceof page.Request;
    const url=isRequest?input.url:String(input);
    if(!intent || Date.now()-intent.at>5000 || !isFollowRequest(url,init?.method || (isRequest?input.method:'GET')))
      return originalFetch.apply(this,arguments);
    let meta;
    try {
      meta = isRequest && init?.body===undefined
        ? input.clone().text().then(requestInfo).catch(() => null)
        : Promise.resolve(requestInfo(init?.body));
    } catch { meta = Promise.resolve(null); }
    const result = originalFetch.apply(this, arguments);
    result.then(response => {
      // Clone before the site's own handler consumes the response body.
      try {
        if(response.status!==200)return;
        const copy=response.clone();
        void meta.then(job=>{if(job)copy.json().then(json=>completed(job,json)).catch(()=>{});});
      } catch { return; }
    }, () => {});
    return result;
  };
  const xhr = page.XMLHttpRequest.prototype;
  const open = xhr.open, send = xhr.send;
  const requests = new WeakMap();
  xhr.open = function(method, url) { if(isFollowRequest(url,method))requests.set(this,true);else requests.delete(this);return open.apply(this,arguments); };
  xhr.send = function(body) {
    const job = requests.has(this) ? requestInfo(body) : null;
    if (job) this.addEventListener('load', () => {
      try { if (this.status === 200) completed(job, this.responseType === 'json' ? this.response : JSON.parse(this.responseText)); } catch { /* A changed response must not affect the page. */ }
    },{once:true});
    return send.apply(this,arguments);
  };

  async function settings() {
    if(activeMenu?.kind==='settings'){closeMenu();return;}
    if(activeMenu){closeMenu();await new Promise(resolve=>setTimeout(resolve,0));}
    if (showing) { message('请先关闭当前分组窗口'); return; }
    showing = true;
    try {
      const mid = account();
      if (!mid) throw new Error('请先登录B站');
      const host=document.querySelector('#bfg-floatwrap'),button=document.querySelector('#bfg-float');
      if(!host || !button)return;
      const list=element('div','',host);list.className='bfg-list';
      list.setAttribute('role','menu');list.setAttribute('aria-label','默认关注分组');
      host.classList.add('bfg-expanded');button.textContent='默认分组 ▴';button.setAttribute('aria-expanded','true');
      let done;const completion=new Promise(resolve=>{done=resolve;});
      const finish=()=>{list.remove();host.classList.remove('bfg-expanded');button.textContent='分组';button.setAttribute('aria-expanded','false');if(activeMenu?.list===list)activeMenu=null;done();};
      activeMenu={list,anchor:button,kind:'settings',finish};
      const state=element('p','加载中…',list);
      try{
      const groups=await loadGroups(mid);
      if(list.isConnected){
        state.hidden=true;
        const saved=String(GM_getValue(prefKey(mid),'')||'');
        menuRows(list,[{id:'',name:'每次询问'},...groups],[saved],async(group,items)=>{
          for(const b of items.querySelectorAll('button'))b.disabled=true;
          try{await checkAccount(mid);GM_setValue(prefKey(mid),group.id);finish();}
          catch(e){showError(state,e);}
        });
      }
      }catch(e){showError(state,e);}
      repositionFloating();
      await completion;
    } catch (e) { message(e.message); }
    finally { showing = false; void drain(); }
  }
  GM_registerMenuCommand('设置后续关注默认分组', settings);

  const uiCSS = `
    .bfg-list{font:13px/1.5 system-ui,sans-serif;color:var(--text1,#222);background:var(--bg1,#fff);border:1px solid var(--line_regular,#ddd);border-radius:6px;padding:4px;min-width:144px;width:168px;max-width:calc(100vw - 20px);box-sizing:border-box;box-shadow:0 4px 15px #0002;text-align:left;z-index:10020}
    .bfg-list.bfg-inline{border:0;border-top:1px solid var(--line_regular,#ddd);box-shadow:none;border-radius:0;margin-top:4px;min-width:140px}
    .menu-popover__panel.bfg-native-menu>.menu-popover__panel-item{box-sizing:border-box!important;display:flex!important;align-items:center!important;justify-content:center!important;height:32px!important;padding:0 12px!important;text-align:center!important;font:13px/1.5 system-ui!important}
    .menu-popover__panel.bfg-native-menu>.bfg-list.bfg-inline{width:auto;min-width:0;background:transparent;color:var(--bfg-native-text,var(--text2,#9499a0))}
    .menu-popover__panel.bfg-native-menu .bfg-list button.bfg-item{min-height:32px!important;justify-content:center!important;text-align:center!important}
    .bfg-list .bfg-items{max-height:220px;overflow:auto;scrollbar-width:thin}
    #action .bfg-list button.bfg-item,.bfg-list button.bfg-item{all:unset!important;display:flex!important;align-items:center!important;width:100%!important;min-width:0!important;height:auto!important;min-height:30px!important;padding:5px 8px!important;box-sizing:border-box!important;border:0!important;border-radius:4px!important;background:transparent!important;color:inherit!important;font:13px/1.5 system-ui!important;text-align:left!important;cursor:pointer!important;white-space:normal!important;overflow-wrap:anywhere!important}
    #action .bfg-list button.bfg-item:hover,.bfg-list button.bfg-item:hover{background:var(--graph_bg_thick,#f1f2f3)!important;color:var(--brand_blue,#00aeec)!important}
    #action .bfg-list button.bfg-item:disabled,.bfg-list button.bfg-item:disabled{opacity:.65!important;cursor:default!important}.bfg-list p{margin:4px 8px;font-weight:400;font-size:12px;overflow-wrap:anywhere}.bfg-list p[hidden]{display:none!important}.bfg-error{color:#ed616b}
    #action .bfg-list button.bfg-item.is-selected,.bfg-list button.bfg-item.is-selected{color:var(--brand_blue,#00aeec)!important;background:rgba(0,174,236,.12)!important;opacity:1!important}
    #action .bfg-follow-control{position:relative!important;display:inline-flex!important;flex:0 0 100px!important;width:100px!important;height:30px!important;gap:0!important}
    #action .bfg-follow-control>button#follow{width:76px!important;min-width:0!important;flex:1 1 76px!important;margin:0!important;border-radius:4px 0 0 4px!important}
    #action .bfg-follow-control>button.bfg-arrow{all:unset!important;display:flex!important;align-items:center!important;justify-content:center!important;box-sizing:border-box!important;flex:0 0 24px!important;width:24px!important;min-width:24px!important;height:30px!important;padding:0!important;margin:0!important;border:1px solid var(--line_regular,#aaa)!important;border-left:0!important;border-radius:0 4px 4px 0!important;background:var(--bg1,#fff)!important;color:var(--text1,#555)!important;cursor:pointer!important;font:12px system-ui!important}
    .bili-user-profile-view__info__footer .bfg-follow-control{position:relative!important;display:inline-flex!important;flex:0 0 102px!important;width:102px!important;height:32px!important;margin-right:8px;gap:0!important}
    .bili-user-profile-view__info__footer .bfg-follow-control>.bili-user-profile-view__info__button.follow{box-sizing:border-box!important;width:78px!important;min-width:0!important;flex:1 1 78px!important;height:32px!important;margin:0!important;border-radius:4px 0 0 4px!important}
    .bili-user-profile-view__info__footer .bfg-follow-control>button.bfg-arrow{all:unset!important;box-sizing:border-box!important;display:flex!important;align-items:center!important;justify-content:center!important;flex:0 0 24px!important;width:24px!important;height:32px!important;border:1px solid var(--line_regular,#777)!important;border-left:0!important;border-radius:0 4px 4px 0!important;color:var(--text1,#888)!important;background:var(--bg1,transparent)!important;cursor:pointer!important;font:12px system-ui!important}
    .dyn-orig-author__right .bfg-follow-control{position:relative;display:inline-flex;align-items:center;gap:4px}
    .dyn-orig-author__right .bfg-follow-control>button.bfg-arrow{all:unset;display:inline-flex;align-items:center;justify-content:center;width:20px;height:24px;color:var(--brand_blue,#00aeec);cursor:pointer;font:12px system-ui}
    .bili-user-profile-view.bfg-author-card{position:fixed!important;z-index:2147483645;width:240px!important;max-width:calc(100vw - 24px);box-sizing:border-box;padding:14px!important;background:var(--bg1,#fff);color:var(--text1,#222);border:1px solid var(--line_regular,#ddd);border-radius:8px;box-shadow:0 5px 18px #0003;font:13px/1.5 system-ui}
    .bfg-author-head{display:flex;align-items:center;gap:12px}
    .bfg-author-card .bili-user-profile-view__avatar{position:static!important;display:flex;align-items:center;justify-content:center;flex:none;width:42px!important;height:42px!important;margin:0!important;border-radius:50%;overflow:hidden;background:var(--graph_bg_thick,#f1f2f3);color:var(--text2,#61666d);font-size:16px;text-decoration:none}
    .bfg-author-card .bili-user-profile-view__avatar img{width:42px;height:42px;object-fit:cover}
    .bfg-author-card .bili-user-profile-view__info__uname{display:block;margin:0!important;font-size:14px;font-weight:600;color:var(--brand_pink,#fb7299);text-decoration:none;overflow-wrap:anywhere}
    .bfg-author-card small{font-size:12px;color:var(--text3,#9499a0)}
    .bfg-author-card .bili-user-profile-view__info__footer{display:flex!important;align-items:center;gap:10px;margin:12px 0 0!important;padding:0!important}
    .bfg-author-card .bfg-follow-control{margin-right:0}
    .bfg-author-card button.bfg-own-follow{box-sizing:border-box;height:32px;padding:0 12px;border:0;border-radius:4px;background:var(--brand_blue,#00aeec);color:#fff;font:13px system-ui;cursor:pointer}
    .bfg-author-card button.bfg-own-follow.checked{background:var(--graph_bg_thick,#f1f2f3);color:var(--text2,#61666d)}
    .bfg-author-card button.bfg-own-follow:disabled{opacity:.6;cursor:default}
    .bfg-author-card:not(.bfg-state-ready) .bfg-follow-control>button.bfg-arrow{display:none!important}
    .bfg-author-card .bfg-profile-link{font-size:13px;color:var(--brand_blue,#00aeec);text-decoration:none;white-space:nowrap}
    .bfg-author-card>.bfg-author-status{margin:8px 0 0;font-size:12px}
    #bfg-floatwrap{--bfg-bg:var(--bg1,#fff);--bfg-fg:var(--text1,#18191c);--bfg-line:var(--line_regular,#e3e5e7);position:fixed;z-index:2147483646;width:max-content;max-width:min(240px,calc(100vw - 16px));font:13px system-ui;box-sizing:border-box}
    #bfg-float{display:block;box-sizing:border-box;width:44px;height:44px;touch-action:none;cursor:grab;border:1px solid #ffffff66;border-radius:50%;padding:0;background:#087e9b;color:#fff;font:13px/1.5 system-ui;box-shadow:0 2px 8px #0002;user-select:none;white-space:nowrap}
    #bfg-float:hover{background:#066e88}
    #bfg-floatwrap.bfg-expanded{border:1px solid var(--bfg-line);border-radius:6px;background:var(--bfg-bg);box-shadow:0 4px 12px #0002}
    #bfg-floatwrap.bfg-expanded #bfg-float{width:100%;height:auto;border:0;border-bottom:1px solid var(--bfg-line);border-radius:5px 5px 0 0;box-shadow:none;text-align:left;padding:8px 12px;color:#fff}
    #bfg-floatwrap>.bfg-list{width:max-content;min-width:100%;max-width:min(238px,calc(100vw - 18px));border:0;border-radius:0 0 5px 5px;box-shadow:none;background:var(--bfg-bg);color:var(--bfg-fg)}
    .bfg-toast{position:fixed;z-index:2147483647;bottom:80px;right:20px;max-width:300px;padding:10px 14px;border-radius:8px;background:#323942;color:#fff;font:13px/1.5 system-ui;pointer-events:none}
    @media(prefers-color-scheme:dark){.bfg-list,.bili-user-profile-view.bfg-author-card{color:var(--text1,#eee);background:var(--bg1,#242628)}#bfg-floatwrap{--bfg-bg:var(--bg1,#242628);--bfg-fg:var(--text1,#e3e5e7);--bfg-line:var(--line_regular,#36383b)}}`;
  const roots = new WeakSet(), arrows = new WeakMap();
  const pendingTrees = new Set([document]), pendingRoots = new Set();
  let scheduled = false;
  function installStyle(root) { element('style',uiCSS,root === document ? document.documentElement : root); }
  function closeMenu() { activeMenu?.finish(); }
  function linkUid(link){
    try{const url=new URL(link?.href,location.href);return url.hostname==='space.bilibili.com'?uid(url.pathname.split('/')[1]):null;}
    catch{return null;}
  }
  function inlineContext(anchor){
    const row=anchor?.closest('.dyn-orig-author');
    if(!row)return null;
    const name=row.querySelector('.dyn-orig-author__name');
    if(!name)return null;
    const bvid=inlineVideo(anchor);
    return {row,name,bvid,signature:location.pathname+'|'+name.textContent.trim()+'|'+bvid+'|'+(row.querySelector('.dyn-orig-author__face img')?.getAttribute('src')||'')};
  }
  function sameInline(a,b){return !!a && !!b && a.row===b.row && a.name===b.name && a.signature===b.signature;}
  function inlineVideo(anchor){
    const card=anchor.closest('.bili-dyn-content__orig');
    if(!card)return null;
    const videos=new Set();
    for(const link of card.querySelectorAll('a[href]')){
      try{const url=new URL(link.href,location.href);
        if(['www.bilibili.com','bilibili.com'].includes(url.hostname)){
          const bv=url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})(?:\/|$)/)?.[1];if(bv)videos.add(bv);
        }
      }catch{}
    }
    return videos.size===1?[...videos][0]:null;
  }
  let dynamicRequest;
  function dynamicId(){return location.hostname==='t.bilibili.com'?uid(location.pathname.split('/')[1]):
    location.hostname==='www.bilibili.com' && location.pathname.startsWith('/opus/')?uid(location.pathname.split('/')[2]):null;}
  function loadDynamic(id){
    if(dynamicRequest?.id!==id){
      dynamicRequest={id,promise:api('/x/polymer/web-dynamic/v1/detail?id='+id).then(data=>{
        if(String(data?.item?.id_str)!==id)throw new Error('原动态身份未核实');
        return data.item;
      })};
    }
    return dynamicRequest.promise;
  }
  async function loadVideoAuthors(id){
    const item=await loadDynamic(id),sources=[];let node=item.orig;
    for(let depth=0;node && depth<8;depth++,node=node.orig){
      const modules=node.modules,fid=uid(modules?.module_author?.mid);
      const bvid=modules?.module_dynamic?.major?.archive?.bvid;
      if(fid && /^BV[0-9A-Za-z]{10}$/.test(bvid||''))sources.push({fid,bvid});
    }
    return sources;
  }
  async function resolveInline(anchor){
    const context=inlineContext(anchor),bvid=context?.bvid;
    const id=dynamicId();
    if(!id || !context || !bvid || sameInline(inlineAttempts.get(anchor),context))return;
    inlineAttempts.set(anchor,context);
    try{
      const sources=await loadVideoAuthors(id);
      if(!anchor.isConnected || !sameInline(context,inlineContext(anchor)))return;
      const ids=[...new Set(sources.filter(source=>source.bvid===bvid).map(source=>source.fid))];
      if(ids.length!==1)return;
      inlineBindings.set(anchor,{...context,fid:ids[0]});
      pendingRoots.add(document);schedule();
    }catch(e){if(halted)message(errorText(e),e.message);}
  }
  let authorCard=null,authorPending=null,authorOpenTimer,authorCloseTimer;
  const authorTrigger='.opus-module-author__avatar,.opus-module-author__name';
  function authorCurrent(record){return authorCard===record && record.host.isConnected && record.trigger.isConnected && dynamicId()===record.id;}
  function hideAuthorCard(){
    clearTimeout(authorOpenTimer);clearTimeout(authorCloseTimer);
    authorPending=null;
    if(!authorCard)return;
    if(activeMenu && authorCard.host.contains(activeMenu.anchor))closeMenu();
    authorCard.host.remove();authorCard=null;
  }
  function delayAuthorClose(){
    clearTimeout(authorCloseTimer);
    const record=authorCard;
    authorCloseTimer=setTimeout(()=>{if(authorCard===record)hideAuthorCard();},240);
  }
  function followingState(data,fid){
    if(String(data?.mid)===fid && [2,6].includes(data.attribute))return true;
    if(data?.attribute===0 && (String(data.mid)===fid || (data.mid===0 && data.mtime===0 && data.tag===null && data.special===0)))return false;
    throw new Error('关注状态无法核实');
  }
  function positionAuthorCard(record){
    const r=record.trigger.getBoundingClientRect(),card=record.host;
    const width=card.offsetWidth,height=card.offsetHeight;
    card.style.left=Math.max(12,Math.min(innerWidth-width-12,r.left))+'px';
    card.style.top=Math.max(12,r.bottom+8+height>innerHeight?r.top-height-8:r.bottom+8)+'px';
  }
  async function showAuthorCard(trigger){
    const id=dynamicId();if(!id || !trigger.isConnected)return;
    const author=trigger.closest('.opus-module-author');if(!author)return;
    clearTimeout(authorCloseTimer);
    if(authorCard?.author===author && authorCurrent(authorCard))return;
    hideAuthorCard();
    const host=element('div');host.className='bili-user-profile-view bfg-author-card';
    host.setAttribute('role','dialog');host.setAttribute('aria-label','UP主关注');
    document.documentElement.append(host);
    const record={host,trigger,author,id};authorCard=record;
    const state=element('p','读取中…',host);state.className='bfg-author-status';
    positionAuthorCard(record);
    host.addEventListener('pointerenter',()=>clearTimeout(authorCloseTimer));
    host.addEventListener('pointerleave',event=>{
      if(event.relatedTarget instanceof Node && author.contains(event.relatedTarget))return;
      delayAuthorClose();
    });
    try{
      const item=await loadDynamic(id),person=item.modules?.module_author;
      const fid=uid(person?.mid);
      if(!fid || typeof person.name!=='string')throw new Error('动态作者身份未核实');
      if(!authorCurrent(record))return;
      const head=element('div','',host);head.className='bfg-author-head';
      const avatar=element('a','',head);avatar.className='bili-user-profile-view__avatar';
      avatar.href='https://space.bilibili.com/'+fid;avatar.target='_blank';avatar.rel='noopener noreferrer';
      let face;
      try{const url=new URL(person.face);if(url.protocol==='https:' && url.hostname.endsWith('.hdslb.com'))face=url.href;}catch{}
      if(face){const img=element('img','',avatar);img.src=face;img.alt=person.name;img.onerror=()=>{avatar.textContent=person.name.slice(0,1);};}else avatar.textContent=person.name.slice(0,1);
      const info=element('div','',head);
      const name=element('a',person.name,info);name.className='bili-user-profile-view__info__uname';
      name.href=avatar.href;name.target='_blank';name.rel='noopener noreferrer';
      element('small','UID '+fid,info);
      const footer=element('div','',host);footer.className='bili-user-profile-view__info__footer';
      const button=element('button','读取中',footer);button.type='button';button.disabled=true;
      button.className='bili-user-profile-view__info__button follow bfg-own-follow';
      const profile=element('a','查看主页',footer);profile.className='bfg-profile-link';profile.href=avatar.href;profile.target='_blank';profile.rel='noopener noreferrer';
      host.append(state);state.hidden=true;
      enhanceRoot(document);
      positionAuthorCard(record);
      const mid=account();if(!mid)throw new Error('请先登录B站');
      if(mid===fid){button.textContent='这是你自己';return;}
      await checkAccount(mid);
      if(!authorCurrent(record))return;
      let current=followingState(await api('/x/relation?fid='+fid),fid);
      if(!authorCurrent(record))return;
      if(account()!==mid)throw new Error('账号已切换，请刷新页面');
      const update=()=>{button.textContent=current?'已关注':'关注';button.classList.toggle('checked',current);button.disabled=false;host.classList.add('bfg-state-ready');};
      update();positionAuthorCard(record);
      button.onclick=async()=>{
        intent=null;
        if(current){openFor(surfaceFor(button));return;}
        button.disabled=true;
        try{
          const added=await serialWrite(async()=>{
            await checkAccount(mid);
            if(!authorCurrent(record))throw new Error('名片已关闭');
            if(followingState(await api('/x/relation?fid='+fid),fid))return false;
            const csrf=cookie('bili_jct');
            if(!csrf || account()!==mid || !authorCurrent(record))throw new Error('账号或页面已切换');
            await api('/x/relation/modify',{act:'1',fid,csrf,re_src:'0'});
            if(!followingState(await api('/x/relation?fid='+fid),fid))throw new Error('关注待核实：请求已接受，但尚未确认关注状态');
            return true;
          });
          current=true;if(authorCurrent(record))update();
          if(added)completed({mid,fid,anchor:button},{code:0});else if(authorCurrent(record))openFor(surfaceFor(button));
        }catch(e){if(authorCurrent(record))showError(state,e);}
      };
    }catch(e){if(authorCurrent(record)){
      showError(state,e);
      const button=host.querySelector('.bfg-own-follow');if(button)button.textContent='状态未知';
    }}
  }
  function queueAuthorCard(trigger){
    if(location.hostname!=='www.bilibili.com' || !location.pathname.startsWith('/opus/'))return;
    clearTimeout(authorCloseTimer);
    const author=trigger.closest('.opus-module-author'),id=dynamicId();
    if(authorCard?.author===author && authorCurrent(authorCard))return;
    if(authorPending?.author===author && authorPending.id===id)return;
    clearTimeout(authorOpenTimer);
    authorPending={author,id};
    authorOpenTimer=setTimeout(()=>{authorPending=null;void showAuthorCard(trigger);},180);
  }
  function surfaceFor(anchor) {
    if (!anchor?.isConnected) return null;
    if (anchor.matches('.space-follow-btn') && location.hostname === 'space.bilibili.com') {
      const fid = uid(location.pathname.split('/')[1]);
      return fid ? {fid,anchor,container:anchor.parentElement} : null;
    }
    if(anchor.matches(vueFollow)){
      const card=anchor.closest('.bili-user-profile-view');
      if(!card)return null;
      const ids=[...new Set([...card.querySelectorAll('.bili-user-profile-view__avatar,.bili-user-profile-view__info__uname')].map(linkUid).filter(Boolean))];
      return ids.length===1?{fid:ids[0],anchor,container:anchor.parentElement}:null;
    }
    if(anchor.matches(inlineFollow)){
      const binding=inlineBindings.get(anchor);
      return sameInline(binding,inlineContext(anchor))?{fid:binding.fid,anchor,container:anchor.parentElement,inline:true}:null;
    }
    const root = anchor.getRootNode();
    if (root.host?.matches('bili-user-profile') && anchor.matches('button#follow')) {
      const fid=linkUid(root.querySelector('a#avatar[href]'));
      return fid ? {fid,anchor,container:anchor.parentElement} : null;
    }
    return null;
  }
  const followed = anchor => /已关注|互相关注|已互粉/.test(anchor.textContent || '');

  async function dropdown(job, nativePanel) {
    const surface = surfaceFor(job.anchor);
    if (!surface || surface.fid !== job.fid) { message('关注成功，名片已关闭；再次打开名片可选择分组'); return; }
    closeMenu();
    let done;
    const completion = new Promise(resolve => {done=resolve;});
    const list = element('div'); list.className='bfg-list';
    list.setAttribute('role','menu'); list.setAttribute('aria-label','关注分组');
    list.dataset.fid=job.fid;
    // Reuse the existing native homepage menu, including its original actions.
    if (nativePanel) {list.classList.add('bfg-inline'); nativePanel.append(list);}
    else {
      list.style.cssText='position:absolute;top:100%;'+(surface.inline?'right:0;':'left:0;')+'margin-top:4px';
      if(getComputedStyle(surface.container).position === 'static') surface.container.style.position='relative';
      surface.container.append(list);
    }
    const finish = () => {list.remove(); if(activeMenu?.list===list)activeMenu=null;done();};
    activeMenu={list,anchor:job.anchor,finish};
    const state=element('p','读取分组…',list);
    let busy=false;
    const identityOK=()=>account()===job.mid && surfaceFor(job.anchor)?.fid===job.fid;
    try {
      if(!job.groups)job.groups=await loadGroups(job.mid);
      if(!list.isConnected)return completion;
      const membership=parseMembership(await api('/x/relation/tag/user?fid='+job.fid));
      if(!list.isConnected)return completion;
      if(!identityOK())throw new Error('账号或名片已切换，请重新打开');
      state.hidden=true;
      const items=menuRows(list,job.groups,membership,async(group)=>{
          if(busy || membership.includes(group.id))return;busy=true;
          for(const b of list.querySelectorAll('button'))b.disabled=true;
          state.hidden=false;state.textContent='保存中…';
          try {
            if(!identityOK())throw new Error('账号或名片已切换，请重新打开');
            await addGroup(job,group.id);
            message('已加入「'+group.name+'」');finish();
          }catch(e){showError(state,e);}
          finally{busy=false;}
      });
      for(const b of items.querySelectorAll('button'))b.disabled=membership.includes(b.dataset.group);
      if(!job.groups.length){state.hidden=false;state.textContent='暂无分组';}
      if(!nativePanel && list.getBoundingClientRect().bottom > innerHeight){list.style.top='auto';list.style.bottom='100%';}
    }catch(e){showError(state,e);}
    list.addEventListener('pointerdown',event=>event.stopPropagation());
    list.addEventListener('click',event=>event.stopPropagation());
    return completion;
  }

  function openFor(surface,nativePanel){
    if(!surface)return;
    if(activeMenu?.anchor===surface.anchor && activeMenu.list.isConnected)return;
    const mid=account();
    if(!mid){message('请先登录B站');return;}
    if(!followed(surface.anchor)){message('请先关注此UP主');return;}
    void dropdown({mid,fid:surface.fid,anchor:surface.anchor},nativePanel);
  }
  function observeRoot(root){
    if(roots.has(root))return;
    roots.add(root);
    if(root===document || root.host?.matches('bili-user-profile'))installStyle(root);
    pendingRoots.add(root);
    new MutationObserver(records=>{
      let changed=false;
      for(const record of records){
        const target=record.target instanceof Element?record.target:record.target.parentElement;
        if(ownUI(target))continue;
        if(record.type==='attributes' && !target?.matches('html,body,.menu-popover__panel,.menu-popover__panel-item,.space-follow-btn,bili-user-profile,a#avatar,.bili-user-profile-view,.bili-user-profile-view__avatar,.bili-user-profile-view__info__uname,'+vueFollow+','+inlineFollow))continue;
        if(record.type==='characterData' && !target?.closest('.space-follow-btn,#action button#follow,'+vueFollow+','+inlineFollow))continue;
        changed=true;
        pendingRoots.add(root);
        if(record.type==='childList'){
          for(const node of record.addedNodes)if(node instanceof Element && !ownUI(node))pendingTrees.add(node);
        }
      }
      if(changed)schedule();
    }).observe(root===document?document.documentElement:root,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class','style','href']});
    discoverTree(root);
  }
  function discoverTree(tree){
    if(tree instanceof Element && tree.shadowRoot)observeRoot(tree.shadowRoot);
    for(const host of tree.querySelectorAll('*'))if(host.shadowRoot)observeRoot(host.shadowRoot);
  }
  function enhanceRoot(root){
    const selector=root===document?vueFollow+','+inlineFollow:'#action button#follow';
    if(root!==document && (!root.host?.matches('bili-user-profile') || !root.host.isConnected))return;
    for(const anchor of root.querySelectorAll(selector)){
      let arrow=arrows.get(anchor);
      const surface=surfaceFor(anchor);
      if(!surface){arrow?.remove();if(anchor.matches(inlineFollow))void resolveInline(anchor);continue;}
      if(!arrow?.isConnected){
        let control=anchor.parentElement;
        if(!control.classList.contains('bfg-follow-control')){control=element('span');control.className='bfg-follow-control';anchor.before(control);control.append(anchor);}
        arrow=element('button','▾');arrow.className='bfg-arrow';arrow.type='button';
        arrow.setAttribute('aria-label','选择关注分组');arrow.title='关注分组';
        anchor.after(arrow);arrows.set(anchor,arrow);
        arrow.onclick=e=>{e.preventDefault();e.stopPropagation();
          if(activeMenu?.anchor===anchor)closeMenu();else openFor(surfaceFor(anchor));};
      }
    }
  }
  const seenNative = new WeakSet();
  function scan(){
    scheduled=false;
    if(!document.documentElement)return;
    const trees=new Set(pendingTrees);pendingTrees.clear();
    for(const tree of trees){
      if(!tree.isConnected || ownUI(tree instanceof Element?tree:null))continue;
      let parent=tree.parentNode;
      while(parent && !trees.has(parent))parent=parent.parentNode;
      if(parent)continue;
      if(tree===document)observeRoot(document);else discoverTree(tree);
    }
    for(const root of pendingRoots)enhanceRoot(root);
    pendingRoots.clear();
    if(authorCard && !authorCurrent(authorCard))hideAuthorCard();
    if(activeMenu){
      const surface=activeMenu.kind==='settings'?null:surfaceFor(activeMenu.anchor);
      if(!activeMenu.list.isConnected || (activeMenu.kind!=='settings' && surface?.fid!==activeMenu.list.dataset.fid))closeMenu();
    }
    const anchor=document.querySelector('.space-follow-btn');
    if(!anchor || !followed(anchor))return;
    for(const menu of document.querySelectorAll('.menu-popover__panel')){
      if(!menu.getClientRects().length || getComputedStyle(menu).visibility==='hidden'){seenNative.delete(menu);continue;}
      const items=[...menu.children].filter(e=>e.classList.contains('menu-popover__panel-item'));
      const actions=items.map(e=>e.textContent.trim());
      if(actions.includes('设置分组')&&actions.includes('取消关注')){
        if(!menu.classList.contains('bfg-native-menu'))menu.classList.add('bfg-native-menu');
        const reference=items.find(e=>!e.matches(':hover')) || items[0];
        const color=getComputedStyle(reference).color;
        if(menu.style.getPropertyValue('--bfg-native-text')!==color)menu.style.setProperty('--bfg-native-text',color);
        if(activeMenu?.anchor===anchor && activeMenu.list.parentElement!==menu){
          activeMenu.list.classList.add('bfg-inline');activeMenu.list.style.cssText='';menu.append(activeMenu.list);
        }else if(!activeMenu && !seenNative.has(menu)){seenNative.add(menu);openFor(surfaceFor(anchor),menu);}
      }
    }
  }
  function schedule(){if(!scheduled){scheduled=true;requestAnimationFrame(scan);}}
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change',schedule);
  function ownUI(element){return !!element?.closest('.bfg-list,#bfg-floatwrap,.bfg-toast,.bfg-arrow,.bfg-author-card');}
  // A custom element can attach its shadow root after insertion. Mouse entry
  // discovers that root without polling the entire page or replacing attachShadow.
  document.addEventListener('pointerover',event=>{
    const path=event.composedPath().filter(el=>el instanceof Element);
    if(path.some(ownUI))return;
    const trigger=path.find(el=>el.matches(authorTrigger));if(trigger)queueAuthorCard(trigger);
    let relevant=false;
    for(const el of path){
      if(el.shadowRoot && !roots.has(el.shadowRoot)){pendingTrees.add(el);relevant=true;}
      if(el.matches('.space-follow-btn,.menu-popover__panel,bili-user-profile,.bili-user-profile-view,'+inlineFollow)){pendingRoots.add(el.getRootNode());relevant=true;}
    }
    if(relevant)schedule();
  },true);
  document.addEventListener('pointerout',event=>{
    const trigger=event.target instanceof Element?event.target.closest(authorTrigger):null;
    if(!trigger)return;
    const next=event.relatedTarget;
    if(next instanceof Node && (trigger.closest('.opus-module-author')?.contains(next) || authorCard?.host.contains(next)))return;
    clearTimeout(authorOpenTimer);
    authorPending=null;
    delayAuthorClose();
  },true);
  document.addEventListener('pointerdown',event=>{
    if(!authorCard && !activeMenu)return;
    const path=event.composedPath();
    if(authorCard && !path.some(e=>e===authorCard.host || e===authorCard.trigger))hideAuthorCard();
    if(activeMenu && !path.some(e=>e===activeMenu.list || e===activeMenu.anchor || e?.classList?.contains('bfg-arrow')))closeMenu();
  },true);
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeMenu();hideAuthorCard();}});
  window.addEventListener('scroll',e=>{if(authorCard && !(e.target instanceof Node && authorCard.host.contains(e.target)))hideAuthorCard();if(activeMenu && activeMenu.kind!=='settings' && !activeMenu.list.contains(e.target) && !activeMenu.list.classList.contains('bfg-inline'))closeMenu();},true);

  function floatingButton(){
    const host=element('div');host.id='bfg-floatwrap';document.documentElement.append(host);
    const button=element('button','分组');button.id='bfg-float';button.type='button';button.title='点击设置默认分组，拖动调整位置';
    host.append(button);button.setAttribute('aria-expanded','false');
    let drag=null,moved=false;
    function place(x,y){
      const width=host.offsetWidth,height=host.offsetHeight;
      const left=Math.max(0,Math.min(innerWidth-width,Number(x)||0))+'px';
      const top=Math.max(0,Math.min(innerHeight-height,Number(y)||0))+'px';
      if(host.style.left!==left)host.style.left=left;
      if(host.style.top!==top)host.style.top=top;
    }
    const saved=GM_getValue('follow-groups:position',null);
    place(saved?.x ?? innerWidth-120,saved?.y ?? innerHeight-130);
    button.onpointerdown=e=>{if(e.button!==0)return;const r=host.getBoundingClientRect();drag={x:e.clientX,y:e.clientY,left:r.left,top:r.top};moved=false;button.setPointerCapture(e.pointerId);};
    button.onpointermove=e=>{if(!drag)return;if(Math.hypot(e.clientX-drag.x,e.clientY-drag.y)>5){if(!moved)closeMenu();moved=true;}if(moved)place(drag.left+e.clientX-drag.x,drag.top+e.clientY-drag.y);};
    const end=()=>{if(drag&&moved){const r=host.getBoundingClientRect();GM_setValue('follow-groups:position',{x:r.left,y:r.top});}drag=null;};
    button.onpointerup=end;button.onpointercancel=end;
    button.onclick=()=>{if(moved){moved=false;return;}void settings();};
    repositionFloating=()=>{const r=host.getBoundingClientRect();place(r.left,r.top);};
    window.addEventListener('resize',repositionFloating);
  }
  function start(){scan();floatingButton();}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
