// RExtract - Flashback data extractor for the Atari ST
// Copyright (c) 2026 Neil Rackett
// SPDX-License-Identifier: GPL-3.0-or-later
//
// End to end, against real disks. These are the tests that need
// REXTRACT_FIXTURES; see test/fixtures.ts.

import { describe, expect, it } from 'vitest';
import { crc32 } from '../src/core/crc32';
import { buildDataSet, buildMusicSet } from '../src/core/dataset';
import { convertTrack } from '../src/core/music';
import { KNOWN_DISKS, REQUIRED_FILES } from '../src/core/manifest';
import { examine } from '../src/core/pipeline';
import { unzipSync } from 'fflate';
import { buildZip } from '../src/core/zip';
import { fixture, haveFixture } from './fixtures';

const DISKS = [1, 2, 3, 4];

describe.skipIf(!haveFixture('disk1.adf'))('from ADFs', () => {
	it('identifies each disk and verifies every file against the manifest', async () => {
		for (const n of DISKS) {
			const result = await examine(`disk${n}.adf`, fixture(`disk${n}.adf`));
			expect(result.identification.disk, `disk ${n}`).toBe(n);
			expect(result.identification.confidence).toBe(1);
			expect(result.identification.altered).toEqual([]);
			expect(result.identification.missing).toEqual([]);
			expect(result.warnings).toEqual([]);
		}
	});

	it('builds the whole DATA folder the port asks for', async () => {
		const disks = await Promise.all(
			DISKS.map(async (n) => ({ label: n, files: (await examine(`disk${n}.adf`, fixture(`disk${n}.adf`))).files })),
		);
		const set = buildDataSet(disks);
		expect(set.files.length).toBe(REQUIRED_FILES.length);
		expect(set.missing).toEqual([]);
		expect(set.conflicts).toEqual([]);
		expect(set.unsafeNames).toEqual([]);

		// Every byte, against the checksums recorded from the originals.
		const want = new Map(KNOWN_DISKS.flatMap((d) => d.files.map((f) => [f.out, f])));
		for (const file of set.files) {
			const expected = want.get(file.out);
			expect(expected, file.out).toBeDefined();
			expect(file.bytes.length, file.out).toBe(expected!.size);
			expect(crc32(file.bytes), file.out).toBe(expected!.crc32);
		}
	});

	it('writes a zip holding DATA and MUSIC', async () => {
		const read = await Promise.all(DISKS.map((n) => examine(`disk${n}.adf`, fixture(`disk${n}.adf`))));
		const data = buildDataSet(read.map((r, i) => ({ label: i + 1, files: r.files })));
		const music = buildMusicSet(read.map((r, i) => ({ label: i + 1, files: r.music })));
		const zip = buildZip(
			data.files,
			music.tracks.map((t) => ({ out: t.out, bytes: convertTrack(t.bytes) })),
		);
		expect(zip.length).toBeGreaterThan(1_000_000);
		// PK\003\004, then the first entry's name.
		expect([...zip.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
		expect(new TextDecoder().decode(zip.subarray(30, 35))).toBe('DATA/');

		// Unpacked again, the archive has to hold both folders in full:
		// this is the whole job, end to end, in one assertion.
		const back = unzipSync(zip);
		const names = Object.keys(back);
		expect(names.filter((n) => n.startsWith('DATA/')).length).toBe(REQUIRED_FILES.length);
		expect(names.filter((n) => n.startsWith('MUSIC/')).length).toBe(21);
		expect(names.filter((n) => !n.startsWith('DATA/') && !n.startsWith('MUSIC/'))).toEqual([]);
		expect(back['MUSIC/JUNGLE.STM'].subarray(0, 4)).toEqual(new Uint8Array([0x53, 0x54, 0x4d, 0x31]));
	}, 30_000);
});

describe.skipIf(!haveFixture('disk1.ipf'))('from IPFs', () => {
	it('gets the same bytes out of an IPF as out of the ADF beside it', async () => {
		for (const n of DISKS) {
			const fromIpf = await examine(`disk${n}.ipf`, fixture(`disk${n}.ipf`));
			expect(fromIpf.format).toBe('ipf');
			expect(fromIpf.identification.disk, `disk ${n}`).toBe(n);
			expect(fromIpf.identification.altered, `disk ${n}`).toEqual([]);
			expect(fromIpf.identification.missing, `disk ${n}`).toEqual([]);

			if (!haveFixture(`disk${n}.adf`)) {
				continue;
			}
			// The ADFs were produced by capsimg, the reference decoder, so
			// this is the IPF port checked against the thing it replaces.
			const fromAdf = await examine(`disk${n}.adf`, fixture(`disk${n}.adf`));
			expect(fromIpf.files.map((f) => f.out)).toEqual(fromAdf.files.map((f) => f.out));
			for (let i = 0; i < fromAdf.files.length; i++) {
				expect(crc32(fromIpf.files[i].bytes), `disk ${n}: ${fromAdf.files[i].out}`).toBe(
					crc32(fromAdf.files[i].bytes),
				);
			}
		}
	}, 60_000);
});
