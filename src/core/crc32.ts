// RExtract - Flashback data extractor for the Atari ST
// Copyright (c) 2026 Neil Rackett
// SPDX-License-Identifier: BSD-2-Clause
//
// CRC32 (the reversed, zlib/PKZIP polynomial) over a byte range.
//
// Used to check an extracted file against the manifest's recorded
// checksum. The IPF decoder carries its own copy of this because it is
// a line-by-line port of MAME's and is easier to trust when it does not
// reach outside itself.

let table: Uint32Array | null = null;

function crcTable(): Uint32Array {
	if (table) {
		return table;
	}
	const t = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let j = 0; j < 8; j++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		t[i] = c >>> 0;
	}
	table = t;
	return t;
}

export function crc32(data: Uint8Array): number {
	const t = crcTable();
	let crc = 0xffffffff;
	for (let i = 0; i < data.length; i++) {
		crc = t[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}
