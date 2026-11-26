import { main } from "@sparkwing/sdk";

await main();

import "./jobs/precheck.ts";

import "./jobs/gate.ts";

import "./jobs/test.ts";

import "./jobs/suite.ts";

import "./jobs/desktop-install.ts";

import "./jobs/upstream-contracts.ts";

import "./jobs/ci.ts";

import "./jobs/release.ts";
