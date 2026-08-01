import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureMedia = resolve(root, 'tests/fixtures/workspace-template/media');
const sampleWorkspaceMedia = resolve(root, 'resources/sample-workspace/Demos/Expense Tracker');

await Promise.all([mkdir(fixtureMedia, { recursive: true }), mkdir(sampleWorkspaceMedia, { recursive: true })]);

function runFfmpeg(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ffmpeg exited with status ${result.status}`);
}

function runCommand(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

const mountainsSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7467a8"/><stop offset="0.55" stop-color="#f2a77d"/><stop offset="1" stop-color="#f7d7aa"/>
    </linearGradient>
    <linearGradient id="lake" x1="0" y1="0" x2="0" y2="1">
      <stop stop-color="#86a9ba"/><stop offset="1" stop-color="#283d58"/>
    </linearGradient>
  </defs>
  <rect width="400" height="190" fill="url(#sky)"/>
  <path d="M0 194 L62 118 L104 165 L162 72 L218 157 L271 104 L323 164 L369 117 L400 150 L400 220 L0 220 Z" fill="#303a55"/>
  <path d="M62 118 L82 151 L104 165 L90 166 Z M162 72 L185 133 L218 157 L180 143 Z M271 104 L288 143 L323 164 L293 154 Z M369 117 L383 142 L400 150 L383 153 Z" fill="#f4edf0" opacity=".92"/>
  <path d="M0 188 Q74 174 138 190 T271 185 T400 194 L400 300 L0 300 Z" fill="url(#lake)"/>
  <path d="M0 230 Q68 211 128 232 T264 226 T400 235" fill="none" stroke="#d2e4e8" stroke-width="3" opacity=".55"/>
  <path d="M0 260 Q82 241 152 263 T292 255 T400 267" fill="none" stroke="#aecbd4" stroke-width="2" opacity=".45"/>
</svg>`;

const dogSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="720" viewBox="0 0 1080 720">
  <rect width="1080" height="720" fill="#e8eef2"/>
  <circle cx="540" cy="380" r="220" fill="#d39a5a"/>
  <ellipse cx="352" cy="332" rx="96" ry="176" fill="#a96f3f" transform="rotate(20 352 332)"/>
  <ellipse cx="728" cy="332" rx="96" ry="176" fill="#a96f3f" transform="rotate(-20 728 332)"/>
  <ellipse cx="540" cy="446" rx="150" ry="116" fill="#f2d2a2"/>
  <circle cx="463" cy="355" r="22" fill="#2b211e"/><circle cx="617" cy="355" r="22" fill="#2b211e"/>
  <circle cx="456" cy="348" r="7" fill="#fff"/><circle cx="610" cy="348" r="7" fill="#fff"/>
  <ellipse cx="540" cy="420" rx="48" ry="34" fill="#2b211e"/>
  <path d="M540 451 Q540 515 474 504 M540 451 Q540 515 606 504" fill="none" stroke="#2b211e" stroke-width="14" stroke-linecap="round"/>
  <path d="M390 568 Q540 650 690 568" fill="none" stroke="#e24a62" stroke-width="36" stroke-linecap="round"/>
</svg>`;

const receiptSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800">
  <rect width="600" height="800" fill="#fff"/>
  <g font-family="Arial, Helvetica, sans-serif" fill="#171717">
    <text x="300" y="64" text-anchor="middle" font-size="34" font-weight="700">EXAMPLE OFFICE SUPPLY</text>
    <text x="300" y="94" text-anchor="middle" font-size="18">Fictional test receipt — not a real merchant</text>
    <text x="48" y="145" font-size="18">Date: 10/14/2025</text><text x="48" y="171" font-size="18">Order: TEST-00284951</text>
    <line x1="48" y1="195" x2="552" y2="195" stroke="#171717" stroke-width="2"/>
    <text x="48" y="232" font-size="17" font-weight="700">ITEM</text><text x="520" y="232" text-anchor="end" font-size="17" font-weight="700">PRICE</text>
    <line x1="48" y1="244" x2="552" y2="244" stroke="#555"/>
    <text x="48" y="286" font-size="17">Printer paper (500 sheets)</text><text x="520" y="286" text-anchor="end" font-size="17">$24.99</text>
    <text x="48" y="330" font-size="17">Ballpoint pens (12-pack)</text><text x="520" y="330" text-anchor="end" font-size="17">$8.49</text>
    <text x="48" y="374" font-size="17">Sticky notes (6-pack)</text><text x="520" y="374" text-anchor="end" font-size="17">$12.99</text>
    <text x="48" y="418" font-size="17">Desktop organizer</text><text x="520" y="418" text-anchor="end" font-size="17">$22.49</text>
    <line x1="48" y1="458" x2="552" y2="458" stroke="#aaa"/>
    <text x="390" y="500" font-size="18">Subtotal:</text><text x="520" y="500" text-anchor="end" font-size="18">$68.96</text>
    <text x="390" y="532" font-size="18">Tax:</text><text x="520" y="532" text-anchor="end" font-size="18">$7.00</text>
    <line x1="350" y1="552" x2="552" y2="552" stroke="#171717" stroke-width="2"/>
    <text x="300" y="598" font-size="28" font-weight="700">TOTAL:</text><text x="540" y="598" text-anchor="end" font-size="28" font-weight="700">$75.96</text>
    <text x="48" y="670" font-size="17">Payment method: TEST CARD •••• 0000</text>
    <text x="300" y="744" text-anchor="middle" font-size="16" fill="#666">Generated fixture for Interpreter Workstation tests</text>
  </g>
</svg>`;

await sharp(Buffer.from(mountainsSvg)).png().toFile(resolve(fixtureMedia, 'mountains.png'));
await sharp(Buffer.from(dogSvg)).jpeg({ quality: 88 }).toFile(resolve(root, 'tests/fixtures/workspace-template/dog_photo.jpg'));
const receipt = await sharp(Buffer.from(receiptSvg)).jpeg({ quality: 92 }).toBuffer();
await Promise.all([
  sharp(receipt).toFile(resolve(fixtureMedia, 'receipt.jpg')),
  sharp(receipt).toFile(resolve(sampleWorkspaceMedia, 'receipt.jpg')),
]);

runFfmpeg([
  '-f', 'lavfi', '-i', 'sine=frequency=220:duration=30:sample_rate=44100',
  '-f', 'lavfi', '-i', 'sine=frequency=329.63:duration=30:sample_rate=44100',
  '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=longest,volume=0.12[a]',
  '-map', '[a]', '-ac', '2', '-ar', '44100', '-codec:a', 'libmp3lame', '-b:a', '96k',
  resolve(fixtureMedia, 'music.mp3'),
]);

runFfmpeg([
  '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=8',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8:sample_rate=44100',
  '-shortest', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '96k', '-metadata', 'title=Interpreter Workstation synthetic test video',
  resolve(fixtureMedia, 'sample-video.mp4'),
]);

runCommand(process.env.PYTHON || 'python3', [
  resolve(root, 'scripts/generate-public-research-note.py'),
  resolve(root, 'apps/interpreter-marketing-demo/public/papers/pi0-general-robot-control.pdf'),
]);

console.log('Generated public-safe media fixtures.');
