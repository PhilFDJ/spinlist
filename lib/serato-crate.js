/* Serato .crate binary writer — produces byte-identical output to the
   Spinlist Crate Converter macOS app (Crate-Converter-source), so a crate
   generated on the server drops straight into ~/Music/_Serato_/Subcrates and
   opens in Serato with working tracks.

   Format (reverse-engineered, matches native Serato ScratchLive crates):
     tag  = 4 ASCII bytes + 4-byte big-endian length + payload
     text = UTF-16 BIG-ENDIAN, no BOM
   A crate is: vrsn header, an osrt sort block, ovct column blocks (cosmetic),
   then one otrk→ptrk per track. ptrk holds the file path with the leading
   slash stripped (Serato stores paths relative to the volume root). */

const VERSION = '1.0/Serato ScratchLive Crate';

function tag(name, payload) {
  const head = Buffer.alloc(8);
  head.write(name, 0, 'ascii');        // 4 ASCII bytes
  head.writeUInt32BE(payload.length, 4);
  return Buffer.concat([head, payload]);
}

// UTF-16 big-endian (Node's 'utf16le' is little-endian, so swap byte pairs).
function utf16be(str) {
  const le = Buffer.from(str, 'utf16le');
  const be = Buffer.alloc(le.length);
  for (let i = 0; i < le.length; i += 2) {
    be[i] = le[i + 1];
    be[i + 1] = le[i];
  }
  return be;
}

function text(name, str) {
  return tag(name, utf16be(str));
}

// Serato stores the absolute path with the leading slash removed.
function seratoPath(p) {
  const s = String(p || '');
  return s.startsWith('/') ? s.slice(1) : s;
}

/* Build a .crate buffer from a list of absolute file paths. */
function buildCrate(paths) {
  const parts = [];
  parts.push(text('vrsn', VERSION));

  // Sort + default column view — cosmetic, matches native crates.
  const osrt = Buffer.concat([
    text('tvcn', 'song'),
    tag('brev', Buffer.from([0])),
  ]);
  parts.push(tag('osrt', osrt));

  for (const col of ['song', 'artist', 'album', 'length', 'bpm', 'key', 'comment']) {
    const ovct = Buffer.concat([text('tvcn', col), text('tvcw', '0')]);
    parts.push(tag('ovct', ovct));
  }

  for (const p of paths) {
    if (!p) continue;
    parts.push(tag('otrk', text('ptrk', seratoPath(p))));
  }
  return Buffer.concat(parts);
}

// A safe crate filename (Serato subcrate names avoid path separators).
function crateFilename(name) {
  const clean = String(name || 'Spinlist')
    .replace(/[\/\\:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'Spinlist';
  return clean + '.crate';
}

module.exports = { buildCrate, crateFilename, seratoPath };
