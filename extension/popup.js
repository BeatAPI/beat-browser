const dot = document.getElementById('dot');
const state = document.getElementById('state');
const btn = document.getElementById('btn');
const conntip = document.getElementById('conntip');

// Version badge: only reliable way to see if extension and CLI match after npx refresh.
document.getElementById('ver').textContent = 'v' + chrome.runtime.getManifest().version;

function render(connected, r = {}) {
  dot.classList.toggle('on', connected);
  state.textContent = connected ? 'Connected to terminal' : 'Disconnected';
  btn.disabled = connected;
  btn.textContent = connected ? 'All good' : 'Reconnect';
  const age = r.lastRx ? Math.round((Date.now() - r.lastRx) / 1000) : null;
  const bits = [];
  if (r.bridge) {
    const mismatch = r.bridge !== chrome.runtime.getManifest().version
      ? ' (≠ extension — reload at chrome://extensions)'
      : '';
    bits.push(`bridge v${r.bridge}${mismatch}`);
  }
  if (age !== null) bits.push(`${age}s since heartbeat`);
  if (!connected && r.offscreenError) bits.push(`offscreen failed: ${r.offscreenError}`);
  if (!connected && age === null) {
    bits.push('Never connected — run an agent once; the bridge starts on first tool call');
  }
  conntip.textContent = bits.join(' · ');
  conntip.hidden = !bits.length;
}

chrome.runtime.sendMessage({ __hcPopup: 'status' }, (r) => render(!!r?.connected, r || {}));

btn.onclick = () => {
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  chrome.runtime.sendMessage({ __hcPopup: 'connect' }, (r) => render(!!r?.connected, r || {}));
};

const l2dot = document.getElementById('l2dot');
const l2state = document.getElementById('l2state');
const l2btn = document.getElementById('l2btn');

function renderL2(on) {
  l2dot.classList.toggle('on', on);
  l2state.textContent = on ? 'High-fidelity mode on' : 'High-fidelity mode off';
  l2btn.textContent = on ? 'Disable' : 'Enable';
  l2btn.classList.toggle('on', on);
}

chrome.storage.local.get('l2Disabled', ({ l2Disabled }) => renderL2(!l2Disabled));

const markdot = document.getElementById('markdot');
const markstate = document.getElementById('markstate');
const markbtn = document.getElementById('markbtn');
const sess = document.getElementById('sess');

function renderMark(on) {
  markdot.classList.toggle('on', on);
  markstate.textContent = on ? 'Control marks on' : 'Control marks off';
  markbtn.textContent = on ? 'Disable' : 'Enable';
  markbtn.classList.toggle('on', on);
}

function renderSessions(rows) {
  sess.textContent = '';
  for (const r of rows) {
    const line = document.createElement('div');
    line.className = 's';
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = r.color;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = r.label;
    const page = document.createElement('span');
    page.className = 'page';
    page.textContent = r.title ? `· ${r.title}` : '· no tab claimed yet';
    line.append(sw, who, page);
    sess.appendChild(line);
  }
}

function refreshMark() {
  chrome.runtime.sendMessage({ __hcPopup: 'sessions' }, (r) => {
    renderMark(r?.enabled !== false);
    renderSessions(r?.sessions || []);
  });
}
refreshMark();

markbtn.onclick = () => {
  chrome.storage.local.get('markDisabled', ({ markDisabled }) => {
    chrome.storage.local.set({ markDisabled: !markDisabled }, () => {
      chrome.runtime.sendMessage({ __hcPopup: 'markSync' }, () => refreshMark());
    });
  });
};

l2btn.onclick = () => {
  chrome.storage.local.get('l2Disabled', ({ l2Disabled }) => {
    const turningOff = !l2Disabled;
    if (turningOff) {
      chrome.runtime.sendMessage({ __hcPopup: 'detachAll' }, () => {
        chrome.storage.local.set({ l2Disabled: true }, () => renderL2(false));
      });
    } else {
      chrome.storage.local.set({ l2Disabled: false }, () => renderL2(true));
    }
  });
};
