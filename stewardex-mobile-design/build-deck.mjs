// Captures every screen (light + dark) and assembles a branded 16:9 PDF deck.
// Outputs:  deck/img/<screen>-<theme>.png   and   deck/Stewardex-Mobile-Prototype-Deck.pdf
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire('file://D:/charitycompliance-backend/');
const puppeteer = require('D:/charitycompliance-backend/node_modules/puppeteer');

const ROOT = 'D:/charitycompliance-backend/stewardex-mobile-design';
const IMG = `${ROOT}/deck/img`;
mkdirSync(IMG, { recursive: true });

const SCREENS = [
  ['login',          'Sign in & two-factor',     'Email + one-time passcode, with optional authenticator-app MFA.'],
  ['home',           'Home · My Tasks',          'A unified daily inbox — approvals, meetings, policies and tasks in one place.'],
  ['calendar',       'Calendar',                 'Meetings, statutory renewals and deadlines across month, week and list views.'],
  ['meetings',       'Meetings',                 'Board, sub-committee and resolution meetings with RSVP and attendance.'],
  ['chat',           'Team Chat',                'Channels, direct messages, online presence and unread badges.'],
  ['chatThread',     'Conversation',             'Real-time messaging with reactions, threads and read receipts.'],
  ['approvals',      'Approvals',                'Sequential and parallel approval requests awaiting your decision.'],
  ['approvalDetail', 'Approval detail',          'Full request, the approval chain, and one-tap approve or reject.'],
  ['policies',       'Policies',                 'Read and acknowledge policies with version and review-date tracking.'],
  ['risk',           'Risk Register',            'Likelihood × consequence heat map and the inherent vs residual register.'],
  ['coi',            'Conflicts of Interest',    'View declarations across the organisation and submit your own.'],
  ['complaints',     'Complaints',               'Status breakdown and tracking from new through to resolved.'],
  ['expenses',       'Submit Expense',           'Amount, vetted supplier, project allocation and invoice capture.'],
  ['billing',        'Billing',                  'Plan, live usage against limits, discounts and Stripe-managed payments.'],
  ['help',           'Help Center',              'Raise support tickets and track the conversation to resolution.'],
  ['notifications',  'Notifications',            'Approvals, mentions, meeting reminders and policy actions.'],
  ['settings',       'Settings',                 'Profile, two-factor, password and notification preferences.'],
  ['more',           'More',                     'The gateway to every register and module in the suite.'],
];

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 2 });
await page.goto(`file:///${ROOT}/index.html`, { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 1200));

async function setTheme(mode) {
  await page.evaluate(m => {
    document.querySelector(`[data-theme-set="${m}"]`).click();
  }, mode);
  await new Promise(r => setTimeout(r, 250));
}
async function capture(screen, theme) {
  await page.evaluate(id => { document.querySelector(`.rail [data-go="${id}"]`).click(); }, screen);
  await new Promise(r => setTimeout(r, 550));
  const dev = await page.$('#device');
  await dev.screenshot({ path: `${IMG}/${screen}-${theme}.png` });
}

for (const theme of ['light', 'dark']) {
  await setTheme(theme);
  for (const [s] of SCREENS) await capture(s, theme);
  console.log('captured', theme);
}

// ---------- build deck HTML ----------
const logo = `data:image/png;base64,${readFileSync(`${ROOT}/assets/logo-full.png`).toString('base64')}`;

const slideCSS = `
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Inter Tight',-apple-system,'Segoe UI',sans-serif;background:#05070d}
  .slide{position:relative;width:1280px;height:720px;overflow:hidden;
    background:#070b14;color:#fff;page-break-after:always;display:flex}
  .slide::before{content:"";position:absolute;inset:0;z-index:0;
    background:
      radial-gradient(60% 60% at 12% 8%,rgba(30,58,138,.55),transparent 60%),
      radial-gradient(55% 55% at 95% 30%,rgba(14,165,233,.4),transparent 60%),
      radial-gradient(60% 60% at 70% 110%,rgba(42,157,143,.45),transparent 60%)}
  .slide>*{position:relative;z-index:1}
  /* cover */
  .cover{flex-direction:column;justify-content:center;align-items:center;text-align:center}
  .cover img{height:54px;filter:brightness(0) invert(1);margin-bottom:34px}
  .cover .ey{font-size:14px;letter-spacing:.32em;text-transform:uppercase;color:#9fd6e8;
    border:1px solid rgba(255,255,255,.18);padding:9px 20px;border-radius:999px;margin-bottom:26px}
  .cover h1{font-size:60px;font-weight:800;letter-spacing:-1.5px;line-height:1.05}
  .cover h1 span{background:linear-gradient(110deg,#5eead4,#0ea5e9 50%,#93c5fd);
    -webkit-background-clip:text;background-clip:text;color:transparent}
  .cover p{margin-top:20px;color:#aab8cf;font-size:19px;max-width:760px;line-height:1.6}
  .cover .meta{margin-top:40px;display:flex;gap:40px;color:#8295b3;font-size:14px;font-weight:600}
  .cover .meta b{color:#dce6f5}
  /* content */
  .info{width:430px;padding:74px 50px;display:flex;flex-direction:column;justify-content:center}
  .info .num{font-size:14px;letter-spacing:.18em;font-weight:700;color:#5eead4}
  .info h2{font-size:46px;font-weight:800;letter-spacing:-1px;margin:14px 0 18px;line-height:1.05}
  .info p{color:#a9b8d2;font-size:18px;line-height:1.65}
  .info .brand{margin-top:auto;display:flex;align-items:center;gap:10px;color:#6b7d9c;font-size:13px;font-weight:600}
  .info .brand img{height:20px;filter:brightness(0) invert(1);opacity:.85}
  .shots{flex:1;display:flex;align-items:center;justify-content:center;gap:40px;padding:40px 50px 40px 0}
  .ph{display:flex;flex-direction:column;align-items:center;gap:14px}
  .ph img{height:566px;filter:drop-shadow(0 34px 55px rgba(0,0,0,.6))}
  .ph span{font-size:13px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#8295b3}
  .ph.dark span{color:#9fd6e8}
`;

let slides = `
  <section class="slide cover">
    <img src="../assets/logo-full.png">
    <div class="ey">Phase 1 · Mobile Prototype</div>
    <h1>Stewardex Mobile<br><span>Design Showcase</span></h1>
    <p>A high-fidelity prototype of the charity compliance suite, reimagined for iOS &amp; Android — presented in both light and dark appearance.</p>
    <div class="meta"><span>Release · <b>Phase 1</b></span><span>Date · <b>15 June 2026</b></span><span>Screens · <b>18</b></span></div>
  </section>`;

SCREENS.forEach(([s, title, desc], i) => {
  slides += `
  <section class="slide">
    <div class="info">
      <div class="num">SCREEN ${String(i + 1).padStart(2, '0')} / 18</div>
      <h2>${title}</h2>
      <p>${desc}</p>
      <div class="brand"><img src="../assets/logo-full.png"> Stewardex Mobile</div>
    </div>
    <div class="shots">
      <div class="ph"><img src="img/${s}-light.png"><span>Light</span></div>
      <div class="ph dark"><img src="img/${s}-dark.png"><span>Dark</span></div>
    </div>
  </section>`;
});

const deckHtml = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>${slideCSS}</style></head><body>${slides}</body></html>`;

writeFileSync(`${ROOT}/deck/_deck.html`, deckHtml);

const dpage = await browser.newPage();
await dpage.goto(`file:///${ROOT}/deck/_deck.html`, { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 800));
await dpage.pdf({
  path: `${ROOT}/deck/Stewardex-Mobile-Prototype-Deck.pdf`,
  width: '1280px', height: '720px', printBackground: true, pageRanges: '',
});

await browser.close();
console.log('Deck built → deck/Stewardex-Mobile-Prototype-Deck.pdf');
