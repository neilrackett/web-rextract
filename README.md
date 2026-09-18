# RExtract

A web app that extracts the data from your Amiga Flashback installation
disks into the `DATA` folder the [Atari ST port of REminscence](https://github.com/neilrackett atarist-reminiscence)
needs.

Drop the four disk images on it, and it gives you back a zip - or writes
the folder straight to disk, where the browser allows that. It does the
same job as the port's `tools/extract-data.sh`, for anyone who would
rather not meet a terminal.

**Everything happens in the browser.** The disk images are read by the
tab you have open and go nowhere else: there is no upload, no server and
nothing to send them to. The page is a static file on GitHub Pages.

You need your own copy of the Amiga release. This supplies no game data,
and neither does this repository - not a test fixture, not a sample
disk, not one file.

## What it reads

| Format | Notes                                                                    |
| ------ | ------------------------------------------------------------------------ |
| `.ipf` | CAPS/SPS images, the preservation format. Decoded here, not by a plugin. |
| `.adf` | A plain sector dump.                                                     |
| `.adz` | A gzipped ADF.                                                           |

DMS archives are not supported: unpack one to an ADF first.

Both AmigaDOS filesystems are read, OFS and FFS. The original Flashback
disks are OFS.

## What it produces

107 files, in one `DATA` folder, named the way a GEMDOS volume needs
them: uppercase, eight characters and three. One file is renamed rather
than truncated - `REPLICANT.SPM` becomes `REPLICAN.SPM`, because GEMDOS
would have shortened it silently and the ST build was changed to ask for
the short name.

Twenty files appear on more than one disk. On the original release every
copy is identical, so one is kept and the rest are checked against it; a
disk that disagrees is reported rather than quietly winning.

And 21 music tracks, in a `MUSIC` folder beside it.

## The music

The Amiga score is sampled music, which a plain ST cannot play: there is
no DMA sound on one and this port has no software mixer. Every ST does
have the YM2149, so each ProTracker module on the disks is converted
here into a YM register stream, the same way the port's own
`tools/make-music.sh` does it offline:

```
MOD  ->  Standard MIDI File  ->  STM
     mod2midi.ts          midi2stm.ts
```

Expect a chip cover rather than a reproduction. The waveforms and the
volume envelopes have nowhere to go on three square waves and a noise
generator, so what survives is the notes.

Two things in there are judgement calls rather than conversions. One MOD
channel is marked as percussion when its samples are short, unlooped and
played over a narrow range of notes, because with only three voices a
kick drum competing with the melody is a poor trade. And a module that
jumps backwards through its order table is saying "loop", so conversion
stops at the first revisited position and the player repeats the track -
following the jump instead rendered three cues as 22-minute files.

Each track is named from the module's own 20-byte title rather than its
filename. The filename is the engine's primary track name, but the port
looks up the alternate one, and the alternate is what the title holds.
Where a name will not fit in 8.3 the LAST character is kept rather than
truncating: `teleporta` and `teleport2` differ only there and would
otherwise both become `TELEPORT`.

Both legs are ports of the Python in the ST repository, and the tests
check them against it: every one of the 21 tracks comes out byte for
byte identical to what `mod2smf.py` and `stdlconv.py` produce.

## How it decides a disk is the right one

Not by checksumming the image. The same disk can arrive as an IPF, an
ADF or an ADZ, and a cracked release has a different boot block and the
same game on it - so what the page recognises is the set of files
inside: their names, their sizes and their CRC32s, recorded in
`src/core/manifest.ts`.

That also means a mismatch can say which file is wrong, which is the
useful thing to know. Most failures are a truncated download or an image
of the wrong release, and without the check those look exactly like a
bug in the parser.

The manifest holds names, byte counts and checksums. There is no game
data in it and there never will be.

## Building it

```
pnpm install
pnpm run dev        # http://localhost:5173/web-rextract/
pnpm run build      # into dist/
pnpm test
pnpm run typecheck
```

`pnpm run build` targets a GitHub Pages project site at `/web-rextract/`.
For a custom domain or a user site, build with `BASE=/ pnpm run build`.

Pushing to `main` deploys, through `.github/workflows/pages.yml`.

### Tests that need disks

Most of the tests run on nothing but synthesised data - the MFM decoder
is checked against sectors the test encodes itself. The end-to-end ones
need real images, so they look for `REXTRACT_FIXTURES`:

```
REXTRACT_FIXTURES=/path/to/disks pnpm test
```

The directory holds `disk1.adf` .. `disk4.adf`, and optionally
`disk1.ipf` .. `disk4.ipf`. A `music/` subdirectory holding the `.STM`
files the port's own `tools/make-music.sh` produced turns on the
byte-comparison against the Python chain. Without any of it those tests
skip themselves, so a fresh clone still passes. Keep that directory outside this repository.

If you have both, the IPF tests compare what this decoder produces
against the ADFs beside it, file by file. Producing those ADFs with
capsimg on your own machine is a fine way to get a reference; shipping
capsimg is the thing that cannot happen, so it stays a local step and
never becomes a dependency.

### Regenerating the manifest

```
pnpm run manifest /path/to/disks
```

Reads four original images and rewrites `src/core/manifest.ts`. A
developer tool - it is not part of the build and CI never runs it.

## How it works

```
the dropped file
      |
      v
  read.ts          picks a reader; the IPF decoder loads on demand
      |
      v
  ipf.ts + mfm.ts  cell stream per track -> Amiga MFM sectors
   or adf.ts       already sectors
      |
      v
  image.ts         1760 blocks of 512 bytes, and which ones were read
      |
      v
  amigados.ts      OFS/FFS walk: a flat list of files
      |
      v
  dataset.ts       which files, what they are called, which disk this is
      |
      +-- music.ts        the score: mod2midi.ts -> midi2stm.ts
      |
      v
  zip.ts           DATA/ and MUSIC/, deflated
```

Each disk is read in its own worker, so four of them decode at once and
the page keeps drawing while they do.

`present`, the flag per block in `image.ts`, is what makes
copy-protection tracks a non-event: they do not decode as AmigaDOS
sectors, they never hold game files, and a hole only becomes a problem
if the filesystem asks for it. When it does, the file that needed it
says so.

## Known limits

The IPF decoder has been checked against the four Flashback disks, which
were written by the CAPS encoder. That encoder only ever produces one
kind of gap description, so the three the SPS encoder can produce are
ported from MAME line by line but have never been run against a real
file. An IPF from a different preservation run may reach them.

If one of them is wrong the failure is contained: a track that will not
decode is a warning and the rest of the disk carries on, and any file
that needed the missing sectors says so by name. If you meet one,
the track number in the warning is the thing to report.

DMS is not supported: unpack one to an ADF first.

## Licensing

BSD-2-Clause, except `src/core/ipf.ts`, which is derived from MAME's
`src/lib/formats/ipf_dsk.cpp` by Olivier Galibert and keeps its own
licence, BSD-3-Clause. The file carries the notice.

The SPS decoder library that usually reads IPFs is deliberately not
used: its licence restricts it to non-commercial use, which makes it
non-free, and a browser has no way for you to supply your own build of
it. MAME's decoder is an independent implementation under a licence that
allows this. It is ported rather than compiled, so there is no
Emscripten in the build.
