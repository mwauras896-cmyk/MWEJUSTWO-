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
