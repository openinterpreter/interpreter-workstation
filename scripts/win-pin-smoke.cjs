// Smoke test for the Windows native pinning addon. Runs inside the Parallels
// Windows mirror via `pnpm run winvm:workspace:run -- node scripts/win-pin-smoke.cjs`.
// Verifies that the addon loads, identifies a window at a screen point, and
// reports z-order context.

const addon = require('interpreter-window-pin');

function safeJson(v) {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

console.log('platform:', addon.platform);
console.log('exports:', Object.keys(addon));

const point = { x: 800, y: 500 };
const w = addon.windowAtPoint(point.x, point.y);
console.log(`windowAtPoint(${point.x},${point.y}):`, safeJson(w));

if (w && typeof w.pid === 'number') {
  const f = addon.frontmostByPid(w.pid);
  console.log('frontmostByPid:', safeJson(f));
  const b = addon.windowBoundsByHwnd(w.hwnd);
  console.log('windowBoundsByHwnd:', safeJson(b));
}
