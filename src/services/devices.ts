/** 裝置名稱（登入裝置清單用） */

/** User-Agent → 「iPhone · Safari」這類看得懂的名稱 */
export function deviceFromUA(ua: string): string {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Macintosh|Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '未知裝置';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Mobile\/|AppleWebKit/.test(ua) ? 'App／主畫面' : '';
  return br ? `${os} · ${br}` : os;
}

