'use strict';
/* ------------------------------------------------------------------
   Serato history reader.

   There is no official Serato API and there never has been. Serato DJ appends
   to a binary "session" file every time a track is loaded onto or ejected from
   a deck. This module finds the newest session file, follows it as it grows,
   and reports tracks as they appear.

   FILE FORMAT (as documented by the sslscrobbler project and others):

     The file is a sequence of chunks. Each chunk is:
       4 bytes  ASCII tag        e.g. "vrsn", "oent"
       4 bytes  big-endian int32 payload length
       N bytes  payload

     A track entry is an "oent" chunk whose payload contains an "adat" chunk.
     The adat payload is itself a sequence of fields:
       4 bytes  big-endian int32 field id
       4 bytes  big-endian int32 field length
       N bytes  value  (strings are UTF-16 BIG endian, usually null-terminated)

   IMPORTANT CAVEAT, by design not omission: the file records loads and ejects,
   NOT how long a track actually played. A track loaded, auditioned and pulled
   back looks identical to one played in full. Everything downstream treats
   "played" as inferred, never as fact.

   The field ids below are the widely-used mapping, but they are NOT officially
   documented and have shifted between Serato versions. Anything unrecognised is
   kept in `unknownFields` so a real-world run can tell us what we're missing
   instead of silently dropping it.
   ------------------------------------------------------------------ */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

const FIELD = {
  2:  'filepath',
  3:  'location',
  4:  'filename',
  6:  'title',
  7:  'artist',
  8:  'album',
  9:  'genre',
  15: 'length',
  16: 'bitrate',
  17: 'samplerate',
  28: 'startTime',
  29: 'endTime',
  31: 'played',
  45: 'deck',
  52: 'deckAlt',
};

/* Serato stores strings as UTF-16BE. Node can decode UTF-16LE natively, so swap
   the byte pairs first rather than hand-rolling a decoder. */
function readUtf16be(buf) {
  if (!buf || !buf.length) return '';
  const even = buf.length - (buf.length % 2);
  const swapped = Buffer.allocUnsafe(even);
  for (let i = 0; i < even; i += 2) {
    swapped[i] = buf[i + 1];
    swapped[i + 1] = buf[i];
  }
  return swapped.toString('utf16le').replace(/\u0000+$/g, '').trim();
}

function readInt(buf) {
  if (!buf || !buf.length) return null;
  if (buf.length === 1) return buf[0];
  if (buf.length === 2) return buf.readUInt16BE(0);
  if (buf.length >= 4) return buf.readUInt32BE(0);
  return null;
}

/* Walks chunks in a buffer. Returns the entries found plus how many bytes were
   consumed, so a partially-written trailing chunk can be left for next time —
   Serato is appending to this file while we read it. */
function parseChunks(buf) {
  const entries = [];
  let off = 0;
  let consumed = 0;

  while (off + 8 <= buf.length) {
    const tag = buf.toString('ascii', off, off + 4);
    const len = buf.readUInt32BE(off + 4);

    // A length that can't be right means we've lost sync; stop rather than
    // wander through the file emitting nonsense.
    if (len < 0 || len > 50 * 1024 * 1024) break;
    if (off + 8 + len > buf.length) break;   // incomplete — wait for more bytes

    const payload = buf.subarray(off + 8, off + 8 + len);
    if (tag === 'oent') {
      const entry = parseOent(payload);
      if (entry) entries.push(entry);
    }
    off += 8 + len;
    consumed = off;
  }
  return { entries, consumed };
}

function parseOent(payload) {
  let off = 0;
  while (off + 8 <= payload.length) {
    const tag = payload.toString('ascii', off, off + 4);
    const len = payload.readUInt32BE(off + 4);
    if (off + 8 + len > payload.length) break;
    if (tag === 'adat') return parseAdat(payload.subarray(off + 8, off + 8 + len));
    off += 8 + len;
  }
  return null;
}

function parseAdat(payload) {
  const out = { unknownFields: {} };
  let off = 0;
  while (off + 8 <= payload.length) {
    const id = payload.readUInt32BE(off);
    const len = payload.readUInt32BE(off + 4);
    if (len > payload.length || off + 8 + len > payload.length) break;
    const val = payload.subarray(off + 8, off + 8 + len);
    const name = FIELD[id];

    if (name === 'startTime' || name === 'endTime' || name === 'played' ||
        name === 'deck' || name === 'deckAlt' || name === 'length' ||
        name === 'bitrate' || name === 'samplerate') {
      out[name] = readInt(val);
    } else if (name) {
      out[name] = readUtf16be(val);
    } else if (len <= 400) {
      // Kept so a real Serato install can tell us what we don't recognise.
      const text = readUtf16be(val);
      out.unknownFields[id] = text && /[\x20-\x7e]/.test(text) ? text : readInt(val);
    }
    off += 8 + len;
  }
  if (!out.title && !out.filepath) return null;
  /* Untagged files — bootlegs, edits, promos — are common in a DJ library and
     turn up with no title at all. Fall back to the filename so the track is at
     least reportable, and flag it so nothing downstream trusts it for matching. */
  if (!out.title) {
    const base = out.filename || (out.filepath ? out.filepath.split(/[\\/]/).pop() : '');
    if (base) {
      out.title = base.replace(/\.[a-z0-9]{2,4}$/i, '');
      out.titleFromFilename = true;
    }
  }
  return out;
}

/* Where Serato keeps its history. Checked in order; the first that exists wins.
   Serato has used both ~/Music/_Serato_ and the older ScratchLIVE locations, and
   a DJ with an external drive may have it elsewhere entirely — hence the manual
   override. */
function candidateDirs() {
  const home = os.homedir();
  const dirs = [];
  if (process.platform === 'darwin') {
    dirs.push(path.join(home, 'Music', '_Serato_', 'History', 'Sessions'));
    dirs.push(path.join(home, 'Music', '_Serato_', 'History'));
    dirs.push(path.join(home, 'Music', 'ScratchLIVE', 'History', 'Sessions'));
  } else {
    dirs.push(path.join(home, 'Music', '_Serato_', 'History', 'Sessions'));
    dirs.push(path.join(home, 'Music', '_Serato_', 'History'));
    dirs.push(path.join(home, 'My Music', '_Serato_', 'History', 'Sessions'));
    dirs.push(path.join(home, 'Documents', '_Serato_', 'History', 'Sessions'));
  }
  return dirs;
}

function findHistoryDir(override) {
  if (override) {
    // Accept either the Sessions folder or the _Serato_ folder above it.
    const tries = [
      override,
      path.join(override, 'Sessions'),
      path.join(override, 'History', 'Sessions'),
      path.join(override, '_Serato_', 'History', 'Sessions'),
    ];
    for (const d of tries) {
      try { if (fs.statSync(d).isDirectory()) return d; } catch (e) {}
    }
    return null;
  }
  for (const d of candidateDirs()) {
    try { if (fs.statSync(d).isDirectory()) return d; } catch (e) {}
  }
  return null;
}

function newestSession(dir) {
  let best = null;
  let files = [];
  try { files = fs.readdirSync(dir); } catch (e) { return null; }
  for (const f of files) {
    if (!/\.session$/i.test(f)) continue;
    const full = path.join(dir, f);
    try {
      const st = fs.statSync(full);
      if (!best || st.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: st.mtimeMs, size: st.size };
    } catch (e) {}
  }
  return best;
}

/* ------------------------------------------------------------------
   The watcher.

   Polls rather than using fs.watch: fs.watch is unreliable across platforms and
   on network/external volumes, and a missed event here means a missed alarm.
   Polling a file size every second costs nothing and never lies.
   ------------------------------------------------------------------ */
class SeratoWatcher extends EventEmitter {
  constructor(opts) {
    super();
    this.override = (opts && opts.folder) || null;
    this.pollMs = (opts && opts.pollMs) || 1000;
    this.dir = null;
    this.file = null;
    this.offset = 0;
    this.tail = Buffer.alloc(0);
    this.timer = null;
    this.lastTrackKey = null;
    this.stats = { entriesSeen: 0, filesFollowed: 0, lastError: null, startedAt: null };
  }

  status() {
    return {
      running: !!this.timer,
      dir: this.dir,
      file: this.file,
      offset: this.offset,
      override: this.override,
      searched: this.override ? [this.override] : candidateDirs(),
      ...this.stats,
    };
  }

  setFolder(folder) {
    this.override = folder || null;
    this.dir = null;
    this.file = null;
    this.offset = 0;
    this.tail = Buffer.alloc(0);
    this.emit('status', this.status());
  }

  start() {
    if (this.timer) return;
    this.stats.startedAt = Date.now();
    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    try {
      if (!this.dir) {
        this.dir = findHistoryDir(this.override);
        if (!this.dir) return;                       // Serato may not be installed yet
        this.emit('status', this.status());
      }
      const newest = newestSession(this.dir);
      if (!newest) return;

      if (newest.path !== this.file) {
        /* A new session file: Serato has been restarted, or it rolled over
           mid-night. Start at the END of it rather than the beginning — replaying
           an old session would fire the alarm for tracks played hours ago. */
        this.file = newest.path;
        this.offset = newest.size;
        this.tail = Buffer.alloc(0);
        this.stats.filesFollowed++;
        this.emit('status', this.status());
        this.emit('session', { file: this.file, startedAtEnd: true });
        return;
      }

      if (newest.size < this.offset) {
        // The file shrank — Serato compacts it on shutdown. Re-sync.
        this.offset = newest.size;
        this.tail = Buffer.alloc(0);
        return;
      }
      if (newest.size === this.offset) return;       // nothing new

      const fd = fs.openSync(this.file, 'r');
      const want = newest.size - this.offset;
      const buf = Buffer.allocUnsafe(want);
      const read = fs.readSync(fd, buf, 0, want, this.offset);
      fs.closeSync(fd);
      this.offset += read;

      const combined = Buffer.concat([this.tail, buf.subarray(0, read)]);
      const { entries, consumed } = parseChunks(combined);
      this.tail = combined.subarray(consumed);       // keep any partial chunk

      for (const e of entries) {
        this.stats.entriesSeen++;
        /* Serato appends several chunks about the same track as its state
           changes. De-duplicate on the track itself so one load is one event. */
        const key = (e.filepath || '') + '|' + (e.title || '') + '|' + (e.artist || '');
        if (key === this.lastTrackKey) continue;
        this.lastTrackKey = key;
        this.emit('track', e);
      }
      if (entries.length) this.emit('status', this.status());
    } catch (err) {
      this.stats.lastError = err.message;
      this.emit('status', this.status());
    }
  }
}

module.exports = {
  SeratoWatcher,
  findHistoryDir,
  candidateDirs,
  newestSession,
  parseChunks,
  parseAdat,
  readUtf16be,
  FIELD,
};
