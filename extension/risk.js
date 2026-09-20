
//

//

//

export const CHALLENGE_TEXT = /verify (you|that you)|are you (a )?human|i'?m not a robot|checking your browser|just a moment|press (and|&) hold|complete the (security )?check/i;

export const CHALLENGE_FRAME = /challenges\.cloudflare\.com|hcaptcha\.com|recaptcha|geetest|captcha|arkoselabs|funcaptcha|perimeterx|datadome/i;

export function matchChallenge(ev) {
  const frames = Array.isArray(ev?.frames) ? ev.frames : [];
  const overlays = Array.isArray(ev?.overlays) ? ev.overlays : [];
  for (const src of frames) {
    if (typeof src === 'string' && CHALLENGE_FRAME.test(src)) {
      return src.replace(/\?.*/, '').slice(0, 120);
    }
  }
  for (const t of overlays) {
    if (typeof t !== 'string') continue;
    const m = t.match(CHALLENGE_TEXT);
    if (m) return m[0];
  }
  return null;
}

export const L2_ORIGINS_SEED = ['lovart.art', 'lovart.ai'];

export function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

export function hostMatches(host, keys) {
  if (!host) return false;
  return keys.some((k) => host === k || host.endsWith(`.${k}`));
}
