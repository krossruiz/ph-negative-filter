'use strict';

import './popup.css';

(function () {
  document.addEventListener('DOMContentLoaded', () => {
    const openOptionsBtn = document.getElementById('openOptionsBtn');
    if (openOptionsBtn) {
      openOptionsBtn.addEventListener('click', () => {
        if (chrome.runtime.openOptionsPage) {
          chrome.runtime.openOptionsPage();
        } else {
          window.open('options.html');
        }
      });
    }
  });
})();
