// On the member's "My Next of Kin" view, hide the Officials Access (PIN) box.
// Officials who open the page from their own button still see it.
(function () {
  'use strict';
  var box = null;

  function findBox() {
    var inputs = document.querySelectorAll('input');
    for (var i = 0; i < inputs.length; i++) {
      if (String(inputs[i].placeholder || '').toLowerCase().indexOf('secure pin') < 0) { continue; }
      var el = inputs[i].parentNode;
      while (el && el !== document.body) {
        if (String(el.textContent || '').indexOf('Officials Access') >= 0) {
          // only accept a small container, so the whole page is never hidden by mistake
          return String(el.textContent).length < 400 ? el : null;
        }
        el = el.parentNode;
      }
    }
    return null;
  }

  function apply() {
    if (!box) { box = findBox(); }
    if (!box) { return; }
    box.style.display = (location.hash === '#kin') ? 'none' : '';
  }

  apply();
  document.addEventListener('DOMContentLoaded', apply);
  window.addEventListener('hashchange', apply);
  new MutationObserver(apply).observe(document.documentElement, { childList: true, subtree: true });
})();
