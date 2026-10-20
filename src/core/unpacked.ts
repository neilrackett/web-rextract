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
// What the game unpacks as a scene, the title or a level loads:
// cutscenes, the title picture, sprites, level graphics, objects and
// collision data. And what it unpacks on entering a room: the room data
// (.LEV, a stream per room) and the object and tile banks (.MBK, a
// stream per bank). The game keeps those two whole in memory, so it
// reads them from here only where it has the RAM to spare (a 4MB
// machine); elsewhere it unpacks DATA's as before, room by room.
//
// The port's tools/make-unpacked.py writes the same folder, and the two
// have to agree byte for byte. Each file keeps its DATA name and holds
//
//   "RXU1"         magic and version
//   BE32 count     streams: 2 for a cutscene (polygons, commands), 64 for
//                  room data (one per room, empty where a room has none),
//                  one per bank for banks (empty for an empty entry),
//                  else 1
//   BE32 size      one per stream
//   the streams    as the unpacker writes them
//
// and the ST checks the sizes add up before trusting any of it.

import { unpackBytekiller, unpackBytekillerSpan } from './bytekiller';
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
		case 'LEV': {
			// 64 rooms, each a BE32 offset to where its packed stream
			// ends; a room with no data here ends where the one before
			// it does (the first, where the table does)
			const parts: Uint8Array[] = [];
			let prev = 64 * 4;
			for (let room = 0; room < 64; room++) {
				const end = be32(bytes, room * 4);
				parts.push(end !== prev ? unpackBytekiller(bytes.subarray(0, end)) : new Uint8Array(0));
				prev = end;
			}
			return parts;
		}
		case 'MBK': {
			// 6-byte entries: a BE32 offset and a signed BE16 count of
			// 32-byte tiles - negative where the bank is stored as it is
			// (the offset is then its start), positive where packed (the
			// offset is where its stream ends), 0 for none. The table
			// runs up to where the first bank begins.
			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			const parts: Uint8Array[] = [];
			let first = bytes.length;
			for (let n = 0; 6 * (n + 1) <= first; n++) {
				const off = view.getUint32(n * 6);
				const count = view.getInt16(n * 6 + 4);
				if (count < 0) {
					parts.push(bytes.slice(off, off - count * 32));
					first = Math.min(first, off);
				} else if (count > 0) {
					const { out, start } = unpackBytekillerSpan(bytes.subarray(0, off));
					if (out.length !== count * 32) {
						throw new Error(`bank ${n} is ${out.length} bytes, not ${count * 32}`);
					}
					parts.push(out);
					first = Math.min(first, start);
				} else {
					parts.push(new Uint8Array(0));
				}
			}
			return parts;
		}
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
