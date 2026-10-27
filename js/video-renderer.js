(function () {
  'use strict';
  const V = window.ShortsVideoCore;
  const transitionLayers = new WeakMap();
  const random = n => { const value = Math.sin(n * 127.1 + 311.7) * 43758.5453; return value - Math.floor(value); };
  const ease = x => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
  const THEME_LABELS = { mystery: 'ПОЛУНОЧНЫЕ ИСТОРИИ', space: 'ЗА ПРЕДЕЛАМИ ПРИВЫЧНОГО', sunrise: 'НАВСТРЕЧУ НОВОМУ', neon: 'ДРУГОЙ ВЗГЛЯД' };

  function glow(ctx, x, y, radius, color) {
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, color); gradient.addColorStop(1, 'transparent');
    ctx.fillStyle = gradient; ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }

  function stars(ctx, seconds, count = 65) {
    for (let i = 0; i < count; i++) {
      const x = (random(i + 1) * 780 + Math.sin(seconds * .12 + i) * 9) % 760;
      const y = (random(i + 142) * 1080 + seconds * (2 + random(i + 25) * 4)) % 1100;
      ctx.globalAlpha = .2 + .5 * (.5 + .5 * Math.sin(seconds * .8 + i));
      ctx.fillStyle = '#ece1ff'; ctx.beginPath(); ctx.arc(x, y, .7 + random(i + 31) * 1.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function mystery(ctx, seconds, index) {
    const sky = ctx.createLinearGradient(0, 0, 500, 1280);
    sky.addColorStop(0, '#0d1225'); sky.addColorStop(.55, index % 2 ? '#2d2244' : '#251f3c'); sky.addColorStop(1, '#11101d');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, 720, 1280);
    stars(ctx, seconds, 38);
    const moonX = 480 + Math.sin(seconds * .1 + index) * 20;
    glow(ctx, moonX, 330, 250, '#a58bcc30');
    const moon = ctx.createRadialGradient(moonX - 25, 300, 8, moonX, 330, 67);
    moon.addColorStop(0, '#d6c9dd'); moon.addColorStop(1, '#867a9e');
    ctx.fillStyle = moon; ctx.beginPath(); ctx.arc(moonX, 330, 62, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.translate(Math.sin(seconds * .13 + index) * 12, Math.sin(seconds * .18) * 3);
    ctx.fillStyle = '#0a0a14'; ctx.fillRect(148, 550, 425, 440);
    ctx.beginPath(); ctx.moveTo(105, 565); ctx.lineTo(365, 355); ctx.lineTo(620, 565); ctx.closePath(); ctx.fill();
    ctx.fillRect(465, 390, 43, 140);
    ctx.strokeStyle = '#43344d'; ctx.lineWidth = 2;
    for (let y = 580; y < 970; y += 38) { ctx.beginPath(); ctx.moveTo(150, y); ctx.lineTo(570, y); ctx.stroke(); }
    for (let row = 0; row < 2; row++) for (let col = 0; col < 3; col++) {
      const x = 185 + col * 126, y = 592 + row * 139;
      const lit = (row * 3 + col) === (index + 1) % 6;
      if (lit) glow(ctx, x + 25, y + 40, 120, '#d2a46845');
      ctx.fillStyle = lit ? `rgba(230,186,120,${.63 + Math.sin(seconds * 2) * .12})` : '#272338';
      ctx.fillRect(x, y, 55, 83); ctx.strokeStyle = '#080810'; ctx.lineWidth = 6; ctx.strokeRect(x, y, 55, 83);
      ctx.beginPath(); ctx.moveTo(x + 27, y); ctx.lineTo(x + 27, y + 83); ctx.moveTo(x, y + 40); ctx.lineTo(x + 55, y + 40); ctx.stroke();
    }
    ctx.fillStyle = '#100d19'; ctx.fillRect(323, 819, 73, 170); ctx.strokeStyle = '#4c3854'; ctx.lineWidth = 2; ctx.strokeRect(323, 819, 73, 170);
    ctx.restore();
    // Foreground branches move at a different speed from the house.
    ctx.strokeStyle = '#080a12'; ctx.lineCap = 'round';
    for (const side of [-1, 1]) {
      const x = side < 0 ? 28 : 702;
      ctx.lineWidth = 24; ctx.beginPath(); ctx.moveTo(x, 1150); ctx.lineTo(x + side * Math.sin(seconds * .3) * 5, 320); ctx.stroke();
      ctx.lineWidth = 7;
      for (let n = 0; n < 5; n++) {
        ctx.beginPath(); ctx.moveTo(x, 470 + n * 95); ctx.lineTo(x - side * (60 + n * 12), 380 + n * 85); ctx.lineTo(x - side * (95 + n * 14), 320 + n * 84); ctx.stroke();
      }
    }
    for (let i = 0; i < 5; i++) {
      const x = ((seconds * (13 + i * 2) + i * 207) % 1250) - 230;
      ctx.save(); ctx.scale(1, .23); glow(ctx, x, (780 + i * 94) / .23, 390, '#c8b9e018'); ctx.restore();
    }
    ctx.strokeStyle = '#b3b4d32b'; ctx.lineWidth = 1;
    for (let i = 0; i < 65; i++) {
      const x = (random(i + 600) * 900 - seconds * 75 + 9000) % 900 - 90;
      const y = (random(i + 700) * 1380 + seconds * 430) % 1380 - 60;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 8, y + 29); ctx.stroke();
    }
  }

  function space(ctx, seconds, index) {
    ctx.fillStyle = '#0c1024'; ctx.fillRect(0, 0, 720, 1280);
    glow(ctx, 580 + Math.sin(seconds * .1) * 70, 500, 700, index % 2 ? '#8750ab78' : '#494caa78');
    glow(ctx, 60, 950, 480, '#ad6d7c45'); stars(ctx, seconds, 95);
    const x = 365 + Math.sin(seconds * .16 + index) * 30, y = 470 + Math.cos(seconds * .13) * 20;
    const planet = ctx.createRadialGradient(x - 100, y - 120, 5, x, y, 226);
    planet.addColorStop(0, '#9881c8'); planet.addColorStop(.45, '#514576'); planet.addColorStop(1, '#15182b');
    ctx.fillStyle = planet; ctx.beginPath(); ctx.arc(x, y, 225, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.translate(x, y); ctx.rotate(-.35 + Math.sin(seconds * .1) * .03);
    ctx.strokeStyle = '#c9a9dc55'; ctx.lineWidth = 15; ctx.beginPath(); ctx.ellipse(0, 20, 320, 67, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = '#c9a9dc33'; ctx.lineWidth = 3; ctx.beginPath(); ctx.ellipse(0, 20, 344, 77, 0, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    ctx.fillStyle = '#111321'; ctx.beginPath(); ctx.ellipse(400, 1370, 750, 310, -.12, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#a491cc66'; ctx.lineWidth = 2; ctx.stroke();
    const shooting = (seconds + index * 1.7) % 7;
    if (shooting < 1.5) { ctx.strokeStyle = '#e0d5ff88'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(700 - shooting * 400, 170 + shooting * 180); ctx.lineTo(770 - shooting * 400, 130 + shooting * 180); ctx.stroke(); }
  }

  function sunrise(ctx, seconds, index) {
    const sky = ctx.createLinearGradient(0, 0, 0, 1280);
    sky.addColorStop(0, '#241a3b'); sky.addColorStop(.5, '#b16a83'); sky.addColorStop(.8, '#e8ac86'); sky.addColorStop(1, '#493851');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, 720, 1280);
    const sunY = 600 - Math.sin(seconds * .12 + index * .3) * 30;
    glow(ctx, 420, sunY, 340, '#f8c18c80'); ctx.fillStyle = '#f3cba3'; ctx.beginPath(); ctx.arc(420, sunY, 90, 0, Math.PI * 2); ctx.fill();
    for (let layer = 0; layer < 4; layer++) {
      const base = 760 + layer * 100;
      ctx.fillStyle = ['#765274', '#513b60', '#30253f', '#1a182b'][layer];
      ctx.beginPath(); ctx.moveTo(-90, 1280);
      for (let i = -1; i <= 9; i++) { const x = i * 100 + Math.sin(seconds * .08) * (layer + 1) * 12; const y = base - random(i + 30 + layer * 49) * 220; ctx.lineTo(x, y); }
      ctx.lineTo(850, 1280); ctx.closePath(); ctx.fill();
    }
    ctx.strokeStyle = '#2b223c'; ctx.lineWidth = 3;
    for (let i = 0; i < 5; i++) {
      const x = (seconds * 20 + i * 120) % 900 - 90, y = 380 + i * 22;
      ctx.beginPath(); ctx.moveTo(x - 14, y); ctx.quadraticCurveTo(x - 6, y - 6 - Math.sin(seconds * 3 + i) * 3, x, y); ctx.quadraticCurveTo(x + 6, y - 6 - Math.sin(seconds * 3 + i) * 3, x + 14, y); ctx.stroke();
    }
  }

  function neon(ctx, seconds, index) {
    ctx.fillStyle = '#100e21'; ctx.fillRect(0, 0, 720, 1280);
    glow(ctx, 180 + Math.sin(seconds * .35) * 130, 460, 500, '#7447a66b');
    glow(ctx, 580 + Math.cos(seconds * .2) * 120, 800, 450, '#31648a68');
    ctx.save(); ctx.translate(360, 670); ctx.rotate(seconds * .055 + index * .2);
    for (let i = 0; i < 13; i++) {
      ctx.strokeStyle = i % 2 ? '#b57bff80' : '#6ebee46b'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(0, 0, 150 + i * 14, 220 + i * 15, i * .08, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore(); stars(ctx, seconds * 2, 55);
    glow(ctx, 360 + Math.sin(seconds * .4) * 100, 600 + Math.cos(seconds * .25) * 140, 70, '#d4b5ff4a');
  }

  function background(ctx, plan, index, seconds) {
    ctx.save();
    const zoom = 1.025 + Math.sin(seconds * .12) * .012;
    ctx.translate(360, 640); ctx.scale(zoom, zoom); ctx.translate(-360, -640);
    ({ mystery, space, sunrise, neon }[plan.theme] || mystery)(ctx, seconds, index);
    ctx.restore();
  }

  function linesFor(ctx, words, maxWidth) {
    const lines = [[]];
    words.forEach((word, index) => {
      const pieces = [];
      let piece = '';
      for (const char of Array.from(word)) {
        if (piece && ctx.measureText(piece + char).width > maxWidth) { pieces.push(piece); piece = ''; }
        piece += char;
      }
      if (piece) pieces.push(piece);
      pieces.forEach(text => {
        let line = lines[lines.length - 1];
        const candidate = line.map(token => token.text).concat(text).join(' ');
        if (line.length && ctx.measureText(candidate).width > maxWidth) { line = []; lines.push(line); }
        line.push({ text, index });
      });
    });
    return lines;
  }

  function captions(ctx, plan, frame) {
    const shade = ctx.createLinearGradient(0, 590, 0, 1190);
    shade.addColorStop(0, 'transparent'); shade.addColorStop(.65, '#080812a6'); shade.addColorStop(1, '#08081299');
    ctx.fillStyle = shade; ctx.fillRect(0, 590, 720, 600);
    if (!frame.cue) return;
    let font = 58, lines;
    do { ctx.font = `750 ${font}px sans-serif`; lines = linesFor(ctx, frame.cue.words, 594); if (lines.length <= 4 || font <= 30) break; font -= 4; } while (true);
    const lineHeight = font * 1.32;
    const startY = 880 - (lines.length - 1) * lineHeight / 2;
    const reveal = ease((frame.time - frame.cue.startMs) / 220);
    ctx.save(); ctx.globalAlpha = .8 + .2 * reveal; ctx.translate(0, (1 - reveal) * 17);
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    lines.forEach((line, row) => {
      const widths = line.map(token => ctx.measureText(token.text).width);
      const gap = ctx.measureText(' ').width;
      const width = widths.reduce((a, b) => a + b, 0) + gap * (line.length - 1);
      let x = (720 - width) / 2;
      const y = startY + row * lineHeight;
      if (plan.caption === 'classic') { ctx.fillStyle = '#08080dd9'; ctx.beginPath(); ctx.roundRect(x - 15, y - font * .65, width + 30, font * 1.3, 10); ctx.fill(); }
      line.forEach((token, i) => {
        ctx.shadowColor = '#05030ba8'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3;
        if (plan.caption === 'outline') { ctx.lineWidth = 7; ctx.strokeStyle = '#090713'; ctx.strokeText(token.text, x, y); }
        ctx.fillStyle = plan.caption === 'accent' && token.index === frame.activeWord ? '#cfa8ff' : '#fbf7ff';
        ctx.fillText(token.text, x, y); x += widths[i] + gap;
      });
    });
    ctx.restore();
  }

  function visual(ctx, plan, scene, time, resources) {
    background(ctx, plan, scene.index, time / 1000 + scene.index * .7);
    if (scene.visual !== 'image') return;
    const image = (resources?.images || plan.images)?.get(scene.imageId);
    if (!image) throw new Error('Изображение сцены не загружено. Выберите файл заново или включите анимированный фон.');
    const progress = (time - scene.startMs) / (scene.endMs - scene.startMs);
    const rect = V.cameraRect(image.width || image.naturalWidth, image.height || image.naturalHeight, progress, scene.camera);
    ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height);
  }

  function render(canvas, plan, elapsedMs, resources) {
    window.ShortsRenderPlan.assertRenderable(plan);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Браузер не смог создать Canvas для видео.');
    const frame = V.frameAt(plan, elapsedMs);
    ctx.save(); ctx.scale(canvas.width / V.WIDTH, canvas.height / V.HEIGHT);
    const previous = plan.timeline[frame.scene.index - 1];
    const transitionMs = Math.min(440, (frame.scene.endMs - frame.scene.startMs) / 3, previous ? (previous.endMs - previous.startMs) / 3 : 440);
    const transition = frame.scene.transition === 'none' ? 1 : ease(frame.localMs / transitionMs);
    if (frame.scene.index > 0 && transition < 1) {
      visual(ctx, plan, previous, previous.visual === 'image' ? previous.endMs : frame.time, resources);
      let layer = transitionLayers.get(canvas);
      if (!layer) {
        layer = document.createElement('canvas'); layer.width = V.WIDTH; layer.height = V.HEIGHT;
        transitionLayers.set(canvas, layer);
      }
      visual(layer.getContext('2d', { alpha: false }), plan, frame.scene, frame.time, resources);
      ctx.save();
      if (frame.scene.transition === 'slide') ctx.translate(V.WIDTH * (1 - transition), 0);
      else {
        ctx.globalAlpha = transition;
        if (frame.scene.transition === 'zoom') { const scale = 1 + .1 * (1 - transition); ctx.translate(360, 640); ctx.scale(scale, scale); ctx.translate(-360, -640); }
      }
      ctx.drawImage(layer, 0, 0, V.WIDTH, V.HEIGHT); ctx.restore();
    } else visual(ctx, plan, frame.scene, frame.time, resources);
    ctx.globalAlpha = 1;
    const topShade = ctx.createLinearGradient(0, 0, 0, 350); topShade.addColorStop(0, '#080812b3'); topShade.addColorStop(1, 'transparent');
    ctx.fillStyle = topShade; ctx.fillRect(0, 0, 720, 350);
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'; ctx.font = '600 16px sans-serif'; ctx.fillStyle = '#d5c5e6';
    ctx.fillText('✦  SHORTS STUDIO', 51, 65); ctx.textAlign = 'right'; ctx.fillStyle = '#b7a7cc';
    ctx.fillText(String(frame.scene.index + 1).padStart(2, '0') + ' / ' + String(plan.timeline.length).padStart(2, '0'), 666, 65);
    ctx.textAlign = 'left'; ctx.font = '600 29px sans-serif'; ctx.fillStyle = '#eee5f8';
    const titleLines = linesFor(ctx, plan.title.trim().split(/\s+/u), 610);
    titleLines.slice(0, 2).forEach((line, index) => ctx.fillText(line.map(word => word.text).join(' ') + (index === 1 && titleLines.length > 2 ? '…' : ''), 51, 128 + index * 40));
    ctx.font = '500 13px sans-serif'; ctx.fillStyle = '#b5a0c8'; ctx.fillText(THEME_LABELS[plan.theme] || THEME_LABELS.mystery, 53, 218);
    captions(ctx, plan, frame);
    const width = 610 / plan.timeline.length;
    plan.timeline.forEach((scene, index) => {
      const x = 55 + index * width;
      ctx.fillStyle = '#c8b1e033'; ctx.fillRect(x, 1169, width - 7, 3);
      const progress = Math.max(0, Math.min(1, (frame.time - scene.startMs) / (scene.endMs - scene.startMs)));
      ctx.fillStyle = '#ccacfa'; ctx.fillRect(x, 1169, (width - 7) * progress, 3);
    });
    ctx.font = '400 14px sans-serif'; ctx.fillStyle = '#bfa7d1'; ctx.fillText('У каждой истории есть начало', 55, 1220);
    ctx.restore();
  }

  window.ShortsVideoRenderer = { render };
})();
