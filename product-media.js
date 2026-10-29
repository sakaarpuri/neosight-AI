// Reuse the live site's film without intercepting scrolling or requiring motion.
(() => {
  const video = document.getElementById('revealProductVideo');
  const frame = document.getElementById('productFrame');
  const toggle = document.getElementById('productMotionToggle');
  if (!video || !frame || !toggle) return;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const saveData = Boolean(navigator.connection?.saveData);
  let inView = false;
  let userPaused = false;

  function updateControl() {
    toggle.textContent = video.paused ? 'Play rotation' : 'Pause rotation';
    toggle.setAttribute('aria-label', video.paused ? 'Play VeoClara product rotation' : 'Pause VeoClara product rotation');
  }
  function showFilm() {
    frame.classList.add('is-ready');
    toggle.hidden = false;
    updateControl();
  }
  function updatePlayback() {
    if (!inView || document.hidden || reducedMotion.matches || saveData || userPaused) {
      video.pause();
    } else {
      video.play().catch(updateControl);
    }
  }
  video.addEventListener('loadeddata', showFilm);
  video.addEventListener('play', updateControl);
  video.addEventListener('pause', updateControl);
  video.addEventListener('error', () => {
    video.pause();
    frame.classList.remove('is-ready');
    toggle.hidden = true;
  });
  toggle.addEventListener('click', () => {
    if (video.paused) {
      userPaused = false;
      video.play().catch(updateControl);
    } else {
      userPaused = true;
      video.pause();
    }
  });
  new IntersectionObserver(entries => {
    inView = entries[0].isIntersecting;
    updatePlayback();
  }, { threshold: 0.15 }).observe(frame);
  document.addEventListener('visibilitychange', updatePlayback);
  reducedMotion.addEventListener('change', updatePlayback);
  if (video.readyState >= 2) showFilm();
})();
