# Стенд MailSense: учётки, роли и как всё поднять

Документ для того, кто **сам** проверяет систему: что где крутится, под какими учётками входить,
какой ящик что делает и как поднять тот же продукт в контейнере. Все значения взяты из базы стенда
на 2026-10-08, а не из памяти.

⚠️ Пароли стенда — **не секрет** (решение заказчика 2026-10-05): это тестовый контур, менять их
и чистить историю git не нужно.

---

## 1. Что где крутится

| Что | Адрес | Комментарий |
|---|---|---|
| Приложение (API + интерфейс) | `http://127.0.0.1:8123` | нативный стенд; `/api/health` — проверка живости |
| PostgreSQL стенда | `127.0.0.1:55432`, база `mailsense` | пользователь `mailsense`, пароль `testpass` |
| PostgreSQL для тестов | `127.0.0.1:55432`, база `mailsense_test` | тем же пользователем; тесты её очищают |
| Почтовый сервер (IMAP/SMTP) | `127.0.0.1`, IMAP `993` (TLS), SMTP `465` | ящики `@mail.test` |
| Каталог (LDAP) | `ldaps://127.0.0.1:636` | `rejectUnauthorized=false` — самоподписанный сертификат стенда |
| ИИ: выжимка | `http://100.74.62.22:3006/v1` | модель `Ornith-1.5-9B-Q4_K_M` |
| ИИ: OCR | `http://100.74.62.22:3010/v1` | модель `glm-ocr` |

Почтовый сервер — отдельный контейнер с ящиками `@mail.test`; POP3 (110/995) тоже доступен,
подробности и ограничения — в `docs/mail.md` (раздел «POP3 в проде»).

### Контейнеры стенда

| Контейнер | Образ | Порты (хост) | Что это |
|---|---|---|---|
| `mailserver` | `ghcr.io/docker-mailserver/docker-mailserver:latest` | 25, 110, 143, 465, 587, 993, 995 | Почта: SMTP, POP3, IMAP, IMAPS, SMTPS. Ящики `@mail.test` |
| `mail-admin` | `testmail-admin` (собирается из `test mail/admin`) | 18080 | Веб-админка: пользователи сразу в почте и LDAP |
| `ldap` | `nowsci/samba-domain:latest` | 389, 636, 3268 | Домен и каталог AD: `stand.test`, пользователи и группы |
| `mailsense-db-dev` | `postgres:16-alpine` | 55432 | PostgreSQL стенда (`mailsense`) и тестовая база (`mailsense_test`) |

Все четыре поднимаются с `restart: unless-stopped`, то есть переживают перезапуск Docker.

Веб-админка стенда — http://127.0.0.1:18080 (`admin` / `MailAdmin123!`): заводит и удаляет
почтовые ящики и учётки AD одной формой. Подробности — `admin/README.md` в папке `test mail`.

```bash
docker ps                                   # что поднято и здорово ли
docker logs mailserver --tail 20            # почта
docker logs mail-admin --tail 20            # веб-админка
docker logs ldap --tail 20                  # домен/каталог
docker compose -f docker/docker-compose.dev.yml up -d      # вернуть базу стенда
```

**Само приложение стенда в контейнере не работает** — оно запускается процессом Node на 8123
(см. раздел ниже). Контейнерное развёртывание продукта — отдельная история, раздел 6.

---

## 2. Как поднять нативный стенд

```bash
# 1. База документооборота (контейнер разработки, том сохраняется)
make pg                                  # postgres на 127.0.0.1:55432

# 2. Сборка (в ограниченной песочнице make build падает на esbuild — собираем через tsc)
cd packages/core    && node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit false --declaration && cd ../..
cd packages/docflow && node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit false --declaration && cd ../..
cd packages/server  && node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit false --declaration && cd ../..

# 3. Интерфейс (Vite; в песочнице нужен полный доступ — запускает esbuild)
cd packages/web && node node_modules/vite/bin/vite.js build && cd ../..

# 4. Сервер
cd packages/server
DOCFLOW_DATABASE_URL=postgres://mailsense:testpass@127.0.0.1:55432/mailsense MAILSENSE_ADMIN_LOGINS=test node dist/bin/server.js
```

Данные нативного стенда: `packages/server/data/` (`mailsense.sqlite`, вложения, ключ шифрования,
`logs/mailsense.log`). Документооборот — в PostgreSQL на 55432.

---

## 3. Учётные записи СЭД (AD стенда)

Вход — **полный UPN** (`логин@stand.test`), пароль — доменный. Роли выданы в базе; права считаются
сервером по ролям, интерфейс лишь прячет кнопки.

| Вход | Пароль | Роль в стенде | Кто это | Что может / чего не может |
|---|---|---|---|---|
| `test@stand.test` | `Test1234!` | **Администратор** | Test Mail Test | Всё: журнал, резолюции, пользователи, настройки, аудит, **почта служебных ящиков**. Единственная учётка с админскими вкладками |
| `admin-extra-1` | служебная (создаётся сценариями) | Администратор | Доп. администратор | То же, что выше; используется в проверках «второй администратор» |
| `Иванов_ИИ@stand.test` | `IvanovPass123!` | **Секретарь / Аппарат** | Иван Иванов | Регистрация и ведение журнала, архив года, **черновик резолюции**, отправка исполнителям, подтверждение отчётов, **почта служебных ящиков**. НЕ утверждает резолюцию и НЕ правит утверждённый текст |
| `ivanov` (ivanov@test.local) | служебная (создаётся сценариями) | Секретарь / Аппарат | Иван Иванов | То же; вторая учётка аппарата для проверок |
| `user2@stand.test` | `User2Pass123!` | **Подписант** | User Two Mail Test | Утверждение резолюций, уведомления. НЕ отправляет исполнителям, НЕ регистрирует документы, **почты не видит** |
| `partner@stand.test` | `Partner123!` | **Руководитель** | Partner Mail Test | Наложение резолюций, контроль исполнения, уведомления. НЕ редактирует журнал, **почты не видит** |
| `Петрова_МА@stand.test` | `PetrovaPass123!` | **Исполнитель** | Мария Петрова | Свои задачи, отчёт об исполнении, письмо-источник по своему поручению, уведомления. **Почту не видит** (403) |
| `admin-extra-2` | служебная (создаётся сценариями) | Исполнитель | Доп. администратор | Исполнитель для проверок «чужая задача» |
| `Petrov`, `noauto`, `Новый_Логин` | служебные | **без ролей** | — | Проверки «пользователь без прав»: почта 403, задачи пусто |

**Права по ролям (что именно проверяет сервер):**

| Право | admin | secretary | manager | signer | executor |
|---|---|---|---|---|---|
| `journal.view` (журнал) | да | да | да | да | да |
| `journal.register` / `journal.edit` | да | да | — | — | — |
| `journal.archive` / `journal.reopen` | да | только архив | — | — | — |
| `resolution.create` / `edit` | да | только create | да | — | — |
| `resolution.approve` (утверждение) | да | — | да | **да** | — |
| `resolution.dispatch` (отправка) | да | **да** | — | — | — |
| `task.view` / `task.report` | да | да | view | view | view + report |
| почта (свои ящики) | всем | всем | всем | всем | всем |
| `users.manage` / `settings.manage` / `audit.view` | да | — | — | — | — |
| `notifications.view` | да | да | да | да | да |

⚠️ Не все логины из таблицы есть в каталоге AD: там заведены только `test`, `user2`, `partner`,
`Иванов_ИИ` и `Петрова_МА` (у остальных четырёх ящиков ролей нет). `admin-extra-1`,
`admin-extra-2`, `ivanov@test.local`, `noauto@test.local`, `Petrov` и `Новый_Логин` живут только в
базе документооборота. Что именно лежит в каталоге — раздел 5.1.

---

## 4. Почтовые учётки стенда

Почтовая и доменная учётки — **разные** (как на проде): адрес входа — полный адрес ящика.

| Ящик | Пароль | Протоколы | Роль в сценариях |
|---|---|---|---|
| `test@mail.test` | `Test1234!` | IMAP `127.0.0.1:993` + SMTP `127.0.0.1:465` | **Служебный ящик аппарата (внутренний)**: с него уходит письмо руководителю и исполнителям. Настроен в стенде как `docflow.serviceAccountId` |
| `user2@mail.test` | `User2Pass123!` | IMAP 993 (SMTP не настроен) | Ящик **подписанта/директора**: на него приходит письмо-запрос, с него уходит ответ (резолюция письмом) |
| `petrova_ma@mail.test` | `PetrovaMail456!` | IMAP 993 (SMTP не настроен) | Ящик **исполнителя**: ответ-отчёт письмом |
| `ivanov_ii@mail.test` | `IvanovMail456!` | IMAP 993 | Запасной ящик аппарата для сценариев |
| `manufactory@kaluga.net` | внешний | — | Адрес **внешнего контрагента** в тестовых письмах (роль внешней приёмной) |

Во внешней приёмной на стенде сейчас **никто не назначен** (`docflow.externalAccountId` пуст):
на пилоте обе роли закрывает `test@mail.test`. Это ожидаемо, а не дефект.

Письма для живых проверок ИИ лежат в `test mail/тестовые письма` (PDF-сканы и письма с текстовым слоем).

### 4.1 Почта для СЭД: личный выбор (Р24)

С 0.1.4 работник сам подключает свой ящик (адрес закреплён за ним в LDAP) и сам выбирает,
с какого ящика уходят письма по документообороту. Администратор ящики больше не выдаёт.

| Кто | Что делает | Где |
|---|---|---|
| Работник | подключает свой ящик на почтовом сервере предприятия | «Настройки» → «Почта» → «Добавить аккаунт» |
| Работник | выбирает свою почту для СЭД | «Настройки» → «Личные настройки» → «Почта для СЭД» |
| Аппарат | в действии «Направить руководителю» / «Отправить исполнителям» может переопределить ящик | карточка документа |

Правила, которые стоит проверять руками:

- разрешены **ровно два** ящика — служебный внутренний и личный рабочий этого работника;
  письмо «с первого попавшегося» ящика не уйдёт никогда;
- если работник ещё не подключил ящик, он видит «Ящик ещё не подключён» и кнопку «Перейти
  в „Почту“», а действие отказывает с понятным текстом;
- **ящик без настроенного SMTP** в списке виден, но помечен «отправка не настроена» — выбрать можно,
  отправка откажет понятной ошибкой. На стенде SMTP настроен **только** у `test@mail.test`,
  поэтому для сценария «личная почта для СЭД» другому ящику сначала настраивают SMTP
  (Настройки → Почта → Редактировать → SMTP), иначе письмо уйти не сможет;
- **очереди СЭД** («На регистрацию», уведомления) показывают письма служебных ящиков и личной
  «почты для СЭД» смотрящего — письма обычных (внешних) ящиков в документооборот не попадают.

Живой API для проверки без браузера:

```bash
GET  /api/docflow/my-edms-mail                                  # что доступно и что выбрано
PUT  /api/docflow/my-edms-mail {accountId}                      # выбрать (чужой ящик → 403)
GET  /api/docflow/users/:userId/edms-mail-allowance             # что выдано работнику
PUT  /api/docflow/users/:userId/edms-mail-allowance {accountIds} # выдать/отозвать (админ)
```

---

## 5. Каталог (AD) и служебные настройки стенда

| Настройка | Значение |
|---|---|
| LDAP URL | `ldaps://127.0.0.1:636` |
| Служебная учётка каталога (bind) | `ldap-bind@stand.test` / `LdapBind123!` |
| База поиска | `OU=KNIITMU,DC=stand,DC=test` |
| Формат входа | UPN, суффикс `@stand.test` |
| Проверка сертификата | выключена (самоподписанный) |
| Служебный ящик (внутренний) | `test@mail.test` (`d45c6f8e-5e4f-4146-a072-46c7ab797b6c`) |
| Служебный ящик (внешняя приёмная) | не задан |
| ИИ выжимки | `http://100.74.62.22:3006/v1`, `Ornith-1.5-9B-Q4_K_M`, мультимодальный |
| ИИ OCR | `http://100.74.62.22:3010/v1`, `glm-ocr` |
| Лимиты PDF | OCR 10 страниц, текстовый слой 20 (настраиваются: `ai.ocrMaxPages`, `ai.textMaxPages`) |
| Часовой пояс | задаётся `TZ` процесса; «сегодня» для сроков и журнала считается по нему |

### 5.1 Что лежит в каталоге: снимок живого LDAP (2026-10-08)

Каталог стенда — **Samba AD DC** домена `stand.test` (realm `STAND.TEST`), заведённый только как
справочник/адресная книга и способ входа. Он **не** хранит ни роли СЭД, ни почтовые пароли, ни
кадровые поля. Снимок ниже снят прямым LDAPS-bind'ом сервисной учёткой (`ldap-bind@stand.test`),
то есть это ровно то, что видит приложение. Данные каталога живут в docker-томе `stand-ldap-samba`
и переживают пересоздание контейнера. Отвечают все три порта: LDAP 389, LDAPS 636, Global Catalog
3268 (проверено bind'ом).

**Состав домена** (обход всего поддерева `DC=stand,DC=test`):

| Что | Количество | Комментарий |
|---|---|---|
| Всего объектов | 277 | включая служебные разделы, DNS-узлы и встроенные группы |
| Учётные записи (`objectClass=user`) | 14 | 9 «людей» + `ldap-bind` + `Administrator`, `krbtgt`, `Guest` + учётка компьютера `DC$` |
| Группы (`objectClass=group`) | 37 | все встроенные AD; ни одной группы подразделения |
| Компьютеры (`objectClass=computer`) | 1 | контроллер домена `CN=DC,OU=Domain Controllers` |
| Подразделения (`objectClass=organizationalUnit`) | 2 | `OU=KNIITMU` (люди) и `OU=Domain Controllers` |
| Контейнеры (`objectClass=container`) | 123 | `CN=Users`, `CN=Builtin`, `CN=System` и прочая структура AD |

**Структура** (важна для Base DN: от корня домена AD отдаёт referrals, а не результат):

```
DC=stand,DC=test
├── OU=KNIITMU                        ← база поиска приложения: здесь все «люди»
│   ├── CN=Test Mail Test             test
│   ├── CN=User Two Mail Test         user2
│   ├── CN=Kolobok Mail Test          kolobok
│   ├── CN=Partner Mail Test          partner
│   ├── CN=Client Mail Test           client
│   ├── CN=Supplier Mail Test         supplier
│   ├── CN=Support Mail Test          support
│   ├── CN=Иван Иванов                Иванов_ИИ
│   └── CN=Мария Петрова              Петрова_МА
├── CN=Users                          ← встроенные учётки + сервисный bind приложения
│   ├── CN=ldap-bind                  (description: «LDAP bind for mail.test»)
│   └── CN=Administrator, CN=krbtgt, CN=Guest
├── OU=Domain Controllers → CN=DC      ← сам контроллер домена (dc.stand.test)
└── CN=Builtin, CN=System, CN=Configuration, CN=Schema, DC=DomainDnsZones, DC=ForestDnsZones
```

Разделы `CN=Configuration`, `CN=Schema`, `DC=DomainDnsZones` — служебные, приложению не нужны.

**«Люди» в `OU=KNIITMU`** — девять учёток; логин — UPN, адрес ящика — в атрибуте `mail`:

| sAMAccountName | UPN (логин) | mail | cn / displayName | givenName, sn |
|---|---|---|---|---|
| `test` | `test@stand.test` | `test@mail.test` | Test Mail Test | Test, Mail Test |
| `user2` | `user2@stand.test` | `user2@mail.test` | User Two Mail Test | User Two, Mail Test |
| `kolobok` | `kolobok@stand.test` | `kolobok@mail.test` | Kolobok Mail Test | Kolobok, Mail Test |
| `partner` | `partner@stand.test` | `partner@mail.test` | Partner Mail Test | Partner, Mail Test |
| `client` | `client@stand.test` | `client@mail.test` | Client Mail Test | Client, Mail Test |
| `supplier` | `supplier@stand.test` | `supplier@mail.test` | Supplier Mail Test | Supplier, Mail Test |
| `support` | `support@stand.test` | `support@mail.test` | Support Mail Test | Support, Mail Test |
| `Иванов_ИИ` | `Иванов_ИИ@stand.test` | `ivanov_ii@mail.test` | Иван Иванов | Иван, Иванов |
| `Петрова_МА` | `Петрова_МА@stand.test` | `petrova_ma@mail.test` | Мария Петрова | Мария, Петрова |

Как и на проде, `sAMAccountName`/UPN — кириллицей, `mail` — латиницей (см. `test mail/ldap/seed.sh`).
Пароли домена — в `test mail/README.md`; у `Иванов_ИИ` и `Петрова_МА` они **специально другие**, чем
почтовые (`IvanovPass123!` и `PetrovaPass123!` против `IvanovMail456!` и `PetrovaMail456!`), — чтобы
разделение «почтовая учётка ≠ доменная» было видно. У остальных семи доменный пароль совпадает с
почтовым.

**Служебные и встроенные учётки:**

| DN | sAMAccountName | Пароль | Что это |
|---|---|---|---|
| `CN=ldap-bind,CN=Users` | `ldap-bind` | `LdapBind123!` | Сервисная bind-учётка приложения (UPN `ldap-bind@stand.test`, `mail` не заполнен) |
| `CN=Administrator,CN=Users` | `Administrator` | `AsupAdmin123!` | Администратор домена из `docker-compose.yml` (UPN не заполнен, но bind `Administrator@stand.test` проходит) |
| `CN=krbtgt,CN=Users` | `krbtgt` | — | Служебная учётка центра выдачи билетов Kerberos |
| `CN=Guest,CN=Users` | `Guest` | — | Встроенный гость, **отключён** (`userAccountControl` = 66082) |
| `CN=DC,OU=Domain Controllers` | `DC$` | — | Учётка компьютера контроллера домена |

**Что заполнено, а что пусто.** У «людей» заполнены `cn`, `sn`, `givenName`, `displayName`,
`sAMAccountName`, `userPrincipalName`, `mail`, `distinguishedName`, `objectClass`/`objectCategory`,
`objectGUID`, `objectSid`, `name`, `primaryGroupID`, `userAccountControl`, `pwdLastSet`,
`accountExpires`, `whenCreated`/`whenChanged` и счётчики входов (`lastLogon`, `logonCount`).
**Кадровых полей в каталоге стенда нет**: `title`, `department`, `telephoneNumber`, `manager`,
`company` не заполнены ни у кого. Поэтому в базе СЭД у этих сотрудников пустые `department`,
`position` и `phone`, а адресная книга показывает только ФИО и адрес.

**Признаки учётных записей.** У всех девяти: `userAccountControl` = 66048 (`NORMAL_ACCOUNT` +
`DONT_EXPIRE_PASSWORD` — учётка включена, пароль бессрочный), `accountExpires` = 0 (срок не
ограничен), `primaryGroupID` = 513 (`Domain Users`), `pwdLastSet` = 29.09.2026 (момент заведения).
Атрибут `memberOf` **пуст у всех**: в явных группах AD никто не состоит, и права приложение по
группам каталога не выдаёт — роли лежат в базе документооборота (раздел 3).

**Группы.** 37 групп, все встроенные AD (`Domain Admins`, `Enterprise Admins`, `Schema Admins`,
`Administrators`, `Users`, `Guests`, …). Явные участники есть только у 11 групп, и это
`Administrator`, `Guest` и служебные SID-ы. Групп вида «аппарат / руководители / исполнители» в
каталоге нет.

**Способы входа** (проверено на живом каталоге):

| Что пробуем | Результат |
|---|---|
| `ldap-bind@stand.test` / `LdapBind123!` (UPN) | ок — так ходит приложение |
| `CN=ldap-bind,CN=Users,DC=stand,DC=test` + пароль (DN) | ок |
| `test@stand.test` / `Test1234!` | ок |
| `STAND\test` + пароль (NetBIOS-домен) | ок |
| `Петрова_МА@stand.test` / `PetrovaPass123!` (кириллица в UPN) | ок |
| `Administrator@stand.test` / `AsupAdmin123!` | ок (UPN у записи пуст, Samba сопоставляет по имени) |
| `test@mail.test` (адрес ящика вместо доменного логина) | 49 invalidCredentials — **по почтовому адресу в домен не пускают** |
| неверный пароль | 49 invalidCredentials |
| пустые логин/пароль (анонимно) | bind проходит, но поиск отклоняется (rc=1) — без bind каталог не читается |
| сертификат LDAPS | самоподписанный Samba (`CN=DC.stand.test`, без SAN, годен до 29.08.2028) → нужен `rejectUnauthorized=false` |

**Чего в каталоге нет.** Учётки из раздела 3, которые заведены **не** в AD, а в базе СЭД:
`admin-extra-1`, `admin-extra-2` (`source=manual`), `ivanov@test.local`, `noauto@test.local`
(`source=local`), а также `Petrov@test.local` и `Новый_Логин@test.local` (`source=ldap`, но в
каталоге их нет — их создали сценарии/API). Ролей, прав, блокировок и почтовых паролей в LDAP тоже
нет: почта входит по своей базе (`postfix-accounts.cf`).

**Как приложение ходит в каталог** (значения — из базы стенда на 2026-10-08):

| Настройка / поведение | Значение |
|---|---|
| `ldap.enabled` / `ldap.url` | `true` / `ldaps://127.0.0.1:636` |
| `ldap.baseDn` | `OU=KNIITMU,DC=stand,DC=test` |
| Bind | `ldap.login` = `ldap-bind@stand.test`, пароль зашифрован (`ldap.passwordEncrypted`, ключ `packages/server/data/secret.key`) |
| Формат входа | `ldap.loginFormat=upn`, `ldap.upnSuffix=@stand.test`; `ldap.netbiosDomain=ASUP` — наследие прода, при UPN-формате не используется |
| Фильтр | `ldap.userFilter` пуст → встроенный `(&(objectCategory=person)(objectClass=user)(mail=*)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))`; под `OU=KNIITMU` это ровно те 9 человек |
| Что читает | вход: `sAMAccountName`, UPN, `mail`, `cn`/`displayName`, `title`, `department`, `telephoneNumber`, `manager`, `distinguishedName`; адресная книга: `displayName`, `mail`, `sAMAccountName`, `cn`, `title`, `department`, `telephoneNumber` |
| Когда читает | при каждом входе (bind для проверки пароля + профиль в `users`), по синхронизации справочника (`POST /api/users/sync`), при поиске в адресной книге |
| Кэш | таблица `contacts` в `packages/server/data/mailsense.sqlite`; на стенде в ней 3 записи, обновляется при поиске и полной выгрузке каталога |
| Предел подсказок | настройка `ldap.sizeLimit=25`, но фактический предел задаёт запрос `/api/contacts/search?limit=` (по умолчанию 25, максимум 50) |

**Проверить самому** (в обычной консоли: в песочнице DSH доступ к docker закрыт):

```bash
# все учётки домена — та же команда, что в test mail/ldap/seed.sh
docker exec ldap samba-tool user list -H ldap://127.0.0.1 -U 'Administrator%AsupAdmin123!'

# что именно лежит в OU=KNIITMU (ldbsearch есть внутри контейнера — им же проверяется healthcheck)
docker exec ldap ldbsearch -H /var/lib/samba/private/sam.ldb -b 'OU=KNIITMU,DC=stand,DC=test' '(objectClass=user)'

# полный прогон проверок каталога и модели «почта ≠ домен» (из папки test mail)
python3 test_ldap.py
```

---

## 6. Как самому поднять контейнерное развёртывание

Это тот же продукт, но как у заказчика: сервер СЭД со служебными ящиками в Docker.

```bash
cd mailsense/docker
cp .env.example .env
# в .env обязательно: POSTGRES_PASSWORD, TZ; при желании пути данных
docker compose -f docker-compose.yml up -d --build
docker compose -f docker-compose.yml ps        # оба сервиса должны быть healthy
curl -s http://127.0.0.1:8123/api/health
```

Что появится на хосте (данные **вынесены из контейнера**):

| Путь | Что внутри |
|---|---|
| `docker/data/` | `mailsense.sqlite`, вложения, ключ шифрования, `logs/mailsense.log` |
| `docker/pgdata/` | PostgreSQL: журнал, резолюции, пользователи, аудит |

Дальше — включить вход и войти:

```bash
# в .env: MAILSENSE_ADMIN_LOGINS=<ваш логин>, MAILSENSE_ADMIN_PASSWORD=<пароль>
docker compose -f docker-compose.yml up -d
```

⚠️ **Документооборот в серверном режиме включается сам** на свежей базе (проверено живьём
2026-10-08: строка в журнале, настройка записана, вход 200 без ручных шагов). Ручное включение нужно
только для образа, собранного до этой доработки:

```bash
curl -X PUT http://127.0.0.1:8123/api/docflow/settings \
     -H 'Content-Type: application/json' -d '{"enabled":true}'
```

Проверено живьём 2026-10-08: `enabled:true` → `POST /api/auth/login` 200, роль `admin`, 17 прав,
журнал и резолюции отвечают (значит миграции применились). Правка «документооборот включается сам
в серверном режиме» уже готова в исходниках (T48) и войдёт в следующую сборку образа.

Остановка без потери данных: `docker compose -f docker-compose.yml down` — папки `data/` и `pgdata/`
остаются. Полная процедура обновления, резервного копирования и восстановления — в
`docs/deploy-guide.md`.

⚠️ Боевой и dev compose теперь имеют разные имена проектов (`mailsense` и `mailsense-dev`):
до этой правки `down` на боевом гасил базу разработки на 55432.

---

## 7. Что стоит проверить руками (чеклист по ролям)

**Аппарат** (`Иванов_ИИ@stand.test`):
1. Почта: список писем, карточка, вложения; кнопка «Скан» забирает новые письма.
2. Регистрация входящего: анализ ИИ → форма предзаполнена (номер отправителя, дата, листы, отправитель,
   краткое содержание), номер выдаёт база.
3. Поручение: черновик резолюции кнопкой «Заполнить с помощью ИИ», отправка подписанту.
4. Ответом письма: ответ руководителя → «Это письмо в переписке по поручению» → черновик резолюции.
5. Отчёт исполнителя: черновик отчёта, подтверждение — поручение закрывается только подтверждением.
6. Личные настройки: имя и подпись; в новом письме подписи **ящика** нет, есть личная; в ответе
   подпись стоит до/после цитаты по настройке.

**Подписант** (`user2@stand.test`): видит «На утверждении», утверждает (в т.ч. чипами типовых сроков);
почты не видит — 403.

**Руководитель** (`partner@stand.test`): накладывает резолюцию, видит контроль исполнения; журнал
не редактирует; почту не видит.

**Исполнитель** (`Петрова_МА@stand.test`): вместо почты экран «Почта недоступна», в «Моих задачах»
кнопка «Письмо» открывает письмо-источник **своего** поручения; чужое — 403, отправка — недоступна.

**Администратор** (`test@stand.test`): пользователи и роли, служебные ящики (два селектора),
ИИ-модели, аудит (без сырых идентификаторов), адрес сервера во вкладке «Подключение».

Сквозные сценарии (нужен запущенный стенд) — список и переменные окружения в `docs/testing.md`.

---

## 8. Если что-то не работает

| Симптом | Причина и что делать |
|---|---|
| `ECONNREFUSED 127.0.0.1:55432` | Не поднята база стенда: `make pg` (или `docker compose -f docker/docker-compose.dev.yml up -d`) |
| Порт 8123 занят | Уже запущен другой экземпляр: найти и остановить (`netstat -ano | findstr :8123`) |
| Вход отвечает 400 | Документооборот выключен: `PUT /api/docflow/settings {"enabled":true}` (или настройка `docflow.enabled`) |
| Вход отвечает «Неверный логин или пароль» | Доменная учётка ≠ почтовая: логин — UPN (`test@stand.test`), пароль — доменный. По адресу ящика (`test@mail.test`) каталог не пускает (49 invalidCredentials) — раздел 5.1 |
| Каталог не отвечает | Проверить контейнер `ldap` (`docker logs ldap --tail 20`) и порты 389/636/3268; URL, Base DN и bind-учётка — в разделе 5.1 |
| Почта пустая у аппарата | Не заданы/не настроены служебные ящики (`.env` или интерфейс); скан запускает аппарат |
| Нет прав в интерфейсе | Роль не выдана в базе: проверить `user_roles`; админ получает роль по `MAILSENSE_ADMIN_LOGINS` при первом входе |
| Даты сроков «сдвинуты» | Проверить `TZ` процесса и часовой пояс машины |
| ИИ отвечает ошибкой | Проверить доступность моделей (`100.74.62.22:3006` / `:3010`) и кнопку проверки в настройках |

---

## 9. Сброс стенда «в чистое»

```bash
# Документооборот: пересоздать базу
docker exec mailsense-db-dev psql -U mailsense -d postgres -c "drop database mailsense;" -c "create database mailsense;"
# Почта, вложения и профили: убрать локальные данные сервера
rm -rf packages/server/data
```

После этого сервер при старте применит миграции заново и заново выдаст роль администратора
логинам из `MAILSENSE_ADMIN_LOGINS`.
