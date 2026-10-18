// Puts the Mwea East JSS Teachers Welfare logo into the app.
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

  // Login screen: replace the drawn picture with the real logo
  var big = document.querySelector('#v-login svg');
  if (big) { big.replaceWith(logo(150, 'margin:6px auto 10px;box-shadow:0 4px 14px rgba(0,0,0,.2);')); }

  // Welcome and home bars: logo instead of the emoji circle (the status tick stays)
  ['v-staff', 'v-home'].forEach(function (id) {
    var av = document.querySelector('#' + id + ' .top .av:not(#hs)');
    if (av) { av.replaceWith(logo(48, 'flex:none;')); }
  });

  // Every other page bar: a small logo before the title
  document.querySelectorAll('.top').forEach(function (t) {
    if (t.querySelector('img') || t.querySelector('.av') || t.querySelector('button')) { return; }
    t.insertBefore(logo(36, 'flex:none;'), t.firstChild);
  });
})();
