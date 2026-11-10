(function () {
  'use strict';

  var root = document.documentElement;
  var themeButton = document.querySelector('.theme-toggle');
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function effectiveTheme() {
    if (root.dataset.theme === 'light' || root.dataset.theme === 'dark') {
      return root.dataset.theme;
    }
    return media && media.matches ? 'dark' : 'light';
  }

  function renderTheme() {
    if (!themeButton) return;
    var dark = effectiveTheme() === 'dark';
    themeButton.setAttribute('aria-pressed', dark ? 'true' : 'false');
    themeButton.setAttribute('aria-label', dark ? '切换到浅色主题' : '切换到深色主题');
  }

  if (themeButton) {
    themeButton.addEventListener('click', function () {
      var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      try {
        localStorage.setItem('semantic-theme', next);
      } catch (error) {}
      renderTheme();
    });

    if (media) {
      var onMediaChange = function () {
        if (!root.dataset.theme) renderTheme();
      };
      if (media.addEventListener) media.addEventListener('change', onMediaChange);
      else if (media.addListener) media.addListener(onMediaChange);
    }

    renderTheme();
  }

  var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));
  var panels = tabs.map(function (tab) {
    return document.getElementById(tab.getAttribute('aria-controls'));
  });

  function activateTab(index, focus) {
    tabs.forEach(function (tab, i) {
      var active = i === index;
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.tabIndex = active ? 0 : -1;
      if (panels[i]) panels[i].hidden = !active;
    });
    if (focus && tabs[index]) tabs[index].focus();
  }

  function tabFromHash() {
    var hash = window.location.hash.replace('#', '');
    if (!hash) return -1;
    var found = -1;
    tabs.forEach(function (tab, i) {
      if (tab.getAttribute('aria-controls') === hash || tab.id === hash) found = i;
    });
    return found;
  }

  function selectTab(index, focus) {
    activateTab(index, focus);
    try {
      window.history.replaceState(null, '', '#' + tabs[index].id);
    } catch (error) {}
  }

  if (tabs.length && panels.every(Boolean)) {
    tabs.forEach(function (tab, i) {
      tab.addEventListener('click', function () {
        selectTab(i, false);
      });
      tab.addEventListener('keydown', function (event) {
        var next = null;
        if (event.key === 'ArrowRight') next = (i + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        if (next !== null) {
          event.preventDefault();
          activateTab(next, true);
        }
      });
    });

    var initial = tabFromHash();
    if (initial < 0) {
      initial = 0;
      tabs.forEach(function (tab, i) {
        if (tab.getAttribute('aria-selected') === 'true') initial = i;
      });
    }
    activateTab(initial, false);

    window.addEventListener('hashchange', function () {
      var index = tabFromHash();
      if (index >= 0) activateTab(index, false);
    });
  }

  var navLinks = Array.prototype.slice.call(document.querySelectorAll('.site-nav a'));
  var sections = navLinks.map(function (link) {
    var href = link.getAttribute('href');
    return href && href.charAt(0) === '#' ? document.querySelector(href) : null;
  }).filter(Boolean);

  if ('IntersectionObserver' in window && sections.length) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        navLinks.forEach(function (link) {
          if (link.getAttribute('href') === '#' + entry.target.id) {
            link.setAttribute('aria-current', 'true');
          } else {
            link.removeAttribute('aria-current');
          }
        });
      });
    }, { rootMargin: '-40% 0px -52% 0px', threshold: 0 });

    sections.forEach(function (section) {
      observer.observe(section);
    });
  }
})();
