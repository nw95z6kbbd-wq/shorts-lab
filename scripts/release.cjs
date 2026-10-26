'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const P = require('../js/product.js');
const ROOT = path.resolve(__dirname, '..');
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function validate() {
  if (!P.releases.length || P.version !== P.releases[0].version) throw new Error('Текущая версия должна соответствовать первой записи истории.');
  const seen = new Set();
  let previous;
  for (const release of P.releases) {
    if (!semver.test(release.version) || seen.has(release.version)) throw new Error('Некорректная или повторяющаяся версия.');
    seen.add(release.version);
    const parts = release.version.split('.').map(Number);
    if (previous) {
      const index = parts.findIndex((part, i) => part !== previous[i]);
      if (index < 0 || parts[index] > previous[index]) throw new Error('Версии должны идти от новой к старой.');
    }
    previous = parts;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(release.date) || new Date(release.date + 'T12:00:00Z').toISOString().slice(0, 10) !== release.date) throw new Error('Некорректная дата выпуска.');
    if (!release.title || !release.changes.length || release.changes.some(text => typeof text !== 'string' || !text.trim())) throw new Error('Заполните описание обновления.');
    if (!/^[a-f0-9]{40}$/.test(release.commit) || !release.pullRequests.length || release.pullRequests.some(number => !Number.isInteger(number) || number < 1)) throw new Error('Укажите действительные ссылки на историю Git и PR.');
  }
}

function changelog() {
  validate();
  let text = '# История обновлений Shorts Studio\n\n';
  text += '> Файл сформирован из `js/product.js`. Редактируйте источник и запускайте `node scripts/release.cjs changelog`.\n\n';
  text += P.historyNote + '\n\n';
  text += '## Будущие обновления\n\nНовые выпуски добавляются в начало списка `releases` в `js/product.js`. Номер интерфейса и история используют этот же источник. Подготовка тега и публикация — отдельные действия; порядок описан в [RELEASING.md](RELEASING.md).\n\n';
  for (const release of P.releases) {
    text += `## ${release.version} — ${release.date}\n\n${release.title}\n\n`;
    text += release.changes.map(change => '- ' + change).join('\n') + '\n\n';
    text += 'Основание: ' + release.pullRequests.map(number => `[PR #${number}](${P.repository}/pull/${number})`).join(', ') + `; [merge-коммит](${P.repository}/commit/${release.commit}).\n\n`;
  }
  return text.trimEnd() + '\n';
}

function check() {
  validate();
  if (fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8') !== changelog()) throw new Error('CHANGELOG.md устарел. Выполните node scripts/release.cjs changelog.');
}

function prepareTag() {
  check();
  const git = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  if (git(['status', '--porcelain'])) throw new Error('Сначала сохраните изменения в коммит; рабочая копия должна быть чистой.');
  const tag = 'v' + P.version;
  if (git(['tag', '--list', tag])) throw new Error(`Тег ${tag} уже существует локально. Он не будет перезаписан.`);
  git(['tag', '-a', tag, '-m', `${P.name} ${P.version}\n\nПодготовлен локально на проверенном коммите. Публикация требует отдельного подтверждения.`]);
  return { tag, commit: git(['rev-parse', tag + '^{commit}']), published: false };
}

if (require.main === module) {
  try {
    const command = process.argv[2] || 'check';
    if (command === 'check') { check(); process.stdout.write('Версия и CHANGELOG согласованы.\n'); }
    else if (command === 'changelog') { fs.writeFileSync(path.join(ROOT, 'CHANGELOG.md'), changelog()); process.stdout.write('CHANGELOG обновлён из единого источника.\n'); }
    else if (command === 'info') process.stdout.write(JSON.stringify({ name: P.name, version: P.version, tag: 'v' + P.version }) + '\n');
    else if (command === 'tag') process.stdout.write(JSON.stringify(prepareTag()) + '\n');
    else throw new Error('Команды: check, changelog, info, tag. Публикация из этого скрипта не выполняется.');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
module.exports = { validate, changelog, check, prepareTag };
