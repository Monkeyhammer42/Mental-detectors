// Checks a "Sign in with Google" ID token without any packages:
// signature against Google's published keys, then issuer, audience and expiry.
const crypto = require('crypto');

const CERTS_URL = process.env.GOOGLE_CERTS_URL || 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
let keys = null, keysUntil = 0;

async function googleKeys(force) {
  if (!force && keys && Date.now() < keysUntil) return keys;
  const r = await fetch(CERTS_URL);
  if (!r.ok) throw new Error('Could not fetch Google keys: ' + r.status);
  const jwks = await r.json();
  const m = /max-age=(\d+)/.exec(r.headers.get('cache-control') || '');
  keysUntil = Date.now() + (m ? Number(m[1]) : 3600) * 1000;
  keys = new Map(jwks.keys.map(k => [k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })]));
  return keys;
}

const b64json = s => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

// Returns the token's claims ({sub, email, name, given_name, ...}) or throws.
async function verifyGoogleToken(token, clientId) {
  if (!clientId) throw new Error('Google sign-in is not set up on this server.');
  if (typeof token !== 'string' || token.length > 4096) throw new Error('Bad Google sign-in.');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Bad Google sign-in.');
  const [h, p, sig] = parts;
  let head, claims;
  try { head = b64json(h); claims = b64json(p); } catch { throw new Error('Bad Google sign-in.'); }
  if (head.alg !== 'RS256' || !head.kid) throw new Error('Bad Google sign-in.');
  let key = (await googleKeys()).get(head.kid);
  if (!key) key = (await googleKeys(true)).get(head.kid); // keys rotated since we last looked
  if (!key) throw new Error('Bad Google sign-in.');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(h + '.' + p), key, Buffer.from(sig, 'base64url'));
  if (!ok) throw new Error('Bad Google sign-in.');
  const now = Date.now() / 1000;
  if (!ISSUERS.includes(claims.iss)) throw new Error('Bad Google sign-in.');
  if (claims.aud !== clientId) throw new Error('That Google sign-in was for a different app.');
  if (!(claims.exp > now - 60)) throw new Error('Google sign-in expired. Try again.');
  if (!claims.sub) throw new Error('Bad Google sign-in.');
  return claims;
}

module.exports = { verifyGoogleToken };
