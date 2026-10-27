# Сторонние компоненты и лицензии

Проверка выполнена при подготовке сведений о продукте. Это перечень внешних компонентов, а не лицензия на Shorts Studio. Свободная лицензия проекта не выбрана; имя правообладателя и контакт в `js/product.js` оставлены пустыми.

## Код, который получает пользователь сайта

Клиент состоит из собственных HTML, CSS и обычного JavaScript этого репозитория. В нём нет npm-зависимостей, встроенных сторонних библиотек, CDN-шрифтов, сторонних изображений и аудиофайлов. Фоны и иконки описаны кодом; Canvas, MediaRecorder, Web Audio, IndexedDB и DOM — API установленного браузера. Приложение не распространяет браузер, его кодеки или FFmpeg.

ZIP32 STORE, CRC32 и резервный SHA-256 для ZIP-копий реализованы кодом этого репозитория, без встроенной библиотеки ZIP и без CDN. Новых runtime-зависимостей для версии 1.4.0 нет. Синтетические тестовые PNG/JPG/WebP созданы для проекта, WAV генерируются стандартной библиотекой Python; сторонние медиа в тестовых копиях не используются.

Загруженные пользователем изображения, голос и музыка не становятся собственностью проекта. Пользователь сохраняет оригиналы и самостоятельно располагает правами на свои материалы.

## Инструменты разработки и проверки

Эти программы не входят в публикуемую папку `_site` и автономный HTML/ZIP.

| Компонент | Проверенная лицензия | Основание |
| --- | --- | --- |
| Python Playwright, версия из `requirements-dev.txt` | Apache-2.0 | Метаданные установленного пакета и `playwright-*.dist-info/licenses/LICENSE`; [исходный LICENSE](https://github.com/microsoft/playwright-python/blob/main/LICENSE) |
| pyee, транзитивная зависимость Playwright | MIT | Метаданные и LICENSE установленного пакета; [исходный LICENSE](https://github.com/jfhbrook/pyee/blob/main/LICENSE) |
| greenlet, транзитивная зависимость Playwright | MIT AND PSF-2.0 | Метаданные, LICENSE и LICENSE.PSF установленного пакета; [исходники лицензий](https://github.com/python-greenlet/greenlet) |
| FFmpeg / ffprobe | Зависит от сборки; локальная проверенная сборка сообщает GPL-2.0-or-later | Фактический вывод `ffmpeg -L`; [условия FFmpeg](https://ffmpeg.org/legal.html). Используется только для анализа тестовых экспортов, а не для генерации в приложении |
| Python и Node.js | PSF / MIT и отдельные уведомления компонентов | Внешние инструменты; не поставляются вместе с сайтом |
| Chromium и сборка WebKit для Playwright | Собственные наборы лицензий движков и зависимостей | Внешние тестовые браузеры. WebKit содержит компоненты BSD/LGPL; [лицензии WebKit](https://webkit.org/licensing-webkit/). Движки не встроены в приложение |
| Safari / safaridriver | Условия Apple | Системные программы macOS-раннера, не распространяются проектом |

Для изменившихся версий повторяйте проверку метаданных и оригинальных LICENSE, а для другой сборки FFmpeg — `ffmpeg -L`. Лицензия одного тестового инструмента не назначает лицензию приложению или пользовательскому видео.

## GitHub Actions

Для используемых тегов проверены оригинальные файлы LICENSE: все перечисленные Actions распространяются под MIT.

- [actions/checkout@v4](https://github.com/actions/checkout/blob/v4/LICENSE)
- [actions/setup-node@v4](https://github.com/actions/setup-node/blob/v4/LICENSE)
- [actions/setup-python@v5](https://github.com/actions/setup-python/blob/v5/LICENSE)
- [actions/configure-pages@v5](https://github.com/actions/configure-pages/blob/v5/LICENSE)
- [actions/upload-pages-artifact@v3](https://github.com/actions/upload-pages-artifact/blob/v3/LICENSE)
- [actions/deploy-pages@v4](https://github.com/actions/deploy-pages/blob/v4/LICENSE)

Файлы лицензий Actions проверены по используемым тегам, а не по предположению о текущей ветке upstream. Если в будущем сторонний код будет включён непосредственно в приложение, его лицензия и обязательные уведомления должны поставляться вместе с этим кодом.
