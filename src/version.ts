// Single source of truth for the installed stm version.
//
// Imported here (rather than in cli.ts) so other modules can read
// STM_VERSION without dragging the CLI command tree into their
// import graph. The CLI re-exports this for backward compatibility
// with the v0.7.3 wiring.

import pkg from "../package.json" with { type: "json" };

export const STM_VERSION: string = (pkg as { version: string }).version;
