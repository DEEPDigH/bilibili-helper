// ==UserScript==
// @name         B站已参与抽奖备忘录
// @namespace    local.bili.reminder
// @version      0.7.0
// @description  仅检查自己的转发动态与手动记录的活动；提取开奖时间、UP主和UID，本地去重及到期提醒。
// @match        https://space.bilibili.com/*
// @match        https://t.bilibili.com/*
// @match        https://www.bilibili.com/opus/*
// @match        https://www.bilibili.com/video/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_registerMenuCommand
// @connect      api.bilibili.com
// @connect      api.vc.bilibili.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  "use strict";
  const FOLLOW_TTL = 10 * 60 * 1000;
  function canonical(value) {
    try {
      const u = new URL(value);
      let m;
      if (u.protocol !== "https:" || u.username || u.password || u.port)
        return null;
      if (["www.bilibili.com", "bilibili.com"].includes(u.hostname)) {
        m = u.pathname.match(/^\/video\/(BV[\da-zA-Z]{10})\/?$/);
        if (m)
          return {
            key: "video:" + m[1],
            id: m[1],
            url: "https://www.bilibili.com/video/" + m[1],
          };
        m = u.pathname.match(/^\/opus\/(\d+)\/?$/);
      } else if (u.hostname === "t.bilibili.com")
        m = u.pathname.match(/^\/(\d+)\/?$/);
      if (m)
        return {
          key: "dynamic:" + m[1],
          id: m[1],
          url: "https://www.bilibili.com/opus/" + m[1],
        };
    } catch (_) {
      /* 非活动链接 */
    }
    return null;
  }
  // 只提取开奖语句。缺失年份时使用原活动发布时间，并保留推断依据。
  function parseTime(text, publishedAt) {
    const unknown=(source='没有识别到明确开奖日期，请填写',quote='')=>({time:null,source,quote});
    const raw=typeof publishedAt==='number'||/^\d+$/.test(String(publishedAt||''))?Number(publishedAt)*1000:Date.parse(publishedAt);
    const published=Number.isFinite(raw)?new Date(raw+8*3600000):null;
    const lines=String(text).split(/[\n。；;]/);const found=[];
    for(let i=0;i<lines.length;i++){
      let line=lines[i];if(!/开奖|抽奖|抽取时间|抽取日期|抽出/.test(line))continue;
      if(!/\d\s*[月/.-]\s*\d/.test(line)&&lines[i+1]&&/^\s*(?:20\d{2}\s*年)?\s*\d{1,2}\s*[月/.-]/.test(lines[i+1]))line+=' '+lines[i+1];
      if(/截止|延期|推迟|改为|取消|不再|原定|UTC|美东|日本时间|\b(?:AM|PM)\b/i.test(line))return unknown('日期有歧义，请核实',line.trim());
      const datePattern=/(?:(20\d{2})\s*[年/.-]\s*)?(\d{1,2})\s*[月/.-]\s*(\d{1,2})\s*[日号]?/g;
      const dates=[...line.matchAll(datePattern)];
      for(const match of dates){
        const month=+match[2],day=+match[3];let year=+match[1],inferred=false;
        if(!year){
          if(!published)return unknown('缺少年份，请填写',line.trim());
          year=published.getUTCFullYear();const pm=published.getUTCMonth()+1,pd=published.getUTCDate();
          if(month<pm||(month===pm&&day<pd)){if(pm===12&&month===1)year++;else continue;}
          inferred=true;
        }
        const date=year+'-'+String(month).padStart(2,'0')+'-'+String(day).padStart(2,'0');
        const tail=line.slice(match.index+match[0].length);
        const clockText=tail.replace(/([一二三四五六七八九十两]{1,3})(?=[点时])/g,(_,n)=>{const map={一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};return n.includes('十')?((n.split('十')[0]?map[n.split('十')[0]]:1)*10+(map[n.split('十')[1]]||0)):map[n];});
        const clocks=[...clockText.matchAll(/(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|晚间|晚)?\s*(\d+)\s*([:：点时])\s*(\d+)?\s*(分|半|一刻|三刻)?/g)];
        if(clocks.length>1)return unknown('存在多个时刻，请核实',line.trim());
        const explanation=inferred?'；年份按原活动发布时间推断':'';
        try{
          const remindAt=manualTime(date+'T09:00');
          if(!clocks.length){found.push({time:null,drawDate:date,precision:'date',remindAt,source:'活动原文日期'+explanation,quote:line.trim(),yearInferred:inferred});continue;}
          const c=clocks[0];if(/[:：]/.test(c[3])&&!c[4])continue;
          if(c[2].length>2||(c[4]||'').length>2)return unknown('时刻格式无效，请核实',line.trim());
          let hour=+c[2],minute=c[5]==='半'?30:c[5]==='一刻'?15:c[5]==='三刻'?45:+(c[4]||0);
          if(hour===12&&/早上|早晨|上午|晚上|晚间|晚/.test(c[1]||''))return unknown('时刻有歧义，请核实',line.trim());
          if(/下午|傍晚|晚上|晚间|晚/.test(c[1]||'')&&hour<12)hour+=12;
          if(c[1]==='凌晨'&&hour===12)hour=0;
          if(c[1]==='中午'&&hour<11)continue;
          const time=manualTime(date+'T'+String(hour).padStart(2,'0')+':'+String(minute).padStart(2,'0'));
          found.push({time,precision:'time',source:'活动原文开奖时间'+explanation,quote:line.trim(),yearInferred:inferred});
        }catch(_){return unknown('日期或时刻无效，请核实',line.trim());}
      }
    }
    const unique=[...new Map(found.map(r=>[r.time||r.drawDate,r])).values()];
    return unique.length===1?unique[0]:unknown(unique.length?'存在多个开奖日期，请核实':undefined);
  }
  function mergeRecord(old, incoming) {
    if (!old)
      return {
        ...incoming,
        aliases: [...new Set([incoming.key, ...(incoming.aliases || [])])],
      };
    const result = {
      ...old,
      aliases: [
        ...new Set([
          old.key,
          ...(old.aliases || []),
          incoming.key,
          ...(incoming.aliases || []),
        ]),
      ],
      checkedAt: incoming.checkedAt || old.checkedAt,
      manual: [...new Set([...(old.manual || []), ...(incoming.manual || [])])],
    };
    const oldOutcome = outcomeOf(old), newOutcome = outcomeOf(incoming);
    result.resultConflict = old.resultConflict === true || incoming.resultConflict === true ||
      oldOutcome !== "pending" && newOutcome !== "pending" && oldOutcome !== newOutcome;
    result.outcome = result.resultConflict ? "pending" : oldOutcome === "pending" ? newOutcome : oldOutcome;
    result.done = result.outcome !== "pending";
    for (const field of ["title", "up", "uid", "text"])
      if (incoming[field] && !old.manual?.includes(field))
        result[field] = incoming[field];
    const oldDate = timingDate(old), newDate = timingDate(incoming);
    const timeConflict = old.time && incoming.time && old.time !== incoming.time ||
      oldDate && newDate && oldDate !== newDate;
    if (incoming.quote && !old.manual?.includes("time") && !timeConflict)
      result.quote = incoming.quote;
    if (
      !old.manual?.includes("time") && !timeConflict &&
      ((!old.time && incoming.time) ||
        (!old.time && !old.drawDate && incoming.drawDate))
    ) {
      for (const f of ["time", "drawDate", "precision", "remindAt", "source", "yearInferred"])
        result[f] = incoming[f] || null;
    }
    if (timeConflict) {
      result.conflict = "新检测到的时间与已记录时间不同，请核实";
      result.proposedTime = incoming.time || null;
      result.proposedDate = incoming.drawDate || null;
    }
    result.reposts = [
      ...new Set([...(old.reposts || []), ...(incoming.reposts || [])]),
    ];
    result.repostedAt = Math.max(old.repostedAt || 0, incoming.repostedAt || 0);
    return result;
  }
  function schedule(r) {
    if (r.drawDate && !validDay(r.drawDate)) return null;
    const time = r.time || r.remindAt;
    return validTime(time) ? time : null;
  }
  function validTime(time) {
    if (typeof time !== "string" || !Number.isFinite(Date.parse(time))) return false;
    const day = time.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    return !day || validDay(day);
  }
  function validDay(day) {
    try {return typeof day === "string" && Boolean(manualTime(day + "T09:00"));}
    catch (_) {return false;}
  }
  function timingDate(r) {
    return validTime(r.time) ? new Date(Date.parse(r.time) + 8 * 3600000).toISOString().slice(0,10) : r.drawDate || null;
  }
  function activityOrder(a, b) {
    const newest = (r) =>
      (r.reposts || [])
        .filter((x) => /^\d+$/.test(x))
        .reduce((max, x) => (BigInt(x) > max ? BigInt(x) : max), 0n);
    const ai = newest(a),
      bi = newest(b);
    if (ai !== bi) return ai > bi ? -1 : 1;
    return (
      (b.repostedAt || Date.parse(b.createdAt) || 0) -
      (a.repostedAt || Date.parse(a.createdAt) || 0)
    );
  }
  function drawLabel(r) {
    return r.precision === "date" && validDay(r.drawDate)
      ? r.drawDate + " 当天开奖，具体时刻未知（当天09:00提醒）"
      : fmt(r.time);
  }
  function upLink(name, uid) {
    const id = String(uid || "").trim();
    const valid = /^[1-9]\d*$/.test(id);
    const el = document.createElement(valid ? "a" : "span");
    el.textContent = name || "UP主待填写";
    if (valid) {
      el.href = "https://space.bilibili.com/" + id;
      el.target = "_blank";
      el.rel = "noopener noreferrer";
      el.title = "打开UP主主页";
    }
    return el;
  }
  function activityInfo(target, r, hint = "") {
    target.replaceChildren(upLink(r.up, r.uid), document.createTextNode(" · UID " + (r.uid || "待填写")));
    if (hint) {
      const label = document.createElement("span");
      label.className = "unfollow-hint";
      label.textContent = hint;
      label.title = hint === "最后一场"
        ? "该UP仅剩这1场待处理，活动结束并确认结果后再考虑取关"
        : "该UP本地已记录活动均已标记未中奖，可考虑取消关注；请自行确认其他关注原因";
      target.append(label);
    }
    target.append(document.createTextNode("\n开奖：" + drawLabel(r) + outcomeLabel(r)));
  }
  function counts(records, now = Date.now()) {
    const c = {total: 0, soon: 0, due: 0, unknown: 0, lost: 0, won: 0, recorded: records.length};
    for (const r of records) {
      const outcome = outcomeOf(r);
      if (outcome !== "pending") {c[outcome]++; continue;}
      c.total++;
      const time = schedule(r);
      if (!time) {c.unknown++; continue;}
      const at = Date.parse(time);
      if (at <= now) c.due++;
      else if (at <= now + 7 * 86400000) c.soon++;
    }
    return c;
  }
  function outcomeOf(r) {
    if (r.resultConflict === true) return "pending";
    if (r.outcome !== undefined) return ["pending", "lost", "won"].includes(r.outcome) ? r.outcome : "pending";
    return r.done === true ? "lost" : "pending";
  }
  function upKey(r) {
    const uid = String(r.uid || "").trim().replace(/^0+(?=\d)/, "");
    return /^[1-9]\d*$/.test(uid) ? "uid:" + uid : "unknown:" + r.key;
  }
  function matchesSearch(record, query) {
    const text = [record.title, record.up, record.uid].join(" ").toLocaleLowerCase();
    return query.trim().toLocaleLowerCase().split(/\s+/).every(word => text.includes(word));
  }
  function activityTitle(record) {
    const title = String(record.title || "").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
    return title.replace(/^互动抽奖\s*/, "") || title || record.key;
  }
  function capsuleState(link, records) {
    if (!link?.key.startsWith("dynamic:")) return {state:"neutral", label:"抽奖记录"};
    const matches = records.filter(record => [record.key, ...(record.aliases || []),
      ...(record.reposts || []).map(id => "dynamic:" + id)].includes(link.key));
    const recorded = matches.some(record => (record.reposts || []).some(id => /^[1-9]\d*$/.test(String(id))));
    return {state:recorded ? "recorded" : "missing", label:recorded
      ? "本地已记录自己的转发" : matches.length ? "活动已记录，转发待核实" : "未找到本地转发记录"};
  }
  function upStatistics(records) {
    const groups = new Map();
    for (const r of records) {
      const key = upKey(r);
      if (!groups.has(key)) groups.set(key, {key, uid: key.startsWith("uid:") ? key.slice(4) : "", name: r.up || "UP主待填写", total: 0, lost: 0, won: 0});
      const row = groups.get(key);
      row.total++;
      const outcome = outcomeOf(r);
      if (outcome !== "pending") row[outcome]++;
    }
    return [...groups.values()].sort((a,b) => b.total-a.total || a.key.localeCompare(b.key));
  }
  function outcomeLabel(r) {
    return outcomeOf(r) === "won" ? " · 已中奖（手动标记）" : outcomeOf(r) === "lost" ? " · 未中奖" : "";
  }
  function relationFollowing(data, uid) {
    if (!/^[1-9]\d*$/.test(uid)) return null;
    // 真实未关注响应没有目标UID，返回完整的零值关系。调用方api已核对HTTP和code=0。
    if (data?.mid === 0 && data.attribute === 0 && data.mtime === 0 && data.tag === null && data.special === 0)
      return false;
    if (String(data?.mid) !== uid) return null;
    if ([2, 6].includes(data.attribute)) return true;
    return data.attribute === 0 ? false : null;
  }
  function followRefreshNeeded(cached, priority, force = false, now = Date.now()) {
    if (force || !Number.isFinite(cached.checkedAt)) return true;
    if (now - cached.checkedAt < FOLLOW_TTL) return false;
    return priority || cached.following === null;
  }
  function unfollowHint(record, group, following, lastKey) {
    if (following !== true || !group?.uid || group.won || record.resultConflict) return "";
    const pending = group.total - group.lost - group.won;
    if (pending === 1 && outcomeOf(record) === "pending")
      return "最后一场";
    return pending === 0 && record.key === lastKey
      ? "可取关" : "";
  }
  function normalizeClock(value) {
    const text = value.trim();
    const m = text.match(/^(\d{1,2})[:：]?(\d{2})$/);
    return m && +m[1] < 24 && +m[2] < 60
      ? m[1].padStart(2, "0") + ":" + m[2] : text;
  }
  function manualTime(value) {
    if (!value) return null;
    const m = value.match(
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/,
    );
    if (!m) throw Error("请填写完整的年、月、日、时、分");
    const date = new Date(value + (m[6] ? "" : ":00") + "+08:00"),
      cn = new Date(date.getTime() + 8 * 3600000);
    if (
      !Number.isFinite(date.getTime()) ||
      cn.getUTCFullYear() !== +m[1] ||
      cn.getUTCMonth() + 1 !== +m[2] ||
      cn.getUTCDate() !== +m[3] ||
      +m[4] > 23 ||
      +m[5] > 59 ||
      +(m[6] || 0) > 59
    )
      throw Error("开奖日期或时间无效");
    return date.toISOString();
  }
  function validateRecord(r) {
    if (!r || typeof r !== "object" || Array.isArray(r)) throw Error("备份含无效活动");
    const link = canonical(r.url);
    const ids = /^(?:dynamic:\d+|lottery:\d+|video:BV[\da-zA-Z]{10})$/;
    if (!link || link.key !== r.key ||
      ["title", "up", "uid", "text", "quote", "source"].some(field => r[field] != null && typeof r[field] !== "string") ||
      ["aliases", "reposts", "manual"].some(field => r[field] != null &&
        (!Array.isArray(r[field]) || r[field].some(value => typeof value !== "string"))) ||
      r.aliases?.some(value => !ids.test(value)) ||
      r.reposts?.some(value => !/^\d+$/.test(value)) ||
      ["time", "remindAt"].some(field => r[field] != null && !validTime(r[field])) ||
      r.drawDate != null && !validDay(r.drawDate) ||
      r.deletedAt != null && !validTime(r.deletedAt) ||
      r.done !== undefined && typeof r.done !== "boolean" ||
      r.outcome !== undefined && !["pending", "lost", "won"].includes(r.outcome))
      throw Error("备份含无效活动、时间或状态");
  }
  function pageHasMore(data) {
    if (!Array.isArray(data?.items) || ![true, false, 0, 1].includes(data.has_more))
      throw Error("动态响应格式改变，已停止；不能认定历史检查完成");
    return Boolean(data.has_more);
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      canonical,
      parseTime,
      mergeRecord,
      counts,
      manualTime,
      schedule,
      activityOrder,
      outcomeOf,
      upStatistics,
      relationFollowing,
      unfollowHint,
      validateRecord,
      pageHasMore,
      followRefreshNeeded,
      capsuleState,
    };
    return;
  }

  const PREFIX = "bili-reminder:v1:activity:";
  let relationAccount = "", followingTask = null, requestTail = Promise.resolve();
  let paused = false,
    busy = false,
    me = "",
    nextAt = 0,
    route = "",
    stopScan = false,
    filter = "all",
    upFilter = "";
  const reminderOwner = Date.now() + ":" + Math.random();
  const owner = () => me || GM_getValue("bili-reminder:last-uid") || "";
  const scanKey = () => "bili-reminder:v2:scan:" + owner();
  const freshScan = (status = "尚未检查") => ({offset: "", index: 0, pages: 0, examined: 0, matched: 0, other: 0, complete: false, status});
  const scanState = () => GM_getValue(scanKey()) || freshScan();
  const dynamicPageUid = () => location.hostname === "space.bilibili.com"
    ? location.pathname.match(/^\/(\d+)\/dynamic\/?$/)?.[1] || "" : "";
  const ownDynamicPage = () => Boolean(owner()) && dynamicPageUid() === owner();
  if (document.getElementById("bili-reminder-host")) return;
  const host = document.createElement("div");
  host.id = "bili-reminder-host";
  document.documentElement.append(host);
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>
:host{--text:#24334a;--bg:#f6f8fb;--surface:#fff;--border:#dce4ec;--soft:#f2f5f9;--muted:#65778b;--link:#225777;--accent:#176b83;--selected:#e5f2f6;--selected-border:#a7cdd9;--danger:#c83c3c;--success:#16803c;--warning:#db8754;--scrollbar:#b8c5ce;--scheme:light;all:initial;color-scheme:var(--scheme);font:14px/1.6 "Microsoft YaHei",sans-serif;color:var(--text)}*{box-sizing:border-box}button,input{font:inherit}button{cursor:pointer;border:1px solid var(--border);border-radius:8px;background:var(--surface);padding:7px 12px;color:inherit}button:hover{background:var(--selected)}button:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}#toggle{position:fixed;right:20px;bottom:22px;background:var(--accent);color:white;border:0;border-radius:24px;padding:10px 18px;z-index:2147483647;box-shadow:0 4px 16px #0002}#panel{position:fixed;right:20px;bottom:76px;width:490px;max-width:calc(100vw - 32px);height:min(780px,calc(100vh - 100px));background:var(--bg);border:1px solid var(--border);border-radius:16px;z-index:2147483647;box-shadow:0 12px 40px #142b4526;overflow:auto}header{padding:20px 20px 12px;background:var(--surface);border-radius:16px 16px 0 0;position:sticky;top:0;z-index:2;border-bottom:1px solid var(--border)}.head{display:flex;align-items:center;gap:10px}.head h2{flex-shrink:0}#header-status{flex:1;min-width:0;text-align:right}#search{margin-top:12px}h2{font-size:19px;margin:0}#close{border:0;font-size:21px;padding:0 5px}small{font-size:12px;color:var(--muted)}#stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin:16px 0 12px}#stats button{text-align:left;padding:8px 6px;border:1px solid transparent;background:var(--soft)}#stats button[aria-pressed=true]{background:var(--selected);border-color:var(--selected-border);color:var(--link)}#stats strong{display:block;font-size:23px;line-height:1.4}#stats span{font-size:12px}.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}#tools{display:flex;gap:8px;flex-wrap:wrap}#tools>button:first-child{background:var(--accent);color:#fff;border:0}#more{margin-left:auto;position:relative}summary{cursor:pointer;color:var(--muted);font-size:12px;padding:5px 0}#more summary{font-size:14px;padding:6px}#more>div{position:absolute;right:0;top:34px;width:200px;max-height:55vh;overflow:auto;padding:8px;background:var(--surface);border:1px solid var(--border);box-shadow:0 8px 24px #0002;border-radius:10px}#more button{display:block;width:100%;text-align:left;margin:3px 0;border:0}#status,#progress,#follow-status{font-size:10px;line-height:1.4;color:var(--muted);margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#header-status:hover p{white-space:normal;overflow-wrap:anywhere}#status:empty,#follow-status:empty{display:none}#list{padding:4px 14px 16px}article{background:var(--surface);border:1px solid var(--border);border-radius:12px;margin:9px 0;padding:14px}article>a{font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.6;font-size:14px}article>p{margin:9px 0 4px;font-size:13px;white-space:pre-line}article>small{display:block;overflow-wrap:anywhere}.due{border-left:3px solid var(--warning)}article>details{margin-top:10px;border-top:1px solid var(--border)}article>button{font-size:12px;padding:4px 8px;margin-top:8px}label{display:block;font-size:12px;margin:9px 0;color:var(--muted)}input{display:block;width:100%;padding:8px 10px;margin-top:4px;border:1px solid var(--border);border-radius:7px;color:var(--text);background:var(--surface)}details button{margin:5px 4px 5px 0;font-size:12px}details p{font-size:12px;margin:8px 0}.tip{padding:0 20px 16px;font-size:11px;color:var(--muted);line-height:1.7}
.summary-actions{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}.up-table{width:100%;border-collapse:collapse;font-size:12px}.up-table th,.up-table td{text-align:left;padding:8px 4px;border-bottom:1px solid var(--border);overflow-wrap:anywhere}.up-table th:first-child{width:42%}.up-table button{padding:3px 6px;font-size:12px}.view-title{font-size:15px;margin:10px 0}.stats-tip{font-size:12px;color:var(--muted)}
.unfollow-hint{color:var(--danger);margin-left:6px;white-space:nowrap;font-size:12px}
.follow-badge{display:inline-flex;align-items:center;justify-content:center;border:1px solid currentColor;border-radius:4px;min-width:20px;height:20px;margin-right:5px;font-weight:700}
:host([data-theme="dark"]){--text:#e1e7ee;--bg:#1d2025;--surface:#252930;--border:#414953;--soft:#2e343d;--muted:#aeb9c8;--link:#8fcef0;--accent:#176b83;--selected:#263e49;--selected-border:#558393;--danger:#ff8585;--success:#71d699;--warning:#eab385;--scrollbar:#5a6573;--scheme:dark}
.follow-badge[data-state="followed"]{color:var(--success)}.follow-badge[data-state="unfollowed"]{color:var(--danger)}.follow-badge[data-state="unknown"]{color:var(--muted)}
#toggle[data-activity="recorded"]{background:#187d45}#toggle[data-activity="missing"]{background:#b63c3c}
#panel,#more>div{scrollbar-width:thin;scrollbar-color:var(--scrollbar) transparent}#panel::-webkit-scrollbar,#more>div::-webkit-scrollbar{width:5px;height:5px}#panel::-webkit-scrollbar-thumb,#more>div::-webkit-scrollbar-thumb{background:var(--scrollbar);border-radius:6px}
</style><button id="toggle">抽奖记录</button><section id="panel" hidden><header><div class="head"><h2>抽奖记录</h2><div id="header-status"><p id="progress"></p><p id="status" role="status"></p><p id="follow-status" role="status"></p></div><button id="close" aria-label="收起面板">×</button></div><input id="search" type="search" aria-label="搜索已记录活动" placeholder="搜索标题 / UP主 / UID"><div id="stats"></div><div class="toolbar"><div id="tools"></div><details id="more"><summary>更多</summary><div id="extras"></div></details></div></header><div id="list"></div><div class="tip">有时间按时提醒，只有日期当天 9 点提醒。关闭浏览器后，下次打开补提醒。仅浏览活动不会自动记为已参与。</div></section>`;
  const $ = (s) => root.querySelector(s);
  let capsuleUrl = "";
  function updateCapsule(records) {
    capsuleUrl = location.href;
    const status = capsuleState(canonical(capsuleUrl), records);
    $("#toggle").dataset.activity = status.state;
    $("#toggle").title = status.label + "；仅核对当前动态的本地转发记录，不代表官方参与资格；未找到可能是历史尚未检查完整";
    $("#toggle").setAttribute("aria-label", status.label + "；" + $("#toggle").textContent);
  }
  const systemTheme = matchMedia("(prefers-color-scheme: dark)");
  function syncTheme() {
    const elements = [document.documentElement, document.body].filter(Boolean);
    let theme;
    for (const el of elements) {
      const explicit = el.getAttribute("data-theme") || el.getAttribute("data-color-mode") || "";
      if (["dark", "light"].includes(explicit)) {theme = explicit; break;}
      if (/(?:^|[\s_-])dark(?:$|[\s_-])/i.test(el.className)) {theme = "dark"; break;}
      if (/(?:^|[\s_-])light(?:$|[\s_-])/i.test(el.className)) {theme = "light"; break;}
    }
    if (!theme) for (const el of [...elements].reverse()) {
      const color = getComputedStyle(el).backgroundColor.match(/[\d.]+/g)?.map(Number);
      if (color && (color.length < 4 || color[3] === 1)) {
        theme = color[0]*0.2126 + color[1]*0.7152 + color[2]*0.0722 < 128 ? "dark" : "light";
        break;
      }
    }
    host.dataset.theme = theme || (systemTheme.matches ? "dark" : "light");
  }
  const themeObserver = new MutationObserver(syncTheme);
  for (const el of [document.documentElement, document.body].filter(Boolean))
    themeObserver.observe(el, {attributes:true, attributeFilter:["class","style","data-theme","data-color-mode"]});
  systemTheme.addEventListener("change", syncTheme);
  syncTheme();
  $("#search").addEventListener("input", () => {
    if (root.querySelector("#list details[open]")) message("请先收起正在编辑的记录，搜索将在收起后应用");
    render();
  });
  document.addEventListener("click", event => {
    if (!event.composedPath().includes(host)) $("#more").open = false;
  }, true);
  root.addEventListener("click", event => {
    if (!event.composedPath().includes($("#more")) || event.target.closest("#extras button")) $("#more").open = false;
  });
  function message(s) {
    $("#status").textContent = s;
  }
  const all = (includeDeleted = false) =>
    GM_listValues()
      .filter((k) => k.startsWith(PREFIX))
      .map((k) => GM_getValue(k))
      .filter((x) => x && typeof x.key === "string")
      .map(normalizeRecord)
      .filter(r => includeDeleted || !r.deletedAt);
  function normalizeRecord(r) {
    if (!r) return r;
    const outcome = outcomeOf(r);
    return {...r, outcome, done: outcome !== "pending"};
  }
  const get = (k) => normalizeRecord(GM_getValue(PREFIX + k));
  const save = (r) => GM_setValue(PREFIX + r.key, r);
  function localAction(fn) {
    try {
      fn();
    } catch (e) {
      message(e.message);
    } finally {
      render();
    }
  }
  const button = (label, fn, parent, local = false) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => (local ? localAction(fn) : run(fn));
    parent.append(b);
    return b;
  };
  async function run(fn) {
    if (busy) {
      message("正在检查，请稍候");
      return;
    }
    busy = true;
    message("正在检查，请稍候…");
    try {
      await fn();
    } catch (e) {
      message(e.message);
    } finally {
      busy = false;
      render();
    }
  }
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  function api(url) {
    const request = requestTail.then(() => requestApi(url));
    requestTail = request.catch(() => {});
    return request;
  }
  async function requestApi(url) {
    if (paused)
      throw Error("检查已暂停。请先确认登录或平台提示，再点“继续历史检查”。");
    const u = new URL(url);
    if (!["api.bilibili.com", "api.vc.bilibili.com"].includes(u.hostname))
      throw Error("拒绝非预设接口");
    await delay(Math.max(0, nextAt - Date.now()));
    if (paused) throw Error("检查已暂停，请先处理平台提示");
    nextAt = Date.now() + 1600;
    const body = await new Promise((resolve, reject) =>
      GM_xmlhttpRequest({
        method: "GET",
        url,
        timeout: 15000,
        onload: (r) => {
          try {
            if (r.status !== 200) {
              if ([401, 403, 412, 429].includes(r.status)) paused = true;
              throw Error("HTTP " + r.status);
            }
            resolve(JSON.parse(r.responseText));
          } catch (e) {
            reject(
              Error(
                "接口不可读（" +
                  e.message +
                  "），请手动填写；限制响应会暂停检查。",
              ),
            );
          }
        },
        onerror: () => reject(Error("网络请求失败")),
        ontimeout: () => reject(Error("读取超时")),
      }),
    );
    if (!body || typeof body !== "object" || typeof body.code !== "number")
      throw Error("接口响应结构异常，未取得有效数据");
    if (body.code !== 0) {
      if ([-101, -111, -352, -412, -509, 4101131].includes(body.code))
        paused = true;
      throw Error(
        "B站返回 " + body.code + "，未取得数据；请检查登录或平台限制。",
      );
    }
    if (!body.data || typeof body.data !== "object" || Array.isArray(body.data))
      throw Error("接口未返回有效数据");
    return body.data;
  }
  async function identity(force = false) {
    if (!me || force) {
      const d = await api("https://api.bilibili.com/x/web-interface/nav");
      if (d.isLogin !== true || !/^[1-9]\d*$/.test(String(d.mid))) {
        me = relationAccount = "";
        paused = true;
        throw Error("请先在 B站登录");
      }
      const next = String(d.mid);
      if (next !== me) relationAccount = "";
      me = next;
      GM_setValue("bili-reminder:last-uid", me);
    }
    return me;
  }
  const relationKey = (uid, account = relationAccount) => "bili-reminder:v1:relation:" + account + ":" + uid;
  function followState(uid) {
    if (paused) return {following: null, reason: "检查已暂停，请检查登录或平台提示"};
    const cached = relationAccount && uid && GM_getValue(relationKey(uid));
    if (!cached || cached.schema !== 2 || ![true,false,null].includes(cached.following) ||
      !Number.isFinite(cached.checkedAt) || cached.checkedAt > Date.now())
      return {following: null, reason: "尚未检查或缓存无效"};
    return cached;
  }
  function checkFollows(force = false) {
    if (followingTask) return followingTask;
    if (paused || stopScan) {
      if (force) $("#follow-status").textContent = "关注检查已暂停，请先处理登录或平台提示，再继续检查";
      return Promise.resolve();
    }
    const records = all(), now = Date.now();
    const priority = new Set(records.filter(record => outcomeOf(record) !== "pending" ||
      schedule(record) && Date.parse(schedule(record)) <= now).map(upKey));
    const knownGroups = upStatistics(records).filter(group => group.uid);
    const needsCheck = group => followRefreshNeeded(followState(group.uid), priority.has(group.key), force);
    if (!knownGroups.length || !force && relationAccount && knownGroups.every(group =>
      group.uid === relationAccount || !needsCheck(group))) return Promise.resolve();
    followingTask = (async () => {
      relationAccount = "";
      $("#follow-status").textContent = "正在核对登录并读取关注状态…";
      render();
      const account = await identity(force);
      relationAccount = account;
      const groups = knownGroups.filter(group => group.uid !== account && needsCheck(group));
      let checked = 0;
      for (const group of groups) {
        if (me !== account) throw Error("登录账号已变化，请重新检查关注状态");
        if (paused || stopScan) break;
        $("#follow-status").textContent = "正在检查关注状态：" + checked + " / " + groups.length;
        try {
          const data = await api("https://api.bilibili.com/x/relation?fid=" + group.uid);
          if (me !== account) throw Error("登录账号已变化，已丢弃本次关注响应");
          const following = relationFollowing(data, group.uid);
          GM_setValue(relationKey(group.uid, account), {schema: 2, following, checkedAt: Date.now(), reason: following === null ? "关注关系响应无法确认" : ""});
          checked++;
          render();
        } catch (e) {
          GM_setValue(relationKey(group.uid, account), {schema: 2, following: null, checkedAt: Date.now(), reason: e.message});
          throw e;
        }
      }
      $("#follow-status").textContent = groups.length
        ? (paused || stopScan ? "关注检查已暂停：" : "关注状态已检查：") + checked + " / " + groups.length + " 位UP主"
        : "关注状态沿用缓存，无需重查";
    })().catch(e => {
      $("#follow-status").textContent = "关注状态未完成：" + e.message;
    }).finally(() => {followingTask = null; render();});
    return followingTask;
  }
  function followBadge(uid) {
    const state = followState(uid);
    const badge = document.createElement("span");
    const [symbol, label, tone] = state.following === true
      ? ["✓", "已关注", "followed"] : state.following === false
        ? ["✗", "未关注", "unfollowed"] : ["?", "关注待核实", "unknown"];
    badge.className = "follow-badge";
    badge.textContent = symbol;
    badge.dataset.state = tone;
    badge.title = label + (state.checkedAt ? "；上次检查于 " + fmt(state.checkedAt) : "") + (state.reason ? "；" + state.reason : "");
    badge.setAttribute("aria-label", label);
    return badge;
  }
  function dynamicText(item) {
    const d = item?.modules?.module_dynamic || {};
    return [
      d.desc?.text,
      d.major?.opus?.title,
      d.major?.opus?.summary?.text,
      d.major?.archive?.title,
      d.major?.archive?.desc,
    ]
      .filter(Boolean)
      .join("\n");
  }
  function hasLotteryComponent(item) {
    const d = item?.modules?.module_dynamic;
    return [d?.desc, d?.major?.opus?.summary].some(part =>
      part?.rich_text_nodes?.some(node => node.type === "RICH_TEXT_NODE_TYPE_LOTTERY"));
  }
  function isLottery(item) {
    return hasLotteryComponent(item) || /抽奖|开奖|抽取|送出|幸运观众|抽出|抽送|随机抽|随机揪出|揪(?:一|1)位|roll出|抽(?:一个|一位|一人|1人)|开抽|抽|安排福利/.test(dynamicText(item));
  }
  function dynamicChain(item) {
    const chain = [];
    while (item) {
      if (chain.length === 9 || chain.includes(item)) throw Error("转发层级异常，请核实");
      chain.push(item);
      item = item.orig;
    }
    return chain;
  }
  function forwardedQuote(item) {
    const desc = item?.modules?.module_dynamic?.desc;
    const match = desc?.text?.match(/^\/\/\s*@([^:：]+)[:：]([\s\S]+)$/);
    const at = desc?.rich_text_nodes?.find(node => node.type === "RICH_TEXT_NODE_TYPE_AT");
    if (!match || !at || at.text.trim() !== "@" + match[1].trim() || !/^[1-9]\d*$/.test(String(at.rid))) return null;
    return {name: match[1].trim(), mid: String(at.rid), text: match[2]};
  }
  async function dynamicRecord(item, repost) {
    const repostedAt = repost
      ? Number(item.modules?.module_author?.pub_ts) || 0
      : 0;
    const aliases = [],
      reposts = [];
    if (repost) reposts.push(String(item.id_str));
    const chain = dynamicChain(item);
    const candidates = chain.slice(repost ? 1 : 0).filter(isLottery);
    const selected = candidates.at(-1);
    if (!selected && repost) {
      const quote = forwardedQuote(item);
      if (!quote || !isLottery(item)) return null;
      // B站可能扁平化中间转发：只保存可证实的文案和UID，不把底层视频当成主办方。
      const timing = parseTime(quote.text);
      return {key:"dynamic:" + item.id_str, url:"https://www.bilibili.com/opus/" + item.id_str,
        aliases:[], reposts, repostedAt, title:quote.text.slice(0,70), up:quote.name, uid:quote.mid,
        text:quote.text, ...timing, source:(timing.source || "") + "；转发文案，原活动链接待核实",
        forwardedOriginUnresolved:true, createdAt:new Date().toISOString(), checkedAt:new Date().toISOString(), done:false};
    }
    const target = selected || chain.at(-1);
    for (const parent of chain.slice(0, chain.indexOf(target))) aliases.push("dynamic:" + parent.id_str);
    item = target;
    if (!item?.id_str) throw Error("无法确定原动态ID，请手动填写");
    const d = item.modules?.module_dynamic || {},
      author = item.modules?.module_author || {};
    const key = "dynamic:" + item.id_str,
      text = dynamicText(item);
    let timing = parseTime(text, author.pub_ts);
    if (d.major?.archive?.bvid) aliases.push("video:" + d.major.archive.bvid);
    // 只读取抽奖组件中可识别的结构化开奖时间，不因“抽奖”文案认定官方类型。
    if (hasLotteryComponent(item)) {
      try {
        const notice = await api(
          "https://api.vc.bilibili.com/lottery_svr/v1/lottery_svr/lottery_notice?business_id=" +
            encodeURIComponent(item.id_str) +
            "&business_type=1",
        );
        if (notice?.lottery_id) {
          aliases.push("lottery:" + notice.lottery_id);
          const t = Number(notice.lottery_time);
          if (Number.isFinite(t) && t > 946684800 && t < 7258118400)
            timing = {
              time: new Date(t * 1000).toISOString(),
              precision: "time",
              source: "互动抽奖详情的结构化开奖时间",
              quote: "lottery_time=" + t,
            };
        }
      } catch (e) {
        timing = {
          ...timing,
          source:
            (timing.source || "时间待填") + "；官方详情未取得：" + e.message,
        };
      }
    }
    return {
      key,
      aliases,
      reposts,
      repostedAt,
      url: "https://www.bilibili.com/opus/" + item.id_str,
      title:
        d.major?.opus?.title ||
        d.major?.archive?.title ||
        text.slice(0, 70) ||
        "动态 " + item.id_str,
      up: author.name || "",
      uid: String(author.mid || ""),
      text,
      ...timing,
      createdAt: new Date().toISOString(),
      checkedAt: new Date().toISOString(),
      done: false,
    };
  }
  function put(record) {
    const ids = new Set([record.key, ...(record.aliases || [])]);
    const matches = all(true).filter((r) =>
      [r.key, ...(r.aliases || [])].some((k) => ids.has(k)),
    );
    let result = record;
    for (const old of matches) result = mergeRecord(old, result);
    save(result);
    for (const old of matches)
      if (old.key !== result.key) GM_deleteValue(PREFIX + old.key);
    return result;
  }
  async function detail(link) {
    if (link.key.startsWith("video:")) {
      const d = await api(
        "https://api.bilibili.com/x/web-interface/view?bvid=" + link.id,
      );
      return {
        key: link.key,
        url: link.url,
        title: d.title,
        up: d.owner?.name || "",
        uid: String(d.owner?.mid || ""),
        text: d.desc || "",
        ...parseTime(d.desc || "", d.pubdate),
        createdAt: new Date().toISOString(),
        checkedAt: new Date().toISOString(),
      };
    }
    const d = await api(
      "https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?features=itemOpusStyle&id=" +
        link.id,
    );
    return dynamicRecord(d.item, false);
  }
  async function scanMine(mode = "resume") {
    const uid = await identity();
    if (dynamicPageUid() !== uid)
      throw Error("请打开自己的个人空间 → 动态");
    const worker = async () => {
      const knownReposts = new Set(all(true).flatMap((r) => r.reposts || []));
      stopScan = false;
      let state = scanState();
      const recent = mode === "recent";
      if (mode === "restart") state = freshScan("检查中");
      if (state.complete && !recent) {
        message("历史已检查到接口末尾；之后自动检查新增动态。");
        return;
      }
      let offset = recent ? "" : state.offset,
        hitKnown = false;
      state.status = recent ? "正在检查新增动态" : "正在自动翻页检查历史";
      GM_setValue(scanKey(), state);
      render();
      try {
        do {
          if (stopScan || paused) break;
          const d = await api(
            "https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?features=itemOpusStyle&host_mid=" +
              uid +
              (offset ? "&offset=" + encodeURIComponent(offset) : ""),
          );
          const hasMore = pageHasMore(d);
          for (let i = recent ? 0 : state.index; i < d.items.length; i++) {
            if (stopScan || paused) break;
            const item = d.items[i];
            if (recent && knownReposts.has(String(item.id_str)))
              hitKnown = true;
            if (String(item.modules?.module_author?.mid) === uid && item.orig) {
              if (dynamicChain(item).some(isLottery)) {
                const r = await dynamicRecord(item, true);
                if (r) {put(r); if (!recent) state.matched++;}
                else if (!recent) state.other++;
              } else if (!recent) state.other++;
            }
            if (!recent) {
              state.examined++;
              state.index = i + 1;
              GM_setValue(scanKey(), state);
            }
            message(recent ? "正在从最新动态检查…" : "正在检查历史动态…");
            render();
          }
          if (stopScan || paused) break;
          if (recent) {
            if (hitKnown || !hasMore) break;
            if (!d.offset || d.offset === offset)
              throw Error("新增动态分页未前进");
            offset = d.offset;
            continue;
          }
          state.pages++;
          state.index = 0;
          if (!hasMore) {
            state.complete = true;
            state.offset = "";
            state.status = "历史检查完成（仅限接口可见动态）";
            GM_setValue(scanKey(), state);
            break;
          }
          if (!d.offset || d.offset === offset)
            throw Error("历史分页未前进，已停止，未认定检查完成");
          offset = state.offset = d.offset;
          GM_setValue(scanKey(), state);
        } while (recent || !state.complete);
        if (stopScan || paused) {
          state.status = "已暂停，保留进度";
          GM_setValue(scanKey(), state);
        } else if (recent) {
          state.status = "新增动态检查完成";
          GM_setValue(scanKey(), state);
        }
        message(stopScan||paused?"已暂停，进度已保存":"已更新 · "+all().length+" 场活动");
      } catch (e) {
        state.status = "检查中断：" + e.message;
        GM_setValue(scanKey(), state);
        throw e;
      }
    };
    if (navigator.locks)
      await navigator.locks.request(
        "bili-reminder-scan-" + uid,
        { ifAvailable: true },
        (lock) =>
          lock ? worker() : message("另一个标签正在检查，请在该标签查看进度"),
      );
    else await worker();
  }
  async function recordCurrent() {
    const link = canonical(location.href);
    if (!link) throw Error("请在具体视频或动态详情页操作");
    try {
      put(await detail(link));
      checkFollows();
      message("已记录。若开奖时间未识别，请在下面补填。");
    } catch (e) {
      put({
        ...link,
        title: document.title.replace(/[_-]哔哩哔哩.*$/, ""),
        createdAt: new Date().toISOString(),
        source: "接口读取失败，请手填",
        manual: [],
      });
      throw e;
    }
  }
  async function scanAndCheckFollows(mode) {
    await scanMine(mode);
    if (!paused && !stopScan) checkFollows();
  }
  const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short",
  });
  function fmt(t) {
    const at = typeof t === "number" ? t : validTime(t) ? Date.parse(t) : NaN;
    return Number.isFinite(at) ? dateFormatter.format(new Date(at)) : "待填写";
  }
  function input(parent, label, value) {
    const l = document.createElement("label");
    l.textContent = label;
    const i = document.createElement("input");
    i.value = value || "";
    l.append(i);
    parent.append(l);
    return i;
  }
  // 定位只读取页面和滚动，不触发关注、点赞、转发等账号操作。
  let locationRun = 0, locating = false;
  function repostIds(record) {
    return (record.reposts || []).filter(id => /^\d{8,25}$/.test(String(id)))
      .map(String).sort((a,b) => BigInt(a)>BigInt(b)?-1:BigInt(a)<BigInt(b)?1:0);
  }
  function dynamicCardText(card) {
    // innerText不包含表情图片的alt；按DOM顺序补回，保留表情差异和隐藏内容过滤。
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    const parts = [];
    for (let node; (node = walker.nextNode());) {
      const text = node.nodeType === Node.TEXT_NODE ? node.nodeValue
        : node.tagName === "IMG" ? node.getAttribute("alt") : "";
      if (!text) continue;
      const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      if (el.getClientRects().length && getComputedStyle(el).visibility === "visible") parts.push(text);
    }
    return parts.join("");
  }
  function findDynamic(record) {
    if (!ownDynamicPage()) return null;
    const ids = repostIds(record);
    const aliases = new Set([record.key, ...(record.aliases || [])]);
    const cards = [...document.querySelectorAll('.bili-dyn-list__item, .bili-dyn-item, [data-did], [data-dynamic-id], [data-dyn-id]')].filter(el=>el.getClientRects().length);
    const outer = [...new Set(cards.map(el=>el.closest('.bili-dyn-list__item')||el))];
    const links = outer.map(el=>({el, keys:new Set([...el.querySelectorAll('a[href]')].map(a=>canonical(a.href)?.key))}));
    const unique = matches => {
      if(matches.length>1)throw Error('列表中有多条对应的动态，无法准确定位，已停止');
      return matches[0] || null;
    };
    for (const id of ids) {
      const card = cards.find(el => ['data-did','data-dynamic-id','data-dyn-id','data-id'].some(attr => el.getAttribute(attr)===id) || el.id===id || el.id==='dynamic_'+id);
      if (card) return card.closest('.bili-dyn-list__item') || card;
      const linked = links.find(item=>item.keys.has('dynamic:'+id));
      if(linked)return linked.el;
    }
    // 某些页面只在卡片里提供原动态链接；不使用标题模糊匹配。
    const linked = unique(links.filter(item=>[...item.keys].some(key=>aliases.has(key))).map(item=>item.el));
    if(linked)return linked;
    // 实际空间页的卡片只带class，不公开动态ID。仅在自己的列表中做精确唯一匹配。
    const normalize=value=>String(value||'').replace(/[\s\u200B-\u200D\uFEFF]/g,'').replace(/互动抽奖/g,'');
    const up=normalize(record.up),title=normalize(record.title);
    // 通用短标题不能单独定位，改用已保存的完整正文，仍须UP主和内容唯一匹配。
    const content=title.length>=8?title:normalize(record.text);
    if(up&&content.length>=8){
      const matches=outer.filter(el=>{const text=normalize(dynamicCardText(el));return text.includes(up)&&text.includes(content);});
      return unique(matches);
    }
    return null;
  }
  function highlightDynamic(el) {
    el.scrollIntoView({behavior:'smooth', block:'center'});
    el.setAttribute('data-bili-reminder-located','true');
    el.animate?.([{outline:'3px solid #1681a4',outlineOffset:'4px'},{outline:'3px solid transparent',outlineOffset:'4px'}],{duration:4000});
    setTimeout(()=>el.removeAttribute('data-bili-reminder-located'),4000);
    $('#panel').hidden = true;
  }
  async function locateDynamic(record) {
    const run=++locationRun;
    locating=false;
    if(!ownDynamicPage()){message('请回到自己的动态列表再点击定位；不会跳转活动页');return;}
    locating=true;
    try{
      for(let attempt=0;attempt<=12&&run===locationRun;attempt++){
        const card=findDynamic(record);if(card){highlightDynamic(card);message('已定位对应动态');return;}
        if(attempt===12||/你已经到达世界的尽头|没有更多动态|没有更多了/.test(document.body.innerText))break;
        if(attempt===0)message('正在加载列表查找，按 Esc 可取消');
        const cards=document.querySelectorAll('.bili-dyn-list__item, .bili-dyn-item');
        if(cards.length)cards[cards.length-1].scrollIntoView({block:'end'});
        window.scrollTo({top:Math.max(document.documentElement.scrollHeight,document.body.scrollHeight),behavior:'instant'});
        await delay(700);
      }
      if(run===locationRun)message('没有在当前列表准确找到这条动态，已停止；页面不会跳转');
    }finally{if(run===locationRun)locating=false;}
  }
  function cancelLocation(){if(locating){locationRun++;locating=false;message('已取消定位');}}
  window.addEventListener('keydown',event=>{if(event.key==='Escape')cancelLocation();});
  window.addEventListener('wheel',event=>{if(event.isTrusted)cancelLocation();},{passive:true});
  function switchView(value, up = "") {
    if (root.querySelector("#list details[open]")) {
      message("请先收起正在编辑的记录");
      return;
    }
    filter = value;
    upFilter = up;
    $("#more").open = false;
    if (value === "stats") checkFollows();
  }
  function renderStatistics(list, groups, c) {
    const heading = document.createElement("h3");
    heading.className = "view-title";
    heading.textContent = "抽奖统计";
    list.append(heading);
    const actions = document.createElement("div");
    actions.className = "summary-actions";
    for (const [label, value, count] of [["全部活动", "history", c.recorded], ["未中奖", "lost", c.lost], ["已中奖", "won", c.won]])
      button(label + " " + count, () => switchView(value), actions, true);
    list.append(actions);
    const note = document.createElement("p");
    note.className = "stats-tip";
    note.textContent = "只统计本机已记录的活动，不代表UP主发布的全部抽奖。结果由你标记；旧版已处理按未中奖计入。UID相同合并，UID缺失时暂不合并。✓已关注，✗未关注，?待核实。未到期活动可沿用上次检查结果，悬停查看时间；更多里可手动刷新。";
    list.append(note);
    const table = document.createElement("table");
    table.className = "up-table";
    const head = table.createTHead().insertRow();
    for (const text of ["UP主 / UID", "活动", "未中", "中奖"]) {
      const th = document.createElement("th"); th.scope = "col"; th.textContent = text; head.append(th);
    }
    const body = table.createTBody();
    for (const group of groups) {
      const row = body.insertRow(); row.dataset.up = group.key;
      const author = row.insertCell();
      const name = upLink(group.name, group.uid);
      author.append(followBadge(group.uid), name, document.createElement("br"), document.createTextNode(group.uid ? "UID " + group.uid : "UID待填写"));
      for (const [value, number] of [["history", group.total], ["lost", group.lost], ["won", group.won]])
        button(String(number), () => switchView(value, group.key), row.insertCell(), true);
    }
    list.append(table);
    if (!groups.length) {const empty = document.createElement("p"); empty.textContent = $("#search").value.trim() ? "没有匹配的UP主。" : "尚无记录。"; list.append(empty);}
  }
  function render() {
    const records = (filter === "deleted" ? all(true).filter(r=>r.deletedAt) : all()).sort(activityOrder);
    const c = counts(all());
    $("#toggle").textContent = "抽奖 " + c.total + " · 待提醒 " + c.soon;
    updateCapsule(all());
    for (const [key, value] of Object.entries(c)) {
      const tile = root.querySelector('[data-count="' + key + '"]');
      if (tile) tile.textContent = value;
    }
    for (const tile of root.querySelectorAll("#stats button"))
      tile.setAttribute("aria-pressed", String(tile.dataset.filter === filter || tile.dataset.filter === "stats" && (["history", "lost", "won"].includes(filter) || upFilter)));
    const state = scanState();
    $("#progress").textContent = owner()
      ? state.complete
        ? "历史已检查完成 · " + state.examined + " 条动态"
        : "历史已检查 " +
          state.examined +
          " 条动态 · " +
          (state.status || "待继续")
      : "进入自己的动态页，将自动检查最新动态。";
    if (
      root.activeElement?.tagName === "INPUT" && root.activeElement.id !== "search" ||
      root.querySelector("#list details[open]")
    )
      return;
    const list = $("#list");
    list.replaceChildren();
    const groups = upStatistics(records);
    const query = $("#search").value;
    if (filter === "stats") {
      const matchedGroups = new Set(records.filter(record => matchesSearch(record, query)).map(upKey));
      renderStatistics(list, groups.filter(group => matchedGroups.has(group.key)), c);
      return;
    }
    const byUp = new Map(groups.map(group => [group.key, group]));
    for (const record of records) {
      const group = byUp.get(upKey(record));
      if (!group.lastKey) group.lastKey = record.key;
    }
    if (["history", "lost", "won"].includes(filter) || upFilter) {
      const heading = document.createElement("h3");
      heading.className = "view-title";
      const group = upFilter && byUp.get(upFilter);
      heading.textContent = (group ? group.name + " · " : "") + ({history: "全部活动", lost: "未中奖", won: "已中奖", all: "待处理"}[filter] || "活动");
      list.append(heading);
      button("返回统计", () => switchView("stats"), list, true);
    }
    const now = Date.now();
    let visible = 0;
    for (const r of records) {
      if (!matchesSearch(r, query)) continue;
      if (upFilter && upKey(r) !== upFilter) continue;
      if (filter === "all" && r.done) continue;
      if (
        filter === "soon" &&
        (r.done ||
          !schedule(r) ||
          Date.parse(schedule(r)) <= now ||
          Date.parse(schedule(r)) > now + 7 * 86400000)
      )
        continue;
      if (
        filter === "due" &&
        (r.done || !schedule(r) || Date.parse(schedule(r)) > now)
      )
        continue;
      if (filter === "unknown" && (r.done || schedule(r))) continue;
      if (["lost", "won"].includes(filter) && outcomeOf(r) !== filter) continue;
      visible++;
      const a = document.createElement("article");
      a.style.cursor = 'pointer';
      a.title = '点击空白处定位自己的对应动态';
      a.tabIndex = 0;
      a.addEventListener('click',event=>{
        if(event.target.closest('a,button,input,textarea,select,label,details,[contenteditable]') || window.getSelection()?.toString())return;
        locateDynamic(get(r.key)||r).catch(e=>message(e.message));
      });
      a.addEventListener('keydown',event=>{
        if(event.target===a && event.key==='Enter'){event.preventDefault();locateDynamic(get(r.key)||r).catch(e=>message(e.message));}
      });
      if (!r.done && schedule(r) && Date.parse(schedule(r)) <= Date.now())
        a.className = "due";
      const title = document.createElement("a");
      title.textContent = activityTitle(r);
      title.title = r.title || r.key;
      title.href = r.url;
      title.target = "_blank";
      title.rel = "noopener noreferrer";
      a.append(title);
      const p = document.createElement("p");
      const updateInfo = record => {
        const group = byUp.get(upKey(record));
        activityInfo(p, record, unfollowHint(record, group,
          followState(group?.uid).following, group?.lastKey));
      };
      updateInfo(r);
      a.append(p);
      const note = document.createElement("small");
      note.textContent = r.resultConflict ? "结果记录冲突，请重新标记确认" : r.conflict
        ? "开奖时间有变动，请核对"
        : !schedule(r)
          ? "待补充开奖日期"
          : r.source === "手动确认"
            ? "手动记录"
            : "";
      a.append(note);
      const details = document.createElement("details");
      details.addEventListener("toggle", () => {
        if (details.isConnected && !details.open) render();
      });
      const summary = document.createElement("summary");
      summary.textContent = "编辑日期与信息";
      details.append(summary);
      const localTime = validTime(r.time)
        ? new Date(Date.parse(r.time) + 8 * 3600000).toISOString() : "";
      const ti = input(details, "活动标题", r.title),
        up = input(details, "UP主", r.up),
        uid = input(details, "UID", r.uid),
        time = input(
          details,
          "时间（可留空）",
          localTime.slice(11, 16),
        );
      time.type = "text";
      time.placeholder = "输入1930即19:30，930即09:30（24小时制）";
      time.inputMode = "numeric";
      time.maxLength = 5;
      time.pattern = "(?:[01][0-9]|2[0-3]):[0-5][0-9]";
      time.addEventListener("blur", () => { time.value = normalizeClock(time.value); });
      const day = input(
        details,
        "开奖日期",
        r.drawDate || localTime.slice(0, 10),
      );
      day.type = "date";
      details.insertBefore(day.parentElement, time.parentElement);
      const quote = document.createElement("small");
      quote.textContent =
        "识别依据：" +
        (r.quote || "无") +
        (r.proposedTime ? "；新检测时间：" + fmt(r.proposedTime) : r.proposedDate ? "；新检测日期：" + r.proposedDate : "");
      details.append(quote);
      const saved = document.createElement("p");
      saved.setAttribute("role", "status");
      saved.style.color = "var(--success)";
      details.append(saved);
      button(
        "保存",
        () => {
          try {
            const current = get(r.key);
            if (!current) throw Error("记录不存在，请重新打开活动");
            const v = uid.value.trim();
            if (v && !/^[1-9]\d*$/.test(v)) throw Error("UID需填写大于0的数字");
            time.value = normalizeClock(time.value);
            if (day.validity.badInput || time.validity.badInput || (time.value && !time.validity.valid))
              throw Error("请检查日期和时间是否填写完整");
            if (time.value && !day.value) throw Error("请先填写开奖日期");
            const t =
              day.value && time.value
                ? manualTime(day.value + "T" + time.value)
                : null;
            const drawDate = day.value && !time.value ? day.value : null;
            const remindAt = drawDate ? manualTime(drawDate + "T09:00") : null;
            const updated = {
              ...current,
              title: ti.value.slice(0, 200),
              up: up.value.slice(0, 100),
              uid: v,
              time: t,
              drawDate,
              remindAt,
              precision: t ? "time" : drawDate ? "date" : "unknown",
              source: "手动确认",
              quote: drawDate
                ? "用户填写日期：" + drawDate + "；具体时刻未知；当天09:00提醒"
                : t
                  ? "用户填写：" + time.value
                  : "用户确认时间未知",
              manual: ["title", "up", "uid", "time"],
              conflict: null,
              proposedTime: null,
              proposedDate: null,
              notified:
                (t || remindAt) === schedule(current) ? current.notified : null,
            };
            save(updated);
            const persisted = get(r.key);
            if (
              !persisted ||
              persisted.time !== t ||
              persisted.drawDate !== drawDate ||
              persisted.title !== updated.title
            )
              throw Error("保存未通过读取核对，请重试");
            title.textContent = activityTitle(updated);
            updateInfo(updated);
            note.textContent = "手动确认；已保存到本机";
            quote.textContent = "时间依据：" + updated.quote;
            saved.style.color = "var(--success)";
            saved.textContent =
              "已保存并核对：" + drawLabel(updated) + "。刷新页面后仍保留。";
            message(
              "已保存：" + updated.title + "；开奖 " + drawLabel(updated),
            );
            if (filter === "unknown" && schedule(updated)) {
              details.open = false;
              a.remove();
            }
          } catch (e) {
            saved.style.color = "var(--danger)";
            saved.textContent = "未保存：" + e.message;
            throw e;
          }
        },
        details,
        true,
      );
      a.append(details);
      button(r.deletedAt ? "恢复记录" : "删除记录", () => {
        const current = get(r.key);
        if (!current) return;
        save({...current, deletedAt: r.deletedAt ? null : new Date().toISOString()});
        details.open = false;
        a.remove();
        message(r.deletedAt ? "已恢复本地记录" : "已移入已删除记录，可在更多中恢复；未删除B站动态");
      }, details, true);
      for (const [label, outcome] of (r.done
        ? [["恢复待处理", "pending"], [outcomeOf(r) === "won" ? "改为未中奖" : "改为中奖", outcomeOf(r) === "won" ? "lost" : "won"]]
        : [["标记未中奖", "lost"], ["标记中奖", "won"]])) {
        button(label, () => {
          const current = get(r.key);
          if (current) {
            save({...current, outcome, done: outcome !== "pending", resultConflict: false});
            details.open = false;
            a.remove();
          }
        }, a, true);
      }
      button(
        "重新读取本活动",
        async () => {
          const link = canonical(r.url);
          if (!link) throw Error("活动链接无效");
          put(await detail(link));
          message("已重新检查，手填信息已保留。");
        },
        details,
      );
      button(
        "与另一条合并",
        () => {
          const other = prompt(
            "输入另一条已记录活动的原链接；只合并你明确认为是同一活动的记录",
          );
          if (!other) return;
          const c = canonical(other);
          const target =
            c &&
            all().find(
              (x) =>
                x.key !== r.key &&
                [x.key, ...(x.aliases || [])].includes(c.key),
            );
          if (!target) throw Error("未找到另一条记录");
          save(mergeRecord(get(r.key), target));
          GM_deleteValue(PREFIX + target.key);
          message("已合并为一条，原链接保留作去重依据。");
        },
        details,
        true,
      );
      list.append(a);
    }
    if (!visible) {
      const empty = document.createElement("p");
      empty.textContent = records.length
        ? "当前筛选没有活动。"
        : "尚无记录。你自己的动态页会识别转发；其他活动页请点“记录当前：我已参与”。";
      list.append(empty);
    }
  }
  for (const [label, value, key] of [
    ["待处理", "all", "total"],
    ["7天内", "soon", "soon"],
    ["已到期", "due", "due"],
    ["待填写", "unknown", "unknown"],
    ["统计", "stats", "recorded"],
  ]) {
    const tile = document.createElement("button");
    tile.dataset.filter = value;
    const n = document.createElement("strong");
    n.dataset.count = key;
    n.textContent = "0";
    const caption = document.createElement("span");
    caption.textContent = label;
    tile.append(n, caption);
    tile.onclick = () => localAction(() => switchView(value));
    $("#stats").append(tile);
  }
  const tools = $("#tools"),
    extras = $("#extras");
  button("刷新近期", () => scanAndCheckFollows("recent"), tools);
  if (canonical(location.href)) button("记录当前活动", recordCurrent, tools);
  button("检查全部历史", () => scanAndCheckFollows("restart"), extras);
  button("刷新关注状态", () => checkFollows(true), extras);
  button("已删除记录", () => switchView("deleted"), extras, true);
  button("暂停检查", () => {
    stopScan = true;
    message("当前读取结束后暂停，进度会保留");
  }, extras, true);
  button(
    "继续历史检查",
    () => {
      paused = false;
      return scanAndCheckFollows();
    },
    extras,
  );
  button(
    "测试提醒",
    () => {
      GM_notification({
        title: "抽奖备忘录 · 测试",
        text: "这是通知测试，不是真实开奖提醒。",
        timeout: 8000,
      });
      message("已发送测试提醒。");
    },
    extras,
    true,
  );
  button(
    "导出备份",
    () => {
      const blob = new Blob(
        [
          JSON.stringify(
            { format: "bili-reminder-v1", records: all(true) },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      );
      const url = URL.createObjectURL(blob),
        a = document.createElement("a");
      a.href = url;
      a.download =
        "B站抽奖备忘录-" + new Date().toISOString().slice(0, 10) + ".json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    },
    extras,
    true,
  );
  button(
    "导入备份",
    () => {
      const file = document.createElement("input");
      file.type = "file";
      file.accept = ".json";
      file.onchange = () =>
        run(async () => {
          const f = file.files[0];
          if (!f) return;
          if (f.size > 5e6) throw Error("备份过大");
          const data = JSON.parse(await f.text());
          if (
            data.format !== "bili-reminder-v1" ||
            !Array.isArray(data.records) ||
            data.records.length > 5000
          )
            throw Error("备份格式错误");
          data.records.forEach(validateRecord);
          for (const r of data.records) put(r);
          message("导入完成，同一活动已去重。");
        });
      file.click();
    },
    extras,
    true,
  );
  $("#toggle").onclick = () => {
    $("#panel").hidden = !$("#panel").hidden;
    render();
  };
  $("#close").onclick = () => {
    $("#panel").hidden = true;
  };
  GM_registerMenuCommand("打开抽奖备忘录", () => {
    $("#panel").hidden = false;
    render();
  });
  // GM共享租约协调不同B站子域；Web Locks额外协调同来源标签。
  async function remind() {
    const task = async () => {
      const leaseKey = "bili-reminder:v1:reminder-owner",
        lease = GM_getValue(leaseKey);
      if (lease && lease.until > Date.now() && lease.owner !== reminderOwner) {
        render();
        return;
      }
      GM_setValue(leaseKey, {
        owner: reminderOwner,
        until: Date.now() + 45000,
      });
      await delay(120);
      if (GM_getValue(leaseKey)?.owner !== reminderOwner) return;
      for (const r of all()) {
        if (
          r.done ||
          !schedule(r) ||
          Date.parse(schedule(r)) > Date.now() ||
          r.notified === schedule(r)
        )
          continue;
        const latest = get(r.key);
        if (latest?.notified === schedule(r)) continue;
        try {
          GM_notification({
            title:
              r.precision === "date"
                ? "今天是记录的开奖日期（具体时刻未知）"
                : "已到记录的开奖时间",
            text:
              (r.up || "UP主待确认") +
              "：" +
              r.title +
              "。请打开活动核实开奖。",
            timeout: 15000,
            onclick: () => window.open(r.url, "_blank", "noopener"),
          });
          save({ ...latest, notified: schedule(r) });
        } catch (_) {
          message("系统提醒不可用，请查看面板内到期活动");
        }
      }
      render();
    };
    if (navigator.locks)
      await navigator.locks.request("bili-reminder-notifications", task);
    else await task();
  }
  async function routeCheck(force = false) {
    if (capsuleUrl !== location.href) updateCapsule(all());
    if (busy || (!force && route === location.href)) return;
    route = location.href;
    message("请在自己的动态页检查转发，或在活动详情页记录。");
    render();
    if (dynamicPageUid())
      await run(async () => {
        if (dynamicPageUid() === (await identity(force))) {
          $("#panel").hidden = false;
          if (all().length || scanState().examined) await scanMine("recent");
          if (!paused && !stopScan && !scanState().complete)
            await scanMine("resume");
          if (!paused && !stopScan) checkFollows();
        } else
          message(
            "这是其他UP主的动态页，不自动扫描。请打开自己的动态页或具体活动。",
          );
      });
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) routeCheck(true);
  });
  routeCheck();
  remind();
  setInterval(routeCheck, 1000);
  setInterval(remind, 30000);
  setInterval(
    () => {
      if (
        !paused &&
        !busy &&
        me && dynamicPageUid() === me
      )
        run(() => scanAndCheckFollows("recent"));
    },
    FOLLOW_TTL,
  );
})();
