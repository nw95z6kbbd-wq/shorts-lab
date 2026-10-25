'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/core.js');

test('counts Russian words, numbers and hyphenated words without punctuation or emoji', () => {
  assert.equal(C.countWords('Привет, мир! Это кое-что новое — 150 слов. 🚀'), 7);
  assert.equal(C.countWords('  \n … ! 🚀'), 0);
  assert.equal(C.countWords('don’t stop'), 2);
});

test('voice duration is exactly 150 words per minute', () => {
  assert.equal(C.durationMs(Array(150).fill('слово').join(' ')), 60000);
  assert.equal(C.durationMs('Один два три'), 1200);
  assert.equal(C.durationMs(''), 0);
});

test('splits Russian sentences, multiline text, ellipsis and unpunctuated final text', () => {
  assert.deepEqual(C.splitSentences('Привет, мир! Как дела? Хорошо.\nНовая строка без точки\n\nФинал'),
    ['Привет, мир!', 'Как дела?', 'Хорошо.', 'Новая строка без точки', 'Финал']);
  assert.deepEqual(C.splitSentences('Подожди… Всё начинается!'), ['Подожди…', 'Всё начинается!']);
  assert.deepEqual(C.splitSentences('...\n🚀\n   '), []);
  assert.equal(C.splitSentences(C.DEMO_SCRIPT).length, 8);
});

test('timeline skips blank scenes and keeps millisecond-accurate contiguous cues', () => {
  const scenes = [{ id: 'a', text: 'Один два три' }, { id: 'empty', text: '' }, { id: 'b', text: 'Четыре пять' }];
  assert.deepEqual(C.timeline(scenes).map(cue => [cue.id, cue.startMs, cue.endMs]), [['a', 0, 1200], ['b', 1200, 2000]]);
  assert.equal(C.totalDuration(scenes), 2000);
});

test('SRT has sequential indexes, exact timecodes and no empty cue delimiters inside text', () => {
  const scenes = [{ id: '1', text: 'Один\n\nдва три' }, { id: '2', text: ' ' }, { id: '3', text: 'Финал!' }];
  assert.equal(C.generateSrt(scenes), '1\n00:00:00,000 --> 00:00:01,200\nОдин два три\n\n2\n00:00:01,200 --> 00:00:01,600\nФинал!\n');
  assert.equal(C.generateSrt([]), '');
});

test('time formatting carries milliseconds, seconds, minutes and hours correctly', () => {
  assert.equal(C.srtTime(59999), '00:00:59,999');
  assert.equal(C.srtTime(60000), '00:01:00,000');
  assert.equal(C.srtTime(3661200), '01:01:01,200');
  assert.equal(C.srtTime(-1), '00:00:00,000');
  assert.equal(C.clockTime(59600), '1:00');
});

test('SRT wraps lines without losing words and neutralizes player markup', () => {
  const text = 'Очень длинная строка с несколькими словами для проверки переноса текста субтитров';
  const wrapped = C.wrapSubtitle(text);
  assert.ok(wrapped.split('\n').every(line => line.length <= 42));
  assert.equal(wrapped.replace(/\n/g, ' '), text);
  assert.equal(C.wrapSubtitle('<b>Текст</b>'), '‹b›Текст‹/b›');
});

test('project round trip preserves empty projects, manual scene edits and styles', () => {
  const project = C.createProject();
  assert.equal(C.parseProject(JSON.stringify(project)).scenes.length, 0);
  project.scenes = [{ id: 'a', text: 'Отредактированная сцена' }];
  project.selectedSceneId = 'a';
  project.style = { caption: 'outline', size: 'large', theme: 'dusk' };
  assert.deepEqual(C.parseProject(JSON.stringify(project)), project);
});

test('project parser rejects invalid schemas and recovers duplicate IDs and unknown styles', () => {
  for (const bad of ['null', '{}', 'не json', '{"version":2}', '{"version":1,"name":"a","script":"","scenes":[null]}']) {
    assert.throws(() => C.parseProject(bad));
  }
  const project = C.createProject();
  project.scenes = [{ id: 'a', text: 'Раз' }, { id: 'a', text: 'Два' }];
  project.selectedSceneId = 'missing';
  project.style = { theme: 'malicious-class' };
  const parsed = C.parseProject(project);
  assert.notEqual(parsed.scenes[0].id, parsed.scenes[1].id);
  assert.equal(parsed.selectedSceneId, 'a');
  assert.equal(parsed.style.theme, 'cosmos');
});

test('file names exclude path separators and word labels follow Russian plurals', () => {
  assert.equal(C.fileName('../мой/проект:*?'), '..мойпроект');
  assert.equal(C.fileName('   '), 'Мой Short');
  assert.equal(C.wordLabel(1), '1 слово');
  assert.equal(C.wordLabel(2), '2 слова');
  assert.equal(C.wordLabel(11), '11 слов');
  assert.equal(C.wordLabel(21), '21 слово');
});
