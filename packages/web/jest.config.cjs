/**
 * Тесты пакета @mailsense/web.
 *
 * ⚠️ Своих jest/ts-jest у пакета нет: `pnpm add` в ограниченной песочнице падает
 * (контент-адресуемый store лежит вне рабочей папки → ERR_SQLITE_ERROR). Поэтому
 * инструменты берутся из соседнего @mailsense/core, где они уже установлены.
 *
 * Компонентные тесты (*.test.tsx) работают в jsdom и используют @testing-library/react.
 * Симлинки в песочнице запрещены, а линковка pnpm (и isolated, и hoisted) падает с
 * переполнением стека, поэтому дерево зависимостей разложено в packages/web/node_modules
 * ПЛОСКОЙ КОПИЕЙ — тот же приём, что в packages/server. Как пересобрать это дерево:
 *   1) в .ui-test-harness лежат package.json/pnpm-lock.yaml с составом обвязки;
 *   2) `pnpm install --lockfile-only` там же обновляет граф (линковка не нужна — она и падает);
 *   3) `node .ui-test-harness/fetch-tarballs.cjs` скачивает архивы и распаковывает их
 *      плоско в packages/web/node_modules (каталоги, без симлинков).
 * Когда появится доступ к нормальной установке — заменить это на
 * `pnpm add -D jest ts-jest @types/jest jest-environment-jsdom @testing-library/react`.
 *
 * Запуск: `pnpm --filter @mailsense/web test` (или из корня `pnpm -r test`).
 */
const path = require("path");

const coreNodeModules = path.join(__dirname, "..", "core", "node_modules");

module.exports = {
  rootDir: __dirname,
  testEnvironment: "node",
  // Стор и утилиты — в node, компоненты — в jsdom (прагма @jest-environment в файле).
  testMatch: ["<rootDir>/src/**/*.test.ts", "<rootDir>/src/**/*.test.tsx"],
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
        // Проверка типов внутри тестов ВЫКЛЮЧЕНА: она дублировала tsc --noEmit и стоила
        // секунды на каждый файл. Типы проверяются отдельной командой пакета (typecheck).
        // ⚠️ Здесь же причина, по которой НЕ нужен --runInBand: у веба нет общей базы,
        // файлы независимы. В песочнице, где запрещены дочерние процессы (spawn EPERM),
        // jest не может поднять воркеры — там запускать test:serial.
        isolatedModules: true,
        diagnostics: false
      }
    ]
  },
  moduleFileExtensions: ["ts", "tsx", "js", "mjs", "json"],
  // jsdom + antd небыстрые: отправка письма в тесте занимает ~11 с (анимации rc-motion
  // и разбор большого дерева компонентов). Под ПАРАЛЛЕЛЬНОЙ нагрузкой (несколько воркеров
  // делят процессор) тяжёлые модалки не укладывались в 30 с — отсюда ложные падения
  // «Exceeded timeout» в тяжёлых наборах при полностью зелёном последовательном прогоне.
  // 90 с — запас на медленной машине под нагрузкой; проверки от этого не слабеют.
  testTimeout: 90000,
  // Столько воркеров — компромисс: вдвое быстрее последовательного прогона, но без
  // перегрузки: на 100% воркеров тяжёлые jsdom-наборы снова упираются в таймауты.
  maxWorkers: "50%",
  clearMocks: true,
  restoreMocks: true
};
