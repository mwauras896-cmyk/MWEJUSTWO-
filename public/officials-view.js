// On the member's "My Next of Kin" view (address ends in #kin), hide the Officials Access box.
// Officials who open the page from their own button still see it.
(function () {
  'use strict';
  function apply() {
    var lock = document.getElementById('lock');
    if (lock) { lock.style.display = (location.hash === '#kin') ? 'none' : ''; }
  }
  apply();
  document.addEventListener('DOMContentLoaded', apply);
  window.addEventListener('hashchange', apply);
})();
