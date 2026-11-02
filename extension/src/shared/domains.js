// Определение «сайта» (регистрируемого домена) и пресеты для сервисов с несколькими доменами
const MULTI_SUFFIXES = new Set(`co.uk org.uk ac.uk gov.uk me.uk ltd.uk plc.uk net.uk sch.uk nhs.uk
com.au net.au org.au edu.au gov.au asn.au id.au co.nz org.nz net.nz govt.nz ac.nz
co.jp ne.jp or.jp ac.jp go.jp gr.jp co.kr or.kr ne.kr go.kr ac.kr
com.br net.br org.br gov.br edu.br com.cn net.cn org.cn gov.cn edu.cn com.hk org.hk net.hk
com.tw org.tw net.tw com.sg org.sg net.sg com.my org.my net.my com.tr org.tr net.tr gen.tr
com.mx org.mx net.mx gob.mx com.ar org.ar net.ar gob.ar com.co org.co net.co com.pe com.ve com.uy com.ec com.bo com.py com.cl
com.ua org.ua net.ua in.ua kiev.ua kharkov.ua odessa.ua dp.ua lviv.ua gov.ua
com.ru net.ru org.ru pp.ru msk.ru spb.ru nov.ru com.by org.by net.by com.kz org.kz net.kz
co.in net.in org.in firm.in gen.in ind.in ac.in co.za org.za net.za web.za co.il org.il net.il ac.il
co.id or.id web.id my.id ac.id com.pl net.pl org.pl waw.pl com.vn net.vn org.vn com.ph net.ph org.ph
com.pk net.pk org.pk com.eg org.eg com.sa net.sa org.sa com.ng org.ng co.th in.th or.th ac.th
com.es org.es nom.es com.pt org.pt com.gr co.at or.at com.cy com.mt com.ge com.am com.az co.ke or.ke
github.io gitlab.io herokuapp.com vercel.app netlify.app pages.dev web.app firebaseapp.com appspot.com
blogspot.com workers.dev azurewebsites.net cloudfront.net onrender.com fly.dev glitch.me repl.co
ngrok.io ngrok-free.app myshopify.com wixsite.com tilda.ws notion.site narod.ru ucoz.ru
livejournal.com tumblr.com substack.com webflow.io bubbleapps.io readthedocs.io`.split(/\s+/).filter(Boolean));

export function isIP(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

export function normalizeHost(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.replace(/[/?#].*$/, '');
  s = s.replace(/^\[|\](:\d+)?$/g, '');
  if (!s.includes('::')) s = s.replace(/:\d+$/, '');
  s = s.replace(/^\*\./, '').replace(/^\.+/, '').replace(/\.$/, '');
  return s;
}

export function registrableDomain(host) {
  host = normalizeHost(host);
  if (!host || isIP(host) || !host.includes('.')) return host;
  const parts = host.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const suffix = parts.slice(i + 1).join('.');
    if (MULTI_SUFFIXES.has(suffix)) return parts.slice(i).join('.');
  }
  return parts.slice(-2).join('.');
}

export function hostMatches(host, domain) {
  if (!host || !domain) return false;
  host = host.toLowerCase();
  domain = domain.toLowerCase();
  return host === domain || host.endsWith('.' + domain);
}

// Сервисы, у которых один вход на несколько доменов
export const SITE_PRESETS = [
  { name: 'Google', test: /(^|\.)(google\.[a-z.]+|youtube\.com|gmail\.com)$/, domains: ['google.com', 'youtube.com', 'gmail.com'] },
  { name: 'Microsoft', test: /(^|\.)(live\.com|microsoft\.com|microsoftonline\.com|office\.com|outlook\.com|bing\.com|skype\.com|xbox\.com)$/, domains: ['live.com', 'microsoft.com', 'microsoftonline.com', 'office.com', 'outlook.com', 'bing.com'] },
  { name: 'Facebook', test: /(^|\.)(facebook\.com|messenger\.com|fb\.com)$/, domains: ['facebook.com', 'messenger.com'] },
  { name: 'X (Twitter)', test: /(^|\.)(x\.com|twitter\.com)$/, domains: ['x.com', 'twitter.com'] },
  { name: 'Steam', test: /(^|\.)(steamcommunity\.com|steampowered\.com)$/, domains: ['steamcommunity.com', 'steampowered.com'] },
  { name: 'ВКонтакте', test: /(^|\.)(vk\.com|vk\.ru|vkontakte\.ru)$/, domains: ['vk.com', 'vk.ru'] },
  { name: 'Яндекс', test: /(^|\.)(yandex\.(ru|com|by|kz|uz|com\.tr)|ya\.ru)$/, domains: ['yandex.ru', 'ya.ru', 'yandex.com'] },
  { name: 'Discord', test: /(^|\.)(discord\.com|discordapp\.com)$/, domains: ['discord.com', 'discordapp.com'] },
  { name: 'Apple', test: /(^|\.)(apple\.com|icloud\.com)$/, domains: ['apple.com', 'icloud.com'] },
  { name: 'AliExpress', test: /(^|\.)(aliexpress\.(com|ru|us))$/, domains: ['aliexpress.com', 'aliexpress.ru'] },
  { name: 'Telegram Web', test: /(^|\.)(telegram\.org|t\.me)$/, domains: ['telegram.org'] },
];

export function suggestSite(host) {
  host = normalizeHost(host);
  const preset = SITE_PRESETS.find((p) => p.test.test(host));
  if (preset) {
    const domains = [...preset.domains];
    const reg = registrableDomain(host);
    if (!domains.some((d) => hostMatches(host, d))) domains.push(reg);
    return { name: preset.name, domains };
  }
  const reg = registrableDomain(host);
  return { name: reg, domains: [reg] };
}

// Поиск сайта (из сохранённых) для хоста: самое длинное совпадение домена
export function findSiteForHost(sites, host) {
  host = normalizeHost(host);
  let best = null, bestLen = -1;
  for (const s of Object.values(sites)) {
    for (const d of s.domains || []) {
      if (hostMatches(host, d) && d.length > bestLen) { best = s; bestLen = d.length; }
    }
  }
  return best;
}

// Glob-шаблоны для правил прокси: "example.com" (домен и поддомены), "*.example.com", "10.*", "<local>"
export function matchPattern(host, pattern) {
  host = String(host).toLowerCase();
  const p = String(pattern).toLowerCase();
  if (p === '<local>') return !host.includes('.');
  if (p.includes('*') || p.includes('?')) {
    const re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    return re.test(host);
  }
  return host === p || host.endsWith('.' + p);
}

export function normalizePattern(input) {
  const s = String(input || '').trim().toLowerCase();
  if (s === '<local>') return s;
  if (s.includes('*') || s.includes('?')) return s.replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '');
  return normalizeHost(s);
}
