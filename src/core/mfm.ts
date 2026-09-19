// RExtract - Flashback data extractor for the Atari ST
// Copyright (c) 2026 Neil Rackett
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Amiga MFM: pulling sectors out of a track's cell stream.
//
// Only the IPF path needs this. An ADF is already sectors; an IPF is
// the magnetic surface, and the 11 sectors have to be found in it.
//
// The layout of one sector, following the Amiga hardware reference
// manual. All the byte counts below are of ENCODED bytes, which are
// twice the size of what they carry, and one encoded byte is eight
// cells:
//
//   0x4489 0x4489   two sync words, already consumed when decode starts
//   8 bytes         info longword: 0xff, track, sector, sectors to gap
//   32 bytes        16-byte OS recovery label, normally zero
//   8 bytes         header checksum longword
//   8 bytes         data checksum longword
//   1024 bytes      the 512 bytes of payload
//
// Every field is stored as all its odd bits followed by all its even
// bits, so a field is contiguous in neither half on its own.

const SYNC = 0x44894489;

/** Encoded bytes from the end of the sync words to the end of a sector. */
const SECTOR_MFM_BYTES = 8 + 32 + 8 + 8 + 1024;

const OFF_INFO = 0;
const OFF_HEADER_SUM = 40;
const OFF_DATA_SUM = 48;
const OFF_DATA = 56;

export interface DecodedSector {
	/** Track byte from the sector's own header: cylinder * 2 + head. */
	track: number;
	sector: number;
	data: Uint8Array;
	headerOk: boolean;
	dataOk: boolean;
}

/** Read `count` bytes of cells from a circular bit stream. */
function readCells(bits: Uint8Array, bitCount: number, start: number, count: number): Uint8Array {
	const out = new Uint8Array(count);
	let pos = start;
	for (let i = 0; i < count; i++) {
		let v = 0;
		for (let b = 0; b < 8; b++) {
			if (pos >= bitCount) {
				pos -= bitCount;
			}
			v = (v << 1) | ((bits[pos >> 3] >> (7 - (pos & 7))) & 1);
			pos++;
		}
		out[i] = v;
	}
	return out;
}

/**
 * Undo the odd/even split. Masking with 0x55 keeps the data bits and
 * drops the clock bits, and the odd half shifts up one to sit between
 * the even half's bits.
 */
function mfmDecode(raw: Uint8Array, off: number, length: number): Uint8Array {
	const out = new Uint8Array(length);
	for (let i = 0; i < length; i++) {
		out[i] = (((raw[off + i] & 0x55) << 1) | (raw[off + length + i] & 0x55)) & 0xff;
	}
	return out;
}

/**
 * The checksum an Amiga computes: exclusive-or of the encoded
 * longwords, then the clock bits thrown away. The stored checksum was
 * encoded from exactly this value, so decoding it gives something
 * directly comparable.
 */
function mfmChecksum(raw: Uint8Array, off: number, length: number): number {
	let sum = 0;
	for (let i = 0; i < length; i += 4) {
		sum ^= ((raw[off + i] << 24) | (raw[off + i + 1] << 16) | (raw[off + i + 2] << 8) | raw[off + i + 3]) >>> 0;
	}
	return (sum & 0x55555555) >>> 0;
}

function u32(b: Uint8Array): number {
	return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
}

/**
 * Find and decode every sector in one track's cell stream.
 *
 * The stream is a whole revolution, so it is read as a circle: a sector
 * can begin near the end of the array and finish at the start of it.
 * Sectors are not written in numerical order either, which is why each
 * one is placed by the sector number in its own header rather than by
 * where it was found.
 */
export function decodeTrack(bits: Uint8Array, bitCount: number): DecodedSector[] {
	const sectors: DecodedSector[] = [];
	if (bitCount < SECTOR_MFM_BYTES * 8) {
		return sectors;
	}
	// One pass with a 32-bit window, wrapping far enough past the end to
	// catch a sync mark that straddles it.
	let window = 0;
	for (let i = 0; i < bitCount + 32; i++) {
		const pos = i >= bitCount ? i - bitCount : i;
		window = ((window << 1) | ((bits[pos >> 3] >> (7 - (pos & 7))) & 1)) >>> 0;
		if (window !== SYNC) {
			continue;
		}
		const start = pos + 1 >= bitCount ? 0 : pos + 1;
		const raw = readCells(bits, bitCount, start, SECTOR_MFM_BYTES);
		const info = mfmDecode(raw, OFF_INFO, 4);
		if (info[0] !== 0xff || info[2] > 10) {
			continue;
		}
		const headerOk = u32(mfmDecode(raw, OFF_HEADER_SUM, 4)) === mfmChecksum(raw, OFF_INFO, 40);
		const dataOk = u32(mfmDecode(raw, OFF_DATA_SUM, 4)) === mfmChecksum(raw, OFF_DATA, 1024);
		sectors.push({
			track: info[1],
			sector: info[2],
			data: mfmDecode(raw, OFF_DATA, 512),
			headerOk,
			dataOk,
		});
	}
	return sectors;
}
