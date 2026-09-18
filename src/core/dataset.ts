// RExtract - Flashback data extractor for the Atari ST
// Copyright (c) 2026 Neil Rackett
// SPDX-License-Identifier: MIT
//
// Which files the Atari ST port wants, what they are called when they
// get there, and which of the four disks a given image actually is.
//
// The selection rule is the same one tools/extract-data.sh applies in
// the port's own repository: everything in the disk's data/ and cine/
// directories, plus font8.spr from the root, flattened into one folder
// with uppercase GEMDOS names. The two have to agree, so if one changes
// the other needs the same change.

import { crc32 } from './crc32';
import { KNOWN_DISKS, REQUIRED_FILES, type KnownDisk } from './manifest';
import type { AmigaFile, AmigaVolume } from './amigados';

/**
 * REPLICANT.SPM is eight characters plus one. GEMDOS would truncate it
 * to REPLICAN.SPM silently, so the ST build was changed to ASK for the
 * short name (see the #ifdef ATARIST in the port's staticres.cpp) and
 * the extraction renames it to match. This is a named exception rather
 * than a truncation rule, because the two sides have to agree exactly.
 */
const RENAMES: Record<string, string> = {
	'REPLICANT.SPM': 'REPLICAN.SPM',
};

export function isWanted(path: string): boolean {
	const slash = path.lastIndexOf('/');
	if (slash < 0) {
		return path === 'font8.spr';
	}
	const dir = path.slice(0, slash);
	return dir === 'data' || dir === 'cine';
}

export function dataFileName(path: string): string {
	const base = path.slice(path.lastIndexOf('/') + 1).toUpperCase();
	return RENAMES[base] ?? base;
}

/** Does this name survive a GEMDOS volume unchanged? */
export function isGemdosName(name: string): boolean {
	return /^[A-Z0-9_-]{1,8}(\.[A-Z0-9_-]{1,3})?$/.test(name);
}

export interface Identification {
	/** 1 to 4, or null when nothing matched well enough to say. */
	disk: number | null;
	/** Share of the expected files that were found and checksummed right. */
	confidence: number;
	found: number;
	expected: number;
	/** Files the disk should carry and does not. */
	missing: string[];
	/** Files that are there but do not match the known checksum. */
	altered: string[];
}

function scoreAgainst(volume: AmigaVolume, known: KnownDisk): Identification {
	const byPath = new Map<string, AmigaFile>();
	for (const f of volume.files) {
		byPath.set(f.path, f);
	}
	const missing: string[] = [];
	const altered: string[] = [];
	let found = 0;
	for (const want of known.files) {
		const got = byPath.get(want.src);
		if (!got) {
			missing.push(want.out);
		} else if (got.size !== want.size || crc32(got.bytes) !== want.crc32) {
			altered.push(want.out);
		} else {
			found++;
		}
	}
	return {
		disk: known.disk,
		confidence: known.files.length ? found / known.files.length : 0,
		found,
		expected: known.files.length,
		missing,
		altered,
	};
}

/**
 * Identify by contents rather than by a checksum of the whole image.
 * A disk can be an ADF, an ADZ or an IPF, it can be a cracked release
 * with a different boot block, and it is still the same four disks
 * underneath - so what the tool recognises is the set of game files,
 * which also means a mismatch can name the file that is wrong.
 */
export function identifyDisk(volume: AmigaVolume): Identification {
	let best: Identification | null = null;
	for (const known of KNOWN_DISKS) {
		const score = scoreAgainst(volume, known);
		if (!best || score.confidence > best.confidence) {
			best = score;
		}
	}
	if (!best || best.confidence < 0.5) {
		return {
			disk: null,
			confidence: best ? best.confidence : 0,
			found: best ? best.found : 0,
			expected: best ? best.expected : 0,
			missing: [],
			altered: [],
		};
	}
	return best;
}

export interface SelectedFile {
	/** The name it takes in DATA/. */
	out: string;
	/** Where it came from on the Amiga disk, for reporting. */
	src: string;
	bytes: Uint8Array;
}

/** Everything on one disk that belongs in DATA/, already renamed. */
export function selectFiles(volume: AmigaVolume): SelectedFile[] {
	return volume.files
		.filter((f) => isWanted(f.path))
		.map((f) => ({ out: dataFileName(f.path), src: f.path, bytes: f.bytes }));
}

export interface ExtractedFile extends SelectedFile {
	/** Which supplied disk it came from, in drop order. */
	fromDisk: number;
}

export interface DataSet {
	files: ExtractedFile[];
	/** Names the port needs that no supplied disk provided. */
	missing: string[];
	/** Names two disks both carry, with different contents. */
	conflicts: string[];
	/** Names that would not survive a GEMDOS volume. */
	unsafeNames: string[];
	totalBytes: number;
}

export interface DiskContribution {
	label: number;
	files: SelectedFile[];
}

/**
 * Twenty of the files appear on more than one disk - the cinematics
 * shared between chapters, mostly - and on the original release every
 * copy is identical. Taking the first and checking the rest against it
 * means a disk that disagrees is reported rather than silently winning
 * because it happened to be dropped last.
 */
export function buildDataSet(disks: DiskContribution[], required: string[] = REQUIRED_FILES): DataSet {
	const chosen = new Map<string, ExtractedFile>();
	const conflicts = new Set<string>();
	for (const { label, files } of disks) {
		for (const file of files) {
			const have = chosen.get(file.out);
			if (!have) {
				chosen.set(file.out, { ...file, fromDisk: label });
			} else if (have.bytes.length !== file.bytes.length || crc32(have.bytes) !== crc32(file.bytes)) {
				conflicts.add(file.out);
			}
		}
	}
	const files = [...chosen.values()].sort((a, b) => (a.out < b.out ? -1 : 1));
	return {
		files,
		missing: required.filter((name) => !chosen.has(name)),
		conflicts: [...conflicts].sort(),
		unsafeNames: files.map((f) => f.out).filter((n) => !isGemdosName(n)),
		totalBytes: files.reduce((n, f) => n + f.bytes.length, 0),
	};
}
