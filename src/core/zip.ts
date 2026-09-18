// RExtract - Flashback data extractor for the Atari ST
// Copyright (c) 2026 Neil Rackett
// SPDX-License-Identifier: BSD-2-Clause
//
// The download: a zip holding one DATA folder.
//
// Nothing else goes in it. The port's own notes make the point that
// DATA/ should hold only what came off the disks, so that it can be
// compared against a fresh extraction - a stray readme in there would
// make that comparison lie.

import { zipSync, type Zippable } from 'fflate';
import type { ExtractedFile } from './dataset';

export function buildZip(files: ExtractedFile[]): Uint8Array {
	const entries: Zippable = {};
	for (const file of files) {
		entries[`DATA/${file.out}`] = file.bytes;
	}
	// The game data is already compressed, so the default effort buys
	// very little for a noticeable wait on a phone.
	return zipSync(entries, { level: 1 });
}
