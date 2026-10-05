#!/usr/bin/env node

import { CODEBRIDGE_VERSION } from "./version.js";

const command = process.argv[2];

if (command === "--version" || command === "-v") {
  process.stdout.write(`${CODEBRIDGE_VERSION}\n`);
} else {
  process.stderr.write(
    `CodeBridge ${CODEBRIDGE_VERSION} scaffold: command '${command ?? ""}' is not implemented yet.\n`,
  );
  process.exitCode = 2;
}
