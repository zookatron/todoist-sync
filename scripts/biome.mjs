#!/usr/bin/env node
/**
 * Runs Biome, picking an executable that actually works on this machine.
 *
 * Biome ships as a prebuilt, dynamically linked binary. That binary cannot run on NixOS
 * (no global dynamic loader), so on NixOS we fall back to `nix run nixpkgs#biome`.
 * Everywhere else — including CI — the npm-installed binary is used directly.
 *
 * Usage: node scripts/biome.mjs check --write .
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const args = process.argv.slice(2)

/** Resolve the npm-installed platform binary, if one was installed for this platform. */
function npmBiome() {
  const require = createRequire(import.meta.url)
  const pkg = `@biomejs/cli-${process.platform}-${process.arch}`
  try {
    // The package's main entry sits next to the binary.
    const binary = require.resolve(`${pkg}/biome`)
    return existsSync(binary) ? binary : null
  } catch {
    return null
  }
}

const isNixOS = existsSync('/etc/NIXOS')
const local = npmBiome()

const [command, commandArgs] =
  local && !isNixOS
    ? [local, args]
    : // `nix run` needs `--` to stop parsing our flags as its own.
      ['nix', ['run', 'nixpkgs#biome', '--', ...args]]

const result = spawnSync(command, commandArgs, { stdio: 'inherit' })

if (result.error) {
  console.error(`Failed to run Biome via "${command}": ${result.error.message}`)
  process.exit(1)
}

process.exit(result.status ?? 1)
