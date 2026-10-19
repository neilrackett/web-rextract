// RExtract - Flashback data extractor for the Atari ST
// Copyright (c) 2026 Neil Rackett
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { container, unpackedFiles, unpackedStreams } from '../src/core/unpacked';
import type { ExtractedFile } from '../src/core/dataset';
import { noise, pack } from './bkpack';

const be32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const concat = (...parts: (Uint8Array | number[])[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
const file = (out: string, bytes: Uint8Array): ExtractedFile => ({ out, src: `data/${out.toLowerCase()}`, bytes, fromDisk: 1 });

/** The container the ST reads: RXU1, a count, the sizes, the streams. */
function read(bytes: Uint8Array): Uint8Array[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('RXU1');
	const count = view.getUint32(4);
	let at = 8 + 4 * count;
	const parts: Uint8Array[] = [];
	for (let i = 0; i < count; i++) {
		const size = view.getUint32(8 + 4 * i);
		parts.push(bytes.subarray(at, at + size));
		at += size;
	}
	// the ST refuses a file whose sizes do not add up to its length
	expect(at).toBe(bytes.length);
	return parts;
}

describe('UNPACKED', () => {
	const a = noise(700, 11);
	const b = Uint8Array.from({ length: 900 }, (_, i) => i % 50);

	it('unpacks a file that is one stream from end to end', () => {
		for (const name of ['PERSO.SPM', 'LEVEL1.SGD', 'LEVEL1.CT']) {
			expect(unpackedStreams(name, pack(a)), name).toEqual([a]);
		}
	});

	it('unpacks a stream behind a length', () => {
		const stream = pack(a);
		// what follows the stream is not part of it
		const bytes = concat(be32(stream.length), stream, [0, 0]);
		expect(unpackedStreams('LEVEL1.OBC', bytes)).toEqual([a]);
		expect(unpackedStreams('PRESENT.CMP', bytes)).toEqual([a]);
	});

	it('splits a cutscene into its polygons and its commands, stored or packed', () => {
		// a negative length is a stream stored as it is
		const packedFirst = concat(be32(pack(a).length), pack(a), be32(-b.length >>> 0), b);
		expect(unpackedStreams('INTRO.CMP', packedFirst)).toEqual([a, b]);
		const storedFirst = concat(be32(-a.length >>> 0), a, be32(pack(b).length), pack(b));
		expect(unpackedStreams('INTRO.CMP', storedFirst)).toEqual([a, b]);
	});

	it('leaves alone what the game keeps packed in memory, and the rest', () => {
		for (const name of ['LEVEL1.LEV', 'LEVEL1.MBK', 'LEVEL1.PAL', 'FONT8.SPR']) {
			expect(unpackedStreams(name, pack(a)), name).toBeNull();
		}
	});

	it('writes the container the ST reads', () => {
		const bytes = container([a, b]);
		expect(bytes.length).toBe(16 + a.length + b.length);
		expect(read(bytes)).toEqual([a, b]);
		expect(read(container([a]))).toEqual([a]);
	});

	it('names what will not unpack and leaves it out', () => {
		const corrupt = pack(a);
		corrupt[corrupt.length - 9] ^= 1;
		const set = unpackedFiles([
			file('PERSO.SPM', pack(a)),
			file('JUNKY.SPM', corrupt),
			file('LEVEL1.PAL', new Uint8Array(96)),
		]);
		expect(set.files.map((f) => f.out)).toEqual(['PERSO.SPM']);
		expect(read(set.files[0].bytes)).toEqual([a]);
		expect(set.failed).toEqual(['JUNKY.SPM']);
	});
});
