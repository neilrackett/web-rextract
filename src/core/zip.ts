// RExtract - Flashback data extractor for the Atari ST
// Copyright (c) 2026 Neil Rackett
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The download: a zip holding a DATA folder and a MUSIC folder.
//
// Those two and nothing else. The port's own notes make the point that
// DATA/ should hold only what came off the disks, so that it can be
// compared against a fresh extraction - a stray readme in there would
// make that comparison lie. MUSIC is the score, not the game's data -
// the modules and the streams made from them - so it is kept apart.

import { zipSync, type Zippable } from 'fflate';
import type { ExtractedFile } from './dataset';

export interface ZipStream {
	out: string;
	bytes: Uint8Array;
}

/**
 * Nothing is compressed. Every entry is stored.
 *
 * This is not laziness, and it is worth the paragraph. When fflate
 * deflates a small file in which it finds no repeated run to point
 * back at, it writes a dynamic Huffman block whose DISTANCE tree is
 * empty - it declares one distance code and then gives it a length of
 * zero. zlib pads that tree with two dummy codes instead, precisely so
 * that the block stays valid for a strict reader. Windows' own inflate
 * is a strict reader: File Explorer refuses to copy such a file out of
 * an archive, reporting only "unspecified error 0x80004005", and the
 * file is unrecoverable through the built-in zip viewer.
 *
 * Two of the game's palettes land exactly on it - LEVEL4_1.PAL and
 * LEVEL4_2.PAL, 96 bytes each with nothing in them that repeats. It
 * was diagnosed by handing a Windows 11 machine four archives that
 * differed in one variable each: the one holding a STORED copy gave it
 * up, every deflated copy failed, and duplication and timestamps both
 * turned out to be red herrings.
 *
 * Storing sidesteps the whole class of decoder disagreement rather
 * than the one file that found it, and costs about 430KB on a 1.5MB
 * download - the game data is mostly compressed already, so deflate
 * was only buying 22%. A machine that cannot open the archive costs
 * rather more than that.
 */
const STORE = 0;

export function buildZip(files: ExtractedFile[], music: ZipStream[] = []): Uint8Array {
	const entries: Zippable = {};
	for (const file of files) {
		entries[`DATA/${file.out}`] = file.bytes;
	}
	// MUSIC sits beside DATA, which is where the game looks for it.
	for (const track of music) {
		entries[`MUSIC/${track.out}`] = track.bytes;
	}
	return zipSync(entries, { level: STORE });
}
