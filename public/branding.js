// Puts the Mwea East JSS Teachers Welfare logo into every page of the app,
// and hides leader-only buttons from ordinary members.
(function () {
  'use strict';
  var LOGO = '/logo.png';
  function logo(size, extra) {
    var i = new Image();
    i.src = LOGO;
    i.alt = 'Mwea East JSS Teachers Welfare logo';
    i.width = size; i.height = size;
    i.style.cssText = 'display:block;border-radius:50%;object-fit:cover;' + (extra || '');
    return i;
  }

  // Browser-tab icon on pages that don't have one
  if (!document.querySelector('link[rel~="icon"]')) {
    var l = document.createElement('link');
    l.rel = 'icon'; l.href = '/icon-192.png';
    document.head.appendChild(l);
  }

  // Login screen: replace the drawn picture with the real logo
  var big = document.querySelector('#v-login svg');
  if (big) { big.replaceWith(logo(150, 'margin:6px auto 10px;box-shadow:0 4px 14px rgba(0,0,0,.2);')); }

  // Welcome and home bars: logo instead of the emoji circle (the status tick stays)
  ['v-staff', 'v-home'].forEach(function (id) {
    var av = document.querySelector('#' + id + ' .top .av:not(#hs)');
    if (av) { av.replaceWith(logo(48, 'flex:none;')); }
  });

  // Every other page bar in the member app: a small logo before the title
  document.querySelectorAll('.top').forEach(function (t) {
    if (t.querySelector('img') || t.querySelector('.av') || t.querySelector('button')) { return; }
    t.insertBefore(logo(36, 'flex:none;'), t.firstChild);
  });

  // Leaders' Desk and Officials pages: logo at the left of the header
  document.querySelectorAll('header').forEach(function (h) {
    if (h.querySelector('img')) { return; }
    h.style.display = 'flex'; h.style.alignItems = 'center'; h.style.flexWrap = 'wrap'; h.style.gap = '12px';
    h.insertBefore(logo(44, 'flex:none;border:2px solid #d4af37;'), h.firstChild);
    var a = h.querySelector('a');
    if (a) { a.style.marginLeft = 'auto'; }
  });

  // Member profile page: show the leader buttons only to leaders
  var prof = document.getElementById('v-prof');
  if (prof) {
    var showForLeaders = function () {
      var L = null;
      try { L = JSON.parse(sessionStorage.getItem('leader') || 'null'); } catch (e) {}
      prof.querySelectorAll('button[onclick*="leaders.html"]').forEach(function (b) { b.hidden = !L; });
      prof.querySelectorAll('button[onclick*="officials.html"]').forEach(function (b) { b.hidden = !(L && L.admin); });
    };
    showForLeaders();
    new MutationObserver(showForLeaders).observe(prof, { attributes: true, attributeFilter: ['class'] });
    document.addEventListener('click', function () { setTimeout(showForLeaders, 50); });
  }
})();

// Welcome and goodbye animations for the member app.
(function () {
  'use strict';
  if (typeof go !== 'function' || !document.getElementById('v-login')) { return; }

  var css = [
    '#mwe-fx{position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px;overflow:hidden;color:#fff;background:radial-gradient(circle at 50% 30%,#0b7a68 0%,#004d40 55%,#00251f 100%);opacity:1;transition:opacity .4s ease}',
    '#mwe-fx.out{opacity:0}',
    '#mwe-fx img{width:150px;height:150px;border-radius:50%;object-fit:cover;border:4px solid #d4af37;margin-bottom:22px;animation:mwePop .9s cubic-bezier(.2,1.3,.4,1) both,mweGlow 1.8s ease-in-out .9s infinite}',
    '#mwe-fx .ln{display:block;font-weight:800;letter-spacing:.04em;line-height:1.3;animation:mweUp .7s ease both}',
    '#mwe-fx .l1{font-size:1.5rem;animation-delay:.7s}',
    '#mwe-fx .l2{font-size:2rem;color:#d4af37;animation-delay:1.3s}',
    '#mwe-fx .l3{font-size:1.6rem;animation-delay:1.9s}',
    '#mwe-fx .heart{display:inline-block;animation:mweBeat .9s ease-in-out infinite}',
    '#mwe-fx .bye{font-size:2.8rem;font-weight:800;letter-spacing:.08em;color:#d4af37;animation:mweZoom .7s cubic-bezier(.2,1.3,.4,1) .4s both}',
    '#mwe-fx .wave{display:inline-block;font-size:3.2rem;margin-top:14px;transform-origin:70% 70%;animation:mweWave 1.6s ease-in-out .9s infinite}',
    '#mwe-fx .fl{position:absolute;bottom:-40px;pointer-events:none;animation:mweFloat linear infinite}',
    '#mwe-fx .skip{position:absolute;bottom:22px;left:0;right:0;font-size:.8rem;opacity:.75;animation:mweUp .5s ease 1.6s both}',
    '@keyframes mwePop{0%{transform:scale(.2);opacity:0}60%{transform:scale(1.12);opacity:1}100%{transform:scale(1)}}',
    '@keyframes mweGlow{0%,100%{box-shadow:0 0 0 0 rgba(212,175,55,.55)}50%{box-shadow:0 0 0 22px rgba(212,175,55,0)}}',
    '@keyframes mweUp{from{opacity:0;transform:translateY(22px)}to{opacity:1;transform:none}}',
    '@keyframes mweZoom{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:scale(1)}}',
    '@keyframes mweFloat{0%{transform:translateY(0) scale(.6);opacity:0}15%{opacity:.95}100%{transform:translateY(-105vh) scale(1.2);opacity:0}}',
    '@keyframes mweWave{0%,100%{transform:rotate(0)}20%{transform:rotate(18deg)}40%{transform:rotate(-14deg)}60%{transform:rotate(18deg)}80%{transform:rotate(-8deg)}}',
    '@keyframes mweBeat{0%,100%{transform:scale(1)}50%{transform:scale(1.18)}}',
    '@media (prefers-reduced-motion:reduce){#mwe-fx *{animation:none!important}}'
  ].join('');
  var st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  function line(cls, text) {
    var d = document.createElement('div');
    d.className = cls;
    d.textContent = text;
    return d;
  }

  function floaters(box, glyphs, n) {
    for (var k = 0; k < n; k++) {
      var f = document.createElement('span');
      f.className = 'fl';
      f.textContent = glyphs[k % glyphs.length];
      f.style.left = (Math.random() * 92 + 2) + '%';
      f.style.fontSize = (1 + Math.random() * 1.1) + 'rem';
      f.style.animationDuration = (3.2 + Math.random() * 3) + 's';
      f.style.animationDelay = (Math.random() * 2.6) + 's';
      box.appendChild(f);
    }
  }

  function build(kind) {
    var box = document.createElement('div');
    box.id = 'mwe-fx';
    box.setAttribute('role', 'status');
    var img = new Image();
    img.src = '/logo.png';
    img.alt = '';
    box.appendChild(img);
    if (kind === 'welcome') {
      box.appendChild(line('ln l1', 'WELCOME TO'));
      box.appendChild(line('ln l2', 'MWEJUSTWO FAMILY,'));
      var l3 = line('ln l3', 'WE LOVE YOU ');
      var h = document.createElement('span');
      h.className = 'heart';
      h.textContent = '\u2764\uFE0F';
      l3.appendChild(h);
      box.appendChild(l3);
      floaters(box, ['\u2764\uFE0F', '\u2728', '\uD83D\uDC9B', '\u2728'], 16);
      box.appendChild(line('skip', 'Tap to continue'));
    } else {
      box.appendChild(line('bye', 'GOOD BYE'));
      box.appendChild(line('wave', '\uD83D\uDC4B'));
    }
    return box;
  }

  var timer = null;
  function show(kind) {
    var old = document.getElementById('mwe-fx');
    if (old && old.parentNode) { old.parentNode.removeChild(old); }
    clearTimeout(timer);
    var box = build(kind);
    document.body.appendChild(box);
    function close() {
      clearTimeout(timer);
      box.classList.add('out');
      setTimeout(function () { if (box.parentNode) { box.parentNode.removeChild(box); } }, 450);
    }
    box.addEventListener('click', close);
    timer = setTimeout(close, kind === 'welcome' ? 3800 : 2400);
  }

  // Wrap the app's screen switcher: show the animation when a member signs in or out
  var original = go;
  window.go = function (v) {
    var cur = document.querySelector('.view.on');
    var from = cur ? cur.id.replace('v-', '') : '';
    if (from === 'login' && (v === 'home' || v === 'staff')) { show('welcome'); }
    else if (v === 'login' && from && from !== 'login' && from !== 'reg') { show('bye'); }
    return original.apply(this, arguments);
  };
})();
