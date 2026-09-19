// RExtract - Flashback data extractor for the Atari ST
// Copyright (c) 2026 Neil Rackett
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMusicSet } from '../src/core/dataset';
import { modToMidi } from '../src/core/mod2midi';
import { convertTrack, trackName, trackTitle } from '../src/core/music';
import { examine } from '../src/core/pipeline';
import { fixture, fixtureDir, haveFixture } from './fixtures';

describe('naming a track', () => {
	it('keeps the last character rather than truncating', () => {
		// teleporta and teleport2 differ only in that character, and
		// truncation would give both of them the same name.
		expect(trackName('teleporta')).toBe('TELEPORA.STM');
		expect(trackName('teleport2')).toBe('TELEPOR2.STM');
		expect(trackName('ascenseur')).toBe('ASCENSER.STM');
	});

	it('drops the underscore rather than counting it', () => {
		expect(trackName('game_over')).toBe('GAMEOVER.STM');
	});

	it('leaves a name that already fits alone', () => {
		expect(trackName('jungle')).toBe('JUNGLE.STM');
		expect(trackName('holocube')).toBe('HOLOCUBE.STM');
	});

	it('reads the title out of a module and drops the prefix', () => {
		const module = new Uint8Array(1084);
		const title = 'flashback-jungle\0\0\0\0';
		for (let i = 0; i < 20; i++) {
			module[i] = title.charCodeAt(i);
		}
		expect(trackTitle(module)).toBe('jungle');
	});
});

describe.skipIf(!haveFixture('disk1.adf'))('the score, off the disks', () => {
	it('converts every track, and names them the way the game asks', async () => {
		const disks = await Promise.all(
			[1, 2, 3, 4].map(async (n) => ({
				label: n,
				files: (await examine(`disk${n}.adf`, fixture(`disk${n}.adf`))).music,
			})),
		);
		const set = buildMusicSet(disks);
		expect(set.conflicts).toEqual([]);
		expect(set.tracks.length).toBe(21);
		expect(set.tracks.map((t) => t.out)).toEqual([
			'ASCENSER.STM', 'CEINTURA.STM', 'CHUTE.STM', 'DESINTER.STM', 'DONNEOBT.STM',
			'FIN.STM', 'FIN2.STM', 'GAMEOVER.STM', 'HOLOCUBE.STM', 'INTROB.STM',
			'JUNGLE.STM', 'LOGO.STM', 'MEMOIRE.STM', 'MISSIONA.STM', 'OPTIONS1.STM',
			'OPTIONS2.STM', 'REUNION.STM', 'TAXI.STM', 'TELEPOR2.STM', 'TELEPORA.STM',
			'VOYAGE.STM',
		]);

		// Counted, so that a missing reference directory shows up as a
		// weaker test rather than a passing one.
		const haveReferences = existsSync(join(fixtureDir, 'music'));
		let compared = 0;
		// Asking for no percussion has to mean no percussion. An earlier
		// draft used `?? 'auto'`, which folds an explicit null back into
		// auto-detect, and it went unnoticed because the three modules
		// where auto-detection finds a drum channel are the only ones
		// that show the difference. Holocube is one of them.
		const holocube = set.tracks.find((t) => t.out === 'HOLOCUBE.STM');
		expect(holocube).toBeDefined();
		const auto = modToMidi(holocube!.bytes);
		const none = modToMidi(holocube!.bytes, { drums: null });
		expect([...none]).not.toEqual([...auto]);

		let total = 0;
		for (const track of set.tracks) {
			const stm = convertTrack(track.bytes);
			total += stm.length;
			// STM1, then the rate, the frame count and the loop point.
			expect(new TextDecoder().decode(stm.subarray(0, 4)), track.out).toBe('STM1');
			expect((stm[4] << 8) | stm[5]).toBe(50);
			const frames = (stm[6] << 8) | stm[7];
			expect(frames, `${track.out} frames`).toBeGreaterThan(50);

			// Where the streams the port's own Python tools produced are
			// to hand, the two have to agree exactly: the same track
			// converted twice must not be two different pieces of music.
			const reference = join(fixtureDir, 'music', track.out);
			if (existsSync(reference)) {
				expect([...stm], `${track.out} against the reference`).toEqual([
					...new Uint8Array(readFileSync(reference)),
				]);
				compared++;
			}
		}
		// The whole score is about 107KB, from a six-second lift cue to
		// a 198-second options theme.
		expect(total).toBeGreaterThan(100 * 1024);
		expect(total).toBeLessThan(115 * 1024);
		if (haveReferences) {
			expect(compared, 'tracks checked against the Python chain').toBe(21);
		}
	}, 30_000);
});
