(function () {
  'use strict';

  var root = document.documentElement;
  var reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false;
  var finePointer = window.matchMedia ? window.matchMedia('(pointer: fine)').matches : false;
  var traceStops = [];
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

  /* ---------- scroll progress ---------- */

  var scrollProgress = document.querySelector('.scroll-progress span');

  function updateScrollProgress() {
    if (!scrollProgress) return;
    var max = document.documentElement.scrollHeight - window.innerHeight;
    var value = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
    scrollProgress.style.transform = 'scaleX(' + value + ')';
  }

  updateScrollProgress();
  window.addEventListener('scroll', updateScrollProgress, { passive: true });
  window.addEventListener('resize', updateScrollProgress);

  /* ---------- hero pointer light ---------- */

  var hero = document.querySelector('.hero');

  if (hero && finePointer && !reduceMotion) {
    var pointerFrame = null;
    hero.addEventListener('pointermove', function (event) {
      if (pointerFrame !== null) return;
      pointerFrame = window.requestAnimationFrame(function () {
        var rect = hero.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          var x = ((event.clientX - rect.left) / rect.width) * 100;
          var y = ((event.clientY - rect.top) / rect.height) * 100;
          hero.style.setProperty('--mx', x.toFixed(1) + '%');
          hero.style.setProperty('--my', y.toFixed(1) + '%');
        }
        pointerFrame = null;
      });
    }, { passive: true });
  }

  /* ---------- live trace ---------- */

  var live = document.querySelector('[data-live-trace]');

  if (live) {
    var liveSteps = Array.prototype.slice.call(live.querySelectorAll('[data-live-step]'));
    var liveStatus = live.querySelector('[data-live-status]');
    var liveToggle = live.querySelector('[data-live-toggle]');
    var liveIndex = 0;
    var livePlaying = !reduceMotion;
    var liveTimer = null;

    var renderLive = function () {
      liveSteps.forEach(function (step, i) {
        step.classList.toggle('is-current', i === liveIndex);
        step.classList.toggle('is-past', i < liveIndex);
      });
      var progress = liveSteps.length > 0 ? ((liveIndex + 1) / liveSteps.length) * 100 : 0;
      live.style.setProperty('--live-progress', progress.toFixed(2) + '%');
      if (liveStatus) {
        liveStatus.textContent = liveIndex === liveSteps.length - 1 ? '已完成' : '运行中';
      }
      if (liveToggle) {
        liveToggle.textContent = livePlaying ? '暂停' : '播放';
        liveToggle.setAttribute('aria-label', livePlaying ? '暂停实时轨迹' : '播放实时轨迹');
      }
    };

    var scheduleLive = function () {
      if (liveTimer !== null) window.clearTimeout(liveTimer);
      liveTimer = null;
      if (!livePlaying || reduceMotion) return;
      var delay = liveIndex === liveSteps.length - 1 ? 2400 : 1600;
      liveTimer = window.setTimeout(function () {
        liveIndex = (liveIndex + 1) % liveSteps.length;
        renderLive();
        scheduleLive();
      }, delay);
    };

    var setLivePlaying = function (playing) {
      livePlaying = playing;
      if (!playing && liveTimer !== null) {
        window.clearTimeout(liveTimer);
        liveTimer = null;
      }
      renderLive();
      if (playing) {
        if (liveIndex === liveSteps.length - 1) liveIndex = 0;
        renderLive();
        scheduleLive();
      }
    };

    if (liveToggle) {
      liveToggle.addEventListener('click', function () {
        setLivePlaying(!livePlaying);
      });
    }

    if (reduceMotion) {
      liveIndex = liveSteps.length - 1;
      renderLive();
      if (liveToggle) liveToggle.hidden = true;
    } else {
      renderLive();
      scheduleLive();
    }
  }

  /* ---------- trace players ---------- */

  Array.prototype.slice.call(document.querySelectorAll('[data-trace-play]')).forEach(function (button) {
    var panel = button.closest('.task-panel');
    if (!panel) return;
    var steps = Array.prototype.slice.call(panel.querySelectorAll('.trace-step'));
    var label = button.querySelector('[data-trace-play-label]');
    var status = panel.querySelector('[data-trace-status]');
    var progress = panel.querySelector('.trace-progress i');
    var current = -1;
    var timer = null;
    var playing = false;

    var renderTrace = function () {
      steps.forEach(function (step, i) {
        step.classList.toggle('is-current', i === current);
        step.classList.toggle('is-past', i < current);
      });
      if (progress) {
        var width = steps.length > 0 ? ((current + 1) / steps.length) * 100 : 0;
        progress.style.width = width.toFixed(2) + '%';
      }
      if (status) {
        status.textContent = current < 0
          ? steps.length + ' 步 · 真实 JSONL'
          : (current + 1) + ' / ' + steps.length + ' 步';
      }
      if (label) label.textContent = playing ? '暂停' : (current >= steps.length - 1 && steps.length > 0 ? '重播' : '播放轨迹');
      button.classList.toggle('is-playing', playing);
    };

    var stopTrace = function () {
      playing = false;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      button.setAttribute('aria-label', '播放任务轨迹');
      renderTrace();
    };

    var advanceTrace = function () {
      if (!playing) return;
      if (current >= steps.length - 1) {
        stopTrace();
        return;
      }
      current += 1;
      renderTrace();
      if (steps[current]) {
        steps[current].scrollIntoView({
          behavior: reduceMotion ? 'auto' : 'smooth',
          block: 'nearest',
          inline: 'nearest'
        });
      }
      timer = window.setTimeout(advanceTrace, 1100);
    };

    button.addEventListener('click', function () {
      if (playing) {
        stopTrace();
        return;
      }
      current = -1;
      playing = true;
      button.setAttribute('aria-label', '暂停任务轨迹');
      renderTrace();
      advanceTrace();
    });

    traceStops.push(stopTrace);
  });

  /* ---------- tabs ---------- */

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

    traceStops.forEach(function (stop) {
      stop();
    });

    var activePanel = panels[index];
    if (activePanel) {
      activePanel.classList.remove('is-entering');
      void activePanel.offsetWidth;
      activePanel.classList.add('is-entering');
      window.setTimeout(function () {
        activePanel.classList.remove('is-entering');
      }, 520);
    }

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

  /* ---------- reveal, counters, chart ---------- */

  var revealItems = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
  var countItems = Array.prototype.slice.call(document.querySelectorAll('[data-count]'));
  var canAnimate = 'IntersectionObserver' in window && !reduceMotion;

  function formatCount(value, format) {
    var rounded = Math.round(value);
    if (format === 'comma') return rounded.toLocaleString('en-US');
    return String(rounded);
  }

  function animateCount(element) {
    if (!element || element.dataset.counted === '1') return;
    var target = Number(element.getAttribute('data-count'));
    if (!Number.isFinite(target) || target === 0) {
      element.dataset.counted = '1';
      return;
    }
    var format = element.getAttribute('data-format');
    var started = window.performance.now();
    var duration = 900;

    var tick = function (now) {
      var progress = Math.min(1, (now - started) / duration);
      var eased = 1 - Math.pow(1 - progress, 3);
      element.textContent = formatCount(target * eased, format);
      if (progress < 1) {
        window.requestAnimationFrame(tick);
      } else {
        element.textContent = formatCount(target, format);
        element.dataset.counted = '1';
      }
    };

    element.textContent = '0';
    window.requestAnimationFrame(tick);
  }

  if (canAnimate) {
    root.classList.add('motion');

    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        revealObserver.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });

    revealItems.forEach(function (item) {
      revealObserver.observe(item);
    });

    var countObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        animateCount(entry.target);
        countObserver.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.2 });

    countItems.forEach(function (item) {
      countObserver.observe(item);
    });
  } else {
    countItems.forEach(function (item) {
      item.dataset.counted = '1';
    });
  }

  /* ---------- image shimmer ---------- */

  Array.prototype.slice.call(document.querySelectorAll('.phone-bezel img')).forEach(function (image) {
    var bezel = image.closest('.phone-bezel');
    if (!bezel) return;

    var markLoaded = function () {
      bezel.classList.add('is-loaded');
    };

    if (image.complete && image.naturalWidth > 0) {
      markLoaded();
    } else {
      image.addEventListener('load', markLoaded, { once: true });
      image.addEventListener('error', markLoaded, { once: true });
    }
  });

  /* ---------- evidence lightbox ---------- */

  var lightbox = document.querySelector('[data-lightbox-modal]');
  var lightboxImage = lightbox ? lightbox.querySelector('[data-lightbox-image]') : null;
  var lightboxCaption = lightbox ? lightbox.querySelector('[data-lightbox-caption]') : null;
  var lightboxClose = lightbox ? lightbox.querySelector('[data-lightbox-close]') : null;
  var lightboxReturnFocus = null;

  function closeLightbox() {
    if (!lightbox) return;
    lightbox.classList.remove('is-open');
    lightbox.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('lightbox-open');
    if (lightboxReturnFocus && typeof lightboxReturnFocus.focus === 'function') {
      lightboxReturnFocus.focus();
    }
  }

  function openLightbox(image) {
    if (!lightbox || !lightboxImage) return;
    lightboxReturnFocus = document.activeElement;
    var figure = image.closest('figure');
    var caption = figure ? figure.querySelector('figcaption') : null;
    lightboxImage.src = image.currentSrc || image.src;
    lightboxImage.alt = image.alt || '证据大图';
    if (lightboxCaption) lightboxCaption.textContent = caption ? caption.textContent.trim() : '';
    lightbox.classList.add('is-open');
    lightbox.setAttribute('aria-hidden', 'false');
    document.body.classList.add('lightbox-open');
    if (lightboxClose) lightboxClose.focus();
  }

  if (lightbox) {
    Array.prototype.slice.call(document.querySelectorAll('img[data-lightbox]')).forEach(function (image) {
      image.setAttribute('tabindex', '0');
      image.setAttribute('role', 'button');
      if (!image.getAttribute('aria-label')) {
        image.setAttribute('aria-label', '查看大图：' + (image.alt || '证据截图'));
      }
      image.addEventListener('click', function () {
        openLightbox(image);
      });
      image.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openLightbox(image);
        }
      });
    });

    if (lightboxClose) lightboxClose.addEventListener('click', closeLightbox);
    lightbox.addEventListener('click', function (event) {
      if (event.target === lightbox) closeLightbox();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && lightbox.classList.contains('is-open')) closeLightbox();
    });
  }

  /* ---------- scrollspy ---------- */

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
