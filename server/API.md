# API сервера «День» (этап 1, опись до кода)

Сервер: FastAPI + SQLite. Все адреса начинаются с `/api`. Ответы — JSON в UTF-8.
Эта опись — договор между `sync.js` и сервером; тесты в `server/tests/` проверяют именно её.
Маркеры тестов: `etap2` — приёмка этапа 2 (вход, личные данные, права, копии), `etap3` — этапа 3 (поручения, файлы).

## Общие правила
- **Вход:** заголовок `Authorization: Bearer <access_token>`. Без него, с плохим, просроченным или отозванным токеном — `401`.
- **Ошибка:** `{"message": "текст для человека", "code": "короткий_код"}`. `sync.js` показывает `message`.
  - `400` неверные данные (в том числе кривой JSON и неверные поля; FastAPI-шный `422` сервер переписывает в `400`),
    `401` нет входа, `403` нельзя (не та роль или поле, которое вам менять нельзя),
    `404` нет такой записи **или она чужая** (чужие записи не «светятся»), `409` уже существует,
    `413` слишком большой запрос (сервер может и просто закрыть соединение, не дочитав тело),
    `429` слишком много попыток (+ заголовок `Retry-After` в секундах).
  - Тексты ошибок без подробностей устройства сервера (никаких трассировок).
- **Успех:** `200` с телом, `201` при создании (с телом), `204` без тела. Точные коды — в таблицах ниже.
- **Время правки** (`updated_at`) ставит устройство, сервер хранит его как пришло, строкой ISO 8601. «Кто новее» решает устройство (как сейчас).
- **Списки отдаются целиком**, без предела в 1000 строк.
- **`payload`** — непрозрачный JSON: сервер хранит его без изменений, неизвестные поля не трогает.
- **Размер:** одна запись до 8 МБ, один запрос до 32 МБ, файл до 20 МБ.
- **Кэш:** все ответы `/api/*` с `Cache-Control: no-store` (иначе `sw.js` закэширует данные).
- **CORS** (разрешение браузеру обращаться к серверу с другого адреса): только адреса из `DEN_ALLOWED_ORIGINS`.
  Разрешены заголовки `Authorization`, `Content-Type`, `apikey`, методы `GET, POST, PUT, PATCH, DELETE`;
  `Access-Control-Expose-Headers: Retry-After`. Заголовок `Access-Control-Allow-Origin` есть и в ответах-ошибках (401, 413, 429), иначе браузер покажет «нет сети» вместо «войдите снова».
- **Журнал сервера** не содержит паролей, токенов, телефонов и адресов.
- **SQLite:** режим WAL, `busy_timeout` 5 с; одновременная запись с двух устройств не даёт ошибок.

## Настройки (`den.env`, не в репозитории)
| Имя | Что | По умолчанию |
|---|---|---|
| `DEN_DATA_DIR` | папка: `den.db`, `files/`, `backups/` | `./data` |
| `DEN_SECRET` | секрет подписи токенов, **обязателен**, не короче 32 символов. Без него сервер не запускается и пишет `DEN_SECRET` в причине | — |
| `DEN_PUBLIC_URL` | адрес сервера, пишется в токен как `iss` | `http://localhost:8787` |
| `DEN_ADMIN_EMAIL`, `DEN_ADMIN_PASSWORD` | первый админ; создаётся только если пользователей ещё нет | — |
| `DEN_ALLOWED_ORIGINS` | адреса сайтов через запятую | `https://sharinskiy888-art.github.io` |
| `DEN_ACCESS_TTL`, `DEN_REFRESH_TTL` | жизнь токенов, секунды | 3600, 2592000 |
| `DEN_LOGIN_LIMIT`, `DEN_LOGIN_WINDOW` | неудачных попыток входа/регистрации и окно, секунды | 5, 60 |
| `DEN_STATIC_DIR` | папка с экранами; если задана — сервер раздаёт их на `/` | — |
| `DEN_BACKUP_KEEP`, `DEN_BACKUP_EVERY` | сколько автокопий хранить; как часто делать, секунды | 14, 86400 |

## Хранение
- `den.db` — база. Таблица `users` со столбцом `password_hash` вида `scrypt$<параметры>$<соль>$<хэш>` (соль своя у каждого пароля).
- `files/shared/<task_id>/<имя>` — фото и голосовые отчётов.
- `backups/den-<время>.db` — копии базы (через SQLite backup), рядом `files-<время>.zip` — копия папки `files/`. Старые сверх `DEN_BACKUP_KEEP` удаляются.

## 1. Вход (`auth.py`)
Пароли — `hashlib.scrypt` с солью. Регистрации «с улицы» нет: только по приглашению админа.
Лимит: `DEN_LOGIN_LIMIT` неудачных попыток входа или регистрации за `DEN_LOGIN_WINDOW` с одного адреса **и** на один email → `429`; после окна снова можно.

| Метод и адрес | Тело | Ответ |
|---|---|---|
| `POST /api/auth/login` | `{email, password}` | `200` **Сессия**; неверный email или пароль — `401` с одинаковым текстом |
| `POST /api/auth/refresh` | `{refresh_token}` | `200` новая Сессия (полная, с `user`). Старый `refresh_token` больше не действует; **повторное** его использование отзывает всю сессию (и новый токен тоже). Плохой — `401` |
| `POST /api/auth/logout` | — | `204`; эта сессия отзывается (и access, и refresh) |
| `GET /api/auth/user` | — | `200 {id, email, role}` |
| `PUT /api/auth/user` | `{password, old_password}` | `200 {id, email, role}`; неверный старый пароль — `403`. Все **прочие** сессии отзываются, текущая остаётся |
| `POST /api/auth/register` | `{email, password, invite}` | `200` Сессия; приглашение одноразовое и только для своего email, иначе `403` |

**Сессия:** `{access_token, refresh_token, token_type: "bearer", expires_in, expires_at, user: {id, email, role}}`;
`expires_at` — секунды с 1970 года, равно `exp` в токене.
**Токен:** `den1.<данные base64url>.<подпись HMAC-SHA256>`, в данных `{sub, email, role, iss, exp, sid}`; `exp` округляется вверх.
Средняя часть читается так же, как у Supabase, поэтому `sync.js` по `iss` поймёт, что вход выдан другим сервером.
Отзыв работает через `sid` (номер сессии): отозванная сессия даёт `401` и для ещё «живого» access-токена.

Email всегда приводится к нижнему регистру и обрезается по краям. Пароль — от 6 символов, иначе `400`.

### Админ (`role = "admin"`)
| Метод и адрес | Тело | Ответ |
|---|---|---|
| `GET /api/admin/users` | — | `200 [{id, email, role, created_at}]` (без хэшей) |
| `POST /api/admin/users` | `{email, password, role?, id?}` | `201 {id, email, role}`; `id` можно задать (перенос пользователей из Supabase с теми же id). Занятый email или id — `409` |
| `PUT /api/admin/users/{id}/password` | `{password}` | `204`; все сессии пользователя отзываются («сброс пароля админом») |
| `DELETE /api/admin/users/{id}` | — | `204`; удаляет пользователя, его сессии и личные данные |
| `POST /api/admin/invites` | `{email, role?}` | `201 {invite, email, expires_at}` (живёт 7 дней) |
| `POST /api/admin/backup` | — | `201 {file, size}` — копия базы прямо сейчас, `file` — имя в `backups/` |
| `GET /api/admin/feedback` | — | `200 [{id, text, email, photo, created_at}]` |

Не-админ на любой `/api/admin/*` — `403`.

## 2. Личные данные (`sync.py`)
`{table}` — `tasks` (было `planner_tasks`) или `expenses` (было `planner_expenses`); любое другое — `404`.
Строки видны только владельцу; владелец всегда берётся из токена. Поле `user_id` в теле строки допускается (его шлёт нынешний `sync.js`) и игнорируется.

| Метод и адрес | Тело | Ответ |
|---|---|---|
| `GET /api/data/{table}/heads` | — | `200 [{id, updated_at, pu}]`, `pu` = `payload.updatedAt` или `null` |
| `GET /api/data/{table}` | — | `200 [{id, payload, updated_at}]` — все свои строки |
| `GET /api/data/{table}?ids=a,b,c` | — | `200` только эти (свои) строки; чужие и несуществующие молча пропускаются |
| `POST /api/data/{table}` | `[{id, payload, updated_at, user_id?}]` | `204`; вставка или замена своих строк. Одна плохая строка — `400`, и не пишется ничего |
| `DELETE /api/data/{table}/{id}` | — | `204`; свою строку. Чужую/несуществующую — тоже `204`, но ничего не происходит |

`id` — строка 1–100 символов, `payload` — объект, `updated_at` — строка. Особая строка «состояние приложения»
(`id = 00000000-0000-4000-8000-000000000001`) хранится у каждого пользователя своя.

## 3. Поручения (`shared.py`, этап 3)
Участник = организатор (`owner_id`) или email в `invited_emails` / `accepted_emails` (email без учёта регистра).
Строка: `{id, owner_id, owner_email, invited_emails, accepted_emails, leave_requests, payload, updated_at}`.

| Метод и адрес | Кто | Ответ |
|---|---|---|
| `GET /api/shared/heads` | участник | `200 [{id, updated_at, pu, invited_emails, accepted_emails}]`, по `updated_at` от новых к старым |
| `GET /api/shared?ids=…` | участник | `200` полные строки; чужие пропускаются |
| `GET /api/shared/{id}` | участник | `200` строка; не участник — `404` |
| `POST /api/shared` | любой | `201` строка. Организатор — из токена. `accepted_emails` и `leave_requests` при создании пустые, `updated_at` — как прислали. Свой существующий `id` — повтор: `200`, обновление как PATCH организатора. Чужой `id` — `409` |
| `PATCH /api/shared/{id}` | организатор | `204`. Меняет всё; `owner_id`/`owner_email` можно прислать только прежними, другие — `403` |
| `PATCH /api/shared/{id}` | исполнитель (принял) | `204`. Только `{payload, updated_at}` (+ прочие столбцы, если они не изменились), и в `payload` — только поля из списка ниже, иначе `403` и ничего не меняется |
| `DELETE /api/shared/{id}` | организатор | `204`, вместе с файлами. Остальные — `404` |
| `POST /api/shared/{id}/answer` | приглашённый | `{accept: true}` → `204`, email переносится в `accepted_emails`; повтор — тоже `204`. `{accept: false}` — `400` (отказаться нельзя). Не приглашённый — `404` |
| `POST /api/shared/{id}/leave` | исполнитель (принял) | `204`: email попадает в `leave_requests`. Выйдет, когда организатор уберёт его из участников. Остальные — `403`/`404` |

**Что может менять исполнитель в `payload`** (всё остальное должно остаться как было):
- `status` — любое значение, **кроме** `completed`; `statusBy`, `statusAt`;
- `completed` — только `false`;
- `subtasks` — тот же список и те же названия, меняются только `done`, `doneBy`, `doneAt`;
- `reports` — новый список = старый без своих удалённых отчётов, с отрезанной головой (если всего больше 50 — `app.js` хранит последние 50) + свои новые (`by` = свой email) в конце. Чужие отчёты в середине не трогать;
- `activity` — новый список = хвост старого + свои новые записи (`email` = свой) в конце;
- `updatedAt`.
Не может: текст, дату, заметку, вложения, `nudgeAt`/`nudgeNumber`/`inviteReminder*`, новые поля, участников, владельца.

## 4. Присутствие (`shared.py`, этап 3)
| Метод и адрес | Тело | Ответ |
|---|---|---|
| `POST /api/presence` | `{locale}` | `204` — «я в сети» |
| `GET /api/presence` | — | `200 [{email, last_seen}]` — только люди, с которыми у меня есть общее поручение |

## 5. Файлы отчётов (`files.py`, этап 3)
| Метод и адрес | Кто | Ответ |
|---|---|---|
| `POST /api/files/shared/{task_id}?ext=jpg` | участник | тело — сам файл. `201 {path: "shared/<task_id>/<uuid>.jpg"}`. `ext` — `jpg, jpeg, png, webp, webm, ogg, m4a, mp4, mp3, wav`, иначе `400` |
| `PUT /api/files/shared/{task_id}/{name}` | организатор | `201 {path}` — для переноса из Supabase с прежним именем. `name` — только `<буквы, цифры, ->.<ext>`, иначе `400`; уже есть — `409` |
| `GET /api/files/shared/{task_id}/{name}` | участник | `200` файл. Не участник или нет файла — `404`. `..`, `%2e%2e`, `\` в пути — `400`/`404`, за пределы `files/` не выйти |

## 6. Прочее
| Метод и адрес | Ответ |
|---|---|
| `GET /api/health` | `200 {ok: true, version}` без входа |
| `POST /api/feedback` | `{text, email?, photo?}`, `photo` — `data:image/...;base64,…` до 5 МБ. `204`. С входом или без; лимит 5 в минуту на адрес (вместо formsubmit.co; `app.js` переводится с FormData на JSON) |
| `GET /` и файлы экранов | если задан `DEN_STATIC_DIR`. Раздаются **только** файлы приложения: `index.html, app.js, sync.js, sync-config.js, i18n-en.js, styles.css, sw.js, version.js, version.json, manifest.webmanifest, install.html, reset.html, qr-iphone.svg, assets/*`. Остальное — `404`. Неизвестный `/api/...` — всегда JSON `404` |

Отложено: push-уведомления (`push_subscriptions`) — до отдельного этапа. Новый `sync.js` на них отвечает «не поддерживается» без ошибки.
Этап 5 (перенос): админ-импорт поручений с готовыми `accepted_emails` — описывается на этапе 5.

## 7. Соответствие функций `sync.js`
| `DaySync.*` | Было (Supabase) | Станет |
|---|---|---|
| `signIn` / `refresh` / `signOut` | `/auth/v1/token`, `/auth/v1/logout` | `/api/auth/login`, `/refresh`, `/logout` |
| `signUp` | `/auth/v1/signup` | `/api/auth/register` (с кодом приглашения) |
| `resetPassword`, `verifyRecoveryCode`, `consumeRecoveryFromUrl`, `reset.html` | письма | убираются: «Обратитесь к администратору» |
| `updatePassword` | `PUT /auth/v1/user` | `PUT /api/auth/user` |
| `sync`, `syncExpenses` | `/rest/v1/planner_*` | `/api/data/tasks`, `/api/data/expenses` |
| `loadSharedTasks`, `loadSharedTask`, `saveSharedTask`, `deleteSharedTask` | `/rest/v1/shared_tasks` | `/api/shared…` |
| `answerSharedInvite` | `rpc/answer_shared_invite` | `/api/shared/{id}/answer` |
| `touchPresence`, `loadSharedPresence` | `rpc/touch_presence`, `rpc/get_shared_presence` | `/api/presence` |
| `uploadSharedMedia`, `loadSharedMedia` | `/storage/v1/object/…attachments` | `/api/files/shared/…` |
| `savePushSubscription`, `deletePushSubscription` | `push_subscriptions` | отложено |
| `deleteAccount` | `rpc/delete_own_account` | не используется экранами; удаляет админ |
| форма обратной связи (`app.js`) | formsubmit.co | `/api/feedback` |
