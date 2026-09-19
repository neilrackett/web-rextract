// RExtract - Flashback data extractor for the Atari ST
// Copyright (c) 2026 Neil Rackett
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The download: a zip holding one DATA folder.
//
// Two folders, DATA and MUSIC, and nothing else. The port's own notes
// make the point that DATA/ should hold only what came off the disks,
// so that it can be compared against a fresh extraction - a stray
// readme in there would make that comparison lie. MUSIC is derived
// rather than copied, so it is kept apart.

import { zipSync, type Zippable } from 'fflate';
import type { ExtractedFile } from './dataset';

export interface ZipStream {
	out: string;
	bytes: Uint8Array;
}

export function buildZip(files: ExtractedFile[], music: ZipStream[] = []): Uint8Array {
	const entries: Zippable = {};
	for (const file of files) {
		entries[`DATA/${file.out}`] = file.bytes;
	}
	// MUSIC sits beside DATA, which is where the game looks for it.
	for (const track of music) {
		entries[`MUSIC/${track.out}`] = track.bytes;
	}
	// The game data is already compressed, so the default effort buys
	// very little for a noticeable wait on a phone.
	return zipSync(entries, { level: 1 });
}
