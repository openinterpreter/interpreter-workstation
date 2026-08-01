const fs = require('node:fs');
const sharp = require('sharp');

const IMAGE_WIDTH = 1024;
const IMAGE_HEIGHT = 1536;

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapText(value, maxChars) {
  const words = String(value || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }

    if (current) {
      lines.push(current);
    }
    current = word;
  }

  if (current) {
    lines.push(current);
  }

  return lines;
}

function formatMoney(value) {
  return Number(value).toFixed(2);
}

function pickSceneTheme(backgroundScene) {
  const scene = String(backgroundScene || '').toLowerCase();

  if (scene.includes('cafe')) {
    return {
      deskStart: '#c9966b',
      deskEnd: '#9f6f4c',
      glow: '#f7d7b6',
      notebook: '#efe2c9',
      keyboard: '#e6e0d7',
      mug: '#f3f2ee',
      mugAccent: '#a97148',
      pen: '#3f526b',
      shadow: 'rgba(47, 31, 20, 0.18)',
    };
  }

  if (scene.includes('hotel')) {
    return {
      deskStart: '#6c5647',
      deskEnd: '#44362d',
      glow: '#f0c989',
      notebook: '#d8c9b4',
      keyboard: '#c8c5bf',
      mug: '#efe7d8',
      mugAccent: '#be9a64',
      pen: '#2c3a4f',
      shadow: 'rgba(22, 16, 12, 0.22)',
    };
  }

  if (scene.includes('commuter')) {
    return {
      deskStart: '#d4d9df',
      deskEnd: '#abb5c1',
      glow: '#f2f7ff',
      notebook: '#f7f9fc',
      keyboard: '#edf2f7',
      mug: '#ffffff',
      mugAccent: '#61758c',
      pen: '#23384e',
      shadow: 'rgba(22, 34, 48, 0.16)',
    };
  }

  return {
    deskStart: '#b8c1c9',
    deskEnd: '#8f9aa4',
    glow: '#edf4ff',
    notebook: '#f4f0e8',
    keyboard: '#f0f2f4',
    mug: '#fbfbfb',
    mugAccent: '#6f879d',
    pen: '#26384b',
    shadow: 'rgba(23, 33, 44, 0.18)',
  };
}

function buildDeskBackgroundSvg(receipt) {
  const theme = pickSceneTheme(receipt.backgroundScene);

  return `
    <svg width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" viewBox="0 0 ${IMAGE_WIDTH} ${IMAGE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="desk" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${theme.deskStart}" />
          <stop offset="100%" stop-color="${theme.deskEnd}" />
        </linearGradient>
        <radialGradient id="glow" cx="24%" cy="20%" r="48%">
          <stop offset="0%" stop-color="${theme.glow}" stop-opacity="0.95" />
          <stop offset="100%" stop-color="${theme.glow}" stop-opacity="0" />
        </radialGradient>
        <filter id="soft-shadow" x="-25%" y="-25%" width="150%" height="150%">
          <feGaussianBlur stdDeviation="16" />
        </filter>
      </defs>

      <rect width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" fill="url(#desk)" />
      <rect width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" fill="url(#glow)" opacity="0.85" />
      <rect x="54" y="82" width="304" height="468" rx="22" fill="${theme.notebook}" transform="rotate(-8 54 82)" />
      <rect x="72" y="106" width="270" height="10" rx="5" fill="${theme.shadow}" opacity="0.18" transform="rotate(-8 72 106)" />
      <rect x="62" y="624" width="392" height="210" rx="24" fill="${theme.keyboard}" />
      <g opacity="0.38">
        <rect x="92" y="668" width="40" height="24" rx="7" fill="#ffffff" />
        <rect x="146" y="668" width="40" height="24" rx="7" fill="#ffffff" />
        <rect x="200" y="668" width="40" height="24" rx="7" fill="#ffffff" />
        <rect x="254" y="668" width="40" height="24" rx="7" fill="#ffffff" />
        <rect x="308" y="668" width="40" height="24" rx="7" fill="#ffffff" />
        <rect x="92" y="706" width="52" height="24" rx="7" fill="#ffffff" />
        <rect x="158" y="706" width="52" height="24" rx="7" fill="#ffffff" />
        <rect x="224" y="706" width="52" height="24" rx="7" fill="#ffffff" />
        <rect x="290" y="706" width="52" height="24" rx="7" fill="#ffffff" />
        <rect x="92" y="744" width="108" height="24" rx="7" fill="#ffffff" />
        <rect x="214" y="744" width="134" height="24" rx="7" fill="#ffffff" />
      </g>
      <circle cx="864" cy="232" r="122" fill="${theme.mug}" />
      <circle cx="864" cy="232" r="82" fill="${theme.mugAccent}" opacity="0.28" />
      <path d="M962 194c34 0 54 20 54 49s-20 49-54 49" fill="none" stroke="${theme.mug}" stroke-width="24" stroke-linecap="round" />
      <rect x="810" y="1020" width="36" height="300" rx="16" fill="${theme.pen}" transform="rotate(14 810 1020)" />
      <rect x="742" y="1118" width="166" height="110" rx="18" fill="#1f2f46" opacity="0.92" transform="rotate(-8 742 1118)" />
      <rect x="758" y="1134" width="134" height="78" rx="12" fill="#f4d86a" opacity="0.86" transform="rotate(-8 758 1134)" />
      <ellipse cx="520" cy="1168" rx="408" ry="156" fill="${theme.shadow}" opacity="0.12" filter="url(#soft-shadow)" />
    </svg>
  `;
}

function buildReceiptSvg(receipt) {
  const items = Array.isArray(receipt.lineItems) ? receipt.lineItems : [];
  const textLines = [];
  const decorativeBlocks = [];

  textLines.push({ text: receipt.merchant, className: 'merchant', top: 92 });
  wrapText(receipt.address, 30).forEach((line, index) => {
    textLines.push({ text: line, className: 'secondary', top: 148 + index * 26 });
  });

  textLines.push({ text: `DATE ${receipt.purchaseDateDisplay}   TIME ${receipt.purchaseTime}`, className: 'secondary', top: 250 });
  textLines.push({ text: `RECEIPT # ${receipt.receiptNumber}`, className: 'secondary', top: 282 });
  textLines.push({ text: '--------------------------------', className: 'secondary', top: 332 });

  let currentTop = 382;
  for (const item of items) {
    textLines.push({ text: item.label, className: 'line-item', top: currentTop });
    textLines.push({ text: formatMoney(item.amount), className: 'amount', top: currentTop });
    currentTop += 48;
  }

  currentTop += 8;
  textLines.push({ text: '--------------------------------', className: 'secondary', top: currentTop });
  currentTop += 48;
  textLines.push({ text: 'SUBTOTAL', className: 'summary', top: currentTop });
  textLines.push({ text: formatMoney(receipt.subtotal), className: 'amount', top: currentTop });
  currentTop += 42;

  if (receipt.taxAmount !== null && receipt.taxAmount !== undefined) {
    textLines.push({ text: 'TAX', className: 'summary', top: currentTop });
    textLines.push({ text: formatMoney(receipt.taxAmount), className: 'amount', top: currentTop });
    currentTop += 42;
  }

  if (receipt.tipAmount !== null && receipt.tipAmount !== undefined && Number(receipt.tipAmount) > 0) {
    textLines.push({ text: 'TIP', className: 'summary', top: currentTop });
    textLines.push({ text: formatMoney(receipt.tipAmount), className: 'amount', top: currentTop });
    currentTop += 42;
  }

  decorativeBlocks.push(`<rect x="52" y="${currentTop - 38}" width="616" height="64" rx="8" fill="#f4ecd7"/>`);
  textLines.push({ text: 'AMOUNT PAID', className: 'total', top: currentTop });
  textLines.push({ text: formatMoney(receipt.totalAmount), className: 'amount total-amount', top: currentTop });
  currentTop += 62;

  textLines.push({ text: `${receipt.paymentMethod.toUpperCase()} **** ${receipt.cardLastFour}`, className: 'payment', top: currentTop });
  currentTop += 42;
  textLines.push({ text: `AID ${receipt.approvalCode}`, className: 'secondary', top: currentTop });
  currentTop += 54;
  textLines.push({ text: 'APPROVED', className: 'summary', top: currentTop });
  currentTop += 70;
  textLines.push({ text: 'Thank you for your business', className: 'footer', top: currentTop });

  const svgLines = textLines.map((line) => {
    const isRightAligned = line.className.includes('amount');
    const x = isRightAligned ? 598 : 72;
    const anchor = isRightAligned ? 'end' : 'start';
    return `<text class="${line.className}" x="${x}" y="${line.top}" text-anchor="${anchor}">${escapeXml(line.text)}</text>`;
  }).join('');

  return `
    <svg width="720" height="1180" viewBox="0 0 720 1180" xmlns="http://www.w3.org/2000/svg">
      <rect x="20" y="16" width="680" height="1148" rx="18" fill="#fffdf7"/>
      <rect x="44" y="40" width="632" height="1100" rx="10" fill="none" stroke="#ebe4d6" stroke-width="2"/>
      <style>
        text {
          fill: #2b241c;
          font-family: "Courier New", monospace;
          letter-spacing: 0.03em;
        }
        .merchant {
          font-size: 36px;
          font-weight: 700;
        }
        .secondary {
          font-size: 20px;
          opacity: 0.92;
        }
        .line-item,
        .summary,
        .payment {
          font-size: 26px;
          font-weight: 600;
        }
        .amount {
          font-size: 26px;
          font-weight: 600;
        }
        .total {
          font-size: 30px;
          font-weight: 800;
          letter-spacing: 0.05em;
        }
        .total-amount {
          font-size: 44px;
          font-weight: 800;
        }
        .footer {
          font-size: 20px;
          opacity: 0.92;
        }
      </style>
      ${decorativeBlocks.join('')}
      ${svgLines}
    </svg>
  `;
}

function buildShadowSvg() {
  return `
    <svg width="840" height="1280" viewBox="0 0 840 1280" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="18" />
        </filter>
      </defs>
      <rect x="74" y="76" width="680" height="1148" rx="24" fill="rgba(15, 23, 42, 0.28)" filter="url(#shadow)"/>
    </svg>
  `;
}

async function buildReceiptCardBuffer(receipt) {
  return sharp(Buffer.from(buildReceiptSvg(receipt)))
    .png()
    .toBuffer();
}

async function buildShadowBuffer() {
  return sharp(Buffer.from(buildShadowSvg()))
    .png()
    .toBuffer();
}

async function buildDeskBackgroundBuffer(receipt) {
  return sharp(Buffer.from(buildDeskBackgroundSvg(receipt)))
    .png()
    .toBuffer();
}

async function buildReceiptImageBuffer(receipt) {
  const backgroundBuffer = await buildDeskBackgroundBuffer(receipt);
  const receiptCard = await buildReceiptCardBuffer(receipt);
  const shadowCard = await buildShadowBuffer();
  const rotatedReceipt = await sharp(receiptCard)
    .rotate(-4.2, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const rotatedShadow = await sharp(shadowCard)
    .rotate(-4.2, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  return sharp(backgroundBuffer)
    .composite([
      { input: rotatedShadow, left: 140, top: 116 },
      { input: rotatedReceipt, left: 154, top: 102 },
    ])
    .png()
    .toBuffer();
}

async function buildReceiptImageDataUrl(receipt) {
  const buffer = await buildReceiptImageBuffer(receipt);
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

async function ensureReceiptImageAsset(assetPath, receipt) {
  const buffer = await buildReceiptImageBuffer(receipt);
  fs.writeFileSync(assetPath, buffer);
}

module.exports = {
  buildReceiptImageBuffer,
  buildReceiptImageDataUrl,
  ensureReceiptImageAsset,
};
