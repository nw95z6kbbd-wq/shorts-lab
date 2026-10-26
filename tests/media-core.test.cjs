'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const V = require('../js/video-core.js');

test('manual scene durations govern video and subtitle boundaries exactly', () => {
  const draft = V.demo(); draft.timing = 'manual';
  draft.scenes = [
    { id: 'a', text: 'Первая сцена с несколькими словами для двух групп субтитров.', durationSeconds: 2.125 },
    { id: 'b', text: 'Вторая сцена.', durationSeconds: 3.375 }
  ];
  const plan = V.makePlan(draft);
  assert.equal(plan.durationMs, 5500);
  assert.deepEqual(plan.timeline.map(cue => [cue.startMs, cue.endMs]), [[0, 2125], [2125, 5500]]);
  for (const scene of plan.timeline) {
    assert.equal(scene.cues[0].startMs, scene.startMs);
    assert.equal(scene.cues.at(-1).endMs, scene.endMs);
    scene.cues.forEach(cue => { assert.ok(cue.startMs >= scene.startMs && cue.endMs <= scene.endMs); });
  }
  assert.equal(V.frameAt(plan, 2124).scene.id, 'a');
  assert.equal(V.frameAt(plan, 2125).scene.id, 'b');
  assert.ok(V.generateSrt(plan).includes('00:00:02,125 --> 00:00:05,500'));
});

test('manual durations validate total length and allow intentional silent scenes', () => {
  const draft = V.demo(); draft.timing = 'manual';
  draft.scenes = [{ id: 'a', text: '', durationSeconds: .5, visual: 'image', imageId: 'picture' }];
  const plan = V.makePlan(draft);
  assert.equal(plan.durationMs, 500);
  assert.equal(V.frameAt(plan, 100).cue, null);
  assert.equal(V.generateSrt(plan), '');
  for (const invalid of [0, NaN, null, 61]) { draft.scenes[0].durationSeconds = invalid; assert.throws(() => V.makePlan(draft)); }
  draft.scenes = [{ text: 'a', durationSeconds: 40 }, { text: 'b', durationSeconds: 40 }];
  assert.throws(() => V.makePlan(draft));
});

test('image IDs, camera settings and manual timings survive draft round trips', () => {
  const draft = V.demo(); draft.timing = 'manual'; draft.musicVolume = .3; draft.musicFadeIn = 2; draft.musicFadeOut = 3;
  draft.scenes = [{ id: 'keep-id', text: 'Сцена', visual: 'image', imageId: 'asset-1', imageName: 'photo.webp', camera: 'pan-left', transition: 'slide', durationSeconds: 4.5 }];
  const parsed = V.parseDraft(JSON.stringify(draft));
  assert.deepEqual(parsed.scenes[0], draft.scenes[0]);
  assert.equal(parsed.timing, 'manual'); assert.equal(parsed.musicVolume, .3); assert.equal(parsed.musicFadeOut, 3);
  const old = V.parseDraft({ ...V.demo(), timing: undefined, musicVolume: undefined });
  assert.equal(old.timing, 'auto'); assert.equal(old.musicVolume, .25);
  assert.equal(V.makePlan(old).durationMs, 18000);
});

test('camera cover geometry leaves no exposed edge for any aspect ratio or motion', () => {
  for (const [width, height] of [[100, 100], [1920, 1080], [720, 1280], [200, 3000], [4000, 200]]) {
    for (const mode of ['zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'static']) {
      for (let step = 0; step <= 20; step++) {
        const r = V.cameraRect(width, height, step / 20, mode);
        assert.ok(r.x <= .00001 && r.y <= .00001);
        assert.ok(r.x + r.width >= 720 - .00001 && r.y + r.height >= 1280 - .00001);
      }
    }
  }
  assert.ok(V.cameraRect(1000, 1000, 1).width > V.cameraRect(1000, 1000, 0).width);
  assert.ok(V.cameraRect(1000, 1000, 1, 'zoom-out').width < V.cameraRect(1000, 1000, 0, 'zoom-out').width);
  assert.throws(() => V.cameraRect(0, 0, 0));
});

test('music envelope fades at its own endpoint, supports seeks, zero and overlapping fades', () => {
  assert.equal(V.musicEnvelope(0, 5, 1, 1), 0);
  assert.equal(V.musicEnvelope(.5, 5, 1, 1), .5);
  assert.equal(V.musicEnvelope(2, 5, 1, 1), 1);
  assert.equal(V.musicEnvelope(4.5, 5, 1, 1), .5);
  assert.equal(V.musicEnvelope(5, 5, 1, 1), 0);
  assert.equal(V.musicEnvelope(2, 5, 0, 0), 1);
  assert.equal(V.musicEnvelope(.5, 1, 2, 2), .25);
});
