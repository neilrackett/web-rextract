// RExtract - Flashback data extractor for the Atari ST
// Copyright (c) 2026 Neil Rackett
// SPDX-License-Identifier: MIT
//
// The one dull interface every input format decodes down to: an Amiga
// double-density disk as a flat run of 512-byte blocks.
//
// Everything downstream - the filesystem walk, the file selection, the
// zip - is written once against this, so adding a format means writing
// a reader and nothing else.

export const SECTOR_SIZE = 512;
export const SECTORS_PER_TRACK = 11;
export const HEADS = 2;
export const CYLINDERS = 80;
export const TRACK_COUNT = CYLINDERS * HEADS;
export const BLOCK_COUNT = TRACK_COUNT * SECTORS_PER_TRACK;
export const IMAGE_SIZE = BLOCK_COUNT * SECTOR_SIZE;

/** Where in the image a cylinder/head/sector lands. */
export function blockNumber(cylinder: number, head: number, sector: number): number {
	return (cylinder * HEADS + head) * SECTORS_PER_TRACK + sector;
}

export type ImageFormat = 'adf' | 'adz' | 'ipf';

export interface DiskImage {
	format: ImageFormat;
	bytes: Uint8Array;
	/**
	 * One flag per block, set when that block was actually recovered.
	 * An ADF is a sector dump so every block is present by definition;
	 * an IPF has to decode its tracks, and a copy-protection track that
	 * will not decode leaves holes. A hole only matters if the
	 * filesystem asks for it, which is why this is carried rather than
	 * treated as a failure.
	 */
	present: Uint8Array;
	warnings: string[];
}

export function emptyImage(format: ImageFormat): DiskImage {
	return {
		format,
		bytes: new Uint8Array(IMAGE_SIZE),
		present: new Uint8Array(BLOCK_COUNT),
		warnings: [],
	};
}

export class ImageError extends Error {}

export function readU32(b: Uint8Array, off: number): number {
	return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
}

export function readI32(b: Uint8Array, off: number): number {
	return readU32(b, off) | 0;
}

export function readU16(b: Uint8Array, off: number): number {
	return (b[off] << 8) | b[off + 1];
}
