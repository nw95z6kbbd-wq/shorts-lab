'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const V = require('../js/video-core.js');
const C = require('../js/core.js');

test('generates a topic-based local script with six nonempty editable scenes', () => {
  for (const [idea, theme] of [['Мистическая история про заброшенный дом', 'mystery'], ['Тайна космоса', 'space'], ['Первый шаг к мечте', 'sunrise'], ['Необычный день в городе', 'neon']]) {
    const draft = V.generateFromIdea(idea);
    assert.equal(draft.theme, theme);
    assert.equal(draft.scenes.length, 6);
    assert.ok(draft.scenes[0].text.includes(idea));
    assert.ok(draft.scenes.every(scene => C.countWords(scene.text) > 0));
    assert.equal(new Set(draft.scenes.map(scene => scene.id)).size, 6);
  }
  for (const invalid of ['', '  ', '!?🚀', 'а'.repeat(281)]) assert.throws(() => V.generateFromIdea(invalid));
  const long = V.generateFromIdea('а'.repeat(280));
  assert.ok(long.scenes.every(scene => scene.text.length <= 280));
  assert.doesNotThrow(() => V.parseDraft(JSON.stringify(long)));
});

test('demo is exactly 18 seconds with contiguous scene and subtitle timelines', () => {
  const plan = V.makePlan(V.demo());
  assert.equal(plan.durationMs, 18000);
  assert.equal(plan.timeline.length, 6);
  assert.equal(plan.timeline[0].startMs, 0);
  assert.equal(plan.timeline.at(-1).endMs, 18000);
  for (const list of [plan.timeline, plan.cues]) list.forEach((cue, index) => {
    assert.ok(cue.endMs > cue.startMs);
    if (index) assert.equal(cue.startMs, list[index - 1].endMs);
  });
  assert.ok(plan.cues.every(cue => cue.words.length <= 6));
  assert.equal(plan.cues.map(cue => cue.text).join(' '), V.demo().scenes.map(scene => scene.text).join(' '));
});

test('empty scenes are skipped; edits and total duration recalculate the actual video plan', () => {
  const draft = V.demo();
  draft.durationSeconds = 20;
  draft.scenes = [{ id: 'empty', text: '…' }, { id: '1', text: 'Раз два три четыре' }, { id: '2', text: 'Пять шесть семь восемь' }];
  const plan = V.makePlan(draft);
  assert.equal(plan.timeline.length, 2);
  assert.deepEqual(plan.timeline.map(cue => [cue.startMs, cue.endMs]), [[0, 10000], [10000, 20000]]);
  draft.scenes = [{ text: '' }];
  assert.throws(() => V.makePlan(draft));
  draft.scenes = [{ text: 'Сцена' }];
  for (const seconds of [0, -1, 61, NaN, Infinity]) { draft.durationSeconds = seconds; assert.throws(() => V.makePlan(draft)); }
});

test('frame selection handles boundaries and word highlighting without overflow', () => {
  const plan = V.makePlan(V.demo());
  assert.equal(V.frameAt(plan, -5).time, 0);
  assert.equal(V.frameAt(plan, plan.timeline[1].startMs).scene.index, 1);
  assert.equal(V.frameAt(plan, 999999).scene.index, 5);
  for (let time = 0; time <= 18000; time += 47) {
    const frame = V.frameAt(plan, time);
    assert.ok(frame.activeWord >= 0 && frame.activeWord < frame.cue.words.length);
  }
});

test('video SRT uses the rendered subtitle chunks and ends at the selected duration', () => {
  const plan = V.makePlan(V.demo());
  const srt = V.generateSrt(plan);
  assert.ok(srt.startsWith('1\n00:00:00,000 -->'));
  assert.ok(srt.includes(' --> 00:00:18,000\n'));
  assert.equal(srt.match(/ --> /g).length, plan.cues.length);
});

test('prefers actual supported MP4, falls back to WebM and respects audio codecs', () => {
  const all = V.supportedFormats(() => true, true);
  assert.ok(all[0].startsWith('video/mp4'));
  assert.ok(all[0].includes('mp4a.40.2'));
  const fallback = V.supportedFormats(type => type.startsWith('video/webm'), true);
  assert.ok(fallback.length > 0 && fallback.every(type => type.startsWith('video/webm')));
  assert.ok(fallback[0].includes('opus'));
  assert.ok(V.supportedFormats(() => true, false, 'webm').every(type => type.startsWith('video/webm')));
  assert.deepEqual(V.supportedFormats(() => { throw new Error('unsupported'); }), []);
  assert.deepEqual(V.supportedFormats(() => false), []);
});

test('extensions derive from actual MIME, never from preferred format', () => {
  assert.equal(V.extensionFor('video/webm;codecs=vp9,opus'), 'webm');
  assert.equal(V.extensionFor('video/mp4;codecs=avc1'), 'mp4');
  assert.equal(V.extensionFor('VIDEO/MP4'), 'mp4');
  assert.throws(() => V.extensionFor('audio/webm'));
  assert.throws(() => V.extensionFor(''));
});

test('video draft round trip and fallback settings keep old editor schema independent', () => {
  const draft = V.demo();
  const parsed = V.parseDraft(JSON.stringify(draft));
  assert.deepEqual(parsed.scenes.map(scene => scene.text), draft.scenes.map(scene => scene.text));
  assert.equal(parsed.durationSeconds, 18);
  assert.equal(V.parseDraft({ ...draft, edited: true }).edited, true);
  assert.equal(C.createProject().version, 1);
  for (const bad of [null, {}, { ...draft, scenes: [null] }, { ...draft, scenes: [{ text: 'x'.repeat(281) }] }]) assert.throws(() => V.parseDraft(bad));
  const recovered = V.parseDraft({ ...draft, durationSeconds: 1000, theme: 'injected', caption: 'other', volume: 500 });
  assert.equal(recovered.durationSeconds, 18);
  assert.equal(recovered.theme, 'mystery');
  assert.equal(recovered.volume, 1);
});

test('streaming WebM gains a real float64 duration without changing cluster data', () => {
  const header = [0x1a, 0x45, 0xdf, 0xa3, 0x80];
  const unknownSegment = [0x18, 0x53, 0x80, 0x67, 0x01, 255, 255, 255, 255, 255, 255, 255];
  const info = [0x15, 0x49, 0xa9, 0x66, 0x87, 0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40];
  const cluster = [0x1f, 0x43, 0xb6, 0x75, 0x84, 1, 2, 3, 4];
  const input = new Uint8Array([...header, ...unknownSegment, ...info, ...cluster]);
  const patched = V.patchWebmDuration(input, 18000);
  assert.equal(patched.length, input.length + 11);
  assert.deepEqual(Array.from(patched.slice(-cluster.length)), cluster);
  const marker = Buffer.from(patched).indexOf(Buffer.from([0x44, 0x89, 0x88]));
  assert.ok(marker > 0);
  assert.equal(new DataView(patched.buffer).getFloat64(marker + 3), 18000);
  const repatched = V.patchWebmDuration(patched, 20000);
  assert.equal(repatched.length, patched.length);
  assert.equal(new DataView(repatched.buffer).getFloat64(marker + 3), 20000);
  assert.throws(() => V.patchWebmDuration(new Uint8Array([0]), 18000));
  assert.throws(() => V.patchWebmDuration(input, NaN));
});

test('WebM duration insertion safely grows Info and updates a known Segment size', () => {
  const scale = [0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40];
  const voidElement = [0xec, 0xf5, ...Array(117).fill(0)];
  const info = [0x15, 0x49, 0xa9, 0x66, 0xfe, ...scale, ...voidElement];
  const cluster = [0x1f, 0x43, 0xb6, 0x75, 0x84, 1, 2, 3, 4];
  const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x80, 0x18, 0x53, 0x80, 0x67, 0x40, 0x8c, ...info, ...cluster]);
  const patched = V.patchWebmDuration(bytes, 18000);
  assert.equal(patched.length - bytes.length, 12);
  assert.deepEqual(Array.from(patched.slice(9, 11)), [0x40, 0x98]);
  assert.deepEqual(Array.from(patched.slice(15, 17)), [0x40, 0x89]);
  assert.deepEqual(Array.from(patched.slice(-cluster.length)), cluster);
});

test('WebM files with existing indexes are not shifted when Duration is missing', () => {
  const bytes = new Uint8Array([0x18, 0x53, 0x80, 0x67, 0xff, 0x11, 0x4d, 0x9b, 0x74, 0x80, 0x15, 0x49, 0xa9, 0x66, 0x80]);
  assert.equal(V.patchWebmDuration(bytes, 18000), bytes);
});


test('idea limit remains compatible with old UTF-16 drafts including supplementary Unicode', () => {
  assert.equal(V.IDEA_LIMIT, 280);
  const old = V.demo();
  old.idea = '🌌'.repeat(V.IDEA_LIMIT / 2);
  assert.equal(V.parseDraft(old).idea, old.idea);
  assert.equal(V.generateFromIdea('я'.repeat(V.IDEA_LIMIT)).idea.length, V.IDEA_LIMIT);
  old.idea += 'я';
  assert.throws(() => V.parseDraft(old));
  assert.throws(() => V.generateFromIdea('я'.repeat(V.IDEA_LIMIT + 1)), /Сократите/);
});


test('stable product projects retain their schema and values through current parsers', () => {
  const previous = require('./fixtures/stable-projects.json');
  assert.deepEqual(C.parseProject(previous.editor), previous.editor);
  assert.deepEqual(V.parseDraft(previous.video), previous.video);
});
