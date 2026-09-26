// RExtract - Flashback data extractor for the Atari ST
// Copyright (c) 2026 Neil Rackett
// SPDX-License-Identifier: GPL-3.0-or-later

import './main.css';
import { buildDataSet, buildMusicSet, type DataSet } from './core/dataset';
import { convertTrack, moduleName } from './core/music';
import type { DiskResult } from './core/pipeline';
import { buildZip, type ZipStream } from './core/zip';
import type { ExamineRequest, ExamineResponse } from './worker';

const DISK_COUNT = 4;

type Slot =
	| { kind: 'empty' }
	| { kind: 'ready'; result: DiskResult };

interface Pending {
	id: number;
	fileName: string;
}

interface Rejected {
	fileName: string;
	reason: string;
}

const slots: Slot[] = Array.from({ length: DISK_COUNT }, () => ({ kind: 'empty' }) as Slot);
let pending: Pending[] = [];
let rejected: Rejected[] = [];
let dataSet: DataSet | null = null;
let music: ZipStream[] = [];
let nextId = 1;

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const dropZone = el<HTMLElement>('drop');
const picker = el<HTMLInputElement>('picker');
const slotList = el<HTMLUListElement>('slots');
const messages = el<HTMLElement>('messages');
const extractButton = el<HTMLButtonElement>('extract');
const saveButton = el<HTMLButtonElement>('save');
const resetButton = el<HTMLButtonElement>('reset');
const themeButton = el<HTMLButtonElement>('theme');

// --- colour theme ----------------------------------------------------

type Theme = 'system' | 'light' | 'dark';

const THEME_KEY = 'rextract-theme';
const THEME_CYCLE: Theme[] = ['system', 'light', 'dark'];

/**
 * The page follows the machine unless a reader says otherwise, and the
 * choice is remembered here rather than anywhere it could leave the
 * browser. Every localStorage call is wrapped: with site data blocked
 * the accessor throws rather than returning nothing, and a colour
 * preference is not worth a page that will not start.
 */
function storedTheme(): Theme {
	try {
		const value = localStorage.getItem(THEME_KEY);
		return value === 'light' || value === 'dark' ? value : 'system';
	} catch {
		return 'system';
	}
}

let theme: Theme = storedTheme();

function applyTheme(next: Theme): void {
	theme = next;
	// No attribute at all means "whatever the machine says", which is
	// what the media query in the stylesheet answers.
	if (next === 'system') {
		delete document.documentElement.dataset.theme;
	} else {
		document.documentElement.dataset.theme = next;
	}
	themeButton.textContent = `${next}`;
	themeButton.setAttribute('aria-label', `Colour theme: ${next}. Press to change it.`);
	try {
		if (next === 'system') {
			localStorage.removeItem(THEME_KEY);
		} else {
			localStorage.setItem(THEME_KEY, next);
		}
	} catch {
		// Nothing to do: the page still looks right for this visit.
	}
}

// --- reading ---------------------------------------------------------

function read(file: File): void {
	const id = nextId++;
	pending.push({ id, fileName: file.name });
	render();

	// One worker per file: four disks decode at once, and a worker that
	// has finished is gone rather than sitting idle.
	const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
	worker.onmessage = (event: MessageEvent<ExamineResponse>) => {
		worker.terminate();
		pending = pending.filter((p) => p.id !== event.data.id);
		if (event.data.ok) {
			place(event.data.result);
		} else {
			rejected.push({ fileName: file.name, reason: event.data.error });
		}
		render();
	};
	worker.onerror = (event) => {
		worker.terminate();
		pending = pending.filter((p) => p.id !== id);
		rejected.push({ fileName: file.name, reason: event.message || 'the file could not be read' });
		render();
	};

	void file.arrayBuffer().then((data) => {
		const request: ExamineRequest = { id, fileName: file.name, data };
		worker.postMessage(request, [data]);
	});
}

function place(result: DiskResult): void {
	const disk = result.identification.disk;
	if (disk === null) {
		rejected.push({
			fileName: result.fileName,
			reason:
				`this reads as an Amiga disk called "${result.volumeName}", but it is not one of the ` +
				'four Flashback disks.',
		});
		return;
	}
	const slot = slots[disk - 1];
	if (slot.kind === 'ready') {
		rejected.push({ fileName: result.fileName, reason: `disk ${disk} was already loaded, from ${slot.result.fileName}.` });
		return;
	}
	slots[disk - 1] = { kind: 'ready', result };
	// A new disk invalidates whatever was extracted before it arrived.
	dataSet = null;
}

// --- rendering -------------------------------------------------------

function slotRow(n: number, slot: Slot): string {
	if (slot.kind === 'empty') {
		return row(n, 'Still needed', '', 'Waiting', '');
	}
	const { result } = slot;
	const id = result.identification;
	const detail =
		`${result.volumeName} &middot; ${result.format.toUpperCase()} &middot; ${result.files.length} files` +
		(result.music.length > 0 ? ` &middot; ${result.music.length} tracks` : '');
	if (id.altered.length > 0) {
		return row(
			n,
			result.fileName,
			`${detail} &middot; ${id.altered.length} file(s) differ from the original`,
			'Altered',
			'warn',
		);
	}
	if (id.missing.length > 0) {
		return row(n, result.fileName, `${detail} &middot; ${id.missing.length} file(s) missing`, 'Incomplete', 'warn');
	}
	return row(n, result.fileName, detail, 'Verified', 'ok');
}

function row(n: number | string, name: string, detail: string, state: string, cls: string): string {
	return `<li class="slot ${cls}">
		<span class="no">${n}</span>
		<span class="name">${escapeHtml(name)}${detail ? `<span class="detail">${detail}</span>` : ''}</span>
		<span class="state">${state}</span>
	</li>`;
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

function render(): void {
	slotList.innerHTML = [
		...slots.map((slot, i) => slotRow(i + 1, slot)),
		...pending.map((p) => row('&hellip;', p.fileName, '', 'Reading', 'busy')),
		...rejected.map((r) => row('!', r.fileName, escapeHtml(r.reason), 'Not used', 'bad')),
	].join('');

	const ready = slots.filter((s) => s.kind === 'ready').length;
	extractButton.disabled = ready < DISK_COUNT || pending.length > 0;
	resetButton.hidden = ready === 0 && pending.length === 0 && rejected.length === 0;
	saveButton.hidden = dataSet === null || !('showDirectoryPicker' in window);

	if (dataSet) {
		return; // the extract result owns the message area once it exists
	}
	const notes: string[] = [];
	if (ready < DISK_COUNT && pending.length === 0 && ready > 0) {
		notes.push(`<p>${DISK_COUNT - ready} disk(s) still to go.</p>`);
	}
	const warnings = slots.flatMap((s) => (s.kind === 'ready' ? s.result.warnings : []));
	if (warnings.length > 0) {
		notes.push(`<p>Noted while reading:</p><ul>${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`);
	}
	messages.innerHTML = notes.join('');
}

// --- extracting ------------------------------------------------------

function extract(): void {
	const contributions = slots
		.map((slot, i) => (slot.kind === 'ready' ? { label: i + 1, files: slot.result.files } : null))
		.filter((c): c is { label: number; files: DiskResult['files'] } => c !== null);

	dataSet = buildDataSet(contributions);
	const notes: string[] = [];

	// The score is converted here rather than when each disk arrives:
	// four of the tracks are carried on more than one disk, and the
	// whole set takes a few tens of milliseconds, so there is nothing
	// to gain by doing it earlier or four times over.
	const musicSet = buildMusicSet(
		slots
			.map((slot, i) => (slot.kind === 'ready' ? { label: i + 1, files: slot.result.music } : null))
			.filter((c): c is { label: number; files: DiskResult['music'] } => c !== null),
	);
	music = [];
	const musicFailed: string[] = [];
	for (const track of musicSet.tracks) {
		// The module as it is, for an STE or Mega STE to play...
		music.push({ out: moduleName(track), bytes: track.bytes });
		// ...and its YM version, for every ST.
		try {
			music.push({ out: track.out, bytes: convertTrack(track.bytes) });
		} catch (e) {
			// One module that will not convert should not cost the
			// player the other twenty.
			musicFailed.push(`${track.out} (${(e as Error).message})`);
		}
	}
	if (musicFailed.length > 0) {
		notes.push(
			'<p class="bad">These tracks could not be converted to YM, so a plain ST will be quiet where ' +
			'they would have played (an STE still plays the original):</p>' +
			`<ul>${musicFailed.map((n) => `<li>${n}</li>`).join('')}</ul>`,
		);
	}
	if (dataSet.missing.length > 0) {
		notes.push(
			`<p class="bad">${dataSet.missing.length} file(s) the game needs are on none of these disks:</p>` +
			`<ul>${dataSet.missing.map((n) => `<li>${n}</li>`).join('')}</ul>`,
		);
	}
	if (dataSet.conflicts.length > 0) {
		notes.push(
			'<p class="bad">Two disks disagree about these files, which should be identical copies. ' +
			'The first copy was kept:</p>' +
			`<ul>${dataSet.conflicts.map((n) => `<li>${n}</li>`).join('')}</ul>`,
		);
	}
	if (dataSet.unsafeNames.length > 0) {
		notes.push(
			'<p class="bad">These names will not survive an Atari filesystem and need renaming by hand:</p>' +
			`<ul>${dataSet.unsafeNames.map((n) => `<li>${n}</li>`).join('')}</ul>`,
		);
	}

	const kb = Math.round((dataSet.totalBytes + music.reduce((n, t) => n + t.bytes.length, 0)) / 1024);
	notes.unshift(
		`<p><strong>${dataSet.files.length} files and ${musicSet.tracks.length} music tracks, ` +
		`${kb.toLocaleString()}KB.</p>` +
		`<p>Unzip it so that <code>FLASHBAK.TOS</code> and the <code>DATA</code> and <code>MUSIC</code> 
		folders are all in the same folder on your hard disk and you're ready to go!</p>`,
	);
	messages.innerHTML = notes.join('');

	const zip = buildZip(dataSet.files, music);
	const url = URL.createObjectURL(new Blob([zip as BlobPart], { type: 'application/zip' }));
	const a = document.createElement('a');
	a.href = url;
	a.download = 'FLASHBACK-DATA.zip';
	a.click();
	URL.revokeObjectURL(url);
	render();
}

/**
 * Chrome and Edge can write the folder straight out, which saves
 * anyone who would otherwise unzip it and move it by hand. Everywhere
 * else the zip is the answer, so this button only appears where it
 * works.
 */
async function saveToFolder(): Promise<void> {
	if (!dataSet) {
		return;
	}
	try {
		const picked = await (window as unknown as {
			showDirectoryPicker(options?: { mode?: string }): Promise<FileSystemDirectoryHandle>;
		}).showDirectoryPicker({ mode: 'readwrite' });
		let written = 0;
		const put = async (folder: string, files: { out: string; bytes: Uint8Array }[]) => {
			if (files.length === 0) {
				return;
			}
			const dir = await picked.getDirectoryHandle(folder, { create: true });
			for (const file of files) {
				const handle = await dir.getFileHandle(file.out, { create: true });
				const stream = await handle.createWritable();
				await stream.write(file.bytes as BufferSource);
				await stream.close();
				written++;
			}
		};
		await put('DATA', dataSet.files);
		await put('MUSIC', music);
		messages.innerHTML =
			`<p><strong>${written} files written to DATA and MUSIC in the folder you chose.</strong></p>`;
	} catch (e) {
		const err = e as Error;
		if (err.name !== 'AbortError') {
			messages.innerHTML = `<p class="bad">Could not write the folder: ${escapeHtml(err.message)}</p>`;
		}
	}
}

function reset(): void {
	for (let i = 0; i < DISK_COUNT; i++) {
		slots[i] = { kind: 'empty' };
	}
	pending = [];
	rejected = [];
	dataSet = null;
	music = [];
	picker.value = '';
	messages.innerHTML = '';
	render();
}

// --- wiring ----------------------------------------------------------

function accept(files: FileList | null): void {
	if (!files) {
		return;
	}
	// A retry should replace what went wrong rather than pile up beside
	// it, so the previous complaints go when new files arrive.
	rejected = [];
	for (const file of Array.from(files)) {
		read(file);
	}
}

dropZone.addEventListener('click', () => picker.click());
dropZone.addEventListener('keydown', (e) => {
	if (e.key === 'Enter' || e.key === ' ') {
		e.preventDefault();
		picker.click();
	}
});
picker.addEventListener('change', () => accept(picker.files));

for (const type of ['dragenter', 'dragover'] as const) {
	dropZone.addEventListener(type, (e) => {
		e.preventDefault();
		dropZone.classList.add('over');
	});
}
for (const type of ['dragleave', 'drop'] as const) {
	dropZone.addEventListener(type, () => dropZone.classList.remove('over'));
}
dropZone.addEventListener('drop', (e) => {
	e.preventDefault();
	accept(e.dataTransfer?.files ?? null);
});
// Anywhere on the page, so a near miss still works.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

el<HTMLButtonElement>('choose').addEventListener('click', (e) => {
	e.stopPropagation();
	picker.click();
});
extractButton.addEventListener('click', extract);
saveButton.addEventListener('click', () => void saveToFolder());
resetButton.addEventListener('click', reset);
themeButton.addEventListener('click', () => {
	applyTheme(THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length]);
});

applyTheme(theme);
render();
