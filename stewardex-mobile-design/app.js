/* Stewardex Mobile prototype — interactive navigation & micro-interactions.
   Visual prototype only: no real data, but every control responds. */
(function () {
  const screens   = document.getElementById('screens');
  const statusbar = document.getElementById('statusbar');
  const tabbar    = document.getElementById('tabbar');
  const toastEl   = document.getElementById('toast');
  const rail      = document.querySelector('.rail');
  const device    = document.getElementById('device');
  let splashTimer = null;

  const LIGHT_STATUS = new Set(['login', 'otp', 'home', 'billing', 'springboard', 'splash']);
  const HIDE_TABBAR  = new Set(['login', 'otp', 'springboard', 'splash', 'chatThread',
                                'approvalDetail', 'expenses', 'notifications', 'settings', 'meetingDetail']);
  const TAB_FOR = {
    home: 'home', calendar: 'calendar', meetings: 'more', meetingDetail: 'more',
    chat: 'chat', chatThread: 'chat',
    approvals: 'approvals', approvalDetail: 'approvals',
    policies: 'more', risk: 'more', coi: 'more', complaints: 'more',
    expenses: 'more', billing: 'more', help: 'more',
    notifications: 'home', settings: 'more', more: 'more',
    login: null, otp: null, springboard: null, splash: null,
  };

  // ---------- toast ----------
  function toast(msg) {
    if (!toastEl || !msg) return;
    toastEl.innerHTML = '<i data-lucide="check"></i><span>' + msg + '</span>';
    if (window.lucide) lucide.createIcons();
    toastEl.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove('show'), 1700);
  }

  // ---------- screen switching ----------
  function show(id) {
    const target = screens.querySelector(`[data-screen="${id}"]`);
    if (!target) return;
    clearTimeout(splashTimer);
    if (notiCenter) notiCenter.classList.remove('open');
    if (typeof closeSheet === 'function') closeSheet();

    screens.querySelectorAll('.screen').forEach(s => s.classList.remove('is-active'));
    target.classList.add('is-active');

    const sc = target.querySelector('.scroll');
    if (sc) sc.scrollTop = 0;

    const intro = (id === 'springboard' || id === 'splash');
    statusbar.classList.toggle('light', LIGHT_STATUS.has(id));
    tabbar.style.display = HIDE_TABBAR.has(id) ? 'none' : 'flex';

    // the navigator sidebar only appears once the app has "launched"
    if (rail) rail.classList.toggle('rail-hidden', intro);

    const tab = TAB_FOR[id];
    tabbar.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    if (rail) rail.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.go === id));

    if (window.lucide) lucide.createIcons();

    // splash auto-advances into the app
    if (id === 'splash') splashTimer = setTimeout(() => show('home'), 2100);
  }

  // ---------- iOS-style notifications ----------
  const bannerStack = document.getElementById('bannerStack');
  const notiCenter  = document.getElementById('notiCenter');
  const ncList      = document.getElementById('ncList');

  const NOTIF = {
    approval:  { cat:'Approvals',     title:'Approval awaiting you',        msg:'Q3 Office Supplies · $1,240',        grad:'var(--grad-amber)',  icon:'receipt',                 go:'approvalDetail' },
    chat:      { cat:'Finance Team',  title:'James Patel mentioned you',    msg:'“@Angela can you approve the Q3…”',  grad:'var(--grad-violet)', icon:'at-sign',                 go:'chatThread' },
    meeting:   { cat:'Calendar',      title:'Meeting in 15 minutes',        msg:'Quarterly Board Meeting · Boardroom',grad:'var(--grad-brand)',  icon:'calendar-clock',          go:'meetingDetail' },
    policy:    { cat:'Policies',      title:'Policy acknowledgement due',   msg:'Safeguarding Policy v3.0',           grad:'var(--grad-teal)',   icon:'file-text',               go:'policies' },
    complaint: { cat:'Complaints',    title:'New complaint logged',         msg:'#1052 · Facility access',            grad:'var(--grad-teal)',   icon:'message-square-warning',  go:'complaints' },
    risk:      { cat:'Risk Register', title:'Risk escalated to Extreme',    msg:'Funding shortfall FY26 · score 20',  grad:'var(--grad-amber)',  icon:'triangle-alert',          go:'risk' },
  };

  // a couple of earlier notifications so the centre isn't empty
  const log = [
    { ...NOTIF.meeting, when:'8:30 AM' },
    { def:true, cat:'Stewardex', title:'Workflow approved', msg:'Venue hire expense · by D. Chen', grad:'var(--grad-teal)', icon:'check-circle-2', go:'approvals', when:'Yesterday' },
  ];

  function cardMarkup(n, cls) {
    return `<div class="${cls}" data-go="${n.go}">
      <div class="bic" style="background:${n.grad}"><i data-lucide="${n.icon}"></i></div>
      <div class="btx">
        <div class="btop"><span>${n.cat}</span><span>${n.when || 'now'}</span></div>
        <b>${n.title}</b><p>${n.msg}</p>
      </div></div>`;
  }

  function triggerNotif(type) {
    const n = NOTIF[type]; if (!n) return;
    log.unshift({ ...n, when:'now' });

    // banner
    const el = document.createElement('div');
    el.className = 'banner';
    el.dataset.go = n.go;
    el.innerHTML = `<div class="bic" style="background:${n.grad}"><i data-lucide="${n.icon}"></i></div>
      <div class="btx"><div class="btop"><span>Stewardex · ${n.cat}</span><span>now</span></div>
      <b>${n.title}</b><p>${n.msg}</p></div>`;
    bannerStack.appendChild(el);
    while (bannerStack.children.length > 3) bannerStack.firstChild.remove();
    if (window.lucide) lucide.createIcons();

    clearTimeout(el._t);
    el._t = setTimeout(() => dismissBanner(el), 4600);
    if (notiCenter.classList.contains('open')) renderCenter();
  }
  function dismissBanner(el) {
    if (!el || el._gone) return; el._gone = true;
    el.classList.add('out');
    setTimeout(() => el.remove(), 400);
  }
  function renderCenter() {
    if (!log.length) { ncList.innerHTML = '<div class="nc-empty">No notifications.<br>Trigger one from the panel on the right.</div>'; return; }
    ncList.innerHTML = '<div class="nc-sec">Notifications</div>' + log.map(n => cardMarkup(n, 'nc-card')).join('');
    if (window.lucide) lucide.createIcons();
  }
  function openCenter()  { renderCenter(); notiCenter.classList.add('open'); }
  function closeCenter() { notiCenter.classList.remove('open'); }
  function clearNotifs() {
    log.length = 0;
    [...bannerStack.children].forEach(dismissBanner);
    renderCenter();
  }

  // ---------- calendar ----------
  const CAL = {
    11: { label:'Wed 11 June', items:[
      { grad:'var(--grad-teal)',   icon:'scale',         title:'COI declaration due',    sub:'Annual trustee declarations', chip:'teal|COI', go:'coi' }] },
    15: { label:'Today · Mon 15 June', items:[
      { grad:'var(--grad-violet)', icon:'users',         title:'Quarterly Board Meeting',sub:'2:00 – 3:30 PM · Boardroom',   chip:'violet|Meeting', go:'meetingDetail' },
      { grad:'var(--grad-amber)',  icon:'graduation-cap',title:'First Aid Training expires', sub:'2 staff certifications',  chip:'amber|Renewal' }] },
    17: { label:'Wed 17 June', items:[
      { grad:'var(--grad-brand)',  icon:'file-text',     title:'Safeguarding Policy review', sub:'Due in 2 days',           chip:'blue|Policy', go:'policies' }] },
    18: { label:'Thu 18 June', items:[
      { grad:'var(--grad-teal)',   icon:'landmark',      title:'Finance Sub-committee',  sub:'10:00 AM',                    chip:'violet|Meeting', go:'meetingDetail' }] },
    19: { label:'Fri 19 June', items:[
      { grad:'var(--grad-brand)',  icon:'gavel',         title:'Special Resolution Vote',sub:'4:00 PM',                     chip:'violet|Meeting', go:'meetingDetail' }] },
    22: { label:'Mon 22 June', items:[
      { grad:'var(--grad-teal)',   icon:'shield-check',  title:'Public Liability Insurance', sub:'Renewal due',             chip:'teal|Reg.' }] },
  };
  function calRow(it) {
    const [c, l] = it.chip.split('|');
    const go = it.go ? ` data-go="${it.go}"` : '';
    return `<div class="row"${go}><div class="ic" style="background:${it.grad}"><i data-lucide="${it.icon}"></i></div>
      <div class="tx"><b>${it.title}</b><span>${it.sub}</span></div><span class="chip ${c}">${l}</span></div>`;
  }
  function renderCalDay(day) {
    const lbl = document.getElementById('calDayLabel');
    const list = document.getElementById('calDayList');
    if (!lbl || !list) return;
    const d = CAL[day];
    if (d) { lbl.textContent = d.label; list.innerHTML = d.items.map(calRow).join(''); }
    else {
      lbl.textContent = 'June ' + day;
      list.innerHTML = `<div class="row" data-open-sheet="newEvent"><div class="ic" style="background:var(--fill);color:var(--muted)"><i data-lucide="plus"></i></div>
        <div class="tx"><b>No events</b><span>Tap to add an event</span></div></div>`;
    }
    if (window.lucide) lucide.createIcons();
  }

  // ---------- bottom sheet ----------
  const scrim = document.querySelector('[data-screen="calendar"] .scrim');
  const sheet = document.getElementById('sheetNewEvent');
  function openSheet()  { if (scrim) scrim.classList.add('open'); if (sheet) sheet.classList.add('open'); }
  function closeSheet() { if (scrim) scrim.classList.remove('open'); if (sheet) sheet.classList.remove('open'); }

  // ---------- fallback labels so nothing feels dead ----------
  const ICON_LABEL = {
    search: 'Search', info: 'Channel info', share: 'Share', 'square-pen': 'New message',
    'check-check': 'All marked as read', 'sliders-horizontal': 'Filters', sliders: 'Filters',
    x: 'Closed', star: 'Starred', paperclip: 'Attachment', 'receipt-text': 'Invoice',
    'chevron-down': 'Select', 'chevron-right': 'Open', bell: 'Notifications',
  };
  function iconName(el) {
    const svg = (el.querySelector && el.querySelector('svg[class*="lucide-"]'))
             || (el.closest('button') && el.closest('button').querySelector('svg[class*="lucide-"]'));
    if (!svg) return null;
    const c = [...svg.classList].find(x => x.startsWith('lucide-') && x !== 'lucide');
    return c ? c.replace('lucide-', '') : null;
  }
  function labelFor(el) {
    if (el.closest('.search')) return 'Search';
    const node = el.closest('.row,.mtile,.card,.input,button');
    let s = '';
    if (node) {
      const b = node.querySelector('.tx b, b, h2, span');
      s = (b ? b.textContent : node.textContent || '').trim();
    }
    if (!s) { const n = iconName(el); if (n && ICON_LABEL[n]) return ICON_LABEL[n]; }
    s = s.replace(/\s+/g, ' ');
    if (!s) s = 'Done';
    return s.length > 30 ? s.slice(0, 28) + '…' : s;
  }

  // ---------- one delegated handler for the whole prototype ----------
  document.addEventListener('click', (e) => {
    const el = e.target;

    // ----- notification controls -----
    const nb = el.closest('[data-notif]');
    if (nb) { triggerNotif(nb.dataset.notif); return; }
    if (el.closest('[data-open-center]') || el.closest('.pull-tab')) { openCenter(); return; }
    if (el.closest('[data-clear]')) { clearNotifs(); return; }
    if (el.closest('[data-close-center]')) { closeCenter(); return; }
    const ncCard = el.closest('.nc-card');
    if (ncCard) { closeCenter(); show(ncCard.dataset.go); return; }
    const banner = el.closest('.banner');
    if (banner) { const g = banner.dataset.go; dismissBanner(banner); if (g) show(g); return; }
    // tap the dimmed area of an open centre to close it
    if (notiCenter.classList.contains('open') && el.closest('#notiCenter') && !el.closest('.nc-list')) {
      closeCenter(); return;
    }

    // theme toggle
    const th = el.closest('[data-theme-set]');
    if (th) {
      const m = th.dataset.themeSet;
      if (m === 'dark') device.setAttribute('data-theme', 'dark');
      else device.removeAttribute('data-theme');
      document.querySelectorAll('[data-theme-set]').forEach(b => b.classList.toggle('on', b === th));
      return;
    }

    // bottom sheet (new event)
    const openS = el.closest('[data-open-sheet]');
    if (openS) { openSheet(); return; }
    const closeS = el.closest('[data-close-sheet]');
    if (closeS) { if (closeS.dataset.toast) toast(closeS.dataset.toast); closeSheet(); return; }
    if (el.closest('.scrim')) { closeSheet(); return; }

    // calendar date selection
    const cday = el.closest('.cday');
    if (cday) { if (cday.dataset.day) {
      cday.closest('#calGrid').querySelectorAll('.cday').forEach(d => d.classList.remove('day-sel'));
      cday.classList.add('day-sel');
      renderCalDay(cday.dataset.day);
    } return; }

    // week-strip day selection
    const wd = el.closest('.week-strip b');
    if (wd) { wd.parentElement.querySelectorAll('b').forEach(b => b.classList.remove('on')); wd.classList.add('on'); return; }

    // RSVP / attendance buttons (meeting detail)
    const rb = el.closest('[data-rsvp]');
    if (rb) {
      rb.parentElement.querySelectorAll('[data-rsvp]').forEach(b => b.classList.remove('on'));
      rb.classList.add('on');
      toast('RSVP updated: ' + rb.textContent.trim());
      return;
    }

    // segmented control — switch active tab within the control
    const seg = el.closest('.seg b');
    if (seg) {
      seg.parentElement.querySelectorAll('b').forEach(b => b.classList.remove('on'));
      seg.classList.add('on');
      const view = seg.dataset.view;        // calendar view switching
      if (view) {
        const screen = seg.closest('.screen');
        screen.querySelectorAll('[data-cal-view]').forEach(v =>
          v.style.display = (v.dataset.calView === view) ? '' : 'none');
      }
      return;
    }

    // toggle switch (the pill itself, or a settings row whose only control is a toggle)
    let tg = el.closest('.tg');
    if (!tg) {
      const row = el.closest('.row');
      if (row && !el.closest('[data-go]') && !el.closest('[data-toast]') && row.querySelector('.tg')) {
        tg = row.querySelector('.tg');
      }
    }
    if (tg) {
      const wasOff = tg.classList.contains('off');
      tg.classList.toggle('off', !wasOff);
      const lbl = (tg.closest('.row') && tg.closest('.row').querySelector('.tx b'))
        ? tg.closest('.row').querySelector('.tx b').textContent.trim() : 'Setting';
      toast(`${lbl} ${wasOff ? 'enabled' : 'disabled'}`);
      return;
    }

    // navigation (optionally with a confirmation toast first)
    const go = el.closest('[data-go]');
    if (go) {
      const id  = go.dataset.go;
      const msg = go.dataset.toast;
      if (msg) { toast(msg); setTimeout(() => show(id), 620); }
      else show(id);
      return;
    }

    // toast-only action
    const ta = el.closest('[data-toast]');
    if (ta) { toast(ta.dataset.toast); return; }

    // catch-all: keep every interactive-looking element alive
    const inter = el.closest('button,.row,.mtile,.input,.fab,.search,.upload,.docprev,.av,.heat b,.glass,.otp b,.chip');
    if (inter && !inter.closest('.seg') && !inter.classList.contains('dot')) {
      toast(labelFor(el));
    }
  });

  // boot
  if (window.lucide) lucide.createIcons();
  renderCalDay('15');
  show('springboard');
})();
