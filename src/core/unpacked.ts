// RExtract - Flashback data extractor for the Atari ST
// Copyright (c) 2026 Neil Rackett
// SPDX-License-Identifier: GPL-3.0-or-later
//
// UNPACKED: the data's packed files with the unpacking already done.
//
// Most of the Amiga data is packed with bytekiller, and on an 8MHz ST
// unpacking it is most of the wait for a scene, the title or a level:
// 3.6s for Conrad's sprites, 1.2s before the intro, 2.3s at the start
// of level 1. The ST build reads these instead and falls back to DATA
// for anything not here, so the folder is optional - and DATA stays
// exactly what came off the disks, which an older build still needs.
//
// Only what the game unpacks as a scene, the title or a level loads:
// cutscenes, the title picture, sprites, level graphics, objects and
// collision data. Room data (.LEV) and sprite banks (.MBK) stay packed:
// the game keeps those whole in memory, and a 2.5MB machine cannot
// spare them unpacked.
//
// The port's tools/make-unpacked.py writes the same folder, and the two
// have to agree byte for byte. Each file keeps its DATA name and holds
//
//   "RXU1"         magic and version
//   BE32 count     streams: 2 for a cutscene (polygons, commands), else 1
//   BE32 size      one per stream
//   the streams    as the unpacker writes them
//
// and the ST checks the sizes add up before trusting any of it.

import { unpackBytekiller } from './bytekiller';
import type { ExtractedFile } from './dataset';
import type { ZipStream } from './zip';

export interface UnpackedSet {
	files: ZipStream[];
	/** DATA names that would not unpack; the ST unpacks those itself. */
	failed: string[];
}

const be32 = (b: Uint8Array, at: number): number =>
	new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at);

/** A length, then that many bytes of one packed stream. */
const prefixed = (bytes: Uint8Array): Uint8Array[] => [unpackBytekiller(bytes.subarray(4, 4 + be32(bytes, 0)))];

/**
 * The unpacked streams of one DATA file, or null for a file that has
 * no place in UNPACKED. Throws when a stream will not unpack.
 */
export function unpackedStreams(name: string, bytes: Uint8Array): Uint8Array[] | null {
	const ext = name.slice(name.lastIndexOf('.') + 1);
	if (name === 'PRESENT.CMP') {
		// the title picture, loaded as one stream rather than as a scene
		return prefixed(bytes);
	}
	switch (ext) {
		case 'CMP': {
			// A cutscene: the polygons, then the commands, each behind a
			// signed length - negative where the stream was stored as it
			// is rather than packed.
			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			const parts: Uint8Array[] = [];
			let at = 0;
			for (let i = 0; i < 2; i++) {
				const packed = view.getInt32(at);
				at += 4;
				if (packed < 0) {
					parts.push(bytes.slice(at, at - packed));
					at -= packed;
				} else {
					parts.push(unpackBytekiller(bytes.subarray(at, at + packed)));
					at += packed;
				}
			}
			return parts;
		}
		case 'OBC':
			return prefixed(bytes);
		case 'SPM':
		case 'SGD':
		case 'CT':
			return [unpackBytekiller(bytes)];
		default:
			return null;
	}
}

export function container(parts: Uint8Array[]): Uint8Array {
	const head = 8 + 4 * parts.length;
	const out = new Uint8Array(head + parts.reduce((n, p) => n + p.length, 0));
	const view = new DataView(out.buffer);
	out.set([0x52, 0x58, 0x55, 0x31]); // RXU1
	view.setUint32(4, parts.length);
	let at = head;
	parts.forEach((part, i) => {
		view.setUint32(8 + 4 * i, part.length);
		out.set(part, at);
		at += part.length;
	});
	return out;
}

export function unpackedFiles(files: ExtractedFile[]): UnpackedSet {
	const set: UnpackedSet = { files: [], failed: [] };
	for (const file of files) {
		try {
			const parts = unpackedStreams(file.out, file.bytes);
			if (parts) {
				set.files.push({ out: file.out, bytes: container(parts) });
			}
		} catch {
			set.failed.push(file.out);
		}
	}
	return set;
}
