/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        isolatedModules: true,
        tsconfig: { module: "CommonJS", target: "ES2022", esModuleInterop: true }
      }
    ]
  },
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    // Пакеты публикуют только условие "import" (ESM), а jest работает в CommonJS
    // и такого exports не видит — берём исходники напрямую (как в docflow).
    // В тестах эти модули подменяются через jest.mock, поэтому тяжёлые
    // зависимости (better-sqlite3, canvas, IMAP) не загружаются.
    "^@mailsense/core$": "<rootDir>/../core/src/index.ts",
    "^@mailsense/docflow$": "<rootDir>/../docflow/src/index.ts",
    // Права ролей и классы ошибок — чистые модули без базы: берём их по-настоящему,
    // чтобы матрица «маршрут × роль» проверяла реальные права, а не их копию в тесте.
    "^@mailsense/docflow/roles$": "<rootDir>/../docflow/src/roles.ts",
    "^@mailsense/docflow/errors$": "<rootDir>/../docflow/src/errors.ts",
    "^@mailsense/docflow/types$": "<rootDir>/../docflow/src/types.ts",
    // Сопоставление ответа по треду — чистая функция: в тестах берём настоящую,
    // чтобы проверять штатный путь «ответ руководителя письмом», а не её копию.
    "^@mailsense/docflow/approvalReplies$": "<rootDir>/../docflow/src/approvalReplies.ts"
  },
  moduleFileExtensions: ["ts", "js", "json"],
  testMatch: ["**/*.test.ts"],
  testTimeout: 20000,
  forceExit: true
};
