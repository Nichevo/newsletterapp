// Firefox on Android hides its bottom toolbar as you scroll but does not grow
// the layout viewport to match, so `position: fixed; bottom: 0` elements sit
// above an empty strip. The visual viewport does know the real height, so the
// difference is published as --vv-gap and the bottom bars offset by it.

export function trackViewportGap() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  let last = -1;
  const update = () => {
    const gap = Math.max(0, Math.round(vv.height + vv.offsetTop - root.clientHeight));
    if (gap !== last) {
      last = gap;
      root.style.setProperty('--vv-gap', `${gap}px`);
    }
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  window.addEventListener('resize', update);
  update();
}
