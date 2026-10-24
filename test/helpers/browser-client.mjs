import assert from 'node:assert/strict';
const password = 'separate-test-password-2026';
export function browserClient(base) {
  const cookies = new Map();
  const request = async (path, options = {}) => {
    const response = await fetch(base + path, { ...options, redirect: 'manual', headers: {
      Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...options.headers,
    } });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';'), equal = pair.indexOf('='); cookies.set(pair.slice(0, equal), pair.slice(equal + 1));
    }
    return response;
  };
  const csrf = async (path = '/console') => {
    const response = await request(path), html = await response.text();
    assert.equal(response.status, 200, html.slice(0, 200));
    return html.match(/name="csrfToken" value="([^"]+)"/)?.[1];
  };
  const post = (path, values) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values) });
  const register = async (email, name = 'Owner') => {
    const response = await post('/register', { name, email, password, csrfToken: await csrf('/register') });
    assert.equal(response.status, 303, await response.text());
    return csrf();
  };
  return { request, csrf, post, register, cookies };
}
