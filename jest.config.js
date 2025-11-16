module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: "./",
  testMatch: ["**/*.e2e-spec.ts"],
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json"],
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: {
          module: "commonjs",
          target: "es6",
          esModuleInterop: true,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
        },
      },
    ],
  },
  testTimeout: 20000,
  maxWorkers: 1,
  verbose: true,
  collectCoverage: false,
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/lib/$1",
  },
};
