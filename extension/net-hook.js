
//

//

(() => {
  if (window.__hcNet) return;
  window.__hcNet = [];

  const MAX_ENTRIES = 300;
  const MAX_BODY = 400000;

  const push = (r) => {
    window.__hcNet.push(r);
    if (window.__hcNet.length > MAX_ENTRIES) window.__hcNet.shift();
  };

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = async function (...a) {
      const res = await origFetch.apply(this, a);
      try {
        const url = typeof a[0] === 'string' ? a[0] : a[0]?.url;
        const ct = res.headers.get('content-type') || '';
        
        const body = /json|text|javascript/.test(ct) ? (await res.clone().text()).slice(0, MAX_BODY) : '';
        push({ t: Date.now(), method: a[1]?.method || 'GET', url, status: res.status, ct, body });
      } catch {  }
      return res;
    };
  }

  const oOpen = XMLHttpRequest.prototype.open;
  const oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) {
    this.__hc = { method: m, url: String(u) };
    return oOpen.call(this, m, u, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...a) {
    this.addEventListener('load', () => {
      try {
        push({
          t: Date.now(),
          ...this.__hc,
          status: this.status,
          ct: this.getResponseHeader('content-type') || '',
          body: String(this.responseText || '').slice(0, MAX_BODY),
        });
      } catch {}
    });
    return oSend.apply(this, a);
  };
})();
