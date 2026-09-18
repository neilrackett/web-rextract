// RExtract - Flashback data extractor for the Atari ST
// Copyright (c) 2026 Neil Rackett
// SPDX-License-Identifier: MIT
//
// Test fixtures are real Flashback disk images, which are not in this
// repository and never will be. Point REXTRACT_FIXTURES at a directory
// holding disk1.adf .. disk4.adf (and optionally the matching .ipf
// files) to run the tests that need them; without it they skip, so a
// clone with no disks still passes.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const fixtureDir = process.env.REXTRACT_FIXTURES ?? '';

export function haveFixture(name: string): boolean {
	return fixtureDir !== '' && existsSync(join(fixtureDir, name));
}

export function fixture(name: string): Uint8Array {
	return new Uint8Array(readFileSync(join(fixtureDir, name)));
}
