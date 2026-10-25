# API сервера «День» (этап 1, опись до кода)

Сервер: FastAPI + SQLite. Все адреса начинаются с `/api`. Ответы — JSON в UTF-8.
Эта опись — договор между `sync.js` и сервером; тесты в `server/tests/` проверяют именно её.

## Общие правила
- **Вход:** заголовок `Authorization: Bearer <access_token>`. Без него или с плохим/просроченным токеном — `401`.
- **Ошибка:** `{"message": "текст для человека", "code": "короткий_код"}`. `sync.js` показывает `message`.
  - `400` неверные данные, `401` нет входа, `403` нельзя (чужое или не та роль), `404` нет такой записи
    **или она чужая** (чужие записи не «светятся»), `409` уже существует, `413` слишком большой запрос,
    `429` слишком много попыток (+ заголовок `Retry-After` в секундах).
- **Время правки** (`updated_at`) ставит устройство, сервер хранит его как пришло, строкой ISO 8601. «Кто новее» решает устройство (как сейчас).
- **Списки отдаются целиком**, без предела в 1000 строк.
- **`payload`** — непрозрачный JSON: сервер хранит его байт-в-байт, неизвестные поля не трогает.
- **Размер:** одна запись до 8 МБ, один запрос до 32 МБ (личные фото пока внутри данных в base64).
- **CORS** (разрешение браузеру обращаться к серверу с другого адреса): только адреса из `DEN_ALLOWED_ORIGINS`
  (по умолчанию `https://sharinskiy888-art.github.io`).

## Настройки (`den.env`, не в репозитории)
| Имя | Что | По умолчанию |
|---|---|---|
| `DEN_DATA_DIR` | папка с `den.db`, `files/`, `backups/` | `./data` |
| `DEN_SECRET` | секрет подписи токенов (≥ 32 символов), **обязателен** | — |
| `DEN_PUBLIC_URL` | адрес сервера, пишется в токен как `iss` | `http://localhost:8787` |
| `DEN_ADMIN_EMAIL`, `DEN_ADMIN_PASSWORD` | первый админ создаётся при первом запуске, если пользователей нет | — |
| `DEN_ALLOWED_ORIGINS` | адреса сайтов через запятую | GitHub Pages |
| `DEN_ACCESS_TTL`, `DEN_REFRESH_TTL` | жизнь токенов, секунды | 3600, 2592000 |
| `DEN_STATIC_DIR` | папка с экранами (`index.html` и т. д.); если задана — сервер раздаёт их на `/` | — |
| `DEN_BACKUP_KEEP` | сколько автокопий хранить | 14 |

## 1. Вход (`auth.py`)
Пароли — `hashlib.scrypt` с солью. Регистрации «с улицы» нет: только по приглашению админа.
Лимит: 5 неудачных попыток входа в минуту на адрес и на email → `429`.

| Метод и адрес | Тело | Ответ |
|---|---|---|
| `POST /api/auth/login` | `{email, password}` | **Сессия** (ниже) |
| `POST /api/auth/refresh` | `{refresh_token}` | новая Сессия; старый `refresh_token` больше не действует. Плохой — `401` |
| `POST /api/auth/logout` | — (с токеном) | `204`; `refresh_token` этой сессии отзывается |
| `GET /api/auth/user` | — | `{id, email, role}` |
| `PUT /api/auth/user` | `{password, old_password}` | `{id, email, role}`; после смены все прочие сессии отзываются |
| `POST /api/auth/register` | `{email, password, invite}` | Сессия; приглашение одноразовое и только для своего email |

**Сессия:** `{access_token, refresh_token, token_type: "bearer", expires_in, expires_at, user: {id, email, role}}`
(`expires_at` — секунды с 1970 года; так `sync.js` заранее обновляет вход).
**Токен:** `den1.<данные base64url>.<подпись HMAC-SHA256>`, в данных `{sub, email, role, iss, exp, sid}`.
Средняя часть читается так же, как у Supabase, поэтому `sync.js` по `iss` поймёт, что вход выдан другим сервером.

Email всегда приводится к нижнему регистру и обрезается по краям. Пароль — от 6 символов.

### Админ (`role = "admin"`)
| Метод и адрес | Тело | Ответ |
|---|---|---|
| `GET /api/admin/users` | — | `[{id, email, role, created_at}]` (без хэшей) |
| `POST /api/admin/users` | `{email, password, role?, id?}` | `{id, email, role}`; `id` можно задать (перенос пользователей из Supabase с теми же id). Занятый email или id — `409` |
| `PUT /api/admin/users/{id}/password` | `{password}` | `204`; все сессии пользователя отзываются (это «сброс пароля админом») |
| `DELETE /api/admin/users/{id}` | — | `204`; удаляет пользователя и его личные данные |
| `POST /api/admin/invites` | `{email, role?}` | `{invite, email, expires_at}` (живёт 7 дней) |
| `POST /api/admin/backup` | — | `{file, size}` — копия базы прямо сейчас |

Не-админ на любой `/api/admin/*` — `403`.

## 2. Личные данные (`sync.py`)
`{table}` — `tasks` (было `planner_tasks`) или `expenses` (было `planner_expenses`); любое другое — `404`.
Строки видны только владельцу; `user_id` всегда берётся из токена, а не из тела.

| Метод и адрес | Тело | Ответ |
|---|---|---|
| `GET /api/data/{table}/heads` | — | `[{id, updated_at, pu}]`, `pu` = `payload.updatedAt` или `null` |
| `GET /api/data/{table}` | — | `[{id, payload, updated_at}]` — все свои строки |
| `GET /api/data/{table}?ids=a,b,c` | — | только эти (свои) строки; чужие и несуществующие молча пропускаются |
| `POST /api/data/{table}` | `[{id, payload, updated_at}]` | `204`; вставка или замена своих строк |
| `DELETE /api/data/{table}/{id}` | — | `204`; свою строку. Чужую/несуществующую — тоже `204`, но ничего не происходит |

`id` — строка 1–100 символов, `payload` — объект. Особая строка «состояние приложения»
(`id = 00000000-0000-4000-8000-000000000001`) хранится у каждого пользователя своя.

## 3. Поручения (`shared.py`, этап 3)
Участник = организатор (`owner_id`) или email в `invited_emails` / `accepted_emails`.

| Метод и адрес | Кто | Что |
|---|---|---|
| `GET /api/shared/heads` | участник | `[{id, updated_at, pu, invited_emails, accepted_emails}]`, новые сверху |
| `GET /api/shared?ids=…` / `GET /api/shared/{id}` | участник | полные строки `{id, owner_id, owner_email, invited_emails, accepted_emails, leave_requests, payload, updated_at}`; не участник — `404` |
| `POST /api/shared` | любой | создать; организатор — тот, кто создал (из токена). Занятый `id` — `409` |
| `PATCH /api/shared/{id}` | организатор | меняет всё, кроме `owner_id`/`owner_email` |
| `PATCH /api/shared/{id}` | исполнитель (принял) | только `{payload, updated_at}`, и в `payload` — только поля из списка ниже, иначе `403` |
| `DELETE /api/shared/{id}` | организатор | удалить вместе с файлами |
| `POST /api/shared/{id}/answer` | приглашённый | `{accept: true}` — переносит email в `accepted_emails`. `{accept: false}` — `400` (отказаться нельзя) |
| `POST /api/shared/{id}/leave` | исполнитель | просьба выйти: email попадает в `leave_requests`. Выйдет, когда организатор уберёт его из участников |

**Что может менять исполнитель в `payload`** (всё остальное должно остаться как было):
- `status` — любое значение, **кроме** `completed`; `statusBy`, `statusAt`;
- `completed` — только `false`;
- `subtasks` — тот же список и те же названия, меняются только `done`, `doneBy`, `doneAt`;
- `reports` — добавить свой (`by` = свой email), удалить свой; чужие отчёты не трогать;
- `activity` — добавлять записи со своим email; старые могут отпадать (хранится последние 30);
- `updatedAt`.
Не может: текст, дату, вложения, `nudgeAt`/`nudgeNumber`/`inviteReminder*`, участников, владельца.

## 4. Присутствие (`shared.py`, этап 3)
| `POST /api/presence` | `{locale}` | `204` — «я в сети» |
|---|---|---|
| `GET /api/presence` | — | `[{email, last_seen}]` — только люди, с которыми у меня есть общее поручение |

## 5. Файлы отчётов (`files.py`, этап 3)
| Метод и адрес | Кто | Что |
|---|---|---|
| `POST /api/files/shared/{task_id}?ext=jpg` | участник | тело — сам файл (до 20 МБ). Ответ `{path: "shared/<task_id>/<uuid>.jpg"}`. `ext` — `jpg, png, webm, ogg, m4a, mp4, mp3`, иначе `400` |
| `GET /api/files/shared/{task_id}/{name}` | участник | файл. Не участник — `404`. Попытка `..` в пути — `400`/`404` |

## 6. Прочее
| Метод и адрес | Что |
|---|---|
| `GET /api/health` | `{ok: true, version}` без входа |
| `POST /api/feedback` | `{text, email?, photo?}` с входом или без; сохраняется на сервере (вместо formsubmit.co); лимит 5 в минуту на адрес |
| `GET /api/admin/feedback` | админ: список сообщений |
| `GET /` и файлы экранов | если задан `DEN_STATIC_DIR` |

Отложено: push-уведомления (`push_subscriptions`) — до отдельного этапа. Новый `sync.js` на них отвечает «не поддерживается» без ошибки.

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
