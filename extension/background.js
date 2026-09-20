
//

//

import * as cdp from './cdp.js';
import { matchChallenge, hostOf, hostMatches, L2_ORIGINS_SEED } from './risk.js';
import { CRED_URL, redactCreds } from './redact.js';
import { identityOf, stripMarkPrefix } from './identity.js';
import { validateScript, condText, repeatMax, EXEC_BUDGET } from './script.js';

const fastRuns = new Map();
const fastTabWatches = new Map();
const fastCanceledRuns = new Set();

//

//

let ensuring = null;
let offscreenFailed = null;   

async function ensureOffscreen() {
  if (ensuring) return ensuring;
  ensuring = (async () => {
    try {
      if (!chrome.offscreen) throw new Error('This Chrome has no offscreen API');
      if (await chrome.offscreen.hasDocument()) return true;
      
      
      
      await Promise.race([
        chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['WORKERS'],
          justification: 'Keep a long-lived connection to the local bridge (127.0.0.1); the service worker gets recycled and the connection would drop with it.',
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('createDocument returned nothing after 8s')), 8000)),
      ]);
      offscreenFailed = null;
      return true;
    } catch (e) {
      
      if (String(e?.message || '').includes('Only a single offscreen')) return true;
      offscreenFailed = String(e?.message || e);
      chrome.storage.session.set({ offscreenError: offscreenFailed }).catch(() => {});
      return false;
    } finally {
      ensuring = null;
    }
  })();
  return ensuring;
}

async function toBridge(msg) {
  if (await ensureOffscreen()) {
    const r = await chrome.runtime.sendMessage({ __hcBridge: 'out', msg }).catch(() => null);
    if (r?.sent) return;
  }
  if (directSend(msg)) return;   
  await stash(msg);              
}

//

const OUTBOX = 'outbox';
async function stash(msg) {
  if (msg?.type !== 'res') return;   
  try {
    const { [OUTBOX]: list = [] } = await chrome.storage.session.get(OUTBOX);
    list.push({ t: Date.now(), msg });
    await chrome.storage.session.set({ [OUTBOX]: list.slice(-50) });
  } catch {  }
}
async function flushOutbox(sendFn) {
  let list = [];
  try { ({ [OUTBOX]: list = [] } = await chrome.storage.session.get(OUTBOX)); } catch { return; }
  if (!list.length) return;
  await chrome.storage.session.remove(OUTBOX).catch(() => {});
  const fresh = list.filter((it) => Date.now() - it.t < 60000);
  for (const it of fresh) await sendFn(it.msg);
}

//

//

async function connected() {
  return (await connState()).connected;
}

async function connState() {
  if (directWs?.readyState === 1 && Date.now() - directLastRx <= DIRECT_DEAD_MS) {
    return { connected: true, lastRx: directLastRx, bridge: directBridgeVersion, leg: 'direct' };
  }
  const r = await chrome.runtime.sendMessage({ __hcBridge: 'status' }).catch(() => null);
  return { connected: !!r?.connected, lastRx: r?.lastRx || directLastRx || 0, bridge: r?.bridge || '', leg: 'offscreen', offscreenError: offscreenFailed };
}

function noteBridgeVersion(v) {
  if (!v) return;
  const mine = chrome.runtime.getManifest().version;
  bridgeMismatch = v === mine ? '' : v;
  chrome.action.setTitle({ title: bridgeMismatch
    ? `beat-browser: extension v${mine} and bridge v${v} do not match; reload it once at chrome://extensions`
    : 'beat-browser' });
  setBadge(true);
}

//

const PORTS = [18899, 18900, 18901, 18902, 18903];
const DIRECT_DEAD_MS = 45000;   
let directWs = null;
let directTimer = null;
let directLastRx = 0;
let directLastTick = 0;
let directBridgeVersion = '';

//

//

let iidCache = null;
async function instanceId() {
  if (iidCache) return iidCache;
  try {
    const { hcInstanceId } = await chrome.storage.local.get('hcInstanceId');
    if (hcInstanceId) return (iidCache = hcInstanceId);
    const fresh = crypto.randomUUID();
    await chrome.storage.local.set({ hcInstanceId: fresh });
    return (iidCache = fresh);
  } catch {
    return null;   
  }
}

const isHeadless = () => /HeadlessChrome/.test(navigator.userAgent);

function directSend(msg) {
  if (directWs?.readyState === 1) { directWs.send(JSON.stringify(msg)); return true; }
  directConnect();
  return false;
}

//

//

async function directConnect() {
  if (directWs && directWs.readyState <= 1) return;
  
  
  const iid = await instanceId();
  for (const port of PORTS) {
    try {
      directWs = await new Promise((resolve, reject) => {
        const sock = new WebSocket(`ws://127.0.0.1:${port}`);
        const t = setTimeout(() => { sock.close(); reject(new Error('timeout')); }, 1500);
        sock.onopen = () => sock.send(JSON.stringify({
          type: 'hello', role: 'extension', extId: chrome.runtime.id,
          version: chrome.runtime.getManifest().version,
          instanceId: iid, headless: isHeadless(),
          chrome: (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1], v: 1,
        }));
        sock.onmessage = (ev) => {
          const m = JSON.parse(ev.data);
          if (m.type !== 'welcome') { clearTimeout(t); sock.close(); return reject(new Error('rejected')); }
          clearTimeout(t);
          directLastRx = Date.now();
          directBridgeVersion = String(m.bridge || '');
          sock.onmessage = (e) => {
            directLastRx = Date.now();
            const x = JSON.parse(e.data);
            if (x.type === 'pong') return;
            if (x.type === 'ping') { if (sock.readyState === 1) sock.send(JSON.stringify({ type: 'pong' })); return; }
            onMessage(x);
          };
          sock.onclose = () => { directWs = null; stopDirectPing(); setBadge(false); };
          sock.onerror = () => {};
          resolve(sock);
        };
        sock.onerror = () => { clearTimeout(t); reject(new Error('error')); };
      });
      startDirectPing();
      setBadge(true);
      noteBridgeVersion(directBridgeVersion);
      void flushOutbox(async (m) => { if (directWs?.readyState === 1) directWs.send(JSON.stringify(m)); });
      return;
    } catch {  }
  }
  setBadge(false);
}

function startDirectPing() {
  stopDirectPing();
  directLastTick = Date.now();
  directTimer = setInterval(() => {
    const now = Date.now();
    const slept = now - directLastTick > 30000;   
    directLastTick = now;
    if (directWs?.readyState !== 1) return directConnect();
    if (slept) { directLastRx = now; directWs.send(JSON.stringify({ type: 'ping' })); return; }
    if (now - directLastRx > DIRECT_DEAD_MS) {
      try { directWs.close(); } catch {  }
      directWs = null;
      stopDirectPing();
      setBadge(false);
      return directConnect();
    }
    directWs.send(JSON.stringify({ type: 'ping' }));
  }, 15000);
}
function stopDirectPing() {
  if (directTimer) clearInterval(directTimer);
  directTimer = null;
}

let bridgeMismatch = '';   

function setBadge(on) {
  if (on && bridgeMismatch) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
    return;
  }
  chrome.action.setBadgeText({ text: on ? '' : '·' });
  chrome.action.setBadgeBackgroundColor({ color: on ? '#22c55e' : '#94a3b8' });
}

const reply = (id, ok, payload, k) => {
  const base = { type: 'res', id, __k: k };
  return toBridge(ok ? { ...base, ok: true, data: payload } : { ...base, ok: false, error: payload });
};
const emit = (event, extra = {}) => toBridge({ type: 'event', event, ...extra });

const NO_SLOT_CMDS = new Set(['tabs', 'download', 'reload', 'status']);

async function onMessage(msg) {
  if (msg.type === 'event') return onBridgeEvent(msg);
  if (msg.type !== 'cmd') return;
  try {
    const handler = HANDLERS[msg.cmd];
    if (!handler) throw err('INTERNAL', `Unknown command ${msg.cmd}`);
    if (msg.cmd.startsWith('fast_')) {
      const data = await handler(msg.params || {}, msg.tabId, { sid: msg.sid });
      return reply(msg.id, true, data, msg.__k);
    }
    
    
    
    
    
    await noteSession(msg.sid, msg.label || msg.client, msg.live);
    
    
    const ctx = { sid: msg.sid, live: msg.live, adopted: false };
    const tabId = NO_SLOT_CMDS.has(msg.cmd) ? msg.tabId : await resolveTab(msg.tabId, msg.sid, ctx);
    
    
    if (tabId && msg.sid && !NO_SLOT_CMDS.has(msg.cmd)) await registerTab(msg.sid, tabId);
    let data = await handler(msg.params || {}, tabId, ctx);
    
    
    
    
    
    
    const marked = tabId || data?.tabId;
    if (marked) void syncMark(marked, { sid: msg.sid, act: actText(msg.cmd, msg.params) });
    
    
    const tip = (await coachNote(msg.sid, msg.cmd)) + (await multiLineNote(msg.sid, msg.tabId, msg.cmd, tabId));
    if (tip) {
      if (typeof data === 'string') data += tip;
      else if (data && typeof data.text === 'string') data.text += tip;
    }
    if (ctx.adopted) {
      
      
      const head = `⚠️ This session has not chosen its own controlled tab yet and is reusing the most recently controlled one, "${ctx.adoptedTitle || ''}" [${ctx.adoptedTab}].\n`
        + `   When several sessions work at once, pin your own tab with tabs(action:"select", tabId:…) so you do not step on each other.\n`;
      if (typeof data === 'string') return reply(msg.id, true, head + '\n' + data, msg.__k);
      if (data && typeof data.text === 'string') data.text = head + '\n' + data.text;
    }
    reply(msg.id, true, data, msg.__k);
  } catch (e) {
    if (String(msg.cmd).startsWith('fast_')) return reply(msg.id, false, { code: 'FAST_FAILED', message: 'Fast command failed; no automatic retry is permitted.' }, msg.__k);
    reply(msg.id, false, { code: e.code || 'INTERNAL', message: e.message || String(e) }, msg.__k);
  }
}

//

const BATCHABLE = new Set(['click', 'type', 'select', 'fill', 'key', 'navigate']);

async function coachNote(sid, cmd) {
  if (!sid) return '';
  const key = `coach:${sid}`;
  try {
    if (cmd === 'act') { await chrome.storage.session.remove(key); return ''; }
    if (!BATCHABLE.has(cmd)) return '';   
    const { [key]: n = 0 } = await chrome.storage.session.get(key);
    await chrome.storage.session.set({ [key]: n + 1 });
    if (n + 1 === 3) {
      return '\n\n💡 Three single-step actions in a row. If the next step is already predictable, run it with act(steps:[…]): '
        + 'every step you merge saves a full model turn (measured: median turn about 6 seconds, browser execution only 0.2 seconds). '
        + 'Use repeat for pagination loops, if for optional dialogs, assert for state checks.';
    }
    if (n + 1 === 8) {
      await chrome.storage.session.remove(key);   
      return '\n\n💡 Eight single-step actions in a row. If your host can start a subagent, hand this loop to a '
        + 'fast-model driver (pass the goal and this site\'s learnings) and review its plan and results yourself. '
        + 'The caller remains responsible for business-action authorization. If you cannot start a subagent, ignore this.';
    }
  } catch {  }
  return '';
}

async function multiLineNote(sid, explicitTab, cmd, resolved) {
  if (!sid || explicitTab || NO_SLOT_CMDS.has(cmd)) return '';
  try {
    const { [regKey(sid)]: mine = [] } = await chrome.storage.local.get(regKey(sid));
    if (mine.length < 2) return '';
    const key = `multiWarn:${sid}`;
    const { [key]: last = 0 } = await chrome.storage.session.get(key);
    if (Date.now() - last < 600000) return '';
    const open = (await Promise.all(mine.map((t) => chrome.tabs.get(t).catch(() => null)))).filter(Boolean);
    if (open.length < 2) return '';
    await chrome.storage.session.set({ [key]: Date.now() });
    return `\n\n⚠️ This session is working on ${open.length} tabs, yet this command carried no tabId, so it landed on the default slot, `
      + `currently pointing at [${resolved}]. The default slot is shared by the whole session (including subagents you started), and any `
      + `tabs/navigate call from any of them rewrites it. When working in parallel, pass tabId explicitly on every command; tabs(action:"list") shows who owns which page.`;
  } catch { return ''; }
}

//

function onBridgeEvent(msg) {
  if (msg.event !== 'sessions') return;
  
  return noteSession(null, null, msg.live).then(() => resyncMarks());
}

const err = (code, message) => Object.assign(new Error(message), { code });

//

//

//

const SLOT_PREFIX = 'agentTab:';
const agentTabKey = (sid) => `${SLOT_PREFIX}${sid}`;
const SLOT_CAP = 32;   

const liveOf = (ctx) => new Set(Array.isArray(ctx?.live) ? ctx.live : []);

async function liveOwnersOf(tabId, exceptSid, live) {
  const all = await chrome.storage.local.get(null);
  return sidsOnTab(all, tabId).filter((sid) => sid !== exceptSid && live.has(sid));
}

async function claimTab(sid, tabId, ctx) {
  if (!sid) return;
  const key = agentTabKey(sid);
  const { [key]: prev } = await chrome.storage.local.get(key);
  await chrome.storage.local.set({ [key]: tabId, [`slotTouch:${sid}`]: Date.now() });
  await registerTab(sid, tabId);   
  
  
  void syncMark(tabId);
  
  
  
  
  if (prev && prev !== tabId) void syncMark(prev);
  const all = await chrome.storage.local.get(null);
  const slots = Object.keys(all).filter((k) => k.startsWith('agentTab:')).map((k) => k.slice('agentTab:'.length));
  if (slots.length <= SLOT_CAP) return;
  const live = liveOf(ctx);
  const victims = slots
    .filter((s) => !live.has(s))
    .sort((a, b) => (all[`slotTouch:${a}`] || 0) - (all[`slotTouch:${b}`] || 0))
    .slice(0, slots.length - SLOT_CAP);
  if (victims.length) await chrome.storage.local.remove(victims.flatMap((s) => [agentTabKey(s), `slotTouch:${s}`, `agentGroup:${s}`, regKey(s)]));
}

//

//

//

const REG_PREFIX = 'ownTabs:';
const regKey = (sid) => `${REG_PREFIX}${sid}`;
const REG_CAP = 16;

async function registerTab(sid, tabId) {
  if (!sid || !tabId) return;
  const key = regKey(sid);
  const { [key]: list = [] } = await chrome.storage.local.get(key);
  if (list.includes(tabId)) return;
  await chrome.storage.local.set({ [key]: [...list, tabId].slice(-REG_CAP), [`slotTouch:${sid}`]: Date.now() });
}

function sidsOnTab(all, tabId) {
  const out = new Set();
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(SLOT_PREFIX) && v === tabId) out.add(k.slice(SLOT_PREFIX.length));
    else if (k.startsWith(REG_PREFIX) && Array.isArray(v) && v.includes(tabId)) out.add(k.slice(REG_PREFIX.length));
  }
  return [...out];
}

const labelKey = (tabId) => `tabLabel:${tabId}`;
const getLabel = async (tabId) => (await chrome.storage.local.get(labelKey(tabId)))[labelKey(tabId)] || '';

async function getActiveTabId(sid, ctx) {
  if (sid !== undefined) {
    const key = agentTabKey(sid);
    const { [key]: mine } = await chrome.storage.local.get(key);
    if (mine) {
      try { await chrome.tabs.get(mine); return mine; } catch { await chrome.storage.local.remove([key, `slotTouch:${sid}`]); } 
    }
  }
  const { activeTabId } = await chrome.storage.local.get('activeTabId');
  if (activeTabId) {
    let tab = null;
    try { tab = await chrome.tabs.get(activeTabId); } catch {  }
    if (tab) {
      
      
      
      const owners = await liveOwnersOf(activeTabId, sid, liveOf(ctx));
      if (owners.length) {
        throw err('NO_TAB',
          `The most recently controlled tab [${activeTabId}] "${tab.title || ''}" is being driven by another live session; not taking it from them.\n`
          + `  To get your own: tabs(action:"new", url:…)\n`
          + `  If you really must take over the same page: tabs(action:"select", tabId:${activeTabId}). You will step on each other on that page, so think first.\n`
          + `  To see which pages are available: tabs(action:"list")`);
      }
      if (sid !== undefined) {
        await claimTab(sid, activeTabId, ctx);   
        if (ctx) { ctx.adopted = true; ctx.adoptedTab = activeTabId; ctx.adoptedTitle = tab.title; }
      }
      return activeTabId;
    }
  }
  throw err('NO_TAB', 'There is no controlled tab yet; open one first with tabs(action:"new", url:…)');
}
const setActiveTabId = (id) => chrome.storage.local.set({ activeTabId: id });

async function resolveTab(tabId, sid, ctx) {
  if (tabId) {
    try { await chrome.tabs.get(tabId); return tabId; } catch { throw err('NO_TAB', `Tab ${tabId} does not exist`); }
  }
  return getActiveTabId(sid, ctx);
}

async function conflictNote(tabId, sid, ctx) {
  const owners = await liveOwnersOf(tabId, sid, liveOf(ctx));
  return owners.length ? '⚠️ This tab is being driven by another live session; you will step on each other on the same page.\n' : '';
}

//

//

//

const LIVE_SIDS = 'liveSids';                     
const MARKED_TABS = 'markedTabs';                 
const sidClientKey = (sid) => `sidClient:${sid}`; 

const markEnabled = async () => !(await chrome.storage.local.get('markDisabled')).markDisabled;

async function noteSession(sid, client, live) {
  const patch = {};
  if (sid && client) patch[sidClientKey(sid)] = client;
  if (Array.isArray(live)) patch[LIVE_SIDS] = live;
  if (Object.keys(patch).length) await chrome.storage.session.set(patch).catch(() => {});
}

const liveList = async () => (await chrome.storage.session.get(LIVE_SIDS))[LIVE_SIDS] || [];

//

async function ownersOfTab(tabId) {
  const lives = new Set(await liveList());
  if (!lives.size) return [];
  const all = await chrome.storage.local.get(null);
  const sids = sidsOnTab(all, tabId).filter((sid) => lives.has(sid));
  if (!sids.length) return [];
  const clients = await chrome.storage.session.get(sids.map(sidClientKey));
  return sids.map((sid) => identityOf(sid, clients[sidClientKey(sid)]));
}

const postMark = (tabId, msg) => chrome.tabs.sendMessage(tabId, msg).then((r) => !!r?.ok).catch(() => false);

//

async function syncMark(tabId, { act, sid, plan } = {}) {
  if (!tabId) return;
  const fastRun = fastTabWatches.get(tabId);
  if (fastRun && !fastRun.canceled && Date.now() < fastRun.deadline) return;
  try {
    if (!(await markEnabled())) return;
    const owners = await ownersOfTab(tabId);
    
    
    void syncGroup(tabId, owners);
    if (act && sid) await pushActLog(sid, act);
    
    
    const msg = { __hcMark: 'set', owners, act: act || null, sid, plan: plan || null, tabLabel: await getLabel(tabId), ...(await panelData(owners)) };
    await noteMarked(tabId, owners.length > 0);
    if (await postMark(tabId, msg)) return;
    
    
    if (!owners.length) return;
    await chrome.scripting.executeScript({ target: { tabId }, files: ['mark.js'] });
    await postMark(tabId, msg);
  } catch {  }
}

const actLogKey = (sid) => `actLog:${sid}`;
const intentKey = (sid) => `intent:${sid}`;

async function pushActLog(sid, text) {
  const key = actLogKey(sid);
  const { [key]: list = [] } = await chrome.storage.session.get(key);
  list.unshift({ t: Date.now(), text: String(text).slice(0, 60) });
  await chrome.storage.session.set({ [key]: list.slice(0, 20) });
}

async function panelData(owners) {
  const logs = {}, intents = {};
  if (owners.length) {
    const got = await chrome.storage.session.get(owners.flatMap((o) => [actLogKey(o.sid), intentKey(o.sid)]));
    for (const o of owners) {
      if (got[actLogKey(o.sid)]) logs[o.sid] = got[actLogKey(o.sid)];
      if (got[intentKey(o.sid)]) intents[o.sid] = got[intentKey(o.sid)];
    }
  }
  return { logs, intents };
}

async function noteMarked(tabId, on) {
  const { [MARKED_TABS]: list = [] } = await chrome.storage.session.get(MARKED_TABS);
  const has = list.includes(tabId);
  if (on === has) return;
  await chrome.storage.session.set({
    [MARKED_TABS]: on ? [...list, tabId].slice(-64) : list.filter((t) => t !== tabId),
  });
}

//

//

const groupKey = (sid) => `agentGroup:${sid}`;

const GROUP_TITLE = 'BeatBrowser';
const groupTitleOk = (title, sid) => title === GROUP_TITLE || title === identityOf(sid).emoji;

async function syncGroup(tabId, owners) {
  try {
    if (!chrome.tabGroups) return;   
    const tab = await chrome.tabs.get(tabId);
    const all = await chrome.storage.local.get(null);
    const ours = new Map(Object.entries(all)
      .filter(([k]) => k.startsWith('agentGroup:'))
      .map(([k, v]) => [k.slice('agentGroup:'.length), v]));

    
    if (!owners.length) {
      if (tab.groupId === -1) return;
      for (const [sid, gid] of ours) {
        if (gid !== tab.groupId) continue;
        const g = await chrome.tabGroups.get(gid).catch(() => null);
        if (g && groupTitleOk(g.title, sid)) await chrome.tabs.ungroup(tabId);
        return;
      }
      return;
    }

    
    const o = owners[0];
    const stored = ours.get(o.sid);
    if (tab.groupId !== -1) {
      if (tab.groupId === stored) return;                         
      if (![...ours.values()].includes(tab.groupId)) return;      
    }
    
    
    let gid = null;
    if (stored !== undefined) {
      const g = await chrome.tabGroups.get(stored).catch(() => null);
      if (g && g.windowId === tab.windowId && groupTitleOk(g.title, o.sid)) gid = stored;
    }
    if (gid !== null) {
      await chrome.tabs.group({ tabIds: tabId, groupId: gid });
    } else {
      gid = await chrome.tabs.group({ tabIds: tabId });
      await chrome.tabGroups.update(gid, { title: GROUP_TITLE, color: o.group });
      await chrome.storage.local.set({ [groupKey(o.sid)]: gid });
    }
  } catch {  }
}

async function resyncMarks() {
  try {
    const [all, sess] = await Promise.all([
      chrome.storage.local.get(null),
      chrome.storage.session.get(MARKED_TABS),
    ]);
    const tabs = new Set(Object.entries(all).filter(([k]) => k.startsWith(SLOT_PREFIX)).map(([, v]) => v));
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith(REG_PREFIX) && Array.isArray(v)) for (const t of v) tabs.add(t);
    }
    for (const t of sess[MARKED_TABS] || []) tabs.add(t);
    for (const tabId of tabs) await syncMark(tabId);
  } catch {  }
}

//

function actText(cmd, p = {}) {
  const ref = p.ref || p.selector || '';
  switch (cmd) {
    case 'navigate': return `open ${hostOf(p.url) || 'page'}`;
    case 'click': return `click ${ref}`;
    case 'type': return `type into ${ref}`;
    case 'fill': return 'fill form';
    case 'select': return `select ${ref}`;
    case 'key': return `press ${p.key || ''}`;
    case 'scroll': return 'scroll';
    case 'snapshot': return 'read page';
    case 'read_text': return 'read text';
    case 'query': return 'query elements';
    case 'screenshot': return 'screenshot';
    case 'network': return 'inspect network';
    case 'fetch': return 'call API';
    case 'download': return 'download';
    case 'upload': return 'upload file';
    case 'eval': return 'run script';
    case 'wait': return 'wait';
    case 'ask': return 'ask the user for help';
    
    
    case 'act': return '';
    default: return cmd;
  }
}

async function pingContent(tabId, frameId = 0) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { __hc: 'ping' }, { frameId });
    return !!r?.pong;
  } catch {
    return false;
  }
}

async function inject(tabId) {
  try {
    
    
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
  } catch (e) {
    throw err('NOT_INTERACTABLE', `Cannot inject a script into this page (${e.message}). chrome:// and store pages are protected by the browser.`);
  }
}

async function ensureContent(tabId, frameId = 0) {
  if (await pingContent(tabId, frameId)) return;
  await inject(tabId);
  if (await pingContent(tabId, frameId)) return;
  if (frameId !== 0) throw err('NOT_INTERACTABLE', `Frame f${frameId} cannot be injected (it may have navigated away or be sandboxed)`);
  
  
  await chrome.tabs.reload(tabId);
  await waitForLoad(tabId);
  await sleep(300);
  await inject(tabId);
  if (!(await pingContent(tabId))) throw err('NOT_INTERACTABLE', 'The page script still does not respond after injection');
}

//

//

//

const frameSnapKey = (tabId) => `frames:${tabId}`;
const getFrameSnaps = async (tabId) => (await chrome.storage.session.get(frameSnapKey(tabId)))[frameSnapKey(tabId)] || null;
const setFrameSnaps = (tabId, snaps) => chrome.storage.session.set({ [frameSnapKey(tabId)]: snaps });

async function listFrames(tabId) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => ({ url: location.href, title: document.title }),
    });
    return res
      .filter((r) => r.result?.url && !/^about:/.test(r.result.url))
      .map((r) => ({ frameId: r.frameId, ...r.result }));
  } catch {
    return [{ frameId: 0, url: '', title: '' }];
  }
}

// "e5@f2" → { ref:"e5", frameId:2 }
function splitRef(ref) {
  const m = /^(.*)@f(\d+)$/.exec(String(ref || ''));
  return m ? { ref: m[1], frameId: Number(m[2]) } : { ref, frameId: 0 };
}

function routeOf(p) {
  const refs = [p.ref, p.submitRef, ...(Array.isArray(p.fields) ? p.fields.map((f) => f.ref) : [])]
    .filter(Boolean).map(splitRef);
  const frames = [...new Set(refs.map((r) => r.frameId))];
  if (frames.length > 1) throw err('REF_NOT_FOUND', `One call mixed refs from different frames (${frames.map((f) => 'f' + f).join(', ')}). Split it into separate calls.`);
  const frameId = frames[0] ?? 0;
  const out = { ...p };
  if (p.ref) out.ref = splitRef(p.ref).ref;
  if (p.submitRef) out.submitRef = splitRef(p.submitRef).ref;
  if (Array.isArray(p.fields)) out.fields = p.fields.map((f) => ({ ...f, ref: f.ref ? splitRef(f.ref).ref : f.ref }));
  return { frameId, params: out };
}

//

const contentBudget = (p) => {
  if (p?.__hc === 'wait') return (Number(p.timeout) || 10000) + 5000;
  if (p?.__hc === 'scroll') return Math.min(Number(p.times) || 1, 50) * (Number(p.wait) || 700) + 10000;
  
  
  return 15000;
};

async function toContent(tabId, payload, frameId = 0) {
  await ensureContent(tabId, frameId);
  let r;
  try {
    let timer;
    const budget = contentBudget(payload);
    r = await Promise.race([
      chrome.tabs.sendMessage(tabId, payload, { frameId }),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(err('DIALOG_BLOCKING',
          `The page script did not respond for ${Math.round(budget / 1000)} seconds. The most common cause is an `
          + `alert / confirm / "Leave this page?" dialog: once it opens, the page's JS stops entirely and the extension cannot reach it.\n`
          + `Ask the user to close the dialog by hand in the browser. Do not retry as-is; wait takes the same path and will hang the same way.\n`
          + `(It could also be a very heavy script; in that case retrying later helps.)`)), budget);
      }),
    ]).finally(() => clearTimeout(timer));
  } catch (e) {
    if (e?.code) throw e;
    throw err('TIMEOUT', `Page not responding (${e.message})`);
  }
  if (!r) throw err('INTERNAL', 'The page script returned nothing');
  if (r.error) throw err(r.error.code, r.error.message);
  return r.data;
}

function waitForLoad(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(h); clearTimeout(t); resolve(); };
    const t = setTimeout(done, timeout);
    const h = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    chrome.tabs.onUpdated.addListener(h);
    chrome.tabs.get(tabId).then((tab) => { if (tab.status === 'complete') done(); }).catch(done);
  });
}

const UNINJECTABLE = /^(chrome|edge|devtools|view-source|chrome-extension|chrome-search|chrome-untrusted):/i;
const isUninjectable = (url) => UNINJECTABLE.test(url || '') || /^https:\/\/chromewebstore\.google\.com/i.test(url || '');

//

//

function waitForCommit(tabId, { expectNav = false } = {}) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(h); clearTimeout(t); resolve(); };
    
    
    const t = setTimeout(done, expectNav ? 3000 : 6000);
    
    const h = (id, info) => { if (id === tabId && (info.url || info.status === 'complete')) done(); };
    chrome.tabs.onUpdated.addListener(h);
    if (!expectNav) chrome.tabs.get(tabId).then((tab) => { if (tab.status !== 'loading') done(); }).catch(done);
  });
}

//

//

async function waitForReady(tabId, { hardCap = 12000, quiet = 300, expectNav = false } = {}) {
  await waitForCommit(tabId, { expectNav });
  try {
    if (isUninjectable((await chrome.tabs.get(tabId)).url)) return;
  } catch {
    return;   
  }
  const deadline = Date.now() + hardCap;
  while (Date.now() < deadline) {
    try {
      const r = await toContent(tabId, { __hc: 'ready', quiet, budget: deadline - Date.now() });
      if (r?.ready) return;
    } catch {
      
      
    }
    await sleep(80);
  }
}

//

//

const NET_SCRIPT_ID = 'hc-net-hook';

async function ensureNetHook() {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [NET_SCRIPT_ID] }).catch(() => []);
  if (existing.length) return false;
  await chrome.scripting.registerContentScripts([{
    id: NET_SCRIPT_ID,
    matches: ['<all_urls>'],
    js: ['net-hook.js'],
    runAt: 'document_start',
    world: 'MAIN',
    allFrames: false,
  }]);
  return true; 
}

async function snapshotAll(tabId, p = {}) {
  const top = await toContent(tabId, { __hc: 'snapshot', ...p });
  const snaps = { 0: top.snapshotId };

  const frames = (await listFrames(tabId)).filter((f) => f.frameId !== 0);
  const parts = [];
  
  
  
  const subs = await Promise.all(
    frames.slice(0, 8)   
      .map((f) => toContent(tabId, { __hc: 'snapshot' }, f.frameId)
        .then((sub) => ({ f, sub }))
        .catch(() => ({ f, sub: null })))
  );
  for (const { f, sub } of subs) {
    if (!sub) {
      parts.push(`\n--- iframe f${f.frameId} · ${f.url} ---\n  (cannot inject, probably sandboxed or navigated away)`);
      continue;
    }
    snaps[f.frameId] = sub.snapshotId;
    
    const body = String(sub.text || '').replace(/^\[(e\d+)\]/gm, `[$1@f${f.frameId}]`);
    const rows = (body.match(/^\[e\d+@f\d+\]/gm) || []).length;
    if (rows) parts.push(`\n--- iframe f${f.frameId} · ${f.url} ---\n${body.split('\n--- Text excerpt')[0].split('\n').slice(2).join('\n')}`);
  }
  await setFrameSnaps(tabId, snaps);
  return parts.length ? { ...top, text: top.text + '\n' + parts.join('\n') } : top;
}

async function prepare(tabId, p) {
  const { frameId, params } = routeOf(p);
  if (frameId !== 0) {
    const known = (await getFrameSnaps(tabId))?.[frameId];
    if (!known) throw err('STALE_SNAPSHOT', `No snapshot for frame f${frameId}; take a new snapshot`);
    params.snapshotId = known;   
  }
  return { frameId, params };
}

async function toFrame(tabId, cmd, p) {
  const { frameId, params } = await prepare(tabId, p);
  const data = await toContent(tabId, { __hc: cmd, ...params }, frameId);
  
  
  if (frameId !== 0 && data?.note) data.note = data.note.replace(/\[(e\d+)\]/g, `[$1@f${frameId}]`);
  return { frameId, data };
}

//

//

const L2_CMDS = new Set(['click', 'type', 'key']);
const IS_MAC = navigator.userAgent.includes('Mac');
const SETTLE_MS = 1200;

//

//

//

const L2_ORIGINS_KEY = 'l2Origins';
let l2OriginsCache = null;

async function learnedL2Origins() {
  if (l2OriginsCache) return l2OriginsCache;
  let stored = {};
  try { ({ [L2_ORIGINS_KEY]: stored = {} } = await chrome.storage.local.get(L2_ORIGINS_KEY)); } catch {  }
  l2OriginsCache = stored;
  return stored;
}

async function prefersL2(url) {
  const h = hostOf(url);
  if (!h) return false;
  if (hostMatches(h, L2_ORIGINS_SEED)) return true;
  return hostMatches(h, Object.keys(await learnedL2Origins()));
}

async function rememberL2Origin(url, why) {
  const h = hostOf(url);
  if (!h || hostMatches(h, L2_ORIGINS_SEED)) return false;
  const m = await learnedL2Origins();
  if (m[h]) return false;
  m[h] = { at: Date.now(), why: String(why).slice(0, 60) };
  l2OriginsCache = m;
  try { await chrome.storage.local.set({ [L2_ORIGINS_KEY]: m }); } catch {  }
  return true;
}

async function execL2(id, cmd, params, loc) {
  const label = params.ref || params.selector || '';
  if (cmd === 'click') {
    await cdp.click(id, loc.x, loc.y);
    return `Clicked [${label}] (real event)`;
  }
  if (cmd === 'type') {
    await cdp.click(id, loc.x, loc.y);          
    await sleep(80);
    if (params.clear !== false) {
      await cdp.key(id, 'a', { mods: IS_MAC ? ['meta'] : ['ctrl'] });
      await cdp.key(id, 'Delete');
    }
    if (params.text) await cdp.insertText(id, String(params.text));
    if (params.submit) await cdp.key(id, 'Enter');
    return `Typed into [${label}]${params.submit ? ' and pressed Enter' : ''} (real event)`;
  }
  if (cmd === 'key') {
    if (loc) { await cdp.click(id, loc.x, loc.y); await sleep(80); }
    const specs = Array.isArray(params.key) ? params.key : [params.key];
    for (const s of specs) await cdp.key(id, s, { mods: params.mods || [], repeat: params.repeat || 1 });
    return `${specs.join(' → ')} (real event)`;
  }
  throw err('INTERNAL', `${cmd} has no L2 implementation`);
}

//

//

async function settle(id, frameId, params, baseline, beforeUrl) {
  const deadline = Date.now() + SETTLE_MS;
  let last = { changed: false, parts: [] };
  let prevKey = null;
  const expect = params.expect && typeof params.expect === 'object' ? params.expect : null;
  let verdict = null;
  while (Date.now() < deadline) {
    await sleep(100);
    const url = (await chrome.tabs.get(id)).url;
    
    if (url !== beforeUrl) return { changed: true, navigated: true, parts: [`navigated to ${url}`] };
    try {
      last = await toContent(id, { __hc: 'effect', baseline, ref: params.ref, selector: params.selector, find: params.find }, frameId);
      if (expect) {
        verdict = await toContent(id, { __hc: 'expect', expect, ref: params.ref, selector: params.selector, find: params.find }, frameId);
        if (verdict?.ok) return { ...last, changed: true, parts: [...(last.parts || []), `expectation met: ${verdict.text}`] };
        continue;   
      }
    } catch {
      
      continue;
    }
    if (!last.changed) continue;
    
    
    const classOnly = last.parts.length === 1 && last.parts[0] === 'target class changed';
    if (classOnly && Date.now() < deadline - SETTLE_MS + 500) { prevKey = null; continue; }
    const key = last.parts.join('|');
    if (key === prevKey) return last;
    prevKey = key;
  }
  if (expect) last = { ...last, expectUnmet: verdict?.text || condOf(expect) };
  return last;
}

const condOf = (e) => Object.entries(e || {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');

//

async function guardCreds(tabId, payload) {
  if (!payload || typeof payload.text !== 'string') return payload;
  let url = '';
  try { url = (await chrome.tabs.get(tabId)).url || ''; } catch {  }

  const { text, count } = redactCreds(payload.text);
  const onCredPage = CRED_URL.test(url);
  if (!count && !onCredPage) return payload;

  const why = [
    count ? `${count} suspected credential line(s) redacted` : '',
    onCredPage ? 'the current address looks like a credentials/security settings page' : '',
  ].filter(Boolean).join('; ');

  return {
    ...payload,
    text: `🔒 ${why}.\n`
      + `   Do not paraphrase this, write it to a file, or send it to anyone; if it is needed, ask the user to look at the screen themselves.\n`
      + `   If you only need to act on this page, snapshot gives you the elements; there is no need to read the body text.\n\n`
      + text,
  };
}

//

//

//

//

const seenKey = (sid, tabId) => `seen:${sid ?? '*'}:${tabId}`;

async function driftNote(tabId, sid) {
  const key = seenKey(sid, tabId);
  let now;
  try { now = (await chrome.tabs.get(tabId)).url; } catch { return ''; }
  const { [key]: was } = await chrome.storage.session.get(key);
  await chrome.storage.session.set({ [key]: now });
  if (!was || was === now) return '';
  return `⚠️ This tab's address changed, and not because of this action:\n`
    + `   was: ${was}\n   now: ${now}\n`
    + `   The user may be using this browser themselves, or the page redirected on its own. What follows comes from the **new page**.\n`
    + `   If this is not the page you expected, stop and confirm first; do not keep acting on or reading an unfamiliar page.\n`;
}

//

//

//

//

const RECENT_TABS = 'recentTabs';
const RECENT_CAP = 20;

chrome.tabs.onCreated.addListener(async (tab) => {
  const { [RECENT_TABS]: list = [] } = await chrome.storage.session.get(RECENT_TABS);
  list.push({ id: tab.id, opener: tab.openerTabId, win: tab.windowId, at: Date.now() });
  await chrome.storage.session.set({ [RECENT_TABS]: list.slice(-RECENT_CAP) });
});

async function childOpenedSince(openerId, since) {
  const { [RECENT_TABS]: list = [] } = await chrome.storage.session.get(RECENT_TABS);
  const fresh = list.filter((r) => r.at >= since && r.id !== openerId);
  if (!fresh.length) return null;

  let win = null;
  try { win = (await chrome.tabs.get(openerId)).windowId; } catch {  }

  const hit = fresh.find((r) => r.opener === openerId)
    || (win !== null ? fresh.find((r) => r.win === win) : null);
  if (!hit) return null;

  
  await chrome.storage.session.set({ [RECENT_TABS]: list.filter((r) => r.id !== hit.id) });
  try {
    const tab = await chrome.tabs.get(hit.id);
    return { ...tab, how: hit.opener === openerId ? 'opener' : 'window' };
  } catch {
    return null;   
  }
}

const markNavigated = async (tabId, sid) => {
  try { await chrome.storage.session.set({ [seenKey(sid, tabId)]: (await chrome.tabs.get(tabId)).url }); } catch {  }
};

function watchUntil(tabId, until, timeout) {
  let timer = null;
  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  const promise = new Promise((resolve) => {
    const deadline = Date.now() + timeout;
    timer = setInterval(async () => {
      if (Date.now() > deadline) return stop();
      try {
        const tab = await chrome.tabs.get(tabId);
        if (until.urlContains && tab.url?.includes(until.urlContains)) { stop(); return resolve({ outcome: 'completed' }); }
        if (until.selectorExists || until.textContains) {
          const [{ result } = {}] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (sel, txt) => (sel ? !!document.querySelector(sel) : false)
              || (txt ? (document.body?.innerText || '').includes(txt) : false),
            args: [until.selectorExists || '', until.textContains || ''],
          });
          if (result) { stop(); return resolve({ outcome: 'completed' }); }
        }
      } catch {  }
    }, 1000);
  });
  return { promise, stop };
}

async function evalCond(tabId, cond) {
  if (!cond || typeof cond !== 'object') return true;
  let hit = false;
  try {
    
    if ((cond.ref || cond.selector) && ('checked' in cond || 'value' in cond || 'text' in cond)) {
      const { ref, selector, not, ...expect } = cond;
      const v = await toContent(tabId, { __hc: 'expect', expect, ref, selector }).catch(() => null);
      hit = !!v?.ok;
      return cond.not ? !hit : hit;
    }
    if (cond.urlContains) hit = ((await chrome.tabs.get(tabId)).url || '').includes(cond.urlContains);
    if (!hit && (cond.selectorExists || cond.textContains)) {
      const [{ result } = {}] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel, txt) => (sel ? !!document.querySelector(sel) : false)
          || (txt ? (document.body?.innerText || '').includes(txt) : false),
        args: [cond.selectorExists || '', cond.textContains || ''],
      });
      hit = !!result;
    }
  } catch { hit = false; }
  return cond.not ? !hit : hit;
}

function pollPanel(id, timeout) {
  return (async () => {
    const deadline = Date.now() + timeout + 2000;
    while (Date.now() < deadline) {
      await sleep(400);
      try {
        const r = await chrome.tabs.sendMessage(id, { __hcAsk: 'poll' });
        if (r && !r.pending) return r;
      } catch {
        
        
      }
    }
    return { outcome: 'timed_out', note: '' };
  })();
}

//

//

//

//

let payTimeout = 180000;

async function confirmPay(id, pay) {
  const tab = await chrome.tabs.get(id);
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  await chrome.tabs.update(id, { active: true });
  await chrome.scripting.executeScript({ target: { tabId: id }, files: ['mark.js'] });

  chrome.notifications?.create(`hc-pay-${Date.now()}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Confirm this payment?',
    message: `${pay.label}${pay.amount ? ` · ${pay.amount}` : ''}\n${tab.title || ''}`.slice(0, 180),
    priority: 2,
  }, () => void chrome.runtime.lastError);

  await chrome.tabs.sendMessage(id, {
    __hcAsk: 'show',
    danger: true,
    title: 'This will spend money, please confirm',
    prompt: 'The agent asked to click this button. It is only clicked after you confirm.',
    facts: [['Button', pay.label], ['Amount', pay.amount], ['Page', tab.title || ''], ['Address', tab.url || '']],
    okText: 'Confirm, click it',
    noText: 'Do not',
    wantNote: false,
    timeout: payTimeout,
  });

  const res = await pollPanel(id, payTimeout);
  return res.outcome === 'continued';
}

async function performCore(id, cmd, p, { blockSensitive = false } = {}, ctx) {
  const { frameId, params } = await prepare(id, p);
  const before = (await chrome.tabs.get(id)).url;
  const startedAt = Date.now();

  
  
  const hasTarget = !!(params.ref || params.selector || params.find);

  
  
  
  
  if (cmd === 'click' && !hasTarget && Number.isFinite(params.x) && Number.isFinite(params.y)) {
    const base = await toContent(id, { __hc: 'locate', baselineOnly: true }, frameId).catch(() => null);
    const x = Number(params.x), y = Number(params.y);
    let note;
    if (params.dragTo && Number.isFinite(params.dragTo.x) && Number.isFinite(params.dragTo.y)) {
      await cdp.drag(id, x, y, Number(params.dragTo.x), Number(params.dragTo.y));
      note = `Dragged from (${x}, ${y}) to (${params.dragTo.x}, ${params.dragTo.y}) (real event)`;
    } else {
      await cdp.click(id, x, y);
      note = `Clicked coordinates (${x}, ${y}) (real event)`;
    }
    const ev = await settle(id, frameId, { ...params, ref: undefined }, base?.baseline, before);
    const after = (await chrome.tabs.get(id)).url;
    return { note, l2note: '', ev, navigated: before !== after, upgraded: false };
  }
  const loc = await toContent(id,
    
    
    
    hasTarget ? { __hc: 'locate', forCmd: cmd, ...params } : { __hc: 'locate', baselineOnly: true, fields: params.fields },
    frameId);

  
  
  
  
  
  
  
  
  if (blockSensitive && loc?.sensitive) {
    return { blocked: true, why: 'sensitive' };
  }

  
  
  if (loc?.pay) {
    if (!await confirmPay(id, loc.pay)) {
      throw err('PAY_DECLINED',
        `The user did not confirm this payment (${loc.pay.label}${loc.pay.amount ? ` · ${loc.pay.amount}` : ''}). `
        + 'This is an explicit "do not": do not retry, and do not look for a way around it.');
    }
  }

  const l2ok = frameId === 0 && L2_CMDS.has(cmd) && hasTarget && !loc?.outside;
  
  
  const riskyOrigin = l2ok && await prefersL2(before);
  let layer = (l2ok && (params.real || loc?.prefer === 'L2' || riskyOrigin)) ? 'L2' : 'L1';

  const runL1 = async () => {
    const d = await toContent(id, { __hc: cmd, ...params }, frameId);
    let n = d?.note || d?.text || '';
    if (frameId !== 0 && n) n = n.replace(/\[(e\d+)\]/g, `[$1@f${frameId}]`);
    return n;
  };

  let note = '', usedL2 = layer === 'L2', l2note = '';
  try {
    note = usedL2 ? await execL2(id, cmd, params, loc) : await runL1();
  } catch (e) {
    
    if (usedL2 && (e.code === 'NEEDS_L2' || e.code === 'L2_BUSY')) {
      usedL2 = false;
      l2note = ` (real events were intended, but ${e.message})`;
      note = await runL1();
    } else throw e;
  }

  let ev = await settle(id, frameId, params, loc?.baseline, before);

  
  
  let upgraded = false;
  if (!ev.changed && !usedL2 && l2ok && !params.real) {
    if (loc?.sensitive) {
      l2note = ' (not retried automatically with real events: this is a submit/pay/delete kind of action, '
             + 'and a retry could run it twice. Pass real:true explicitly if you are sure it is needed)';
    } else {
      try {
        note = await execL2(id, cmd, params, loc);
        usedL2 = true;
        upgraded = true;
        ev = await settle(id, frameId, params, loc?.baseline, before);
      } catch (e) {
        l2note = ` (ordinary events had no effect, and real events could not be used either: ${e.message})`;
      }
    }
  }

  
  
  
  const challenge = matchChallenge(ev.challengeEv);
  if (challenge) {
    const learned = await rememberL2Origin(before, challenge);
    l2note = (l2note ? `${l2note} ` : '')
      + ` (⚠️ The page raised a risk-control challenge: "${challenge}". Only the user can complete it by hand; do not retry and do not try to get around it.`
      + (usedL2
        ? 'Real events were already in use, so the risk control on this site looks at more than event trust; leave the next steps to the user.'
        : learned
          ? `Remembered ${hostOf(before)}; real events will be used on this site from now on.`
          : '')
      + ')';
  }

  const after = (await chrome.tabs.get(id)).url;
  const navigated = before !== after;
  if (navigated) { await waitForReady(id); await markNavigated(id, ctx?.sid); }

  
  
  
  
  const child = await childOpenedSince(id, startedAt);
  if (child) {
    await waitForReady(child.id);
    await setActiveTabId(child.id);
    await claimTab(ctx?.sid, child.id, ctx);
    await markNavigated(child.id, ctx?.sid);
    return { note, l2note, ev, navigated, upgraded, followed: { from: id, to: child.id, url: child.url, how: child.how } };
  }

  return { note, l2note, ev, navigated, upgraded };
}

function describeStep(st) {
  if (st.do === 'repeat') return `repeat ×≤${repeatMax(st)}${st.until ? ` until ${condText(st.until)}` : ''} (${(st.steps || []).length} sub-steps)`;
  if (st.do === 'if') return `if ${condText(st.cond)}`;
  if (st.do === 'assert') return `assert ${condText(st.cond)}`;
  const t = st.find
    ? `${st.find.role ? st.find.role + ' ' : ''}"${st.find.name || st.find.selector || ''}"`
    : st.ref ? `[${st.ref}]`
    : st.selector ? `(${st.selector})`
    : st.contains ? `containing "${String(st.contains).slice(0, 30)}"`
    : '';
  const extra = st.do === 'read' ? (st.attr ? ` @${st.attr}` : '')
    : st.text !== undefined ? ` ←${String(st.text).length} chars`
    : st.value !== undefined ? ` ←"${st.value}"`
    : st.check !== undefined ? (st.check ? ' check' : ' uncheck')
    : st.key !== undefined ? ` ${[].concat(st.key).join('+')}`
    : st.url ? ` ${st.url}`
    : st.value === undefined && st.for ? ` ${st.for} ${st.value || ''}`
    : '';
  return `${st.do || '?'} ${t}${extra}`.trim();
}

function panelStep(st) {
  
  if (st.do === 'repeat') return `loop (≤${repeatMax(st)} passes)`;
  if (st.do === 'if') return 'conditional branch';
  if (st.do === 'assert') return 'check page state';
  if (st.do === 'read') return 'read page';
  const t = st.find
    ? `"${st.find.name || st.find.selector || ''}"`
    : st.ref ? `[${st.ref}]`
    : st.selector ? `(${st.selector})`
    : '';
  const extra = st.text !== undefined ? ` ←${String(st.text).length} chars`
    : st.value !== undefined ? ' ←option'
    : st.check !== undefined ? (st.check ? ' check' : ' uncheck')
    : st.key !== undefined ? ` ${[].concat(st.key).join('+')}`
    : st.url ? ` ${hostOf(st.url) || ''}`
    : '';
  return `${st.do || '?'} ${t}${extra}`.trim();
}

function effectLines({ note, l2note, ev, upgraded, followed }) {
  if (followed) {
    return [
      note + (upgraded ? '  ←  ordinary events had no effect, switched to real events automatically' : ''),
      l2note,
      `↪️ This action opened a **new tab** and the controlled tab followed it:\n`
      + `   now on [${followed.to}] ${followed.url}\n`
      + `   the original page is [${followed.from}]; to go back: tabs(action:"select", tabId:${followed.from})\n`
      + `   The snapshot below comes from the new page.`
      + (followed.how === 'window'
        ? `\n   (The rule is "a tab that just appeared in the same window", not a certain parent/child link; `
          + `if the user happened to open a page in those few seconds, following the wrong one is possible. If so, select back.)`
        : ''),
    ].filter(Boolean).join('\n');
  }
  return [
    note + (upgraded ? '  ←  ordinary events had no effect, switched to real events automatically' : ''),
    l2note,
    ev.expectUnmet ? `⚠️ Expectation not met (waited ${SETTLE_MS / 1000}s): ${ev.expectUnmet}. Do not proceed as if it succeeded.` : '',
    ev.changed
      ? `Effect: ${ev.parts.join('; ')}` + (ev.volatile ? '  (note: this page is also changing on its own)' : '')
      : ev.unattributable
        ? `⚠️ No change attributable to this action. The page keeps changing on its own (${ev.parts.join('; ')}), `
          + `but the target element's state did not move and there is no new page alert, so those changes are probably not caused by this action. `
          + `To confirm it took effect, look at the content near the target in the snapshot below.`
        : `⚠️ The action was sent, but the page did not react at all (DOM, text, focus, target state and page alerts are all unchanged). `
          + `Possible causes: (1) the element is just a container and the real button is inside or next to it; `
          + `(2) the action did happen but only has asynchronous side effects (a request went out, the page changes later); `
          + `(3) the site ignored the input. Do not retry as-is: pick another target, or wait first and look again.`,
  ].filter(Boolean).join('\n');
}

async function perform(id, cmd, p, ctx) {
  const drift = await driftNote(id, ctx?.sid);
  const r = await performCore(id, cmd, p, {}, ctx);
  
  const snap = await snapshotAll(r.followed ? r.followed.to : id);
  const head = [drift, effectLines(r)].filter(Boolean).join('\n');
  return { ...snap, text: `${head}\n\n${snap.text}`, navigated: r.navigated || !!r.followed };
}

// Fast commands deliberately bypass manual input layers, retries, reload recovery,
// action notes and automatic tab following. Every mutation has a bounded run ID.
const FAST_RUN_ID = /^[A-Za-z0-9_-]{8,80}$/;
const FAST_STICKY_REASONS = new Set(['domain-out-of-scope', 'new-tab-opened', 'aborted', 'deadline-exceeded', 'execution-unknown', 'challenge']);
const FAST_BASE_KEYS = ['runId', 'allowedDomains', 'deadline'];

function fastRequestKeys(p, extra = []) {
  return p && typeof p === 'object' && !Array.isArray(p)
    && Object.keys(p).every((key) => [...FAST_BASE_KEYS, ...extra].includes(key));
}

function fastConfiguration(p) {
  if (!FAST_RUN_ID.test(p.runId || '') || !Number.isSafeInteger(p.deadline)
    || !Array.isArray(p.allowedDomains) || !p.allowedDomains.length || p.allowedDomains.length > 32
    || p.allowedDomains.some((host) => typeof host !== 'string' || !host || host !== host.toLowerCase()
      || !/^[a-z0-9.-]+$/.test(host) || host.startsWith('.') || host.endsWith('.') || host.includes('..'))) return 'malformed-request';
  if (fastCanceledRuns.has(p.runId)) return 'aborted';
  if (Date.now() >= p.deadline) return 'deadline-exceeded';
  return null;
}

function fastAllowedUrl(raw, domains) {
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && domains.includes(url.hostname);
  } catch { return false; }
}

function fastUnsafeUrlText(raw) {
  try {
    const url = new URL(raw);
    let text = `${url.pathname}${url.search}${url.hash}`;
    for (let i = 0; i < 3; i++) { const next = decodeURIComponent(text); if (next === text) break; text = next; }
    text = text.normalize('NFKC').replace(/[\u200b-\u200f\u2060\ufeff\u00ad]/g, '');
    return /%[0-9a-f]{2}/i.test(text) || /\p{L}/u.test(text.replace(/[\x00-\x7f]/g, ''));
  } catch { return true; }
}

function fastPublicUrl(raw) {
  try { const url = new URL(raw); return `${url.origin}${url.pathname}`; } catch { return ''; }
}

function fastRunStop(run) {
  if (!run) return 'unknown-run';
  if (fastCanceledRuns.has(run.runId) || run.canceled) return 'aborted';
  if (Date.now() >= run.deadline) return 'deadline-exceeded';
  return run.blockedReason || null;
}

async function fastTabScope(run) {
  let reason = fastRunStop(run);
  if (reason) return reason;
  try {
    const tab = await chrome.tabs.get(run.tabId);
    reason = fastRunStop(run);
    if (reason) return reason;
    const provisional = run.settingUp && (!tab.url || tab.url === 'about:blank' || (tab.status === 'loading' && !!tab.pendingUrl && fastAllowedUrl(tab.pendingUrl, run.allowedDomains)));
    if ((!provisional && !fastAllowedUrl(tab.url || tab.pendingUrl, run.allowedDomains))
      || (tab.pendingUrl && !fastAllowedUrl(tab.pendingUrl, run.allowedDomains))) return (run.blockedReason = 'domain-out-of-scope');
    return null;
  } catch { return 'tab-unavailable'; }
}

async function fastGetRun(p, tabId, { initialize = false, settingUp = false } = {}) {
  const reason = fastConfiguration(p);
  if (reason) return { reason };
  if (!Number.isSafeInteger(tabId) || tabId <= 0) return { reason: 'tab-required' };
  let run = fastRuns.get(p.runId);
  if (run) {
    if (run.tabId !== tabId || run.deadline !== p.deadline || JSON.stringify(run.allowedDomains) !== JSON.stringify(p.allowedDomains)) return { reason: 'run-config-changed' };
    return { run, reason: await fastTabScope(run) };
  }
  if (!initialize) return { reason: 'unknown-run' };
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return { reason: 'tab-unavailable' }; }
  if (fastConfiguration(p)) return { reason: fastConfiguration(p) };
  const provisional = settingUp && (!tab.url || tab.url === 'about:blank' || (tab.status === 'loading' && !!tab.pendingUrl && fastAllowedUrl(tab.pendingUrl, p.allowedDomains)));
  if ((!provisional && !fastAllowedUrl(tab.url || tab.pendingUrl, p.allowedDomains))
    || (tab.pendingUrl && !fastAllowedUrl(tab.pendingUrl, p.allowedDomains))) return { reason: 'domain-out-of-scope' };
  const prior = fastTabWatches.get(tabId);
  if (prior && prior.runId !== p.runId) {
    prior.canceled = true;
    fastCanceledRuns.add(prior.runId);
    void chrome.tabs.sendMessage(tabId, { __hc: 'fast_abort', runId: prior.runId }, { frameId: 0 }).catch(() => {});
  }
  run = { runId: p.runId, deadline: p.deadline, allowedDomains: [...p.allowedDomains], tabId,
    windowId: tab.windowId, lastUrl: tab.url || tab.pendingUrl || '', settingUp, blockedReason: null };
  fastRuns.set(p.runId, run);
  fastTabWatches.set(tabId, run);
  // Keep bounded records. Expired run IDs cannot dispatch because of deadline checks.
  if (fastRuns.size > 128) for (const [id, old] of fastRuns) {
    if (Date.now() >= old.deadline && old !== run) { fastRuns.delete(id); if (fastTabWatches.get(old.tabId) === old) fastTabWatches.delete(old.tabId); }
  }
  return { run, reason: null };
}

async function fastContent(run, command, p) {
  let reason = await fastTabScope(run);
  if (reason) return { blockedReason: reason };
  // Injection is frame 0 only and never reloads a user tab when it fails.
  let pong = false;
  try { pong = !!(await chrome.tabs.sendMessage(run.tabId, { __hc: 'ping' }, { frameId: 0 }))?.pong; } catch { /* Inject once below. */ }
  reason = await fastTabScope(run);
  if (reason) return { blockedReason: reason };
  if (!pong) {
    try { await chrome.scripting.executeScript({ target: { tabId: run.tabId, frameIds: [0] }, files: ['content.js'] }); }
    catch { return { blockedReason: 'content-unavailable' }; }
    reason = await fastTabScope(run);
    if (reason) return { blockedReason: reason };
  }
  // Check cancellation after every transport await, immediately before dispatch.
  reason = fastRunStop(run);
  if (reason) return { blockedReason: reason };
  let timer;
  try {
    const response = await Promise.race([
      chrome.tabs.sendMessage(run.tabId, { __hc: command, ...p }, { frameId: 0 }),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), Math.max(1, Math.min(10000, run.deadline - Date.now()))); }),
    ]);
    if (!response || response.error || response.timedOut || !response.data || typeof response.data !== 'object') {
      if (command === 'fast_act') run.blockedReason = 'execution-unknown';
      return { blockedReason: command === 'fast_act' ? 'execution-unknown' : 'content-unavailable' };
    }
    reason = await fastTabScope(run);
    if (reason) return { blockedReason: reason };
    const data = response.data;
    if (FAST_STICKY_REASONS.has(data.blockedReason)) run.blockedReason = data.blockedReason;
    return data;
  } catch {
    if (command === 'fast_act') run.blockedReason = 'execution-unknown';
    return { blockedReason: command === 'fast_act' ? 'execution-unknown' : 'content-unavailable' };
  } finally { clearTimeout(timer); }
}

async function fastObserve(p, tabId, command) {
  const extra = command === 'fast_verify' ? ['assertions'] : [];
  if (!fastRequestKeys(p, extra)) return { blockedReason: 'malformed-request', ...(command === 'fast_verify' ? { verified: false, checks: [] } : {}) };
  const state = await fastGetRun(p, tabId, { initialize: command === 'fast_snapshot' });
  if (state.reason) return { blockedReason: state.reason, tabId, ...(command === 'fast_verify' ? { verified: false, checks: [] } : {}) };
  const data = await fastContent(state.run, command, p);
  if (data.blockedReason) return { blockedReason: data.blockedReason, challenge: !!data.challenge, tabId,
    ...(command === 'fast_verify' ? { verified: false, checks: [] } : {}) };
  const reason = await fastTabScope(state.run);
  if (reason) return { blockedReason: reason, tabId, ...(command === 'fast_verify' ? { verified: false, checks: [] } : {}) };
  if (command === 'fast_verify') return { verified: data.verified === true, checks: Array.isArray(data.checks) ? data.checks.map((check) => ({ index: check.index, passed: check.passed === true })) : [], tabId };
  if (command === 'fast_status') return { pageChanged: false, navigated: data.navigated === true, stale: data.stale === true, challenge: data.challenge === true, tabId };
  state.run.lastUrl = (await chrome.tabs.get(tabId)).url;
  if (fastRunStop(state.run)) return { blockedReason: fastRunStop(state.run), tabId };
  return { snapshotId: data.snapshotId, url: data.url, title: data.title, visibleText: data.visibleText,
    elements: data.elements, scroll: data.scroll, pageVersion: data.pageVersion, challenge: data.challenge === true, tabId };
}

async function fastPerform(p, tabId) {
  const empty = { pageChanged: false, navigated: false, tabId };
  if (!fastRequestKeys(p, ['operation', 'ref', 'snapshotId', 'optionId', 'text', 'expectedUrl'])) return { ...empty, blockedReason: 'malformed-request' };
  const state = await fastGetRun(p, tabId);
  if (state.reason) return { ...empty, blockedReason: state.reason };
  const before = (await chrome.tabs.get(tabId)).url;
  let reason = await fastTabScope(state.run);
  if (reason) return { ...empty, blockedReason: reason };
  const data = await fastContent(state.run, 'fast_act', p);
  reason = await fastTabScope(state.run);
  let navigated = data.navigated === true;
  try { navigated ||= (await chrome.tabs.get(tabId)).url !== before; } catch { /* Report only a boolean. */ }
  reason ||= fastRunStop(state.run);
  return { pageChanged: data.pageChanged === true, navigated, challenge: data.challenge === true, tabId,
    ...((reason || data.blockedReason) ? { blockedReason: reason || data.blockedReason } : {}) };
}

async function fastOpen(p, tabId) {
  if (!fastRequestKeys(p, ['url']) || typeof p.url !== 'string' || p.url.length > 8000) return { blockedReason: 'malformed-request' };
  let reason = fastConfiguration(p);
  if (reason) return { blockedReason: reason };
  if (!fastAllowedUrl(p.url, p.allowedDomains)) return { blockedReason: 'domain-out-of-scope' };
  if (fastRuns.has(p.runId)) return { blockedReason: 'run-already-started' };
  let tab;
  try {
    if (tabId !== undefined && tabId !== null) {
      if (!Number.isSafeInteger(tabId) || tabId <= 0) return { blockedReason: 'tab-required' };
      await chrome.tabs.get(tabId);
      reason = fastConfiguration(p);
      if (reason) return { blockedReason: reason };
      tab = await chrome.tabs.update(tabId, { url: p.url });
    } else {
      reason = fastConfiguration(p);
      if (reason) return { blockedReason: reason };
      tab = await chrome.tabs.create({ url: p.url, active: true });
      tabId = tab.id;
    }
  } catch { return { blockedReason: 'setup-failed' }; }
  const state = await fastGetRun(p, tabId, { initialize: true, settingUp: true });
  if (state.reason) return { blockedReason: state.reason, tabId };
  const loadDeadline = Math.min(p.deadline, Date.now() + 10000);
  while (Date.now() < loadDeadline) {
    reason = await fastTabScope(state.run);
    if (reason) return { blockedReason: reason, tabId };
    tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') break;
    await sleep(Math.min(25, Math.max(1, loadDeadline - Date.now())));
  }
  reason = await fastTabScope(state.run);
  if (reason) return { blockedReason: reason, tabId };
  await waitForReady(tabId, { hardCap: Math.min(5000, Math.max(1, p.deadline - Date.now())), quiet: 800 });
  reason = await fastTabScope(state.run);
  if (reason) return { blockedReason: reason, tabId };
  state.run.settingUp = false;
  reason = await fastTabScope(state.run);
  if (reason) return { blockedReason: reason, tabId };
  if (tab.status !== 'complete') return { blockedReason: 'setup-timeout', tabId };
  return { tabId, url: fastPublicUrl(tab.url || p.url) };
}

async function fastAbortRun(p, tabId) {
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some((key) => key !== 'runId') || !FAST_RUN_ID.test(p.runId || '')) return { blockedReason: 'malformed-request' };
  fastCanceledRuns.add(p.runId);
  const run = fastRuns.get(p.runId);
  if (run) { run.canceled = true; run.blockedReason = 'aborted'; tabId = run.tabId; }
  // Abort is permitted on a drifted page and never injects or reloads a script.
  if (Number.isSafeInteger(tabId) && tabId > 0) {
    try { await chrome.tabs.sendMessage(tabId, { __hc: 'fast_abort', runId: p.runId }, { frameId: 0 }); } catch { /* A departing document cannot resume. */ }
  }
  return { aborted: true, ...(Number.isSafeInteger(tabId) ? { tabId } : {}) };
}

chrome.tabs.onCreated.addListener((tab) => {
  for (const run of fastTabWatches.values()) {
    if (Date.now() >= run.deadline || run.canceled || tab.id === run.tabId) continue;
    if (tab.openerTabId === run.tabId) run.blockedReason = 'new-tab-opened';
  }
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  const run = fastTabWatches.get(tabId);
  if (!run || Date.now() >= run.deadline || run.canceled) return;
  if (info.url && !fastAllowedUrl(info.url, run.allowedDomains) && !(run.settingUp && info.url === 'about:blank')) run.blockedReason = 'domain-out-of-scope';
});

const HANDLERS = {
  async fast_open(p, tabId) { return fastOpen(p, tabId); },
  async fast_snapshot(p, tabId) { return fastObserve(p, tabId, 'fast_snapshot'); },
  async fast_act(p, tabId) { return fastPerform(p, tabId); },
  async fast_verify(p, tabId) { return fastObserve(p, tabId, 'fast_verify'); },
  async fast_status(p, tabId) { return fastObserve(p, tabId, 'fast_status'); },
  async fast_abort(p, tabId) { return fastAbortRun(p, tabId); },
  async snapshot(p, tabId, ctx) {
    const id = await resolveTab(tabId);
    const drift = await driftNote(id, ctx?.sid);
    
    
    
    await toContent(id, { __hc: 'ready', quiet: 150, budget: 800 }).catch(() => {});
    const snap = await guardCreds(id, await snapshotAll(id, p));
    return drift ? { ...snap, text: drift + '\n' + snap.text } : snap;
  },

  async navigate(p, tabId, ctx) {
    const id = await resolveTab(tabId);
    if (p.url) await chrome.tabs.update(id, { url: p.url });
    else await toContent(id, { __hc: 'history', action: p.action || 'reload' });
    
    
    await waitForReady(id, { expectNav: true });
    await markNavigated(id, ctx?.sid);
    return snapshotAll(id);
  },

  
  //
  
  
  
  
  //
  
  
  
  async act(p, tabId, ctx) {
    let id = await resolveTab(tabId);
    const steps = Array.isArray(p.steps) ? p.steps : [];
    if (!steps.length) throw err('INTERNAL', 'steps must not be empty');
    if (steps.length > 20) throw err('INTERNAL', `At most 20 steps per call, received ${steps.length}. Split it into separate calls.`);
    
    
    const bad = validateScript(steps);
    if (bad) throw err('INTERNAL', bad);

    const drift = await driftNote(id, ctx?.sid);
    const done = [];
    let stopped = null;       
    
    let structureChanged = false;
    let executed = 0;         
                              

    
    
    
    
    const execStep = async (st, progress, plan, out = done) => {
      const { do: cmd, ...rest } = st;
      const label = describeStep(st);
      if (!cmd) { stopped = { label, why: 'this step has no do' }; return; }
      if (++executed > EXEC_BUDGET) {
        stopped = { label, why: `exceeded the ${EXEC_BUDGET}-step execution budget of a single act (after repeat expansion). Split it into several calls.` };
        return;
      }
      
      void syncMark(id, { sid: ctx?.sid, act: `${progress} · ${panelStep(st)}`, plan });
      if (structureChanged && rest.ref && !rest.find) {
        stopped = {
          label,
          why: `The page structure changed after the previous step and every ref in the snapshot is void. `
            + `This step used ref="${rest.ref}"; switch to find (locate by role + name) to carry on.`,
        };
        return;
      }
      try {
        if (cmd === 'wait') {
          const r = await toContent(id, { __hc: 'wait', ...rest });
          out.push(`✅ ${label}  ${r?.text || ''}`);
          return;
        }
        if (cmd === 'navigate') {
          await HANDLERS.navigate(rest, id, ctx);
          structureChanged = true;
          out.push(`✅ ${label}`);
          return;
        }
        if (cmd === 'scroll') {
          const r = await toContent(id, { __hc: 'scroll', ...rest });
          out.push(`✅ ${label}  ${(r?.text || '').split('\n')[0]}`);
          return;
        }
        
        
        if (cmd === 'read') {
          const r = await toContent(id, { __hc: 'read', ...rest });
          out.push(`📖 ${label}\n     ${String(r?.text || '').split('\n').join('\n     ')}`);
          return;
        }

        const r = await performCore(id, cmd, { ...rest, snapshotId: p.snapshotId },
          { blockSensitive: !p.allowSensitive }, ctx);

        if (r.blocked) {
          stopped = {
            label,
            why: 'This is a submit/pay/delete kind of action, and a batch does not do it for you: if one sits inside a chain of steps, '
              + 'nobody can see it once the run finishes. Do it with a single click call, '
              + 'so you get that step\'s own effect evidence.',
          };
          return;
        }
        
        
        if (r.followed) {
          id = r.followed.to;
          structureChanged = true;
          out.push(`✅ ${label}  ↪️ opened a new tab [${r.followed.to}]; the following steps now run on the new page`);
          return;
        }
        if (r.ev.expectUnmet) {
          stopped = { label, why: `expectation not met: ${r.ev.expectUnmet}. The page did not become what this step expected, so the later steps should not run.` };
          return;
        }
        if (!r.ev.changed) {
          stopped = {
            label,
            why: `This step produced no change attributable to it, and the later steps probably rest on a wrong premise, `
              + `so the run stops here. ${r.l2note || ''}`,
          };
          return;
        }
        out.push(`✅ ${label}  effect: ${r.ev.parts.join('; ')}`);
        
        
        
        
        
        
        if (r.navigated || r.ev.parts.some((s) => /top-level|navigated|removed/.test(s) || (/block DOM [+-](\d+)/.exec(s)?.[1] | 0) >= 10)) {
          structureChanged = true;
        }
      } catch (e) {
        stopped = { label, why: `[${e.code || 'INTERNAL'}] ${e.message}` };
      }
    };

    const runLinear = async (list, progress, plan, out) => {
      for (const st of list) {
        if (stopped) return;
        await execStep(st, progress, plan, out);
      }
    };

    let doneTop = 0;   
    for (let i = 0; i < steps.length && !stopped; i++) {
      const st = steps[i] || {};
      const progress = `step ${i + 1}/${steps.length}`;
      const remaining = steps.slice(i + 1).map(panelStep);

      if (st.do === 'assert') {
        
        if (await evalCond(id, st.cond)) done.push(`✅ assertion holds: ${condText(st.cond)}`);
        else stopped = { label: describeStep(st), why: `assertion failed: ${condText(st.cond)}. The page is not in the state this playbook expects, so the later steps should not run.` };
      } else if (st.do === 'if') {
        const hit = await evalCond(id, st.cond);
        const branch = hit ? st.then : (st.else || []);
        done.push(hit
          ? `↳ condition true (${condText(st.cond)}), running then (${st.then.length} steps)`
          : `↷ condition false (${condText(st.cond)}), ${st.else?.length ? `running else (${st.else.length} steps)` : 'skipping'}`);
        await runLinear(branch, progress, remaining, done);
      } else if (st.do === 'repeat') {
        const max = repeatMax(st);
        let hit = false, k = 0;
        while (k < max && !stopped) {
          k++;
          const round = [];
          await runLinear(st.steps, `${progress} · pass ${k}`, remaining, round);
          
          
          
          if (k === 1 || stopped) done.push(...round.map((l) => `  pass ${k}: ${l}`));
          else done.push(`  🔁 pass ${k} ✅ ${round.length} steps`);
          if (stopped) break;
          if (st.until) { hit = await evalCond(id, st.until); if (hit) break; }
        }
        if (!stopped) {
          
          
          if (st.until && !hit) stopped = { label: describeStep(st), why: `repeat ran the full ${max} passes and the until condition (${condText(st.until)}) still did not hit. The playbook's expectation does not match the page, so it stops here.` };
          else done.push(st.until ? `🔁 loop finished: ${condText(st.until)} hit after pass ${k}` : `🔁 ran the full ${max} passes (max)`);
        }
      } else {
        await execStep(st, progress, remaining);
      }
      if (!stopped) doneTop = i + 1;
      else if (stopped.i === undefined) stopped.i = i;
    }

    const snap = await snapshotAll(id);
    const total = steps.length;
    const head = [
      drift,
      `act ${stopped ? `stopped at step ${stopped.i + 1}` : 'finished'} (top level ${doneTop}/${total}, ${executed} actions actually run):`,
      ...done.map((d) => '  ' + d),
      stopped ? `  ⏸ ${stopped.label}\n     ${stopped.why}` : '',
      stopped && stopped.i + 1 < total
        ? `  ${total - stopped.i - 1} step(s) not done: ${steps.slice(stopped.i + 1).map(describeStep).join(', ')}`
        : '',
    ].filter(Boolean).join('\n');

    return { ...snap, text: `${head}\n\n${snap.text}`, completed: !stopped, doneCount: doneTop };
  },

  
  
  
  async click(p, tabId, ctx) { return perform(await resolveTab(tabId), 'click', p, ctx); },
  async type(p, tabId, ctx) { return perform(await resolveTab(tabId), 'type', p, ctx); },
  async key(p, tabId, ctx) { return perform(await resolveTab(tabId), 'key', p, ctx); },
  async fill(p, tabId, ctx) { return perform(await resolveTab(tabId), 'fill', p, ctx); },
  async select(p, tabId, ctx) { return perform(await resolveTab(tabId), 'select', p, ctx); },

  async read_text(p, tabId, ctx) {
    const id = await resolveTab(tabId);
    const drift = await driftNote(id, ctx?.sid);
    const r = await guardCreds(id, await toContent(id, { __hc: 'read_text', ...p }));
    return drift ? { ...r, text: drift + '\n' + r.text } : r;
  },

  async wait(p, tabId) {
    const id = await resolveTab(tabId);
    return toContent(id, { __hc: 'wait', ...p });
  },

  async query(p, tabId, ctx) {
    const id = await resolveTab(tabId);
    const drift = await driftNote(id, ctx?.sid);
    const r = await guardCreds(id, await toContent(id, { __hc: 'query', ...p }));
    return drift ? { ...r, text: drift + '\n' + r.text } : r;
  },

  
  
  
  
  async download(p) {
    const filename = p.filename || `beat-browser/${Date.now()}-${(p.url.split('/').pop() || 'file').split('?')[0].slice(0, 60)}`;
    const dlId = await chrome.downloads.download({ url: p.url, filename, conflictAction: 'uniquify', saveAs: false });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.downloads.onChanged.removeListener(onChanged);
        reject(err('TIMEOUT', `Download not finished after ${(p.timeout || 120000) / 1000}s`));
      }, p.timeout || 120000);
      const onChanged = (d) => {
        if (d.id !== dlId) return;
        if (d.state?.current === 'complete') {
          clearTimeout(timer);
          chrome.downloads.onChanged.removeListener(onChanged);
          chrome.downloads.search({ id: dlId }).then(([item]) =>
            resolve({ text: `Downloaded ${Math.round((item?.fileSize || 0) / 1024)}KB → ${item?.filename}`, path: item?.filename, bytes: item?.fileSize }));
        } else if (d.state?.current === 'interrupted') {
          clearTimeout(timer);
          chrome.downloads.onChanged.removeListener(onChanged);
          reject(err('INTERNAL', `Download interrupted: ${d.error?.current || 'unknown reason'}`));
        }
      };
      chrome.downloads.onChanged.addListener(onChanged);
    });
  },

  async upload(p, tabId) {
    const id = await resolveTab(tabId);

    
    
    
    
    //
    
    
    
    
    
    
    
    
    
    
    if (p.path && !p.dropSelector && !p.base64) {
      try {
        const t = (await toFrame(id, 'uploadTarget', p)).data;
        if (t?.selector) {
          await cdp.setFileInput(id, t.selector, [p.path]);
          const kb = Math.round((p.bytes || 0) / 1024);
          return { text: `Put ${p.name} (${kb >= 1024 ? (kb / 1024).toFixed(1) + 'MB' : kb + 'KB'}) into ${t.accept ? 'accept="' + t.accept + '"' : ''} input` };
        }
      } catch (e) {
        
        if (!p.base64) return { needBytes: true, reason: String(e?.message || e) };
      }
      if (!p.base64) return { needBytes: true, reason: 'no file input on the page; needs a drop' };
    }
    return (await toFrame(id, 'upload', p)).data;
  },

  
  
  async scroll(p, tabId) {
    const id = await resolveTab(tabId);
    const r = await toContent(id, { __hc: 'scroll', ...p });
    const snap = await snapshotAll(id).catch(() => null);
    return snap ? { ...snap, text: `${r?.text || ''}\n\n${snap.text}` } : r;
  },

  
  async read(p, tabId) {
    const id = await resolveTab(tabId);
    return (await toFrame(id, 'read', p)).data;
  },

  
  async network(p, tabId) {
    const id = await resolveTab(tabId);
    const justRegistered = await ensureNetHook();
    
    await chrome.scripting.executeScript({ target: { tabId: id }, world: 'MAIN', files: ['net-hook.js'] }).catch(() => {});

    
    
    
    
    let hasData = false;
    try {
      const [probe] = await chrome.scripting.executeScript({
        target: { tabId: id }, world: 'MAIN',
        func: () => (window.__hcNet || []).length,
      });
      hasData = (probe?.result || 0) > 0;
    } catch {  }

    if (p.reload || !hasData) {
      await chrome.tabs.reload(id);
      await waitForReady(id, { expectNav: true });
      await sleep(p.settle || 2000); 
    }

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: id },
      world: 'MAIN',
      func: (match, want, maxBody, index) => {
        const all = window.__hcNet || [];
        const hit = match ? all.filter((r) => (r.url || '').includes(match)) : all;
        if (want) {
          
          
          const matches = hit.filter((x) => (x.url || '').includes(want));
          const r = matches[matches.length - 1 - (index || 0)];
          return r
            ? { one: true, url: r.url, status: r.status, total: matches.length, body: String(r.body || '').slice(0, maxBody) }
            : { one: true, missing: true, total: matches.length };
        }
        
        return {
          list: hit.map((r) => ({ m: r.method, s: r.status, url: String(r.url).slice(0, 180), kb: Math.round((r.body || '').length / 1024) })),
        };
      },
      args: [p.match || '', p.body || '', p.maxBody || 120000, p.index || 0],
    });

    if (!result) throw err('INTERNAL', 'Cannot read network records; the page may forbid script injection');
    if (result.one) {
      
      
      
      if (result.missing) throw err('NO_MATCH', `No request number ${p.index || 0} matches "${p.body}" (${result.total} requests in total). Call without body first to see which endpoints exist.`);
      return { untrusted: true, meta: `url="${result.url}"`, text: `${result.status} ${result.url}\n\n${result.body}` };
    }
    const rows = result.list;
    if (!rows.length) return { text: 'No network requests recorded on this page. Add reload:true to refresh and try again.' };
    return {
      text: `${rows.length} requests (with response body sizes). Use body:"<url fragment>" to fetch one full response:\n\n`
        + rows.map((r) => `${String(r.s).padEnd(4)} ${String(r.m).padEnd(5)} ${String(r.kb).padStart(4)}KB  ${r.url}`).join('\n'),
    };
  },

  
  
  //
  
  
  
  async fetch(p, tabId) {
    if (p.binary && p.via !== 'page') {
      try {
        const res = await fetch(p.url, { credentials: 'include' });
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length > 12 * 1024 * 1024) {
          throw err('INTERNAL', `The file is ${Math.round(bytes.length / 1048576)}MB, over the 12MB limit of the base64 channel. Use the download tool instead; it uses the browser's native download and has no size limit.`);
        }
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return { base64: btoa(s), ct: res.headers.get('content-type') || '', bytes: bytes.length, status: res.status };
      } catch (e) {
        throw err('INTERNAL', `Extension-side download failed: ${e.message}. If it is hotlink protection, use via:"page" to request from the page context.`);
      }
    }
    const id = await resolveTab(tabId);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: id },
      world: 'MAIN',
      func: async (url, init, maxBody, binary) => {
        try {
          const res = await fetch(url, { credentials: 'include', ...(init || {}) });
          if (!binary) return { status: res.status, body: (await res.text()).slice(0, maxBody) };
          
          
          
          const bytes = new Uint8Array(await res.arrayBuffer());
          let s = '';
          for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          return { status: res.status, base64: btoa(s), ct: res.headers.get('content-type') || '', bytes: bytes.length };
        } catch (e) {
          return { error: String(e && e.message || e) };
        }
      },
      args: [p.url, p.init || null, p.maxBody || 200000, !!p.binary],
    });
    if (result?.error) throw err('INTERNAL', `Request failed: ${result.error}`);
    if (p.binary) return { base64: result.base64, ct: result.ct, bytes: result.bytes, status: result.status };
    return { untrusted: true, meta: `url="${p.url}"`, text: `${result.status}\n\n${result.body}` };
  },

  
  //
  
  
  
  
  
  //
  
  
  async eval(p, tabId) {
    const id = await resolveTab(tabId);

    
    
    
    
    let guarded = false;
    try {
      await ensureContent(id);
      await toContent(id, { __hc: 'payGuard', on: true });
      guarded = true;
    } catch {  }

    let result;
    try {
      ([{ result } = {}] = await chrome.scripting.executeScript({
        target: { tabId: id },
        world: 'MAIN',
        func: (src, max) => {
          try {
            // eslint-disable-next-line no-eval
            const v = (0, eval)(`"use strict"; (${src})`);
            let s;
            try { s = JSON.stringify(v, null, 2); } catch { s = String(v); }
            if (s === undefined) s = 'undefined';
            return { ok: true, text: s.length > max ? s.slice(0, max) + '\n… (truncated)' : s };
          } catch (e) {
            return { ok: false, message: String((e && e.message) || e) };
          }
        },
        args: [String(p.expr || ''), p.maxLength || 20000],
      }));
    } finally {
      if (guarded) {
        const r = await toContent(id, { __hc: 'payGuard', on: false }).catch(() => null);
        const hit = r?.blocked;
        if (hit) {
          throw err('PAY_DECLINED',
            `This eval tried to click a payment button (${hit.label}${hit.amount ? ` · ${hit.amount}` : ''}) and was blocked.\n`
            + `Actions that spend money must go through click, which has a confirmation dialog where a person says yes. Do not use eval to get around it.`);
        }
      }
    }

    if (!result) throw err('NOT_INTERACTABLE', 'Cannot inject a script into this page');
    if (!result.ok) {
      const csp = /Content Security Policy|unsafe-eval/i.test(result.message);
      
      
      
      if (csp) {
        try {
          return { untrusted: true, text: await cdp.evaluate(id, `(${p.expr})`, { maxLength: p.maxLength || 20000 }) };
        } catch (e) {
          throw err(e.code === 'NEEDS_L2' || e.code === 'L2_BUSY' ? e.code : 'INTERNAL',
            e.code === 'NEEDS_L2'
              ? `This page's CSP forbids eval. ${e.message}`
              : `The page's CSP forbids eval, and the real evaluation channel could not be used either: ${e.message}\n`
                + `Use query (extract by selector) or network (read the API); they are not limited by CSP.`);
        }
      }
      throw err('INTERNAL', `Expression failed: ${result.message}`);
    }
    return { untrusted: true, text: result.text };
  },

  
  
  
  
  //
  
  
  async screenshot(p, tabId) {
    const id = await resolveTab(tabId);
    
    
    
    
    
    const veiled = await veilMarks(id, true);
    try {
      return await cdp.screenshot(id, { full: !!p.full });
    } catch (e) {
      if (e.code !== 'NEEDS_L2' && e.code !== 'L2_BUSY') throw e;
      
      const tab = await chrome.tabs.get(id);
      if (!tab.active) {
        if (!p.focus) {
          throw err('NOT_INTERACTABLE',
            `Tab ${id} is not in the foreground. With High-fidelity mode enabled a background tab can be captured directly; ` +
            `until then, capturing it needs it in the foreground: pass focus:true to explicitly agree to interrupt the user, ` +
            `or read the content with snapshot / read_text (no foreground needed).`);
        }
        await chrome.tabs.update(id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        await sleep(250);
        
        
        const now = await chrome.tabs.get(id);
        if (!now.active) {
          throw err('NOT_INTERACTABLE',
            `Asked to bring tab ${id} to the foreground but it did not take effect (the window may be minimized). ` +
            `Refusing to capture, otherwise the screenshot would show whatever other page the user is looking at.`);
        }
      }
      
      
      
      
      if (veiled) await sleep(60);
      
      return p.full
        ? { dataUrl: await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }), scale: 1 }
        : { dataUrl: await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 }), scale: 1 };
    } finally {
      if (veiled) void veilMarks(id, false);
    }
  },

  async tabs(p, tabId, ctx) {
    const sid = ctx?.sid;
    if (p.action === 'list') {
      const live = liveOf(ctx);
      const [all, mineSlot] = await Promise.all([
        chrome.tabs.query({}),
        chrome.storage.local.get(sid === undefined ? 'activeTabId' : agentTabKey(sid)),
      ]);
      const mine = mineSlot[sid === undefined ? 'activeTabId' : agentTabKey(sid)];
      
      
      const slots = await chrome.storage.local.get(null);
      const taken = new Set();       
      const mineToo = new Set();     
      for (const t of all) {
        for (const owner of sidsOnTab(slots, t.id)) {
          if (owner === sid) mineToo.add(t.id);
          else if (live.has(owner)) taken.add(t.id);
        }
      }
      const lines = all.map((t) => {
        const mark = t.id === mine ? ' *' : taken.has(t.id) ? ' ×' : mineToo.has(t.id) ? ' +' : '  ';
        const lb = slots[labelKey(t.id)];
        return `[${t.id}]${mark}${lb ? ` "${lb}"` : ''} ${t.title || '(untitled)'} — ${t.url}`;
      });
      return { text: `${all.length} tab(s) (* = your default slot, + = another of your work lines, × = used by another session; quoted = the label given when the page was opened)\n` + lines.join('\n') };
    }
    
    
    if (p.action === 'new') {
      const tab = await chrome.tabs.create({ url: p.url || 'about:blank', active: !!p.focus });
      const label = String(p.label || '').slice(0, 40);
      if (label) await chrome.storage.local.set({ [labelKey(tab.id)]: label });
      await setActiveTabId(tab.id);   
      await claimTab(sid, tab.id, ctx);
      if (p.url) await waitForReady(tab.id, { expectNav: true });
      
      
      return {
        text: `Opened tab [${tab.id}] in the background${label ? ` "${label}"` : ''}. When working in parallel (including subagents), `
          + `pass tabId:${tab.id} explicitly on later commands`
          + (label ? '' : '; when opening a page, pass label:"which work line this is" so tabs(action:"list") can recover it if you forget which page is which')
          + '.',
        tabId: tab.id,
      };
    }
    
    if (p.action === 'select') {
      const id = await resolveTab(p.tabId, sid, ctx);
      const warn = await conflictNote(id, sid, ctx);
      const label = String(p.label || '').slice(0, 40);
      if (label) await chrome.storage.local.set({ [labelKey(id)]: label });
      await setActiveTabId(id);
      await claimTab(sid, id, ctx);
      if (p.focus) await chrome.tabs.update(id, { active: true });
      return { text: warn + `Controlled tab is now [${id}]${label ? ` "${label}"` : ''}` };
    }
    if (p.action === 'close') {
      const id = await resolveTab(p.tabId, sid, ctx);
      const warn = await conflictNote(id, sid, ctx);
      await chrome.tabs.remove(id);
      return { text: warn + `Closed tab ${id}` };
    }
    throw err('INTERNAL', `Unknown tabs action ${p.action}`);
  },

  
  //
  
  
  //
  
  
  async ask(p, tabId) {
    
    
    if (p.disabled) {
      return { text: 'ask is disabled (unattended mode). Finish it yourself or stop cleanly; do not retry.', outcome: 'disabled' };
    }

    const id = await resolveTab(tabId);
    const timeout = Math.min(Math.max(Number(p.timeout) || 300000, 5000), 600000);

    
    
    let selectors = [];
    if (Array.isArray(p.targets) && p.targets.length) {
      try {
        ({ selectors } = await toContent(id, { __hc: 'markTargets', targets: p.targets }));
      } catch {  }
    }

    if (p.focus !== false) {
      const tab = await chrome.tabs.get(id);
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      await chrome.tabs.update(id, { active: true });
    }

    
    await chrome.scripting.executeScript({ target: { tabId: id }, files: ['mark.js'] });
    if (selectors.length) {
      await chrome.tabs.sendMessage(id, { __hcAsk: 'flash', selectors }).catch(() => {});
    }

    
    chrome.notifications?.create(`hc-ask-${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: p.title || 'BeatBrowser needs your help',
      message: String(p.prompt || '').slice(0, 180),
      priority: 2,
    }, () => void chrome.runtime.lastError);

    const started = Date.now();
    await chrome.tabs.sendMessage(id, {
      __hcAsk: 'show', title: p.title, prompt: p.prompt, timeout, wantNote: p.wantNote !== false,
    });
    const panel = pollPanel(id, timeout);

    
    
    const auto = p.until ? watchUntil(id, p.until, timeout) : null;
    const res = await (auto ? Promise.race([panel, auto.promise]) : panel);
    auto?.stop();
    if (res.outcome === 'completed') {
      await chrome.tabs.sendMessage(id, { __hcAsk: 'abort' }).catch(() => {});
    }
    await toContent(id, { __hc: 'unmarkTargets' }).catch(() => {});

    const waited = Math.round((Date.now() - started) / 1000);
    const snap = await snapshotAll(id).catch(() => ({ text: '' }));
    const head = {
      continued: `✅ The user said it is done (waited ${waited}s)`,
      completed: `✅ Judged complete automatically (waited ${waited}s, your until condition hit)`,
      cancelled: `🛑 The user pressed cancel (waited ${waited}s). This is an explicit "do not do this": stop the current task and do not retry another way.`,
      timed_out: `⏰ Nobody responded within ${Math.round(timeout / 1000)}s. The user may be away from the computer.`,
    }[res.outcome] || res.outcome;

    return {
      outcome: res.outcome,
      text: `${head}${res.note ? `\nUser note: ${res.note}` : ''}\n\n${snap.text}`,
    };
  },

  
  
  
  //
  
  
  async status(p, _tabId, ctx) {
    const text = String(p.text || '').trim().slice(0, 80);
    const sid = ctx?.sid;
    if (sid && text) {
      await chrome.storage.session.set({ [intentKey(sid)]: { text, t: Date.now() } });
      const { [agentTabKey(sid)]: tab } = await chrome.storage.local.get(agentTabKey(sid));
      if (tab) void syncMark(tab, { sid });
    }
    return { text: 'ok' };
  },

  
  
  
  async __pay_timeout(p) {
    payTimeout = Math.min(Math.max(Number(p.ms) || 180000, 1000), 600000);
    return { text: `Payment confirmation wait set to ${payTimeout}ms` };
  },

  
  
  async reload() {
    setTimeout(() => chrome.runtime.reload(), 150);
    return { text: 'Extension is reloading; it reconnects by itself in about 2 seconds' };
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const veilMarks = (tabId, on) =>
  chrome.tabs.sendMessage(tabId, { __hcMark: 'stealth', on }).then((r) => !!r?.ok).catch(() => false);

//

chrome.alarms.create('hc-keepalive', { periodInMinutes: 0.5 });
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('hc-keepalive', { periodInMinutes: 0.5 }));

cdp.reapOrphans();

chrome.alarms?.onAlarm.addListener(async () => {
  await ensureOffscreen();
  if (await connected()) return setBadge(true);
  
  
  
  
  
  const kicked = await chrome.runtime.sendMessage({ __hcBridge: 'kick' }).catch(() => null);
  if (kicked?.connected) return setBadge(true);
  await directConnect();
  setBadge(await connected());
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  
  const all = await chrome.storage.local.get(null);
  const dead = Object.keys(all).filter((k) => (k === 'activeTabId' || k.startsWith('agentTab:')) && all[k] === tabId);
  if (all[labelKey(tabId)] !== undefined) dead.push(labelKey(tabId));
  if (dead.length) await chrome.storage.local.remove(dead);
  
  const shrunk = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(REG_PREFIX) && Array.isArray(v) && v.includes(tabId)) shrunk[k] = v.filter((t) => t !== tabId);
  }
  if (Object.keys(shrunk).length) await chrome.storage.local.set(shrunk);
  const sess = await chrome.storage.session.get(null);
  const gone = Object.keys(sess).filter((k) =>
    (k.startsWith('seen:') && k.endsWith(':' + tabId)) || k === frameSnapKey(tabId) || k === childKey(tabId));
  if (gone.length) await chrome.storage.session.remove(gone);
  await noteMarked(tabId, false);
  emit('tab_closed', { tabId });
});

//

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete') void syncMark(tabId);
});

chrome.runtime.onMessage.addListener((m, _s, sendResponse) => {
  
  
  if (m?.__hcBridge === 'in') {
    onMessage(m.msg);
    return false;
  }
  
  
  if (m?.__hcBridge === 'up') {
    setBadge(true);
    noteBridgeVersion(m.bridge);
    if (directWs) { stopDirectPing(); try { directWs.close(); } catch {  } directWs = null; }
    
    void flushOutbox((msg) => chrome.runtime.sendMessage({ __hcBridge: 'out', msg }).catch(() => null));
    return false;
  }
  
  if (m?.__hcBridge === 'identity') {
    instanceId().then((iid) => sendResponse({
      extId: chrome.runtime.id,
      version: chrome.runtime.getManifest().version,
      instanceId: iid,
      headless: isHeadless(),
    }));
    return true;   
  }
  
  if (m?.__hcBridge === 'status') {
    chrome.storage.session.set({ bridgeConnected: !!m.connected }).catch(() => {});
    setBadge(!!m.connected);
    return false;
  }

  if (m.__hcPopup === 'status') {
    connState().then(sendResponse);
    return true;
  }
  if (m.__hcPopup === 'connect') {
    (async () => {
      if (await ensureOffscreen()) await chrome.runtime.sendMessage({ __hcBridge: 'kick' }).catch(() => {});
      if (!(await connected())) await directConnect();
      const s = await connState();
      setBadge(s.connected);
      sendResponse(s);
    })();
    return true;
  }
  
  
  if (m.__hcPopup === 'detachAll') {
    cdp.reapAll().finally(() => sendResponse({ ok: true }));
    return true;
  }
  
  
  if (m.__hcPopup === 'sessions') {
    (async () => {
      try {
        const [all, lives] = await Promise.all([chrome.storage.local.get(null), liveList()]);
        const clients = await chrome.storage.session.get(lives.map(sidClientKey));
        const rows = [];
        for (const sid of lives) {
          const tabId = all[agentTabKey(sid)];
          let title = '';
          
          
          if (tabId) title = await chrome.tabs.get(tabId).then((t) => stripMarkPrefix(t.title) || t.url || '').catch(() => '');
          rows.push({ ...identityOf(sid, clients[sidClientKey(sid)]), tabId: title ? tabId : null, title });
        }
        sendResponse({ sessions: rows, enabled: await markEnabled() });
      } catch {
        sendResponse({ sessions: [], enabled: true });
      }
    })();
    return true;
  }
  
  
  if (m.__hcPopup === 'markSync') {
    (async () => {
      if (await markEnabled()) await resyncMarks();
      else {
        const { [MARKED_TABS]: list = [] } = await chrome.storage.session.get(MARKED_TABS);
        
        for (const tabId of list) { await postMark(tabId, { __hcMark: 'clear' }); await syncGroup(tabId, []); }
        await chrome.storage.session.set({ [MARKED_TABS]: [] });
      }
      sendResponse({ ok: true });
    })();
    return true;
  }
});

(async () => {
  await ensureOffscreen();
  await sleep(2000);
  if (!(await connected())) await directConnect();
})();
