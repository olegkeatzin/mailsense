export * from "./types.js";
export * from "./config.js";
export * from "./logger.js";
export * from "./secrets.js";
export * from "./context.js";
export * from "./db/index.js";
export * from "./db/schema.js";
export * from "./repos.js";
export * from "./mail/index.js";
export * from "./mail/mbox.js";
export * from "./attachments/index.js";
export * from "./ai/index.js";
export * from "./analysis/queue.js";
export * from "./services/accountService.js";
export * from "./services/mailService.js";
export * from "./services/sendService.js";
export * from "./services/composeService.js";
export * from "./services/draftService.js";
export * from "./services/directoryService.js";
// Каталог — публичная часть core: им пользуется и адресная книга почты, и вход
// в серверную часть (документооборот живёт отдельным пакетом и берёт LDAP отсюда).
export * from "./directory/ldap.js";
export * from "./services/threadService.js";
export * from "./services/maintenance.js";
export * from "./mail/smtpSender.js";
export * from "./services/analysisService.js";
export * from "./services/settingsService.js";
export * from "./services/scheduler.js";
export * from "./services/exportService.js";
export * from "./services/mailSyncHook.js";
// Этап 5: автосортировка писем — чистая логика (маршрутизация и подсветка, НЕ авторегистрация).
export * from "./services/mailSortRules.js";
// Этап 5: рабочие дни и сроки — тоже чистая логика (без часовых поясов и Date-ловушек).
export * from "./services/workingDays.js";
export { initApp } from "./init.js";
