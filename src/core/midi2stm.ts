// RExtract - Flashback data extractor for the Atari ST
// Copyright (c) 2026 Neil Rackett
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The second leg of the chip-music chain: a Standard MIDI File in, a
// YM2149 register stream out.
//
// The ST has three square-wave voices and one noise generator, so this
// plays a MIDI file the way a three-voice chip would have to - newest
// note wins a voice, the oldest gets stolen when all three are busy,
// and anything on MIDI channel 10 becomes a short burst of noise over
// voice C. Every fiftieth of a second it writes the fourteen sound
// chip registers, and the stream is those frames with only the bytes
// that changed.
//
// Ported from stdlconv.py's `midi` command in STDL, which is the same
// author's work under LGPL-2.1-or-later and is therefore relicensed
// here rather than copied under its original terms. It has to agree
// with that Python byte for byte: the same modules are converted by the
// command-line tools in the port's own repository, and two versions of
// a track that differ would be a puzzle nobody needs.

export class MidiError extends Error {}

/** 2MHz divided by 16 - the unit the tone period is counted in. */
const YM_CLOCK = 125000;
const TICK_HZ = 50;

/**
 * Python's round() goes to the nearest EVEN number on a tie, where
 * JavaScript's Math.round always goes up. That difference is one step
 * of a tone period or one step of volume, on any note that lands
 * exactly halfway - so it has to be reproduced rather than glossed
 * over.
 */
function pyRound(x: number): number {
	const below = Math.floor(x);
	const fraction = x - below;
	if (fraction > 0.5) {
		return below + 1;
	}
	if (fraction < 0.5) {
		return below;
	}
	return below % 2 === 0 ? below : below + 1;
}

type Event =
	| { tick: number; kind: 'tempo'; us: number }
	| { tick: number; kind: 'on'; ch: number; note: number; vel: number }
	| { tick: number; kind: 'off'; ch: number; note: number }
	| { tick: number; kind: 'vol'; ch: number; value: number }
	| { tick: number; kind: 'bend'; ch: number; value: number };

/** Note-offs before note-ons at the same tick, so a repeated note retriggers. */
const ORDER: Record<Event['kind'], number> = { tempo: 0, off: 1, vol: 2, bend: 3, on: 4 };

function readVarint(d: Uint8Array, i: number): [number, number] {
	let v = 0;
	for (;;) {
		const b = d[i];
		i++;
		v = (v << 7) | (b & 0x7f);
		if (!(b & 0x80)) {
			return [v, i];
		}
	}
}

function u16(d: Uint8Array, i: number): number {
	return (d[i] << 8) | d[i + 1];
}

function u32(d: Uint8Array, i: number): number {
	return ((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) >>> 0;
}

export function parseSmf(d: Uint8Array): { division: number; events: Event[] } {
	if (d[0] !== 0x4d || d[1] !== 0x54 || d[2] !== 0x68 || d[3] !== 0x64) {
		throw new MidiError('not a MIDI file');
	}
	const ntrk = u16(d, 10);
	const division = u16(d, 12);
	if (division & 0x8000) {
		throw new MidiError('SMPTE-timed MIDI is not supported');
	}
	const events: Event[] = [];
	let i = 14;
	for (let t = 0; t < ntrk; t++) {
		if (d[i] !== 0x4d || d[i + 1] !== 0x54 || d[i + 2] !== 0x72 || d[i + 3] !== 0x6b) {
			throw new MidiError('bad MIDI track header');
		}
		const length = u32(d, i + 4);
		let j = i + 8;
		const end = j + length;
		let tick = 0;
		let status = 0;
		while (j < end) {
			let dt: number;
			[dt, j] = readVarint(d, j);
			tick += dt;
			const b = d[j];
			if (b & 0x80) {
				status = b;
				j++;
			}
			if (status === 0xff) {
				const mtype = d[j];
				const [mlen, j2] = readVarint(d, j + 1);
				if (mtype === 0x51) {
					events.push({ tick, kind: 'tempo', us: (d[j2] << 16) | (d[j2 + 1] << 8) | d[j2 + 2] });
				}
				j = j2 + mlen;
			} else if (status === 0xf0 || status === 0xf7) {
				const [slen, j2] = readVarint(d, j);
				j = j2 + slen;
			} else {
				const kind = status & 0xf0;
				const ch = status & 0x0f;
				if (kind === 0x80 || kind === 0x90 || kind === 0xa0 || kind === 0xb0 || kind === 0xe0) {
					const a = d[j];
					const b2 = d[j + 1];
					j += 2;
					if (kind === 0x90 && b2 > 0) {
						events.push({ tick, kind: 'on', ch, note: a, vel: b2 });
					} else if (kind === 0x80 || (kind === 0x90 && b2 === 0)) {
						events.push({ tick, kind: 'off', ch, note: a });
					} else if (kind === 0xb0 && a === 7) {
						events.push({ tick, kind: 'vol', ch, value: b2 });
					} else if (kind === 0xe0) {
						events.push({ tick, kind: 'bend', ch, value: ((b2 << 7) | a) - 8192 });
					}
				} else if (kind === 0xc0 || kind === 0xd0) {
					j += 1;
				}
			}
		}
		i = end;
	}
	// Stable, like Python's sort: events that agree on both keys keep
	// the order they were read in, and that order reaches the output.
	events.sort((a, b) => a.tick - b.tick || ORDER[a.kind] - ORDER[b.kind]);
	return { division, events };
}

interface Voice {
	serial: number;
	ch: number;
	note: number;
	vel: number;
}

export function midiToFrames(midi: Uint8Array): number[][] {
	const { division, events } = parseSmf(midi);

	// Walk the tempo map to turn ticks into fiftieths of a second. The
	// arithmetic is written in the same order as the Python so the
	// floating point rounds identically.
	let usPerQuarter = 500000;
	const timed: Event[] = [];
	let lastTick = 0;
	let tUs = 0;
	for (const ev of events) {
		tUs += ((ev.tick - lastTick) * usPerQuarter) / division;
		lastTick = ev.tick;
		if (ev.kind === 'tempo') {
			usPerQuarter = ev.us;
			continue;
		}
		timed.push({ ...ev, tick: Math.trunc((tUs * TICK_HZ) / 1e6) });
	}
	if (timed.length === 0) {
		throw new MidiError('there are no notes in this MIDI file');
	}
	// Half a second of tail, so a note at the very end is still heard.
	const total = timed.reduce((n, e) => Math.max(n, e.tick), 0) + TICK_HZ / 2;

	const chVol = new Array<number>(16).fill(100);
	const chBend = new Array<number>(16).fill(0);
	let notes: Voice[] = [];
	const voices: (Voice | null)[] = [null, null, null];
	let drum: [number, number, number] | null = null;
	let serial = 0;
	let ei = 0;
	const out: number[][] = [];

	const periodOf = (ch: number, note: number): number => {
		const freq = 440.0 * Math.pow(2.0, (note - 69 + chBend[ch] / 4096.0) / 12.0);
		const p = pyRound(YM_CLOCK / freq);
		return Math.max(1, Math.min(0xfff, p));
	};

	const volumeOf = (ch: number, vel: number): number => {
		const v = (vel / 127.0) * (chVol[ch] / 127.0);
		return Math.max(1, Math.min(15, pyRound(15 * Math.pow(v, 0.5))));
	};

	for (let frame = 0; frame < total; frame++) {
		while (ei < timed.length && timed[ei].tick <= frame) {
			const ev = timed[ei];
			ei++;
			if (ev.kind === 'vol') {
				chVol[ev.ch] = ev.value;
			} else if (ev.kind === 'bend') {
				chBend[ev.ch] = ev.value;
			} else if (ev.kind === 'on') {
				if (ev.ch === 9) {
					// Percussion has nowhere to go but the noise
					// generator: a low drum rumbles, a cymbal hisses.
					const np = ev.note === 35 || ev.note === 36 ? 25 : ev.note === 38 || ev.note === 40 ? 12 : 3;
					drum = [4, np, volumeOf(ev.ch, ev.vel)];
				} else {
					const ent: Voice = { serial: serial++, ch: ev.ch, note: ev.note, vel: ev.vel };
					notes.push(ent);
					// Newest note wins: take a free voice if there is
					// one, otherwise steal the one holding the oldest.
					const free = voices.indexOf(null);
					if (free >= 0) {
						voices[free] = ent;
					} else {
						let oldest = 0;
						for (let v = 1; v < 3; v++) {
							if (voices[v]!.serial < voices[oldest]!.serial) {
								oldest = v;
							}
						}
						voices[oldest] = ent;
					}
				}
			} else if (ev.kind === 'off') {
				for (const ent of notes) {
					if (ent.ch === ev.ch && ent.note === ev.note) {
						notes = notes.filter((e) => e !== ent);
						const v = voices.indexOf(ent);
						if (v >= 0) {
							voices[v] = null;
							// A note that lost its voice to a steal and
							// is still held gets it back, newest first.
							let spare: Voice | null = null;
							for (const e of notes) {
								if (!voices.includes(e) && (spare === null || e.serial > spare.serial)) {
									spare = e;
								}
							}
							voices[v] = spare;
						}
						break;
					}
				}
			}
		}

		const regs = new Array<number>(14).fill(0);
		let mix = 0x3f; // every channel off; a set bit disables
		for (let v = 0; v < 3; v++) {
			const ent = voices[v];
			if (ent !== null) {
				const p = periodOf(ent.ch, ent.note);
				regs[2 * v] = p & 0xff;
				regs[2 * v + 1] = (p >> 8) & 0x0f;
				regs[8 + v] = volumeOf(ent.ch, ent.vel);
				mix &= ~(1 << v);
			}
		}
		if (drum !== null) {
			// The drum takes channel C for four frames, fading as it
			// goes, and its tone is swapped for noise.
			regs[6] = drum[1];
			regs[8 + 2] = Math.max(1, drum[2] - (4 - drum[0]) * 3);
			mix |= 1 << 2;
			mix &= ~(1 << 5);
			drum[0] -= 1;
			if (drum[0] <= 0) {
				drum = null;
			}
		}
		regs[7] = mix & 0xff;
		out.push(regs);
	}
	return out;
}

/** Only the registers that changed, behind a 16-bit mask of which. */
export function deltaEncode(frames: number[][]): Uint8Array {
	const shadow: (number | null)[] = new Array(14).fill(null);
	const blob: number[] = [];
	for (const regs of frames) {
		let mask = 0;
		const payload: number[] = [];
		for (let r = 0; r < 14; r++) {
			if (regs[r] !== shadow[r]) {
				mask |= 1 << r;
				payload.push(regs[r]);
				shadow[r] = regs[r];
			}
		}
		blob.push((mask >> 8) & 0xff, mask & 0xff, ...payload);
	}
	return new Uint8Array(blob);
}

export function midiToStm(midi: Uint8Array, loopFrame = 0): Uint8Array {
	const frames = midiToFrames(midi);
	const loop = Math.min(loopFrame, frames.length - 1);
	const blob = deltaEncode(frames);
	const out = new Uint8Array(12 + blob.length);
	out.set([0x53, 0x54, 0x4d, 0x31], 0); // STM1
	const head = [TICK_HZ, frames.length, loop, 0];
	for (let i = 0; i < 4; i++) {
		out[4 + i * 2] = (head[i] >> 8) & 0xff;
		out[5 + i * 2] = head[i] & 0xff;
	}
	out.set(blob, 12);
	return out;
}
