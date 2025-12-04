/**
 * Script to compile Helios contracts and output Plutus scripts
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { compileValidator, getHeliosSource } from "../src/compile.js";

async function main() {
  console.log("Compiling S-PAL Enforcer contract...");

  try {
    const compiled = await compileValidator();

    // Ensure output directory exists
    mkdirSync("plutus", { recursive: true });

    // Write compiled script
    const output = {
      type: "PlutusScriptV2",
      description: "S-PAL Enforcer validator",
      cborHex: compiled.cborHex,
      hash: compiled.hash,
    };

    writeFileSync("plutus/spal-enforcer.json", JSON.stringify(output, null, 2));
    console.log(`✓ Compiled to plutus/spal-enforcer.json`);
    console.log(`  Script hash: ${compiled.hash}`);

    // Also write the Helios source for reference
    writeFileSync("plutus/spal-enforcer.helios", getHeliosSource());
    console.log(`✓ Source saved to plutus/spal-enforcer.helios`);
  } catch (error) {
    console.error("Compilation failed:", error);
    process.exit(1);
  }
}

main();
