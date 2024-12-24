import type { Config } from "jest";

const config: Config = {
  testEnvironment: "node",
  transform: {
    "^.+.tsx?$": ["ts-jest", {}],
  },
  testPathIgnorePatterns: ["<rootDir>/node_modules/", "<rootDir>/testFiles/"],
};

export default config;
