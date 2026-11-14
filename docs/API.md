# API OmniDash

Базовый адрес: `http://localhost:7777`.
Формат: `{ "ok": true, "data": … }` / `{ "ok": false, "error": "текст", "code": "CODE" }`.
Авторизация: cookie `od_sid` после входа **или** `Authorization: Bearer od_…` (API-ключ).

| Код | Значение |
|---|---|
| `AUTH_REQUIRED` | нужен вход |
| `FORBIDDEN` | нет прав |
| `NOT_FOUND` | объект не найден |
| `CONFLICT` | конфликт (занято, уже существует) |
| `RATE_LIMIT` | слишком много попыток входа |
| `LIMIT_REACHED` | превышен лимит пользователя |
| `VALIDATION` | неверные данные |

---

## Общее

| Метод | Путь | Описание | Доступ |
|---|---|---|---|
| GET | `/api/meta` | имя, версия, акцент, MOTD, лимиты, демо-входы | публично |
| GET | `/api/health` | состояние и аптайм | публично |
| GET | `/api/system` | host CPU/RAM/диск, процессы | вход |
| GET | `/api/events` | SSE-поток событий | вход |

## Аутентификация

| Метод | Путь | Описание |
|---|---|---|
| POST | `/api/auth/login` | вход, ставит cookie |
| POST | `/api/auth/register` | регистрация (если открыта) |
| POST | `/api/auth/logout` | выход |
| GET | `/api/auth/me` | текущий пользователь |
| PATCH | `/api/auth/me` | имя, e-mail, аватар, пароль |
| GET / POST | `/api/auth/keys` | список / создание API-ключа |
| DELETE | `/api/auth/keys/:keyId` | отозвать ключ |

```bash
curl -c jar -X POST localhost:7777/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"omnidash"}'
```

## Обзор

| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/dashboard` | счётчики, нагрузка, лента событий, внимание |
| GET | `/api/servers` | серверы, видимые пользователю |
| POST | `/api/servers` | создать сервер |
| GET | `/api/servers/:id` | детали, логи, шаблон, узел, порты |
| PATCH | `/api/servers/:id` | имя, лимиты, срок, автостарт, владелец |
| DELETE | `/api/servers/:id` | удалить со всеми файлами |

Создание сервера:

```json
{
  "name": "Новый мир",
  "eggId": "egg_paper",
  "nodeId": "node_ru",
  "memory": 2048,
  "disk": 10240,
  "cpu": 100,
  "expiresDays": 30,
  "ownerId": "usr_…",
  "autoStart": true
}
```

## Питание и мониторинг

| Метод | Путь | Описание |
|---|---|---|
| POST | `/api/servers/:id/power` | `{"action":"start"\|"stop"\|"restart"\|"kill"}` |
| POST | `/api/servers/:id/command` | `{"command":"say привет"}` |
| GET | `/api/servers/:id/logs?tail=200` | строки консоли |
| GET | `/api/servers/:id/stats` | CPU, RAM, диск, TPS, игроки, uptime |

## Сроки и состояние

| Метод | Путь | Описание |
|---|---|---|
| POST | `/api/servers/:id/suspend` | приостановить (админ) |
| POST | `/api/servers/:id/unsuspend` | возобновить (админ) |
| POST | `/api/servers/:id/renew` | продлить (админ), `{"days":30}` |
| POST | `/api/servers/:id/request-renew` | запрос продления (пользователь) |
| POST | `/api/servers/:id/transfer` | передать владельцу, `{"userId":"…"}` |
| GET | `/api/renew-requests` | список запросов (админ) |
| POST | `/api/renew-requests/:id/approve` | одобрить |
| POST | `/api/renew-requests/:id/reject` | отклонить |

## Доступы

| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/servers/:id/subusers` | субпользователи, права, список людей |
| POST | `/api/servers/:id/subusers` | выдать: `{"userId":"…","perms":["console","files"]}` |
| DELETE | `/api/servers/:id/subusers/:userId` | отозвать |

Права: `console`, `control`, `files`, `backups`, `startup`, `settings`, `users`, `schedule`, `allocations`.

## Порты

| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/servers/:id/allocations` | занятые и свободные порты |
| POST | `/api/servers/:id/allocations` | добавить порт, `{"allocationId":"…","primary":false}` |
| DELETE | `/api/servers/:id/allocations/:allocationId` | освободить (кроме основного) |
| GET | `/api/allocations?node=…` | все аллокации (админ) |
| POST | `/api/allocations` | создать одну |
| POST | `/api/allocations/bulk` | диапазон: `{"nodeId":"…","from":25565,"to":25580}` |
| DELETE | `/api/allocations/:id` | удалить свободную |

## Файлы

| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/servers/:id/files?path=` | список каталога |
| GET | `/api/servers/:id/files/content?path=` | чтение файла |
| PUT | `/api/servers/:id/files/content` | запись `{"path":"…","content":"…"}` |
| POST | `/api/servers/:id/files/mkdir` | папка |
| POST | `/api/servers/:id/files/touch` | пустой файл |
| POST | `/api/servers/:id/files/rename` | переименовать |
| POST | `/api/servers/:id/files/delete` | удалить `{"paths":["a","b"]}` |
| POST | `/api/servers/:id/files/upload?path=&name=` | тело — байты файла |
| GET | `/api/servers/:id/files/download?path=` | скачать |
| POST | `/api/servers/:id/files/archive` | ZIP выбранного |
| POST | `/api/servers/:id/files/extract` | распаковать ZIP |

## Бэкапы

| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/servers/:id/backups` | список и лимит |
| POST | `/api/servers/:id/backups` | создать `{"name":"…"}` |
| POST | `/api/servers/:id/backups/:backupId/restore` | восстановить |
| GET | `/api/servers/:id/backups/:backupId/download` | скачать ZIP |
| DELETE | `/api/servers/:id/backups/:backupId` | удалить |

## Расписание

| Метод | Путь | Описание |
|---|---|---|
| GET / POST | `/api/servers/:id/tasks` | список / создать |
| PATCH / DELETE | `/api/servers/:id/tasks/:taskId` | изменить / удалить |
| POST | `/api/servers/:id/tasks/:taskId/run` | выполнить сейчас |

```json
{
  "name": "Ночной рестарт",
  "action": "power_restart",
  "schedule": { "type": "daily", "time": "05:00" }
}
```

Действия: `command`, `power_start`, `power_stop`, `power_restart`, `backup`.
Расписание: `{"type":"interval","minutes":60}`, `{"type":"daily","time":"05:00"}`, `{"type":"weekly","day":1,"time":"04:30"}`, `{"type":"cron","expr":"0 4 * * *"}`.

## Переменные запуска

| Метод | Путь | Описание |
|---|---|---|
| POST | `/api/servers/:id/startup` | сохранить env и startup-override |

## Пользователи (админ)

| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/users` | список с нагрузкой и лимитами |
| GET | `/api/users/:id` | детали |
| POST | `/api/users` | создать |
| PATCH | `/api/users/:id` | роль, лимиты, блокировка, профиль |
| POST | `/api/users/:id/password` | сбросить пароль |
| DELETE | `/api/users/:id` | удалить (серверы должны быть переданы) |

## Узлы и шаблоны (админ)

| Метод | Путь | Описание |
|---|---|---|
| GET / POST | `/api/nodes` | список / создать |
| PATCH / DELETE | `/api/nodes/:id` | изменить / удалить |
| GET / POST | `/api/eggs` | шаблоны |
| PATCH / DELETE | `/api/eggs/:id` | изменить / удалить |

## Служебное (админ)

| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/audit?limit=` | журнал |
| GET / PATCH | `/api/settings` | настройки панели |
| GET | `/api/update` | версия, канал, пакеты, история |
| POST | `/api/update/check` | проверить манифест |
| POST | `/api/update/from-file` | применить из `updates/` |
| POST | `/api/update/upload` | применить загруженный ZIP |

## SSE

`GET /api/events` отдаёт события:

| Событие | Данные |
|---|---|
| `hello` | версия, buildId |
| `log` | `{serverId, line, stream}` |
| `state` | `{serverId, status, pid}` |
| `stats` | `{serverId, cpu, memory, disk, players}` |
| `servers` | изменение списка серверов |
| `notify` | тост для интерфейса |
| `reload` | код панели обновился |
| `shutdown` | панель останавливается |
