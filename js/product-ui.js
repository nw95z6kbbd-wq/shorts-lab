(function () {
  'use strict';
  const P = window.ShortsProduct;
  const $ = id => document.getElementById(id);
  const SEEN = 'shorts-studio.updates.dismissed.v1';
  const PROFILE = 'shorts-studio.product.profile.v1';
  let selected = 'updates';
  let lastOpener;
  let profile = { ...P.rights };
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function storageWorks() {
    const key = SEEN + '.probe.' + Math.random().toString(36).slice(2);
    try { localStorage.setItem(key, '1'); localStorage.removeItem(key); return true; } catch (_) { return false; }
  }
  function dismiss() {
    $('productUpdateNotice').hidden = true;
    try { localStorage.setItem(SEEN, P.version); } catch (_) { /* Automatic notices are disabled when storage is unavailable. */ }
  }
  function setTab(tab, focus = false) {
    selected = tab;
    for (const name of ['updates', 'about']) {
      const active = name === tab;
      const button = $('productTab-' + name);
      button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
      $('productPane-' + name).hidden = !active;
    }
    $('productDialogTitle').textContent = tab === 'updates' ? 'Что нового' : 'О Shorts Studio';
    if (tab === 'updates') dismiss();
    if (focus) $('productTab-' + tab).focus();
  }
  function open(tab, opener) {
    lastOpener = opener;
    setTab(tab);
    if (!$('productDialog').open) $('productDialog').showModal();
    $('productTab-' + tab).focus();
  }

  $('productUpdateNotice').querySelector('.notice-message p').textContent = P.releases[0].status === 'unreleased' ? 'Предварительная версия. Изменения ещё не опубликованы.' : 'Узнайте, какие возможности уже доступны.';
  document.querySelectorAll('[data-product-version]').forEach(element => { element.textContent = 'v' + P.version; });
  document.querySelectorAll('[data-product-open]').forEach(button => button.addEventListener('click', event => open(button.dataset.productOpen, event.currentTarget)));
  $('productClose').addEventListener('click', () => $('productDialog').close());
  $('productDialog').addEventListener('close', () => {
    const target = lastOpener?.getClientRects().length ? lastOpener : document.querySelector('.product-nav [data-product-open="updates"]');
    target?.focus();
  });
  $('productDismissNotice').addEventListener('click', dismiss);
  for (const tab of ['updates', 'about']) $('productTab-' + tab).addEventListener('click', () => setTab(tab, true));
  $('productTabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    setTab(event.key === 'Home' ? 'updates' : event.key === 'End' ? 'about' : selected === 'updates' ? 'about' : 'updates', true);
  });

  const releases = document.createDocumentFragment();
  const formatDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  P.releases.forEach((release, index) => {
    const card = node('article', 'release-item release-' + release.importance + (index === 0 ? ' release-current' : ''));
    card.dataset.importance = release.importance; card.dataset.status = release.status;
    const header = node('div', 'release-heading');
    header.append(node('h3', '', 'Версия ' + release.version));
    header.append(node('span', 'release-kind', P.releaseKinds[release.importance]));
    if (!index) header.append(node('span', 'release-badge', release.status === 'unreleased' ? 'ГОТОВИТСЯ' : 'ТЕКУЩАЯ'));
    if (release.status === 'unreleased') header.append(node('span', 'release-pending', 'Ещё не опубликовано'));
    else {
      const date = node('time', '', formatDate.format(new Date(release.date + 'T12:00:00Z'))); date.dateTime = release.date;
      header.append(date);
    }
    const changes = node('ul'); release.changes.forEach(change => changes.append(node('li', '', change)));
    const sources = node('div', 'release-sources');
    release.pullRequests.forEach(number => {
      const link = node('a', '', 'Подробнее в PR №' + number + ' ↗');
      link.href = P.repository + '/pull/' + number; link.target = '_blank'; link.rel = 'noopener noreferrer'; sources.append(link);
    });
    card.append(header, node('h4', '', release.title));
    if (release.importance === 'highlight') card.append(node('p', 'release-summary', release.summary));
    card.append(changes, sources); releases.append(card);
  });
  $('productReleaseList').append(releases);
  $('productHistoryNote').textContent = P.historyNote;
  P.capabilities.forEach(text => $('productCapabilities').append(node('li', '', text)));
  $('productRepository').href = P.repository;
  $('productLicenseNote').textContent = P.licenseNote;
  try {
    const saved = JSON.parse(localStorage.getItem(PROFILE));
    if (saved && typeof saved === 'object') profile = {
      owner: typeof saved.owner === 'string' ? saved.owner.slice(0, 160) : P.rights.owner,
      contact: typeof saved.contact === 'string' ? saved.contact.slice(0, 240) : P.rights.contact
    };
  } catch (_) { /* Keep the explicitly blank/default product fields. */ }
  function fillProfile() { $('productOwner').value = profile.owner; $('productContact').value = profile.contact; }
  fillProfile();
  $('productProfileForm').addEventListener('submit', event => {
    event.preventDefault();
    profile = { owner: $('productOwner').value.trim().slice(0, 160), contact: $('productContact').value.trim().slice(0, 240) };
    try { localStorage.setItem(PROFILE, JSON.stringify(profile)); $('productProfileStatus').textContent = 'Сохранено только в этом браузере.'; }
    catch (_) { $('productProfileStatus').textContent = 'Сведения доступны в этой вкладке. Браузер запретил сохранение.'; }
    fillProfile();
  });
  $('productResetProfile').addEventListener('click', () => {
    profile = { ...P.rights }; fillProfile();
    try { localStorage.removeItem(PROFILE); $('productProfileStatus').textContent = 'Восстановлены исходные сведения продукта.'; }
    catch (_) { $('productProfileStatus').textContent = 'Сброшено в этой вкладке; постоянное хранилище недоступно.'; }
  });
  if (storageWorks()) {
    try { $('productUpdateNotice').hidden = localStorage.getItem(SEEN) === P.version; } catch (_) {}
  }
})();
