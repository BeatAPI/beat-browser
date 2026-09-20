
//

//

//

//

const PORTS = [18899, 18900, 18901, 18902, 18903];
const PING_MS = 15000;          
const PROBE_MS = 1500;
const MAX_BACKOFF = 15000;
const DEAD_MS = 45000;          

let ws = null;
let pingTimer = null;
let retryTimer = null;
let retryDelay = 0;
let connecting = false;
let lastRx = 0;                 
let lastTick = 0;               
let bridgeVersion = '';         

const post = (m) => chrome.runtime.sendMessage(m).catch(() => {  });

function scheduleReconnect() {
  if (retryTimer) return;
  retryDelay = retryDelay ? Math.min(retryDelay * 2, MAX_BACKOFF) : 400;
  retryTimer = setTimeout(() => { retryTimer = null; connect(); }, retryDelay);
}

function probe(port, hello) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    const t = setTimeout(() => { try { sock.close(); } catch {  } reject(new Error('timeout')); }, PROBE_MS);
    const die = () => { clearTimeout(t); try { sock.close(); } catch {  } reject(new Error('rejected')); };

    sock.onopen = () => sock.send(JSON.stringify(hello));
    sock.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return die(); }
      if (msg.type !== 'welcome') return die();
      clearTimeout(t);
      
      
      
      
      //
      
      
      
      const buffered = [];
      sock.onmessage = (e) => buffered.push(e.data);
      sock.onerror = null;
      sock.onclose = null;
      resolve({ sock, welcome: msg, buffered });
    };
    sock.onerror = die;
    sock.onclose = die;
  });
}

async function askIdentity() {
  const r = await chrome.runtime.sendMessage({ __hcBridge: 'identity' }).catch(() => null);
  return r?.extId ? r : null;
}

async function connect() {
  if (connecting || ws?.readyState <= 1) return;
  connecting = true;
  try {
    const who = await askIdentity();
    if (!who) { setStatus(false); return scheduleReconnect(); }
    const hello = {
      type: 'hello',
      role: 'extension',
      extId: who.extId,
      version: who.version,
      
      
      instanceId: who.instanceId,
      headless: !!who.headless,
      chrome: (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1],
      v: 1,
    };

    let winner = null;
    const races = PORTS.map((p) => probe(p, hello).then((r) => {
      
      
      if (winner) { try { r.sock.close(); } catch {  } return null; }
      winner = r;
      return r;
    }));
    const results = await Promise.allSettled(races);
    const hit = results.map((r) => r.value).find(Boolean);
    if (!hit) { setStatus(false); return scheduleReconnect(); }
    if (hit.sock.readyState !== 1) { setStatus(false); return scheduleReconnect(); }

    ws = hit.sock;
    retryDelay = 0;
    lastRx = Date.now();      
    bridgeVersion = String(hit.welcome?.bridge || '');
    const deliver = (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'pong') return;              
      
      if (msg.type === 'ping') { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'pong' })); return; }
      post({ __hcBridge: 'in', msg });              
    };
    ws.onmessage = (e) => { lastRx = Date.now(); deliver(e.data); };
    ws.onclose = () => { ws = null; stopPing(); setStatus(false); scheduleReconnect(); };
    ws.onerror = () => {  };
    startPing();
    setStatus(true);
    post({ __hcBridge: 'up', bridge: hit.welcome.bridge });
    for (const raw of hit.buffered) deliver(raw);   
  } finally {
    connecting = false;
  }
}

//

//

//

function startPing() {
  stopPing();
  lastTick = Date.now();
  pingTimer = setInterval(() => {
    const now = Date.now();
    const slept = now - lastTick > PING_MS * 2;
    lastTick = now;
    if (ws?.readyState !== 1) return connect();
    if (slept) {
      lastRx = now;                                  
      ws.send(JSON.stringify({ type: 'ping' }));
      return;
    }
    if (now - lastRx > DEAD_MS) {
      try { ws.close(); } catch {  }
      ws = null;
      stopPing();
      setStatus(false);
      return scheduleReconnect();
    }
    ws.send(JSON.stringify({ type: 'ping' }));
  }, PING_MS);
}
function stopPing() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
}

const setStatus = (connected) => post({ __hcBridge: 'status', connected });

chrome.runtime.onMessage.addListener((m, _s, sendResponse) => {
  if (m?.__hcBridge === 'out') {                    
    if (ws?.readyState === 1) ws.send(JSON.stringify(m.msg));
    sendResponse({ sent: ws?.readyState === 1 });
    return true;
  }
  
  
  
  
  const fresh = () => ws?.readyState === 1 && Date.now() - lastRx <= DEAD_MS;
  const state = () => ({ connected: fresh(), lastRx, bridge: bridgeVersion });
  if (m?.__hcBridge === 'status') {
    sendResponse(state());
    return true;
  }
  if (m?.__hcBridge === 'kick') {                   
    connect().then(() => sendResponse(state()));
    return true;
  }
  return false;
});

connect();
