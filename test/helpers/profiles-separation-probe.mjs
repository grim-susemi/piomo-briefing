// Browser-side probes for test/profiles-separation.test.mjs (todo 6 attempt 2).
// Separates computed CSS geometry/contrast from physical-pixel PNG raster analysis at DPR 1.5.

export const SEPARATION_PROBE_SCRIPT = `(() => {
  const parse = (raw) => {
    const s = String(raw || '').trim();
    const srgb = /^color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)(?:\\s*\\/\\s*([\\d.]+))?\\)$/.exec(s);
    if (srgb) return { r: Number(srgb[1]) * 255, g: Number(srgb[2]) * 255, b: Number(srgb[3]) * 255, a: srgb[4] === undefined ? 1 : Number(srgb[4]) };
    const m = /^rgba?\\(([^)]+)\\)$/.exec(s);
    if (!m) return { r: 0, g: 0, b: 0, a: 0 };
    const p = m[1].trim().split(/[\\s,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const lum = (c) => {
    const ch = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
  };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100; };
  const surfaceOf = (el) => {
    const layers = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c.a > 0) { layers.push(c); if (c.a >= 0.999) break; }
    }
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    return bg;
  };
  const main = document.getElementById('main');
  main.scrollTop = 0;
  const pageBg = surfaceOf(main), cardsBox = document.querySelector('.pf-cards'), cardsCs = getComputedStyle(cardsBox);
  const cardTops = [...document.querySelectorAll('.pf-card')].map((c) => {
    const cs = getComputedStyle(c), b = parse(cs.borderTopColor), cardSurface = surfaceOf(c);
    return {
      profile: c.querySelector('[data-profile]')?.dataset.profile || '', on: c.classList.contains('on'),
      pressed: c.querySelector('.pf-card-b')?.getAttribute('aria-pressed'), hasCurrent: !!c.querySelector('.pf-current'),
      borderTopWidth: parseFloat(cs.borderTopWidth) || 0, borderTopColor: cs.borderTopColor, backgroundColor: cs.backgroundColor,
      boxShadow: cs.boxShadow, nameWeight: Number(getComputedStyle(c.querySelector('.pf-card-name')).fontWeight),
      contrastVsPage: ratio(over(b, pageBg), pageBg), contrastVsCardSurface: ratio(over(b, cardSurface), cardSurface),
      contrast: ratio(over(b, pageBg), pageBg), rectTop: c.getBoundingClientRect().top, rectBottom: c.getBoundingClientRect().bottom,
    };
  });
  const cardGaps = [];
  for (let i = 1; i < cardTops.length; i++) cardGaps.push(Math.round(cardTops[i].rectTop - cardTops[i - 1].rectBottom));
  const cardsBottomBorder = { width: parseFloat(cardsCs.borderBottomWidth) || 0, contrast: ratio(over(parse(cardsCs.borderBottomColor), pageBg), pageBg), rowGap: parseFloat(cardsCs.rowGap) || 0 };
  const currentCs = getComputedStyle(document.querySelector('.pf-current'));
  const groups = [...document.querySelectorAll('.pf-tab-panel:not([hidden]) .pf-group')];
  const groupHeaders = groups.map((g) => {
    const h = g.querySelector('.pf-group-h');
    if (!h) return null;
    const cs = getComputedStyle(h), rawBg = parse(cs.backgroundColor);
    return { group: g.dataset.flowSec, backgroundColor: cs.backgroundColor, alpha: rawBg.a, contrastVsPage: ratio(over(rawBg, pageBg), pageBg),
      paddingTop: parseFloat(cs.paddingTop), paddingLeft: parseFloat(cs.paddingLeft), borderRadius: cs.borderRadius };
  }).filter(Boolean);
  const firstAfterHeaderBorders = [], neighborRouteDividers = [];
  for (const g of groups) {
    const rows = [...g.querySelectorAll(':scope > .pf-route, :scope > .pf-agent')];
    for (let i = 0; i < rows.length; i++) {
      const cs = getComputedStyle(rows[i]), bw = parseFloat(cs.borderTopWidth) || 0, c = ratio(over(parse(cs.borderTopColor), pageBg), pageBg);
      if (i === 0 && rows[0].previousElementSibling?.classList.contains('pf-group-h')) firstAfterHeaderBorders.push({ group: g.dataset.flowSec, borderTopWidth: bw });
      else if (i > 0) neighborRouteDividers.push({ group: g.dataset.flowSec, index: i, borderTopWidth: bw, borderTopColor: cs.borderTopColor, contrast: c });
    }
  }
  const collapsedHeights = [...document.querySelectorAll('.pf-tab-panel:not([hidden]) .pf-row-sum[aria-expanded="false"]')]
    .map((s) => Math.round(s.parentElement.getBoundingClientRect().height * 100) / 100);
  const openEditor = document.querySelector('.pf-tab-panel:not([hidden]) .pf-route > .pf-tri:not([hidden]), .pf-tab-panel:not([hidden]) .pf-agent-editor:not([hidden]), .pf-tab-panel:not([hidden]) .pf-mem-sels:not([hidden])');
  const openEditorStyle = openEditor ? (() => {
    const cs = getComputedStyle(openEditor), bg = parse(cs.backgroundColor);
    return { borderTopWidth: parseFloat(cs.borderTopWidth) || 0, borderTopContrast: ratio(over(parse(cs.borderTopColor), pageBg), pageBg), backgroundAlpha: bg.a, backgroundColor: cs.backgroundColor };
  })() : null;
  const hasVisualBox = (el) => {
    const cs = getComputedStyle(el), hasBg = parse(cs.backgroundColor).a > 0;
    const borders = ['Top', 'Right', 'Bottom', 'Left'].map((s) => parseFloat(cs['border' + s + 'Width']) || 0).filter((w) => w > 0).length;
    const hasShadow = cs.boxShadow && cs.boxShadow !== 'none';
    return (hasBg && (borders >= 2 || hasShadow)) || (borders >= 2 && hasShadow);
  };
  const nonFlat = [...main.querySelectorAll('.pf-sec, .pf-card, .pf-tray, .pf-blk, .pf-agent, .pf-route, .pf-mem-row')]
    .filter((el) => el.checkVisibility() && el.getBoundingClientRect().width > 0 && hasVisualBox(el))
    .map((el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '.' + [...el.classList].join('.'));
  const titleRect = document.querySelector('.pf-title').getBoundingClientRect(), mainRect = main.getBoundingClientRect();
  const panesEl = document.querySelector('.pf-panes'), panesRect = panesEl.getBoundingClientRect();
  const webEl = document.querySelector('.pf-web');
  const webRect = webEl?.checkVisibility() ? webEl.getBoundingClientRect() : null;
  const webGap = webRect ? parseFloat(getComputedStyle(panesEl.parentElement).rowGap) : 0;
  return {
    width: innerWidth, dpr: devicePixelRatio,
    panesTop: panesRect.top,
    panesRelToMain: panesRect.top - mainRect.top,
    webTop: webRect ? webRect.top : null,
    webHeight: webRect ? webRect.height : null,
    webGap,
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth || main.scrollWidth > main.clientWidth,
    titleRelBottom: Math.round(titleRect.bottom - mainRect.top), cardsBottomBorder, cardGaps, cardTops,
    greenTokens: { tint: currentCs.backgroundColor, fg: currentCs.color }, currentCount: document.querySelectorAll('.pf-current').length,
    groupHeaders, firstAfterHeaderBorders, neighborRouteDividers, collapsedHeights, openEditorStyle, nonFlat,
  };
})()`;

export function buildRasterMeasureExpression(pngBase64, targets) {
  return `(async () => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + ${JSON.stringify(pngBase64)};
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const dpr = devicePixelRatio;
    const results = [];
    for (const t of ${JSON.stringify(targets)}) {
      const el = document.querySelector(t.selector);
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const cssWidth = parseFloat(t.edge === 'bottom' ? cs.borderBottomWidth : cs.borderTopWidth) || 0;
      const cssY = t.edge === 'bottom' ? r.bottom - cssWidth / 2 : r.top + cssWidth / 2;
      const cssX = r.left + Math.min(48, Math.max(16, r.width * 0.25));
      const pxX = Math.round(cssX * dpr);
      const pxCenterY = Math.round(cssY * dpr);
      const halfWindow = 8;
      const yStart = Math.max(0, pxCenterY - halfWindow);
      const yEnd = Math.min(canvas.height - 1, pxCenterY + halfWindow);
      const strip = ctx.getImageData(pxX, yStart, 1, yEnd - yStart + 1).data;
      const samples = [];
      for (let i = 0; i <= yEnd - yStart; i++) {
        samples.push({ y: yStart + i, r: strip[i * 4], g: strip[i * 4 + 1], b: strip[i * 4 + 2] });
      }
      const topBg = samples[0], botBg = samples[samples.length - 1];
      const dist = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
      const borderPixels = samples.filter((s) => dist(s, topBg) >= 12 && dist(s, botBg) >= 12);
      const cropW = 48, cropH = 20, scale = 8;
      const cropX = Math.max(0, Math.min(canvas.width - cropW, pxX - Math.floor(cropW / 2)));
      const cropY = Math.max(0, Math.min(canvas.height - cropH, pxCenterY - Math.floor(cropH / 2)));
      const outCanvas = document.createElement('canvas');
      outCanvas.width = cropW * scale;
      outCanvas.height = cropH * scale;
      const outCtx = outCanvas.getContext('2d');
      outCtx.imageSmoothingEnabled = false;
      outCtx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW * scale, cropH * scale);
      results.push({
        kind: t.kind,
        selector: t.selector,
        edge: t.edge,
        computedCssPx: cssWidth,
        predictedDevicePx: cssWidth * dpr,
        observedPhysicalThicknessPx: borderPixels.length,
        samplePhysicalX: pxX,
        expectedPhysicalCenterY: pxCenterY,
        borderPhysicalYs: borderPixels.map((p) => p.y),
        borderPhysicalRgbs: borderPixels.map((p) => [p.r, p.g, p.b]),
        adjacentTopRgb: [topBg.r, topBg.g, topBg.b],
        adjacentBottomRgb: [botBg.r, botBg.g, botBg.b],
        verticalProfile: samples,
        cropRectPhysical: { x: cropX, y: cropY, width: cropW, height: cropH, magnification: scale, outputWidth: cropW * scale, outputHeight: cropH * scale },
        cropPngBase64: outCanvas.toDataURL('image/png').replace(/^data:image\\/png;base64,/, ''),
      });
    }
    return { rasterWidth: img.naturalWidth, rasterHeight: img.naturalHeight, dpr, results };
  })()`;
}
