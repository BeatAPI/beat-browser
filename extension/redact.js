
//

//

//

//

// github.com/settings/tokens, npmjs.com/settings/~/tfa, console/api-keys
export const CRED_URL = /\/(tfa|2fa|mfa|totp|recovery|backup[-_]?codes?|tokens?|api[-_]?keys?|credentials?|secrets?|password)(\/|$|\?|#)/i;

export const isCredLine = (l) => {
  const t = String(l).trim();
  return t.length >= 16 && t.length <= 256
    && /^[A-Za-z0-9+/=_-]+$/.test(t)
    && /[0-9]/.test(t) && /[a-zA-Z]/.test(t);
};

//

//

//

const CRED_MIN = 12;

export const isCredToken = (w) => {
  if (w.length < CRED_MIN || w.length > 256) return false;
  if (w.includes('/') || w.includes('\\') || w.includes('@')) return false;  
  return /[0-9]/.test(w) && /[a-zA-Z]/.test(w);
};

const PHONE = /(?<![0-9])(?:(?:00|\+)?86)?1[3-9]\d{9}(?![0-9])/g;

export function scrubProse(s) {
  if (typeof s !== 'string' || !/\s/.test(s)) return s;   
  return s
    .replace(/[!-~]+/g, (w) => (isCredToken(w) ? `<credential ${w.length} chars>` : w))
    .replace(PHONE, '<phone number>');
}

//

export function redactCreds(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  let block = [];     
  let creds = 0;      
  let count = 0;
  const flush = () => {
    
    const tail = [];
    while (block.length && !block[block.length - 1].trim()) tail.unshift(block.pop());
    if (creds >= 3) { out.push(`  [${creds} suspected credential lines redacted]`); count += creds; }
    else out.push(...block);
    out.push(...tail);
    block = []; creds = 0;
  };
  for (const l of lines) {
    if (isCredLine(l)) { block.push(l); creds++; }
    else if (!l.trim() && creds) block.push(l);
    else { flush(); out.push(l); }
  }
  flush();
  return { text: out.join('\n'), count };
}
