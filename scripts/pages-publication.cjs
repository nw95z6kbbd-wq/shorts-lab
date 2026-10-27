'use strict';
const fs = require('node:fs');

// Pure admission check: no API calls, deployments, tags or release metadata writes.
// Invoked before the release checks, artifact upload and privileged deploy step.
function authorize(env, event) {
  const deny = message => { throw new Error('Публикация запрещена: ' + message); };
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch') deny('нужен отдельный ручной запуск Publish GitHub Pages.');
  if (env.GITHUB_REF !== 'refs/heads/main') deny('разрешена только ветка main.');
  if (env.GITHUB_RUN_ATTEMPT !== '1') deny('повторный запуск run не публикует сайт; создайте новый явный запрос.');
  const owner = env.GITHUB_REPOSITORY_OWNER;
  const same = value => typeof value === 'string' && owner && value.toLowerCase() === owner.toLowerCase();
  if (!same(env.GITHUB_ACTOR) || !same(env.GITHUB_TRIGGERING_ACTOR) || !same(event?.sender?.login)) deny('запуск и решение о публикации должны принадлежать владельцу репозитория.');
  if (!env.GITHUB_REPOSITORY || env.GITHUB_REPOSITORY.split('/')[0].toLowerCase() !== owner.toLowerCase() || event?.repository?.full_name !== env.GITHUB_REPOSITORY) deny('репозиторий запроса не совпадает с контекстом запуска.');
  if (event?.inputs?.confirmation !== 'PUBLISH') deny('нужно явное подтверждение PUBLISH.');
  const sha = event?.inputs?.commit_sha;
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha) || sha !== env.GITHUB_SHA) deny('укажите полный SHA именно выбранного коммита main; ветка могла измениться.');
  return { repository: env.GITHUB_REPOSITORY, sha, owner };
}

if (require.main === module) {
  try {
    const result = authorize(process.env, JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')));
    process.stdout.write('Явный запрос публикации проверен: ' + result.repository + '@' + result.sha + '\n');
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
module.exports = { authorize };
