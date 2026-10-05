/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        isolatedModules: true,
        tsconfig: { module: "CommonJS", target: "ES2020", esModuleInterop: true }
      }
    ]
  },
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    // @mailsense/core публикует только условие "import" (ESM), а jest работает
    // в CommonJS и такой exports не видит — берём узкий подпуть по исходникам.
    // Общий баррель core сюда не тянем: он приносит почту, ИИ и очереди.
    "^@mailsense/core/directory$": "<rootDir>/../core/src/directory/index.ts"
  },
  moduleFileExtensions: ["ts", "js", "json"],
  testMatch: ["**/*.test.ts"]
};
