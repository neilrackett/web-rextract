// RExtract - Flashback data extractor for the Atari ST
// Copyright (c) 2026 Neil Rackett
// SPDX-License-Identifier: BSD-2-Clause
//
// A read-only AmigaDOS walk: OFS and FFS, files and directories, no
// writing and no cache blocks.
//
// Block layout follows the ADF format description that ADFlib and
// amitools both implement. The offsets below are given as constants
// rather than inline numbers because the same ones recur in four block
// types and a wrong one is a silent misread rather than an error.

import {
	BLOCK_COUNT,
	SECTOR_SIZE,
	readI32,
	readU32,
	type DiskImage,
} from './image';

const ROOT_BLOCK = 880;

const T_HEADER = 2;
const T_LIST = 16;

const ST_ROOT = 1;
const ST_USERDIR = 2;
const ST_FILE = -3;

const OFF_HIGH_SEQ = 0x008;
const OFF_HT_SIZE = 0x00c;
const OFF_HASH_TABLE = 0x018;
const OFF_BYTE_SIZE = 0x144;
const OFF_NAME_LEN = 0x1b0;
const OFF_HASH_CHAIN = 0x1f0;
const OFF_EXTENSION = 0x1f8;
const OFF_SEC_TYPE = 0x1fc;

/** Data block pointers per header block: (512 / 4) - 56. */
const DATA_PTRS = 72;

/** An OFS data block spends 24 bytes on its own header. */
const OFS_DATA_OFFSET = 0x18;
const OFS_DATA_MAX = SECTOR_SIZE - OFS_DATA_OFFSET;
const OFF_OFS_DATA_SIZE = 0x00c;

export type Filesystem = 'OFS' | 'FFS';

export interface AmigaFile {
	/** Lower-cased path as it sits on the disk, e.g. `data/level1.mbk`. */
	path: string;
	/** The name with its original case, for reporting. */
	name: string;
	size: number;
	bytes: Uint8Array;
	/** Anything suspect about this one file, in plain words. */
	problems: string[];
}

export interface AmigaVolume {
	name: string;
	filesystem: Filesystem;
	international: boolean;
	dircache: boolean;
	files: AmigaFile[];
	warnings: string[];
}

export class FilesystemError extends Error {}

function block(image: DiskImage, n: number): Uint8Array {
	return image.bytes.subarray(n * SECTOR_SIZE, (n + 1) * SECTOR_SIZE);
}

function inRange(n: number): boolean {
	return Number.isInteger(n) && n >= 2 && n < BLOCK_COUNT;
}

/**
 * Every AmigaDOS header block carries a checksum over its own
 * longwords, which sum to zero when the block is intact. A dump with a
 * bad sector usually shows up here first, so it is worth checking even
 * though nothing depends on it.
 */
function checksumOk(b: Uint8Array): boolean {
	let sum = 0;
	for (let i = 0; i < SECTOR_SIZE; i += 4) {
		sum = (sum + readU32(b, i)) >>> 0;
	}
	return sum === 0;
}

/** Names are BCPL strings: a length byte and then the characters. */
function readName(b: Uint8Array): string {
	const len = Math.min(b[OFF_NAME_LEN], 30);
	let s = '';
	for (let i = 0; i < len; i++) {
		s += String.fromCharCode(b[OFF_NAME_LEN + 1 + i]);
	}
	return s;
}

export function isAmigaDos(image: DiskImage): boolean {
	const b = image.bytes;
	return b[0] === 0x44 && b[1] === 0x4f && b[2] === 0x53;
}

export function readVolume(image: DiskImage): AmigaVolume {
	if (!isAmigaDos(image)) {
		throw new FilesystemError(
			'the boot block does not say DOS, so this is not a standard AmigaDOS disk. ' +
				'A custom trackloader disk cannot be read by this tool.',
		);
	}
	const flags = image.bytes[3];
	const volume: AmigaVolume = {
		name: '',
		filesystem: flags & 1 ? 'FFS' : 'OFS',
		international: (flags & 2) !== 0,
		dircache: (flags & 4) !== 0,
		files: [],
		warnings: [],
	};

	if (!image.present[ROOT_BLOCK]) {
		throw new FilesystemError('the root block could not be read from this image.');
	}
	const root = block(image, ROOT_BLOCK);
	if (readU32(root, 0) !== T_HEADER || readI32(root, OFF_SEC_TYPE) !== ST_ROOT) {
		throw new FilesystemError('block 880 is not a root block, so the disk is not readable.');
	}
	if (!checksumOk(root)) {
		volume.warnings.push('the root block checksum is wrong; the image may be damaged');
	}
	volume.name = readName(root);

	// The root block states its own hash table size. Every disk in the
	// wild says 72, but a disk that says something absurd should not be
	// allowed to steer the walk off the end of the block.
	let htSize = readU32(root, OFF_HT_SIZE);
	if (htSize < 1 || htSize > DATA_PTRS) {
		htSize = DATA_PTRS;
	}

	// A hash chain that points back at a block already visited would
	// walk forever, and a deliberately malformed image is the likely
	// reason for one.
	const visited = new Set<number>([ROOT_BLOCK]);
	walkDirectory(image, volume, ROOT_BLOCK, htSize, '', visited, 0);
	volume.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return volume;
}

function walkDirectory(
	image: DiskImage,
	volume: AmigaVolume,
	dirBlock: number,
	htSize: number,
	prefix: string,
	visited: Set<number>,
	depth: number,
): void {
	if (depth > 16) {
		volume.warnings.push(`stopped at ${prefix}: directories nest deeper than 16 levels`);
		return;
	}
	const b = block(image, dirBlock);
	for (let i = 0; i < htSize; i++) {
		let entry = readU32(b, OFF_HASH_TABLE + i * 4);
		// Entries that hashed to the same slot are chained off each
		// other, so each slot is a list rather than a single block.
		while (entry !== 0) {
			if (!inRange(entry) || visited.has(entry)) {
				if (entry !== 0 && !visited.has(entry)) {
					volume.warnings.push(`ignored a directory entry pointing at block ${entry}`);
				}
				break;
			}
			visited.add(entry);
			if (!image.present[entry]) {
				volume.warnings.push(`a directory entry in ${prefix || 'the root'} is on an unreadable track`);
				break;
			}
			const eb = block(image, entry);
			const secType = readI32(eb, OFF_SEC_TYPE);
			const name = readName(eb);
			const path = prefix ? `${prefix}/${name}` : name;

			if (secType === ST_USERDIR) {
				walkDirectory(image, volume, entry, DATA_PTRS, path.toLowerCase(), visited, depth + 1);
			} else if (secType === ST_FILE) {
				volume.files.push(readFile(image, volume, entry, path));
			} else {
				// Links and anything else: the game data is plain files
				// and plain directories, so noting it is enough.
				volume.warnings.push(`skipped ${path}: not a plain file or directory`);
			}
			entry = readU32(eb, OFF_HASH_CHAIN);
		}
	}
}

function readFile(image: DiskImage, volume: AmigaVolume, headerBlock: number, path: string): AmigaFile {
	const header = block(image, headerBlock);
	const problems: string[] = [];
	if (!checksumOk(header)) {
		problems.push('the file header checksum is wrong');
	}
	const size = readU32(header, OFF_BYTE_SIZE);
	const bytes = new Uint8Array(size);

	// The pointer table is the authoritative list for both filesystems,
	// which is why the OFS next-data-block chain is not followed: one
	// code path reads both, and a file whose chain is broken but whose
	// table is intact still comes out.
	let written = 0;
	let listBlock = headerBlock;
	let listCount = 0;
	while (listBlock !== 0 && written < size) {
		if (!inRange(listBlock) || !image.present[listBlock]) {
			problems.push('part of the file is on an unreadable track');
			break;
		}
		if (++listCount > 64) {
			problems.push('the extension block chain does not end');
			break;
		}
		const lb = block(image, listBlock);
		const seq = readU32(lb, OFF_HIGH_SEQ);
		if (seq > DATA_PTRS) {
			problems.push('a header block claims more data blocks than it can hold');
			break;
		}
		for (let i = 0; i < seq && written < size; i++) {
			// The table is stored backwards: the first data block sits at
			// the far end of it and the last one at the start.
			const ptr = readU32(lb, OFF_HASH_TABLE + (DATA_PTRS - 1 - i) * 4);
			written += copyDataBlock(image, volume, ptr, bytes, written, problems);
		}
		const next = readU32(lb, OFF_EXTENSION);
		if (next !== 0 && (!inRange(next) || readU32(block(image, next), 0) !== T_LIST)) {
			problems.push('an extension block pointer is wrong');
			break;
		}
		listBlock = next;
	}

	if (written < size) {
		problems.push(`only ${written} of ${size} bytes could be read`);
	}
	return { path: path.toLowerCase(), name: path, size, bytes, problems };
}

function copyDataBlock(
	image: DiskImage,
	volume: AmigaVolume,
	ptr: number,
	out: Uint8Array,
	at: number,
	problems: string[],
): number {
	if (!inRange(ptr)) {
		problems.push('a data block pointer is outside the disk');
		return 0;
	}
	if (!image.present[ptr]) {
		problems.push('part of the file is on an unreadable track');
		return 0;
	}
	const db = block(image, ptr);
	const room = out.length - at;
	if (volume.filesystem === 'FFS') {
		const n = Math.min(SECTOR_SIZE, room);
		out.set(db.subarray(0, n), at);
		return n;
	}
	// OFS blocks carry their own payload length, which is how the last
	// block of a file is trimmed. Anything longer than the block can
	// hold means a corrupt header rather than a longer block.
	let n = readU32(db, OFF_OFS_DATA_SIZE);
	if (n > OFS_DATA_MAX) {
		problems.push('a data block claims more bytes than it holds');
		n = OFS_DATA_MAX;
	}
	n = Math.min(n, room);
	out.set(db.subarray(OFS_DATA_OFFSET, OFS_DATA_OFFSET + n), at);
	return n;
}
