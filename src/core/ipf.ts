// IPF (SPS/CAPS disk image) decoding, ported from MAME's
// src/lib/formats/ipf_dsk.cpp.
//
// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) Olivier Galibert
// Copyright (c) 2026 Neil Rackett
//
// This one file is NOT under the project's GPL-3.0-or-later. It keeps
// MAME's licence, which is compatible with the GPL and so can be
// combined into this program - but its own terms travel with it, and
// it cannot be relicensed.
//
// MAME decodes an IPF into a flux-level track in which every MFM cell
// carries both a level and a duration, because the result feeds an
// emulated floppy controller that cares how long each cell lasts. All
// we want is the bits, so this port keeps everything that decides a
// cell's LEVEL (the tag scanner, the CRC, the block, data and gap
// generators) and drops everything that only decides its TIMING or its
// position relative to the index pulse: generate_timings, timing_set,
// rotate, mark_track_splice, generate_track_from_levels and the whole
// floppy_image class. Our consumer scans each track as a circular
// bitstream looking for sync marks, so index alignment is irrelevant,
// and the three cells MAME flips at the write splice would only be
// three wrong bits. Dropping the timing pass also means a track type
// MAME refuses (its 'default: return false') still decodes here, which
// is what a filesystem extractor wants.
//
// The internals keep MAME's snake_case names so the two can be read
// side by side; only the exported API is idiomatic TypeScript. Where
// MAME relies on uint32 wraparound and the wrapped value reaches a
// cell, the wrap is reproduced with '>>> 0'. Where the wrap could only
// ever let a malformed file slip past a bounds check, plain JavaScript
// arithmetic is used instead, which is never less strict than MAME.

export interface IpfTrackBits {
	cylinder: number;
	head: number;
	bitCount: number; // number of MFM cells in the track
	bits: Uint8Array; // packed MSB-first, ceil(bitCount / 8) bytes
}

export interface IpfImage {
	tracks: IpfTrackBits[]; // in the order the IMGE records defined them
	minCylinder: number;
	maxCylinder: number;
	minHead: number;
	maxHead: number;
	warnings: string[]; // tracks skipped, and why
}

export class IpfError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'IpfError';
	}
}

// The 12-byte CAPS tag that opens every IPF file: the tag name, its
// size (12) and its CRC. MAME checks it in identify(); we check it up
// front so a stray file gets a clear message rather than a CRC error
// about whatever its first twelve bytes happened to be.
const CAPS_SIGNATURE = [
	0x43, 0x41, 0x50, 0x53, 0x00, 0x00, 0x00, 0x0c, 0x1c, 0xd5, 0x73, 0xba,
];

export function isIpf(data: Uint8Array): boolean {
	if (data.length < CAPS_SIGNATURE.length) return false;
	for (let i = 0; i < CAPS_SIGNATURE.length; i++) {
		if (data[i] !== CAPS_SIGNATURE[i]) return false;
	}
	return true;
}

export function decodeIpf(data: Uint8Array): IpfImage {
	if (!isIpf(data)) {
		throw new IpfError('not an IPF file: the CAPS signature is missing');
	}

	// scan_one_tag zeroes each tag's four CRC bytes in place before it
	// computes the tag's CRC, so the buffer we decode from is modified.
	// The caller may still want its bytes intact (to save the file, or
	// to hand to another decoder), so we work on a private copy.
	const buf = data.slice();

	const dec = new IpfDecode();
	dec.parse(buf);

	return {
		tracks: dec.tracks,
		minCylinder: dec.min_cylinder,
		maxCylinder: dec.max_cylinder,
		minHead: dec.min_head,
		maxHead: dec.max_head,
		warnings: dec.warnings,
	};
}

// Cell levels while a track is being generated: one byte per cell.
// MAME ORs these with a cell time; we have no time, so they are just
// small integers. MG_N is a weak (noise) cell, which packs as 0.
const MG_0 = 0;
const MG_1 = 1;
const MG_N = 2;

// No real track comes anywhere near this many cells (a DD track at 2us
// per cell is about 100,000; ED is four times that). MAME allocates
// whatever block_compute_real_size adds up to, which a malformed file
// can push into gigabytes; we would rather skip such a track.
const MAX_TRACK_CELLS = 1 << 22;

interface TrackInfo {
	cylinder: number;
	head: number;
	type: number;
	sigtype: number;
	process: number;
	reserved: [number, number, number];
	size_bytes: number;
	size_cells: number;
	index_bytes: number;
	index_cells: number;
	datasize_cells: number;
	gapsize_cells: number;
	block_count: number;
	weak_bits: number;

	data_size_bits: number;

	info_set: boolean;

	// MAME keeps a pointer into the file for the track's DATA payload.
	// Here it is a view onto our private copy, so every offset used by
	// the block generators is relative to this view, and its length is
	// what MAME calls dlimit / data_end.
	data: Uint8Array | null;
	data_size: number;
}

function newTrackInfo(): TrackInfo {
	return {
		cylinder: 0,
		head: 0,
		type: 0,
		sigtype: 0,
		process: 0,
		reserved: [0, 0, 0],
		size_bytes: 0,
		size_cells: 0,
		index_bytes: 0,
		index_cells: 0,
		datasize_cells: 0,
		gapsize_cells: 0,
		block_count: 0,
		weak_bits: 0,
		data_size_bits: 0,
		info_set: false,
		data: null,
		data_size: 0,
	};
}

// C++ passes pointers by reference so a callee can advance the caller's
// read position (rb, gap_description_to_reserved_size and
// generate_gap_from_description all do). A one-field object is the
// closest thing TypeScript has to 'uint8_t *&data'.
interface Cursor {
	pos: number;
}

// Likewise for 'bool &context', the MFM clock state that must survive
// across every write to the track.
interface MfmContext {
	context: boolean;
}

function get_u32be(d: Uint8Array, p: number): number {
	return ((d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]) >>> 0;
}

// Reads a big-endian value of 'count' bytes. Descriptors can carry up
// to seven length bytes; MAME's uint32 keeps only the low four, and
// '<< 8' on a JavaScript int32 discards the same high bits.
function rb(d: Uint8Array, cur: Cursor, count: number): number {
	let v = 0;
	for (let i = 0; i < count; i++) v = ((v << 8) | d[cur.pos++]) >>> 0;
	return v;
}

function crc32r(d: Uint8Array, start: number, size: number): number {
	// Reversed crc32
	let crc = 0xffffffff;
	for (let i = 0; i !== size; i++) {
		crc = (crc ^ d[start + i]) >>> 0;
		for (let j = 0; j < 8; j++) {
			if (crc & 1) crc = ((crc >>> 1) ^ 0xedb88320) >>> 0;
			else crc = crc >>> 1;
		}
	}
	return ~crc >>> 0;
}

function track_write_raw(
	track: Uint8Array,
	tpos: number,
	d: Uint8Array,
	dp: number,
	cells: number,
	ctx: MfmContext,
): number {
	for (let i = 0; i !== cells; i++) {
		track[tpos++] = d[dp + (i >> 3)] & (0x80 >> (i & 7)) ? MG_1 : MG_0;
	}
	if (cells) ctx.context = track[tpos - 1] === MG_1;
	return tpos;
}

// Encodes 'cells' MFM cells from a pattern of 'patlen' data bits,
// starting at cell start_offset within the doubled pattern. Odd cells
// are data bits; even cells are clock bits, which are 1 only when both
// neighbouring data bits are 0.
//
// start_offset is a uint32 in MAME and two callers pass it a negative
// number (-block_size, and spos+delta-gap_cells) so that a backwards
// gap pattern ends aligned with the end of the gap. The C++ wraps the
// sum modulo 2^32 and only then takes '% patlen'; a JavaScript '%' on
// a negative operand would give a negative index. Callers convert
// their offset with '>>> 0' and the sum is wrapped here the same way.
// Note this is only a true 'negative modulo' when patlen divides 2^32
// (patlen is a power of two); for any other patlen it is what MAME
// computes, which is what we want to match.
function track_write_mfm(
	track: Uint8Array,
	tpos: number,
	d: Uint8Array,
	dp: number,
	start_offset: number,
	patlen: number,
	cells: number,
	ctx: MfmContext,
): number {
	patlen *= 2;
	for (let i = 0; i !== cells; i++) {
		const pos = ((i + start_offset) >>> 0) % patlen;
		const bit = (d[dp + (pos >> 4)] & (0x80 >> ((pos >> 1) & 7))) !== 0;
		if (pos & 1) {
			track[tpos++] = bit ? MG_1 : MG_0;
			ctx.context = bit;
		} else {
			track[tpos++] = ctx.context || bit ? MG_0 : MG_1;
		}
	}
	return tpos;
}

function track_write_weak(track: Uint8Array, tpos: number, cells: number): number {
	for (let i = 0; i !== cells; i++) track[tpos++] = MG_N;
	return tpos;
}

// Walks a block's data stream, a sequence of (type, length, payload)
// descriptors, writing cells from tpos up to (and exactly to) tlimit.
// In C++ tpos is an iterator passed by value, so the caller never sees
// how far it advanced; here it is a local index for the same reason.
function generate_block_data(
	d: Uint8Array,
	dp: number,
	dlimit: number,
	track: Uint8Array,
	tpos: number,
	tlimit: number,
	dmb: boolean,
	raw: boolean,
	ctx: MfmContext,
): boolean {
	const cur: Cursor = { pos: dp };
	for (;;) {
		if (cur.pos >= dlimit) return false;
		const val = d[cur.pos++];
		if (val >> 5 > dlimit - cur.pos) return false;
		const param = rb(d, cur, val >> 5);
		const tleft = tlimit - tpos;
		let bitcount = dmb ? param : param * 8;
		let bytecount = Math.floor((bitcount + 7) / 8);
		switch (val & 0x1f) {
			case 0: // End of description
				return tleft === 0;

			case 1: // Sync mark, unencoded cells
				if (raw) return false;
				if (bitcount > tleft || bytecount > dlimit - cur.pos) return false;
				tpos = track_write_raw(track, tpos, d, cur.pos, bitcount, ctx);
				cur.pos += bytecount;
				break;

			case 2: // MFM-decoded data bytes
			case 3: // MFM-decoded gap bytes
				if (raw) return false;
				if (2 * bitcount > tleft || bytecount > dlimit - cur.pos) return false;
				tpos = track_write_mfm(track, tpos, d, cur.pos, 0, bitcount, 2 * bitcount, ctx);
				cur.pos += bytecount;
				break;

			case 4: // Raw cell bits, size in bytes regardless of the data size mode
				if (!raw) return false;
				bitcount = param * 8;
				bytecount = param;
				if (bitcount > tleft || bytecount > dlimit - cur.pos) return false;
				tpos = track_write_raw(track, tpos, d, cur.pos, bitcount, ctx);
				cur.pos += bytecount;
				break;

			case 5: // Weak bytes
				if (raw) return false;
				if (2 * bitcount > tleft) return false;
				tpos = track_write_weak(track, tpos, 2 * bitcount);
				ctx.context = false;
				break;

			default:
				return false;
		}
	}
}

// Gap type 0: a single 8-bit pattern (usually 0x4E) repeated forwards
// up to the splice and backwards from the end of the gap to meet it.
// MAME takes the pattern as a uint8_t, so the caller has already kept
// only the low byte of the 32-bit field.
function generate_block_gap_0(
	track: Uint8Array,
	tpos: number,
	gap_cells: number,
	pattern: number,
	ipos: number,
	ctx: MfmContext,
): boolean {
	const pat = Uint8Array.of(pattern);
	// MAME computes 'ipos+16' in uint32. For a block that is not the
	// last one ipos arrives as 0xffffffff minus a small number, and if
	// that number is under 16 the sum wraps to something tiny, the test
	// passes and MAME writes four billion cells past its buffer. Plain
	// arithmetic here gives the comparison its evident intent.
	const spos = ipos >= 16 && ipos + 16 <= gap_cells ? ipos : gap_cells >> 1;
	tpos = track_write_mfm(track, tpos, pat, 0, 0, 8, spos, ctx);
	let delta = 0;
	if (gap_cells & 1) {
		track[tpos++] = MG_0;
		delta++;
	}
	track_write_mfm(
		track,
		tpos,
		pat,
		0,
		(spos + delta - gap_cells) >>> 0,
		8,
		gap_cells - spos - delta,
		ctx,
	);
	return true;
}

// First pass over a gap description: adds up the cells the explicit
// length descriptors reserve and validates the stream, so that the
// second pass can read it without bounds checks. Returns null where
// MAME returns false.
function gap_description_to_reserved_size(
	d: Uint8Array,
	cur: Cursor,
	dlimit: number,
): number | null {
	let res_size = 0;
	for (;;) {
		if (cur.pos >= dlimit) return null;
		const val = d[cur.pos++];
		if (val >> 5 > dlimit - cur.pos) return null;
		const param = rb(d, cur, val >> 5);
		switch (val & 0x1f) {
			case 0:
				return res_size;
			case 1:
				res_size = (res_size + param * 2) >>> 0;
				break;
			case 2:
				cur.pos += Math.floor((param + 7) / 8);
				break;
			default:
				return null;
		}
	}
}

// Fills 'size' cells from a gap description of alternating length
// (type 1) and pattern (type 2) descriptors. A forward ('pre') stream
// is anchored at the start of the gap and its last pattern loops to
// fill whatever is left; a backward stream is anchored at the end and
// its first pattern absorbs the slack. The cursor is advanced past the
// description, which generate_block_gap_3 relies on to find the second
// of its two streams.
function generate_gap_from_description(
	d: Uint8Array,
	cur: Cursor,
	dlimit: number,
	track: Uint8Array,
	tpos: number,
	size: number,
	pre: boolean,
	ctx: MfmContext,
): boolean {
	const cur1: Cursor = { pos: cur.pos };
	const res_size = gap_description_to_reserved_size(d, cur1, dlimit);
	if (res_size === null) return false;

	if (res_size > size) return false;
	// Sixteen bytes, never cleared between patterns: a short pattern
	// reuses whatever the previous one left in the high bytes, exactly
	// as MAME's stack array does. It cannot matter, since a pattern is
	// only ever indexed within its own length.
	const pattern = new Uint8Array(16);
	let pattern_size = 0;

	let pos = 0;
	let block_size = 0;
	for (;;) {
		const val = d[cur.pos++];
		const param = rb(d, cur, val >> 5);
		switch (val & 0x1f) {
			case 0:
				return size === pos;

			case 1:
				if (block_size) return false;
				block_size = (param * 2) >>> 0;
				pattern_size = 0;
				break;

			case 2: {
				pattern_size = param;
				if (pattern_size > pattern.length * 8) return false;

				const nbytes = Math.floor((pattern_size + 7) / 8);
				pattern.set(d.subarray(cur.pos, cur.pos + nbytes));
				cur.pos += nbytes;
				if (pre) {
					// The last data sample of a forward gap stream is the loop point
					if (cur.pos < dlimit && !(d[cur.pos] & 0x1f)) block_size = size - pos;
					else if (!block_size) block_size = pattern_size;
					if (pos + block_size > size) return false;
					// A zero-length pattern asked to fill cells would make
					// track_write_mfm take '% 0'; MAME divides by zero here.
					if (!pattern_size && block_size) return false;
					tpos = track_write_mfm(track, tpos, pattern, 0, 0, pattern_size, block_size, ctx);
					pos += block_size;
				} else {
					if (pos === 0 && block_size && res_size !== size) {
						block_size = (size - (res_size - block_size)) >>> 0;
					}
					if (!block_size) block_size = size - res_size;
					if (pos + block_size > size) return false;
					if (!pattern_size && block_size) return false;
					// -block_size as a uint32, see track_write_mfm.
					tpos = track_write_mfm(
						track,
						tpos,
						pattern,
						0,
						-block_size >>> 0,
						pattern_size,
						block_size,
						ctx,
					);
					pos += block_size;
				}
				block_size = 0;
				break;
			}
		}
	}
}

// Gap types 1 and 2 are a single forward or backward stream. MAME also
// picks a splice position here (spos), but it only feeds
// mark_track_splice and rotate, which we do not do, so it is dropped.
function generate_block_gap_1(
	d: Uint8Array,
	cur: Cursor,
	dlimit: number,
	track: Uint8Array,
	tpos: number,
	gap_cells: number,
	ctx: MfmContext,
): boolean {
	return generate_gap_from_description(d, cur, dlimit, track, tpos, gap_cells, true, ctx);
}

function generate_block_gap_2(
	d: Uint8Array,
	cur: Cursor,
	dlimit: number,
	track: Uint8Array,
	tpos: number,
	gap_cells: number,
	ctx: MfmContext,
): boolean {
	return generate_gap_from_description(d, cur, dlimit, track, tpos, gap_cells, false, ctx);
}

// Gap type 3: a forward stream then a backward stream, meeting at the
// splice. Here spos does decide cell values, because it is where the
// two streams meet, so this one keeps MAME's calculation in full.
function generate_block_gap_3(
	d: Uint8Array,
	cur: Cursor,
	dlimit: number,
	track: Uint8Array,
	tpos: number,
	gap_cells: number,
	ipos: number,
	ctx: MfmContext,
): boolean {
	const cur1: Cursor = { pos: cur.pos };
	let presize = gap_description_to_reserved_size(d, cur1, dlimit);
	if (presize === null) return false;
	let postsize = gap_description_to_reserved_size(d, cur1, dlimit);
	if (postsize === null) return false;

	const delta = gap_cells & 1;
	const usable = gap_cells - delta;

	if (presize + postsize > usable) {
		// Trim both gap streams evenly like the reference decoder
		const rem = presize + postsize - usable;
		let rem0 = rem >>> 1;
		let rem1 = rem - rem0;
		if (presize < rem0) {
			rem1 += rem0 - presize;
			rem0 = presize;
		}
		if (postsize < rem1) {
			rem0 += rem1 - postsize;
			rem1 = postsize;
		}
		presize -= rem0;
		postsize -= rem1;
	}

	let spos: number;
	// 'gap_cells-16' is uint32 in MAME, so a gap under 16 cells makes
	// the upper bound wrap and any ipos >= 16 is taken as inside it. The
	// clamps below keep spos in range either way, but the resulting
	// split differs from the 'else' branch, so the wrap is kept to
	// produce the same cells as MAME.
	if (ipos >= 16 && ipos < (gap_cells - 16) >>> 0) {
		// Keep the index splice within the region the descriptions can fill
		spos = ipos;
		if (spos < presize) spos = presize;
		if (spos > usable - postsize) spos = usable - postsize;
	} else {
		spos = presize + ((usable - presize - postsize) >>> 1);
	}

	if (!generate_gap_from_description(d, cur, dlimit, track, tpos, spos, true, ctx)) {
		return false;
	}
	if (delta) track[tpos + spos] = MG_0;

	return generate_gap_from_description(
		d,
		cur,
		dlimit,
		track,
		tpos + spos + delta,
		gap_cells - spos - delta,
		false,
		ctx,
	);
}

function generate_block_gap(
	gap_type: number,
	gap_cells: number,
	pattern: number,
	ipos: number,
	d: Uint8Array,
	gp: number,
	dlimit: number,
	track: Uint8Array,
	tpos: number,
	ctx: MfmContext,
): boolean {
	const cur: Cursor = { pos: gp };
	switch (gap_type) {
		case 0:
			return generate_block_gap_0(track, tpos, gap_cells, pattern, ipos, ctx);
		case 1:
			return generate_block_gap_1(d, cur, dlimit, track, tpos, gap_cells, ctx);
		case 2:
			return generate_block_gap_2(d, cur, dlimit, track, tpos, gap_cells, ctx);
		case 3:
			return generate_block_gap_3(d, cur, dlimit, track, tpos, gap_cells, ipos, ctx);
		default:
			return false;
	}
}

class IpfDecode {
	tinfos: TrackInfo[] = [];
	tcount = 0;

	type = 0;
	release = 0;
	revision = 0;
	encoder_type = 0;
	encoder_revision = 0;
	origin = 0;
	min_cylinder = 0;
	max_cylinder = 0;
	min_head = 0;
	max_head = 0;
	credit_day = 0;
	credit_time = 0;
	platform = [0, 0, 0, 0];
	extra = [0, 0, 0, 0, 0];

	// What generate_track_from_levels would have handed to floppy_image,
	// plus the reasons for any track it did not.
	tracks: IpfTrackBits[] = [];
	warnings: string[] = [];

	parse(data: Uint8Array): void {
		this.tcount = 84 * 2 + 1; // Usual max
		this.tinfos = [];
		for (let i = 0; i < this.tcount; i++) this.tinfos.push(newTrackInfo());
		this.scan_all_tags(data);
		this.generate_tracks();
		this.tinfos = [];
	}

	// The parse_* and scan_* methods throw where MAME returns false: a
	// bad tag, CRC or INFO record means we cannot trust anything that
	// follows it, so the whole file is rejected, as in MAME.
	parse_info(data: Uint8Array, info: number): void {
		this.type = get_u32be(data, info + 12);
		if (this.type !== 1) {
			throw new IpfError(`INFO record at byte ${info}: unsupported image type ${this.type}`);
		}
		this.encoder_type = get_u32be(data, info + 16); // 1 for CAPS, 2 for SPS
		if (this.encoder_type !== 1 && this.encoder_type !== 2) {
			throw new IpfError(
				`INFO record at byte ${info}: unsupported encoder type ${this.encoder_type}`,
			);
		}
		this.encoder_revision = get_u32be(data, info + 20);
		if (this.encoder_revision !== 1) {
			// Only SPS_ENCODER revision 1 is defined/supported
			throw new IpfError(
				`INFO record at byte ${info}: unsupported encoder revision ${this.encoder_revision}`,
			);
		}
		this.release = get_u32be(data, info + 24);
		this.revision = get_u32be(data, info + 28);
		this.origin = get_u32be(data, info + 32); // Original source reference
		this.min_cylinder = get_u32be(data, info + 36);
		this.max_cylinder = get_u32be(data, info + 40);
		this.min_head = get_u32be(data, info + 44);
		this.max_head = get_u32be(data, info + 48);
		this.credit_day = get_u32be(data, info + 52); // year*1e4 + month*1e2 + day
		this.credit_time = get_u32be(data, info + 56); // hour*1e7 + min*1e5 + sec*1e3 + msec
		for (let i = 0; i < 4; i++) this.platform[i] = get_u32be(data, info + 60 + 4 * i);
		for (let i = 0; i < 5; i++) this.extra[i] = get_u32be(data, info + 76 + 4 * i);
	}

	get_index(idx: number): TrackInfo | null {
		if (idx > 1000) return null;
		if (idx >= this.tcount) {
			while (this.tinfos.length < idx + 1) this.tinfos.push(newTrackInfo());
			this.tcount = idx + 1;
		}

		return this.tinfos[idx];
	}

	parse_imge(data: Uint8Array, imge: number): void {
		const idx = get_u32be(data, imge + 64);
		const t = this.get_index(idx);
		if (!t) throw new IpfError(`IMGE record at byte ${imge}: track index ${idx} out of range`);

		t.info_set = true;

		t.cylinder = get_u32be(data, imge + 12);
		if (t.cylinder < this.min_cylinder || t.cylinder > this.max_cylinder) {
			throw new IpfError(`IMGE record at byte ${imge}: cylinder ${t.cylinder} out of range`);
		}

		t.head = get_u32be(data, imge + 16);
		if (t.head < this.min_head || t.head > this.max_head) {
			throw new IpfError(`IMGE record at byte ${imge}: head ${t.head} out of range`);
		}

		t.type = get_u32be(data, imge + 20);
		t.sigtype = get_u32be(data, imge + 24); // 1 for 2us cells, no other value valid
		if (t.sigtype !== 1) {
			throw new IpfError(`IMGE record at byte ${imge}: unsupported signal type ${t.sigtype}`);
		}
		t.size_bytes = get_u32be(data, imge + 28);
		t.index_bytes = get_u32be(data, imge + 32);
		t.index_cells = get_u32be(data, imge + 36);
		t.datasize_cells = get_u32be(data, imge + 40);
		t.gapsize_cells = get_u32be(data, imge + 44);
		t.size_cells = get_u32be(data, imge + 48);
		t.block_count = get_u32be(data, imge + 52);
		t.process = get_u32be(data, imge + 56); // encoder process, always 0
		if (t.process !== 0) {
			throw new IpfError(`IMGE record at byte ${imge}: unsupported encoder process ${t.process}`);
		}
		t.weak_bits = get_u32be(data, imge + 60);
		t.reserved[0] = get_u32be(data, imge + 68);
		t.reserved[1] = get_u32be(data, imge + 72);
		t.reserved[2] = get_u32be(data, imge + 76);
	}

	// A DATA tag is followed by its payload, which is not part of the
	// tag's own size; the payload is validated by its own CRC and the
	// scan position is moved past it. Returns the new position.
	parse_data(data: Uint8Array, tag: number, pos: number, max_extra_size: number): number {
		const idx = get_u32be(data, tag + 24);
		const t = this.get_index(idx);
		if (!t) throw new IpfError(`DATA record at byte ${tag}: track index ${idx} out of range`);

		t.data_size_bits = get_u32be(data, tag + 16);
		t.data_size = get_u32be(data, tag + 12);
		if (t.data_size > max_extra_size) {
			throw new IpfError(
				`DATA record at byte ${tag}: payload of ${t.data_size} bytes runs past end of file`,
			);
		}
		t.data = data.subarray(tag + 28, tag + 28 + t.data_size);
		if (crc32r(t.data, 0, t.data_size) !== get_u32be(data, tag + 20)) {
			throw new IpfError(`DATA record at byte ${tag}: payload CRC mismatch`);
		}
		return pos + t.data_size;
	}

	scan_one_tag(data: Uint8Array, pos: number): { tag: number; tsize: number; pos: number } {
		const size = data.length;
		if (size - pos < 12) {
			throw new IpfError(`truncated tag header at byte ${pos}`);
		}
		const tag = pos;
		const tsize = get_u32be(data, tag + 4);
		if (tsize < 12) {
			// Every tag has at least a 12-byte header; a smaller size would
			// stall scan_all_tags' loop forever
			throw new IpfError(`tag at byte ${pos}: impossible size ${tsize}`);
		}
		if (size - pos < tsize) {
			throw new IpfError(`tag at byte ${pos}: size ${tsize} runs past end of file`);
		}
		const crc = get_u32be(data, tag + 8);
		data[tag + 8] = data[tag + 9] = data[tag + 10] = data[tag + 11] = 0;
		if (crc32r(data, tag, tsize) !== crc) {
			throw new IpfError(`tag at byte ${pos}: CRC mismatch`);
		}
		return { tag, tsize, pos: pos + tsize };
	}

	scan_all_tags(data: Uint8Array): void {
		const size = data.length;
		let pos = 0;
		while (pos !== size) {
			const scanned = this.scan_one_tag(data, pos);
			const tag = scanned.tag;
			const tsize = scanned.tsize;
			pos = scanned.pos;

			switch (get_u32be(data, tag)) {
				case 0x43415053: // CAPS
					if (tsize !== 12) throw new IpfError(`CAPS record at byte ${tag}: bad size ${tsize}`);
					break;

				case 0x494e464f: // INFO
					if (tsize !== 96) throw new IpfError(`INFO record at byte ${tag}: bad size ${tsize}`);
					this.parse_info(data, tag);
					break;

				case 0x494d4745: // IMGE
					if (tsize !== 80) throw new IpfError(`IMGE record at byte ${tag}: bad size ${tsize}`);
					this.parse_imge(data, tag);
					break;

				case 0x44415441: // DATA
					if (tsize !== 28) throw new IpfError(`DATA record at byte ${tag}: bad size ${tsize}`);
					pos = this.parse_data(data, tag, pos, size - pos);
					break;

				default:
					// Unknown tags (e.g. TRCK, CTEX, CTEI) carry no data needed
					// for decoding and are safe to skip.
					break;
			}
		}
	}

	// This is the one behavioural change from MAME that matters. MAME
	// fails the whole image when any track fails to generate, or when
	// an IMGE record has no DATA record or vice versa. Copy-protection
	// tracks routinely fail to decode, and the files we are after are
	// never on them, so a bad track is reported and skipped and the
	// rest of the disk is still returned.
	generate_tracks(): void {
		for (let i = 0; i !== this.tcount; i++) {
			const t = this.tinfos[i];
			if (t.info_set && t.data) {
				const err = this.generate_track(t, t.data);
				if (err !== null) {
					this.warnings.push(
						`track ${t.cylinder}/${t.head} (index ${i}) skipped: ${err}`,
					);
				}
			} else if (t.info_set) {
				this.warnings.push(
					`track ${t.cylinder}/${t.head} (index ${i}) skipped: IMGE record has no DATA record`,
				);
			} else if (t.data) {
				this.warnings.push(`track index ${i} skipped: DATA record has no IMGE record`);
			}
		}
	}

	// Returns null on success, or the reason the track was skipped. The
	// generated track goes straight onto this.tracks, packed, in place of
	// MAME's generate_track_from_levels call.
	generate_track(t: TrackInfo, data: Uint8Array): string | null {
		if (!t.size_cells) return null;

		if (t.type === 1) {
			// Noise/unformatted track: MAME emits a single MG_N cell as long
			// as the whole track, because the surface has no cell structure.
			// We have nothing to pack, so it is a track with no bits.
			this.tracks.push({
				cylinder: t.cylinder,
				head: t.head,
				bitCount: 0,
				bits: new Uint8Array(0),
			});
			return null;
		}

		if (t.data_size < 32 * t.block_count) {
			return `block table of ${t.block_count} blocks does not fit in ${t.data_size} data bytes`;
		}

		// Annoyingly enough, too small gaps are ignored, changing the
		// total track size.  Artifact stemming from the byte-only support
		// of old times?
		t.size_cells = this.block_compute_real_size(t, data);

		if (t.index_cells >= t.size_cells) {
			return `index position ${t.index_cells} is beyond the track's ${t.size_cells} cells`;
		}
		if (t.size_cells > MAX_TRACK_CELLS) {
			return `track claims ${t.size_cells} cells`;
		}

		const track = new Uint8Array(t.size_cells);

		// MAME also collects data_pos, gap_pos and splice_pos per block for
		// generate_timings, mark_track_splice and rotate; none of those run
		// here, so only the running position is kept.
		const ctx: MfmContext = { context: false };
		let pos = 0;
		for (let i = 0; i !== t.block_count; i++) {
			const next = this.generate_block(
				t,
				data,
				i,
				i === t.block_count - 1 ? t.size_cells - t.index_cells : 0xffffffff,
				track,
				pos,
				ctx,
			);
			if (next === null) return `block ${i} of ${t.block_count} failed to decode`;
			pos = next;
		}
		if (pos !== t.size_cells || t.index_cells >= t.size_cells) {
			return `blocks produced ${pos} cells for a ${t.size_cells}-cell track`;
		}

		// Pack MSB-first. A weak cell (MG_N) becomes 0: weak bits only
		// occur in copy-protection tracks, which carry no filesystem data,
		// and a consumer that needs to know about them has the warnings.
		const bits = new Uint8Array((t.size_cells + 7) >> 3);
		for (let i = 0; i < t.size_cells; i++) {
			if (track[i] === MG_1) bits[i >> 3] |= 0x80 >> (i & 7);
		}
		this.tracks.push({
			cylinder: t.cylinder,
			head: t.head,
			bitCount: t.size_cells,
			bits,
		});

		return null;
	}

	// Generates block idx's data cells then its gap cells, starting at
	// pos. Returns the position after the gap, or null on failure. MAME
	// also returns the block's data, gap and splice positions through
	// reference parameters; see generate_track for why they are dropped.
	generate_block(
		t: TrackInfo,
		data: Uint8Array,
		idx: number,
		ipos: number,
		track: Uint8Array,
		pos: number,
		ctx: MfmContext,
	): number | null {
		const data_end = t.data_size;
		const thead = 32 * idx;
		const data_cells = get_u32be(data, thead);
		let gap_cells = get_u32be(data, thead + 4);

		if (gap_cells < 8) gap_cells = 0;
		// +8  = gap description offset / datasize in bytes (when gap type = 0)
		//       -- old CAPS_ENCODER (v1): 'blocksize', unused, rounded duplicate of data_cells
		// +12 =                      1 / gap size in bytes (when gap type = 0)
		//       -- old CAPS_ENCODER (v1): 'gapsize', unused, rounded duplicate of gap_cells
		// +16 = block encoder type: 1 = MFM, 2 = raw cells (no encoding)
		// +20 = flags: bits 0-1 = gap type, bit 2 = data size mode (DMB, bits vs bytes)
		// +24 = type 0 gap pattern (8 bits) / speed mask for sector 0 track type 9
		// +28 = data description offset

		const encoder = get_u32be(data, thead + 16);
		if (encoder !== 1 && encoder !== 2) return null;
		const raw = encoder === 2;

		const flags = this.encoder_type === 1 ? 0 : get_u32be(data, thead + 20);
		const gap_type = flags & 3;
		const dmb = (flags & 4) !== 0;

		const dpos = pos;
		const gpos = dpos + data_cells;
		pos = gpos + gap_cells;
		if (pos > t.size_cells) return null;
		if (
			!generate_block_data(
				data,
				get_u32be(data, thead + 28),
				data_end,
				track,
				dpos,
				gpos,
				dmb,
				raw,
				ctx,
			)
		) {
			return null;
		}
		// The gap pattern field is 32 bits wide but MAME passes it as a
		// uint8_t, keeping the low byte.
		if (
			!generate_block_gap(
				gap_type,
				gap_cells,
				get_u32be(data, thead + 24) & 0xff,
				ipos > gpos ? ipos - gpos : 0,
				data,
				get_u32be(data, thead + 8),
				data_end,
				track,
				gpos,
				ctx,
			)
		) {
			return null;
		}

		return pos;
	}

	// Summed without uint32 wrap: a wrapped total could only ever come
	// from a malformed file, and the cap in generate_track rejects the
	// unwrapped one.
	block_compute_real_size(t: TrackInfo, data: Uint8Array): number {
		let size = 0;
		let thead = 0;
		for (let i = 0; i !== t.block_count; i++) {
			const data_cells = get_u32be(data, thead);
			let gap_cells = get_u32be(data, thead + 4);
			if (gap_cells < 8) gap_cells = 0;

			size += data_cells + gap_cells;
			thead += 32;
		}
		return size;
	}
}
