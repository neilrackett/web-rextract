// RExtract - Flashback data extractor for the Atari ST
// Copyright (c) 2026 Neil Rackett
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { buildZip } from '../src/core/zip';
import type { ExtractedFile } from '../src/core/dataset';

const file = (out: string, bytes: number[]): ExtractedFile => ({
	out,
	src: `data/${out.toLowerCase()}`,
	bytes: new Uint8Array(bytes),
	fromDisk: 1,
});

/**
 * The compression method of every entry, read out of the central
 * directory. Walked from the end-of-central-directory record rather
 * than by scanning for local headers, because that signature can occur
 * by chance inside entry data and a false match would make this lie.
 */
function methods(zip: Uint8Array): number[] {
	const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	let eocd = -1;
	for (let i = zip.length - 22; i >= 0; i--) {
		if (view.getUint32(i, true) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	expect(eocd, 'end of central directory').toBeGreaterThanOrEqual(0);
	const count = view.getUint16(eocd + 10, true);
	let at = view.getUint32(eocd + 16, true);
	const out: number[] = [];
	for (let n = 0; n < count; n++) {
		expect(view.getUint32(at, true), 'central directory entry').toBe(0x02014b50);
		out.push(view.getUint16(at + 10, true));
		at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
	}
	return out;
}

describe('the zip', () => {
	it('holds DATA and MUSIC, and nothing else', () => {
		const zip = buildZip([file('A.CMP', [1, 2, 3])], [{ out: 'JUNGLE.STM', bytes: new Uint8Array([4, 5]) }]);
		expect(Object.keys(unzipSync(zip)).sort()).toEqual(['DATA/A.CMP', 'MUSIC/JUNGLE.STM']);
	});

	it('stores every entry rather than deflating it', () => {
		// Windows' inflate rejects the dynamic Huffman block fflate
		// writes for a small file with nothing repeated in it - the
		// distance tree comes out empty, which zlib pads and fflate does
		// not. Explorer then cannot copy that file out of the archive at
		// all. Storing avoids the disagreement entirely, so an entry that
		// is deflated here is a regression.
		const zip = buildZip(
			[
				// Shaped like the palette that found the bug: 96 bytes,
				// no run repeated anywhere in it.
				file('LEVEL4_1.PAL', Array.from({ length: 96 }, (_, i) => (i * 37 + (i >> 3)) & 0xff)),
				file('BIG.CMP', Array.from({ length: 5000 }, (_, i) => i & 0x0f)),
			],
			[{ out: 'JUNGLE.STM', bytes: new Uint8Array(2000).fill(7) }],
		);
		expect(methods(zip)).toEqual([0, 0, 0]);
	});

	it('round-trips the bytes it was given', () => {
		const payload = Array.from({ length: 96 }, (_, i) => (i * 37) & 0xff);
		const back = unzipSync(buildZip([file('LEVEL4_1.PAL', payload)]));
		expect([...back['DATA/LEVEL4_1.PAL']]).toEqual(payload);
	});
});
