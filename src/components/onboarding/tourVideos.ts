// NOTE(victor): Cache-warm videos with fetch() instead of detached <video> elements.
//
// The original code created 4 HTMLVideoElement objects with preload="auto" to prime
// the HTTP cache. Each one instantiates a Chromium WebMediaPlayer (decoder, buffer pool,
// network loader). Those native-layer objects were never disposed, leading to a fatal
// V8 HeapObject::SizeFromMap crash (Sentry ELECTRON-B1) -- heap corruption caused by
// stale WebMediaPlayer native state outliving V8's GC expectations.
//
// fetch() with mode:"no-cors" warms the same HTTP cache (matching the <video> element's
// default no-cors request mode) without touching the media pipeline at all. AbortController
// gives instant cancellation with zero teardown risk.
//
// Evidence:
//   - https://issues.chromium.org/40681459
//     Detached <video> elements leak WebMediaPlayer; clearing src + load() is required
//     but still races under GC pressure (confirmed by Chromium engineer).
//   - https://github.com/electron/electron/issues/18277
//     HTML5 video elements cause unbounded resident memory growth even when JS heap is
//     stable -- the leak is in native WebMediaPlayer, not JS.
//   - https://github.com/electron/electron/issues/33994
//     V8 has a ~4GB compressed-pointer cap; native media allocations count toward it,
//     making video element leaks uniquely dangerous in Electron.
//   - https://github.com/facebook/react/issues/15583
//     React's synthetic event system retains references to removed video elements,
//     preventing GC of detached nodes in Chromium.
//   - https://html.spec.whatwg.org/multipage/media.html#loading-the-media-resource
//     removeAttribute("src") + load() transitions to NETWORK_EMPTY, but only after
//     async microtask -- a window for native-side use-after-free under concurrent GC.
//     fetch() has no such window because no native media objects exist.
export const ONBOARDING_TOUR_VIDEO_URLS = Object.freeze([
  'https://www.openinterpreter.com/videos/demos/excel.mp4',
  'https://www.openinterpreter.com/videos/demos/pdf.mp4',
  'https://www.openinterpreter.com/videos/demos/word.mp4',
  'https://www.openinterpreter.com/videos/demos/markdown.mp4',
]);

let activeController: AbortController | null = null;

export function preloadOnboardingTourVideos(): void {
  if (activeController || typeof window === 'undefined') {
    return;
  }

  activeController = new AbortController();
  const { signal } = activeController;

  for (const url of ONBOARDING_TOUR_VIDEO_URLS) {
    fetch(url, { mode: 'no-cors', signal }).catch(() => {});
  }
}

export function disposeOnboardingTourVideos(): void {
  activeController?.abort();
  activeController = null;
}
