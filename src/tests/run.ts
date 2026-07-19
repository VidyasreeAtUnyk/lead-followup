import type { Test } from "./testHelpers.js";
import { groundingTests } from "./grounding.test.js";
import { retryTests } from "./retry.test.js";
import { lockingTests } from "./locking.test.js";

const allTests: Test[] = [...groundingTests, ...retryTests, ...lockingTests];

async function main() {
  let failures = 0;
  for (const test of allTests) {
    try {
      await test.run();
      console.log(`PASS  ${test.name}`);
    } catch (e) {
      failures += 1;
      console.log(`FAIL  ${test.name}`);
      console.error(`      ${(e as Error).message}`);
    }
  }
  console.log(`\n${allTests.length - failures}/${allTests.length} unit tests passed.`);
  if (failures > 0) process.exit(1);
}

main();
