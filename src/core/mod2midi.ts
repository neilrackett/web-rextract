// RExtract - Flashback data extractor for the Atari ST
// Copyright (c) 2026 Neil Rackett
// SPDX-License-Identifier: BSD-2-Clause
//
// ProTracker module to Standard MIDI File.
//
// The Atari ST has no sampled music: the YM2149 gives three square
// wave voices and one noise generator, so the Amiga's four channels
// of looping samples cannot be played as they are. The route from the
// Amiga score to ST chip music is MOD -> SMF -> YM register stream,
// and this file is the first leg. A MOD is already note data, four
// channels of period/instrument/effect per row, so this reads the
// pattern data rather than the audio: periods become MIDI notes, the
// order table is followed as the player would follow it, and tempo
// comes from the speed and BPM effects. Sample-level detail (the
// waveforms, the volume envelopes) has nowhere to go on a YM and is
// dropped.
//
// Percussion is the one judgement call. The second leg sends MIDI
// channel 10 to the noise generator, so a channel is marked as drums
// when its samples are short, unpitched and played across a narrow
// note range: that is what a MOD drum track looks like, and it is
// better than having a kick drum fight the melody for one of only
// three voices.
//
// This is a port of tools/mod2smf.py from the atarist-reminiscence
// repository and its output is byte for byte the same. Where a Python
// idiom did not carry over, or where a number needed care, the
// comment beside it says so.

export class ModError extends Error {}

/** The tags that mark a 4-channel ProTracker module. */
const TAGS = ['M.K.', 'M!K!', '4CHN', 'FLT4', 'M&K!'];

/** Offset of the tag, which is also where the pattern data starts. */
const TAG_OFFSET = 1080;
const PATTERN_OFFSET = 1084;

/** ProTracker period table, note 0 = C-1 .. 35 = B-3, finetune 0. */
const PERIODS = [
	856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480, 453,
	428, 404, 381, 360, 339, 320, 302, 285, 269, 254, 240, 226,
	214, 202, 190, 180, 170, 160, 151, 143, 135, 127, 120, 113,
];

// MOD note 0 (period 856) is C-2 in the usual reckoning; MIDI 36 is
// C2, which puts the three octaves in a comfortable YM range.
const MIDI_BASE = 36;

/** Default pulses per quarter note; a row is a 16th at speed 6. */
const PPQ = 96;

interface Sample {
	name: string;
	length: number;
	finetune: number;
	volume: number;
	repeatPoint: number;
	repeatLen: number;
}

/** One channel's cell in a row: period, sample, effect, param. */
type Cell = [number, number, number, number];
type Row = Cell[];
type Pattern = Row[];

interface Module {
	title: string;
	samples: Sample[];
	order: number[];
	patterns: Pattern[];
}

export interface ModToMidiOptions {
	/** 'auto' detects the percussion channel, a number forces one, null means none. Default 'auto'. */
	drums?: 'auto' | number | null;
}

/**
 * Latin-1 text up to the first NUL. Python did
 * `split(b"\0")[0].decode("latin-1")`; every byte is one character in
 * latin-1 so fromCharCode per byte is the exact equivalent, where a
 * TextDecoder would default to UTF-8 and mangle anything above 0x7f.
 */
function latin1(data: Uint8Array, off: number, length: number): string {
	let s = '';
	const end = Math.min(off + length, data.length);
	for (let i = off; i < end; i++) {
		if (data[i] === 0) {
			break;
		}
		s += String.fromCharCode(data[i]);
	}
	return s;
}

/** Big-endian 16-bit, Python's `struct.unpack(">H", ...)`. */
function u16(data: Uint8Array, off: number): number {
	return (data[off] << 8) | data[off + 1];
}

/** The four-character tag at offset 1080 that says this is a module. */
export function isModule(data: Uint8Array): boolean {
	if (data.length < PATTERN_OFFSET) {
		return false;
	}
	return TAGS.includes(latin1(data, TAG_OFFSET, 4));
}

/** The module's own 20-byte title, NUL-terminated, latin-1. */
export function moduleTitle(data: Uint8Array): string {
	return latin1(data, 0, 20);
}

/**
 * Nearest table entry, so finetuned or slid periods still map. Ties
 * go to the lower index because the comparison is strictly less-than,
 * as in the original.
 */
function periodToNote(period: number): number | null {
	if (period <= 0) {
		return null;
	}
	let best = 0;
	let bestd = -1;
	for (let i = 0; i < PERIODS.length; i++) {
		const d = Math.abs(PERIODS[i] - period);
		if (bestd < 0 || d < bestd) {
			best = i;
			bestd = d;
		}
	}
	return MIDI_BASE + best;
}

function readModule(data: Uint8Array): Module {
	if (data.length < PATTERN_OFFSET) {
		throw new ModError('too short to be a module');
	}
	const tag = latin1(data, TAG_OFFSET, 4);
	if (!TAGS.includes(tag)) {
		throw new ModError(`not a 4-channel ProTracker module (tag ${JSON.stringify(tag)})`);
	}

	const title = latin1(data, 0, 20);
	const samples: Sample[] = [];
	let off = 20;
	// The sample count is fixed at 31 for every tag accepted above.
	// Lengths are stored in words, hence the doubling.
	for (let i = 0; i < 31; i++) {
		samples.push({
			name: latin1(data, off, 22),
			length: u16(data, off + 22) * 2,
			finetune: data[off + 24] & 15,
			volume: data[off + 25],
			repeatPoint: u16(data, off + 26) * 2,
			repeatLen: u16(data, off + 28) * 2,
		});
		off += 30;
	}

	// Python sliced 128 bytes of order table and then cut it to
	// song_len; a slice past the end just stops short, and subarray
	// clamps the same way. The byte between is the restart position,
	// which the original ignores.
	const songLen = data[off];
	const order = Array.from(data.subarray(off + 2, off + 2 + 128)).slice(0, songLen);
	// `max(order) + 1 if order else 0`: Math.max() of nothing is
	// -Infinity, so the empty case has to be spelled out.
	const npat = order.length ? Math.max(...order) + 1 : 0;
	const patterns: Pattern[] = [];
	for (let p = 0; p < npat; p++) {
		const base = PATTERN_OFFSET + p * 1024;
		if (base + 1024 > data.length) {
			break;
		}
		const rows: Pattern = [];
		for (let r = 0; r < 64; r++) {
			const row: Row = [];
			for (let c = 0; c < 4; c++) {
				const i = base + r * 16 + c * 4;
				const b0 = data[i];
				const b1 = data[i + 1];
				const b2 = data[i + 2];
				const b3 = data[i + 3];
				const period = ((b0 & 0x0f) << 8) | b1;
				const sample = (b0 & 0xf0) | (b2 >> 4);
				const effect = b2 & 0x0f;
				row.push([period, sample, effect, b3]);
			}
			rows.push(row);
		}
		patterns.push(rows);
	}
	return { title, samples, order, patterns };
}

/**
 * A percussion channel plays short unpitched samples over a narrow
 * range of notes. Score each channel on those two properties and
 * take the clear winner, if there is one.
 */
function pickDrumChannel(patterns: Pattern[], order: number[], samples: Sample[]): number | null {
	// Python kept a set of sample numbers per channel too, but never
	// read it, so it is not carried over. The pitches set is only ever
	// measured by its size, which is why the unordered Python set and
	// an insertion-ordered JS Set are interchangeable here.
	const stats = [0, 1, 2, 3].map(() => ({ notes: 0, pitches: new Set<number>(), shortsam: 0 }));
	for (const pi of order) {
		if (pi >= patterns.length) {
			continue;
		}
		for (const row of patterns[pi]) {
			for (let c = 0; c < 4; c++) {
				const [period, sample] = row[c];
				if (period) {
					const st = stats[c];
					st.notes += 1;
					st.pitches.add(period);
					if (sample) {
						// The original indexes samples[sample - 1] without a
						// bounds check and a sample number above 31 would
						// raise IndexError there. JS would give undefined
						// and a confusing TypeError, so the failure is made
						// explicit rather than silently skipped.
						const s = samples[sample - 1];
						if (s === undefined) {
							throw new ModError(`sample number ${sample} out of range`);
						}
						// a drum hit is short and does not loop
						if (s.length && s.length < 4000 && s.repeatLen <= 4) {
							st.shortsam += 1;
						}
					}
				}
			}
		}
	}
	let best: number | null = null;
	let bestscore = 0.0;
	for (let c = 0; c < 4; c++) {
		const st = stats[c];
		if (st.notes < 16) {
			continue;
		}
		// Deliberately floating point: Python divided with `/` and the
		// 0.5 threshold below is compared against the real ratio. A JS
		// number is the same IEEE double, so the arithmetic agrees.
		const shortRatio = st.shortsam / st.notes;
		const pitchSpread = st.pitches.size;
		// heavily short samples, few distinct pitches
		const score = shortRatio * (pitchSpread <= 6 ? 1.0 : pitchSpread <= 12 ? 0.5 : 0.15);
		// Strictly greater, so the first channel wins a tie.
		if (score > bestscore) {
			best = c;
			bestscore = score;
		}
	}
	return bestscore >= 0.5 ? best : null;
}

/**
 * MIDI variable-length quantity, most significant group first. Python
 * shifted an unbounded int; a JS `>>` would truncate to 32 bits, so
 * this divides instead, which is the same thing for the non-negative
 * deltas this ever sees.
 */
function varLen(n: number): number[] {
	const out = [n & 0x7f];
	n = Math.floor(n / 128);
	while (n) {
		out.unshift((n & 0x7f) | 0x80);
		n = Math.floor(n / 128);
	}
	return out;
}

/**
 * Set Tempo meta event. `struct.pack(">I", x)[1:]` is the low three
 * bytes of a big-endian 32-bit value; `60000000 // bpm` is floor
 * division, and bpm is never below 0x20 here so it always fits.
 */
function tempoEvent(bpm: number): number[] {
	const us = Math.floor(60000000 / bpm);
	return [0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff];
}

interface Event {
	tick: number;
	prio: number;
	bytes: number[];
}

/**
 * One MIDI track, all four MOD channels on their own MIDI channel
 * (drums on 10). Rows are walked in play order so pattern jumps and
 * breaks land where the player would put them.
 */
function buildSmf(mod: Module, drumCh: number | null, ppq: number): Uint8Array {
	const { title, samples, order, patterns } = mod;
	const events: Event[] = [];
	let tick = 0;
	let speed = 6;
	let bpm = 125;
	// `ppq // 4`: floor, though 96 divides exactly.
	let ticksPerRow = Math.floor(ppq / 4);
	// Python's dict remembers insertion order and the closing note-offs
	// are emitted by iterating it, all at one tick and one priority, so
	// that order reaches the file. A Map keeps insertion order the same
	// way, and like a dict it does not move a key that is reassigned.
	const playing = new Map<number, number>();

	const noteOff = (ch: number, note: number, at: number): void => {
		events.push({ tick: at, prio: 0, bytes: [0x80 | ch, note, 0] });
	};
	const noteOn = (ch: number, note: number, vel: number, at: number): void => {
		events.push({ tick: at, prio: 1, bytes: [0x90 | ch, note, vel] });
	};

	// initial tempo
	events.push({ tick: 0, prio: 0, bytes: tempoEvent(bpm) });
	if (title) {
		// The title came in as latin-1 so every char code is below 256
		// and its low byte is the original byte; a TextEncoder would
		// have written UTF-8 instead. Cut to 127 so the length byte
		// stays a single-byte quantity.
		const t: number[] = [];
		for (let i = 0; i < title.length && i < 127; i++) {
			t.push(title.charCodeAt(i) & 0xff);
		}
		events.push({ tick: 0, prio: 0, bytes: [0xff, 0x03, t.length, ...t] });
	}

	// A module ends either by running off the order list or by
	// jumping back into it (Bxx), which is how a MOD says "loop".
	// Stop at the first revisit: the game loops the track itself,
	// and following the jump would render the same music forever.
	//
	// What follows is the original's control flow statement for
	// statement, including the `continue` that re-enters the row loop
	// with a different pattern's rows after a Dxx break. The output
	// depends on exactly this behaviour, so it has not been tidied.
	let orderPos = 0;
	const visited = new Set<number>();
	while (orderPos < order.length) {
		if (visited.has(orderPos)) {
			break;
		}
		visited.add(orderPos);
		const pat = order[orderPos];
		if (pat >= patterns.length) {
			orderPos += 1;
			continue;
		}
		let rows = patterns[pat];
		let r = 0;
		let jumped = false;
		while (r < 64) {
			const row = rows[r];
			for (let c = 0; c < 4; c++) {
				const [period, sample, effect, param] = row[c];
				// `c if c < 9 else c + 1` in the original skips over the
				// drum channel for a hypothetical channel 9 or above; with
				// four channels it is just c.
				const midiCh = c === drumCh ? 9 : c < 9 ? c : c + 1;
				// effects that change timing
				if (effect === 0x0f) {
					if (param < 0x20) {
						speed = Math.max(1, param);
						// Two floor divisions, and `ppq // 4` is taken first.
						ticksPerRow = Math.max(1, Math.floor((Math.floor(ppq / 4) * speed) / 6));
					} else {
						bpm = param;
						events.push({ tick, prio: 0, bytes: tempoEvent(bpm) });
					}
				}
				if (period) {
					let note = periodToNote(period);
					if (note !== null) {
						const old = playing.get(midiCh);
						if (old !== undefined) {
							noteOff(midiCh, old, tick);
						}
						let vel = 100;
						if (sample && sample <= samples.length) {
							const v = samples[sample - 1].volume;
							// `int(v * 127 / 64)` truncates; v is never
							// negative so floor is the same, and v * 127 is an
							// exact integer divided by a power of two, so the
							// double is exact too.
							vel = Math.max(16, Math.min(127, Math.floor((v * 127) / 64)));
						}
						if (midiCh === 9) {
							// one drum voice: keep it on a fixed key so the
							// noise mapping downstream stays predictable
							note = 38;
						}
						noteOn(midiCh, note, vel, tick);
						playing.set(midiCh, note);
					}
				}
			}
			tick += ticksPerRow;
			// pattern break / position jump
			let brk: number | null = null;
			for (let c = 0; c < 4; c++) {
				const [, , effect, param] = row[c];
				if (effect === 0x0d) {
					// Dxx's parameter is two decimal digits stored as BCD.
					brk = (param >> 4) * 10 + (param & 15);
				} else if (effect === 0x0b) {
					orderPos = param;
					jumped = true;
				}
			}
			r += 1;
			if (brk !== null) {
				r = 64;
				if (!jumped) {
					orderPos += 1;
					jumped = true;
					// continue at row brk of the next pattern
					if (orderPos < order.length && order[orderPos] < patterns.length) {
						rows = patterns[order[orderPos]];
						r = Math.min(63, brk);
						jumped = false;
						continue;
					}
				}
			}
		}
		if (!jumped) {
			orderPos += 1;
		}
	}

	for (const [ch, note] of playing) {
		noteOff(ch, note, tick);
	}
	events.push({ tick, prio: 2, bytes: [0xff, 0x2f, 0x00] });

	// Python's list.sort is stable and so is Array.prototype.sort in
	// every current engine; events at one tick and priority keep their
	// insertion order, which the comparator must not disturb, so it
	// returns 0 for them rather than inventing a further key.
	events.sort((a, b) => a.tick - b.tick || a.prio - b.prio);
	const track: number[] = [];
	let last = 0;
	for (const e of events) {
		track.push(...varLen(e.tick - last));
		track.push(...e.bytes);
		last = e.tick;
	}

	// `struct.pack(">IHHH", 6, 0, 1, ppq)`: header length, format 0,
	// one track, division.
	const out = new Uint8Array(14 + 8 + track.length);
	out.set([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (ppq >> 8) & 0xff, ppq & 0xff], 0);
	const len = track.length;
	out.set([0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff], 14);
	out.set(track, 22);
	return out;
}

export function modToMidi(data: Uint8Array, options?: ModToMidiOptions): Uint8Array {
	const mod = readModule(data);
	// Not `?? 'auto'`: null is a meaningful value here (no percussion
	// channel) and `??` would fold it into the default along with
	// undefined. Only an absent option means auto.
	const drums = options?.drums === undefined ? 'auto' : options.drums;
	let drumCh: number | null;
	if (drums === 'auto') {
		drumCh = pickDrumChannel(mod.patterns, mod.order, mod.samples);
	} else {
		drumCh = drums;
	}
	return buildSmf(mod, drumCh, PPQ);
}
