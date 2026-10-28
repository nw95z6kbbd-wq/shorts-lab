# Runtime-сессии медиа и подготовки сборки

Внутренняя инфраструктура для 1.4.0 Unreleased. Новый UI, ручной Canvas-предпросмотр
и ручная видеосборка не подключены. Video adapter, старый контроллер, Video-ветка renderer,
recorder, микшер, DTO, IndexedDB и ZIP не изменены.

## Проверенная исходная точка

Main `8042586d1c5c65a4a89eedd61052a37ca14b4868`, после Merge PR #14.
Последний push CI перед изменениями: [40573051253](https://github.com/nw95z6kbbd-wq/shorts-lab/actions/runs/40573051253),
Check app, WebKit/mobile и настоящий Safari завершились успешно. GitHub API
возвращал 403; результат проверен по обычным страницам Actions.
Перед реализацией локально прошли 77 Node-тестов, 60 точных кадров RenderPlan,
реальная запись изображений/двух дорожек и строгие source/baseline guards.
Эталоны планов/кадров в `tests/fixtures/render-plan/` остаются прежними;
`tests/fixtures/runtime/before.json` фиксирует неизменённые исходники main.

## Разделение ответственности

- DTO: только сохраняемые пользовательские данные. Оба слота остаются независимыми.
- RenderPlan: чистый временный результат соответствующего адаптера.
- `media-session.js`: оригиналы, проверка заголовков, реальные существующие декодеры,
  бюджеты, глобальная очередь, заимствование и освобождение ресурсов.
- `render-session.js`: снимок конкретной редакции и его план, жизненный цикл,
  тестируемые потребители рисования, аудио и записи.

В браузере используются `ShortsMediaSessions` и `ShortsRenderSessions`.
CommonJS экспортирует factory с явными зависимостями для изолированных тестов.
Production resolver всегда вызывает `ShortsStorage.asset(mediaId)`; декодеры —
`ShortsVideoMedia.decodeImage()` и `ShortsVideoRecorder.decodeAudio()`.
Сетевые URL и временные blob/data ID не принимаются как ссылки на оригиналы.
Сессии никогда не вызывают save/stage/discard/GC или миграции. В тестах staging
повреждённых исходников выполняется только самим тестовым потребителем.

Существующий `video-ui.js` пока остаётся владельцем своих декодированных ресурсов.
Новые сессии не заимствуют его Map/AudioBuffer/URL и не закрывают их; они заново
разрешают явно указанные оригиналы и владеют только своими результатами decode.
Это не второй renderer/recorder. Переход контроллера на новую сессию — отдельный
этап после проверки совместимости. Никаких скрытых связей с его замыканием нет.

## Контракт управляющей сессии

```js
const snapshot = /* снимок editor или video из его контроллера */;
const plan = ShortsRenderAdapters.fromVideo(snapshot); // либо fromEditor
const session = ShortsRenderSessions.create({
  slot: 'video',
  projectId: 'owner-of-this-video-draft',
  contentRevision: 12,
  savedRevision: 8, // либо null, если успешного сохранения ещё нет
  project: snapshot,
  plan
});
await session.prepare(); // звук НЕ запускается
const lease = session.acquire();
try {
  // lease.resources.images: отдельная Map, значения заимствованы;
  // lease.audio(mediaId): заимствованный AudioBuffer.
} finally { lease.release(); }
await session.dispose();
```

`projectId` у Editor должен совпадать с `project.id`. Video DTO 1 не имеет
собственного поля id: вызывающий контроллер обязан передать идентичность владельца,
а не подставлять номер сцены. `contentRevision` — редакция содержимого, `savedRevision`
— ревизия завершённого сохранения; ни одна из них автоматически не увеличивается.
`sessionId` создаётся отдельно; `status().generation` относится только к загрузке.
API не делает выводов о ревизиях по времени, scene ID или положению сцены.

Project и plan глубоко копируются и замораживаются. Копирование допускает только
обычные JSON-данные: без getters, символов, разреженных массивов, циклов, функций,
Blob/Canvas/ImageBitmap/AudioBuffer/Map/Date. Проверяется точное соответствие
переданного плана заново вычисленному адаптером, независимо от порядка ключей.
DTO 1 в снимке остаётся DTO 1; временная нормализация адаптера ничего не пишет.
Позднейшие изменения исходного объекта не влияют на сессию.

Изменение/замена проекта, сцены или файла требует от будущего контроллера отменить
устаревшую сессию и создать новую с новой contentRevision. Готовая старая сессия
сама не наблюдает UI и не смешивает новую редакцию со старой.

## Состояния и заимствование

`created → preparing → ready → use` (пока есть consumers), с отдельными
терминальными `error`, `cancelled`, `disposed`. После ошибки нет частичного ready.
`status()` содержит identity, generation, consumers, pending, originalBytes,
decodedBytes, imagePixels, cleanupPending, renderable и диагностическую ошибку.
`media.statistics()` показывает общий рабочий объём, пик, число сессий и очередь.

`acquire()` доступен только после prepare. Все lease одного владельца используют
один decode данного media ID. Другой slot/session имеет свои результаты decode,
даже если scene ID или явно общий исходный media ID совпадают. Каждый lease
получает собственную Map; её изменение не меняет Map другого consumer. Значения
заимствованы: consumer не должен вызывать bitmap.close(), revokeObjectURL() или
самостоятельно уничтожать их. Возврат lease идемпотентен и очищает его Map.

`cancel()`/`dispose()` немедленно запрещают новые потребления и инвалидируют
поколение. Их Promise завершается только после возвращения всех lease и окончания
неотменяемых native read/decode. Отмена подготовки быстро отклоняет prepare с
`CANCELLED`, но не объявляет реальный decoder остановленным раньше времени.
Даже отменённое чтение сохраняет место в пуле до своего завершения: быстрые
повторные создания не запускают неограниченно много незавершённых операций.
Поздний bitmap сразу закрывается, URL отзывается, AudioBuffer теряет принадлежащие
сессии ссылки. Повторные cancel/dispose безопасны; первый терминальный исход
сохраняется в status. Зависший native API может удерживать cleanupPending;
принудительно закрыть ещё используемый ресурс вместо этого нельзя.

У внешнего consumer обязан быть try/finally с release. Нельзя ожидать dispose,
удерживая собственный lease и не собираясь его вернуть. Уничтожить внешнюю ссылку
на AudioBuffer или bitmap средствами JavaScript невозможно — бюджет описывает
принадлежащие модулю ресурсы, а не произвольные ссылки вызывающего кода.
Сессия, lease и resources явно запрещают JSON.stringify через toJSON.
В DTO/RenderPlan/ZIP не добавляются новые поля или runtime-объекты.

Если принадлежащий сессии AudioContext не подтвердил закрытие, stop/dispose
отклоняется с AUDIO_CLOSE, `status().error` сохраняет причину, lease остаётся
занятым. Повторный dispose повторяет закрытие; очистка не объявляется успешной
до него. Ошибка закрытия из lifetime AbortSignal сохраняется в status, поскольку
у события нет ожидающего Promise вызывающего кода.

## Потребители общего стека

- `renderFrame(canvas, ms)` вызывает существующий renderer с тем же планом и
  ресурсами. Допустим во время звукового предпросмотра, запрещён во время записи.
- `playAudio({offsetSeconds})` вызывается только из явного действия пользователя.
  Он использует существующий `ShortsVideoAudio.connectMix()` и собственный
  AudioContext, который закрывается с ожиданием Promise. Возвращает `{stop()}`;
  будущий контроллер должен остановить его на конце/паузе/seek/скрытии вкладки.
  Сессия сама останавливает его при cancel/dispose. Подготовка не вызывает resume.
- `record({canvas, onProgress, onFormat, signal})` делегирует существующему recorder
  точный plan/resources, оба буфера, `RenderPlan.audioOptions()` и формат плана.
  Потребитель удерживает lease до завершения реального finally рекордера.

Один принадлежащий сессии аудио/record consumer одновременно; повторный запуск до
его остановки выдаёт BUSY. Внешние lease можно использовать параллельно. Перед
размонтированием/сменой режима контроллер вызывает dispose/cancel, прекращает
свой RAF и возвращает свои внешние lease. Canvas принадлежит вызывающему коду.

Начало обеих дорожек, громкости, музыкальные fades, тишина после короткого исходника
и обрезание концом плана берутся из существующего контракта. Голосовые fades,
ASR/TTS, выравнивание и музыкальное зацикливание не добавлены.

Editor теперь поддерживает каноническое оформление `editor-canvas-v1`:
[EDITOR_CANVAS.md](EDITOR_CANVAS.md). Известные 27 сочетаний для непустого плана дают
`status().renderable === true`; это поддержка профиля, не обещание вместить
любой текст. Переполнение даёт `TEXT_OVERFLOW`, неизвестные стили —
`STYLE_UNSUPPORTED`. Принудительный `supported: false` по-прежнему отклоняется
`assertRenderable()` до рисования/записи. Политики субтитров не смешиваются.

## Бюджеты и ограничения первой реализации

| Бюджет | По умолчанию |
| --- | --- |
| Снимок + RenderPlan, точный UTF-8 размер JSON | 16 МиБ |
| Уникальные активные изображения на сессию | 16 |
| Исходные Blob на сессию | 64 МиБ |
| Декодированные ресурсы/резервы на сессию | 96 МиБ |
| Сумма пикселей изображений на сессию | 16 млн, оценка RGBA ×4 |
| Один AudioBuffer / резерв перед его decode | 64 МиБ |
| Общий учтённый объём Blob + decode/резервов | 256 МиБ |
| Незакрытые сессии | 8 |
| Одновременно исполняемые image/audio decode в новом пуле | 1 |

Индивидуальные limits можно задавать доверенным вызывающим кодом; они не отменяют
общий предел пула и прежние ограничения декодеров. Неактивные imageId остаются
в снимке/DTO/ZIP, но не декодируются для текущего таймлайна. Тысячи анимированных
сцен допустимы в пределах бюджета данных. Тысячи активных изображений не начинают
декодироваться автоматически: IMAGE_COUNT до чтения первого файла. Streaming/LRU
рабочего окна записи пока нет; превышение требует другого набора или следующего
технического этапа, не молчаливого удаления сцен.

Перед image decode проверяются размеры PNG/JPEG/WebP в первых 256 КиБ и резерв
памяти; слишком длинный JPEG metadata header даёт IMAGE_HEADER. Анимированные
PNG/WebP пока явно отвергаются IMAGE_ANIMATED, чтобы fallback HTMLImageElement не
делал недетерминированные кадры. Старый пользовательский видеорежим не изменён.
Далее используются прежние проверки содержимого и реальный native decoder.

Для аудио сохраняется существующий decoder (до 25 МиБ/600 с); AudioBuffer измеряется
после decode по length × channels × 4. До вызова резервируется 64 МиБ, операции
строго последовательны; превышение не становится ready. Это НЕ жёсткая граница
RSS: compressed audio способен временно выделить больше внутри native decoder
до проверки, IndexedDB может клонировать исходник при чтении, GPU/кодек имеют
свои копии. decodeAudioData/createImageBitmap нельзя прервать стандартным AbortSignal.
Контекст decoder закрывает прежний primitive; playback закрывает наша сессия.
На новый пул приходится максимум один decode context и до восьми потребителей
(удерживают session slot до фактического закрытия). Старый UI управляет своими
контекстами отдельно. При недостатке памяти Safari/ОС может закрыть вкладку без
перехватываемой ошибки; универсальная гарантия физической памяти не заявляется.

Коды ошибок: IDENTITY, DATA/DATA_BUDGET, PROJECT/UNSUPPORTED, PLAN_MISMATCH,
REFERENCES, ORIGINAL_UNAVAILABLE (с cause), MISSING_ORIGINAL, ORIGINAL_INVALID,
MEDIA_TYPE, IMAGE_HEADER/IMAGE_ANIMATED/IMAGE_DECODE, AUDIO_DECODE,
IMAGE_COUNT/IMAGE_BUDGET/MEMORY_BUDGET/DECODED_BUDGET/SESSION_LIMIT,
CANCELLED, STATE/RELEASED, BUSY/OFFSET, AUDIO_GESTURE/AUDIO_PLAYBACK/AUDIO_CLOSE.
Ошибки renderer/recorder сохраняют прежние сообщения/коды. UI ещё не подключён.

## Проверки и следующий этап

Node проверяет фактические состояния/данные, gated async read/decode, поздние
результаты, lease, бюджеты, отказ оформления и закрытие контекстов. Browser/native
fixture использует реальные PNG/JPG/WebP/WAV, настоящие декодеры с задержкой
публикации результата, trusted clicks для звука/записи, сравнение кадров,
неизменность хешей IndexedDB и round-trip ZIP 2. Chromium дополнительно проверяет
видеофайл FFmpeg: 9:16/6 секунд, обе частоты, отсутствие чёрных кадров. Linux WebKit
без capture codec честно сообщает пропуск именно записи; native Safari требует
реальный результат. Offline HTML обслуживается без доступа к остальным файлам.

```sh
node --test tests/*.test.cjs
python scripts/prepare-site.py
CHROMIUM_PATH=/usr/bin/chromium python tests/check-errors.py tests/runtime-session-browser.py
RUNTIME_ENTRY=downloads/Shorts-Studio.html python tests/check-errors.py tests/runtime-session-browser.py
RUNTIME_BROWSER=webkit python tests/check-errors.py tests/runtime-session-browser.py
RUNTIME_BROWSER=webkit RUNTIME_MOBILE=1 python tests/check-errors.py tests/runtime-session-browser.py
python tests/safari-product.py # только настоящий Safari на macOS
```

Перед будущим UI нужны: пользовательская обработка отказа длинного текста,
контроллер редакций/RAF/seek и пользовательских ошибок, подтверждённый размер
рабочего набора. Существующий результат recorder пока не получает новой проверки
полноты файла в production; реальный результат строго проверяется тестами.
Ручная видеосборка и массовая миграция video-ui.js сюда не входят.
