/**
 * Тесты пакета @mailsense/web.
 *
 * ⚠️ Своих jest/ts-jest у пакета нет: `pnpm add` в ограниченной песочнице падает
 * (контент-адресуемый store лежит вне рабочей папки → ERR_SQLITE_ERROR), а
 * скопировать обвязку плоско, как в server, для web не потребовалось. Поэтому
 * инструменты берутся из соседнего @mailsense/core, где они уже установлены.
 *
 * Запуск: `pnpm --filter @mailsense/web test` (или из корня `pnpm -r test`).
 * Если однажды появится возможность поставить зависимости — заменить пути ниже
 * на обычные "jest"/"ts-jest" и добавить их в devDependencies.
 */
const path = require("path");

const coreNodeModules = path.join(__dirname, "..", "core", "node_modules");

module.exports = {
  rootDir: __dirname,
  testEnvironment: "node",
  testMatch: ["<rootDir>/src/**/*.test.ts"],
  transform: {
    "^.+\\.(ts|tsx)$": [
      path.join(coreNodeModules, "ts-jest"),
      {
        tsconfig: {
          target: "ES2020",
          module: "commonjs",
          moduleResolution: "node",
          esModuleInterop: true,
          jsx: "react-jsx",
          strict: true,
          skipLibCheck: true,
          types: ["jest"],
          // @types/jest тоже лежит в core — своего в пакете нет.
          typeRoots: [path.join(coreNodeModules, "@types")]
        },
        diagnostics: true
      }
    ]
  },
  moduleFileExtensions: ["ts", "tsx", "js", "mjs", "json"],
  clearMocks: true,
  restoreMocks: true
};
