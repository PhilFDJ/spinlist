// Extracts candidate venue contacts from Excel, Word, or PDF files.
// Excel is read as proper tabular data (reliable). Word/PDF are read as text and
// mined with patterns (best-effort) — the dashboard shows results for review/edit
// before anything is saved, so imperfect extraction is corrected by a human.

import * as XLSX from "xlsx";
import mammoth from "mammoth";

// pdf-parse is CommonJS; import its implementation directly to avoid its debug
// harness running on import.
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const norm = (s) => (s || "").toString().trim();

// ---- field pickers for tabular (Excel) rows ----
const normKey = (s) => norm(s).toLowerCase().replace(/\s+/g, " ");
function pick(row, candidates) {
  const keys = Object.keys(row);
  for (const c of candidates) {
    const hit = keys.find((k) => normKey(k) === normKey(c));
    if (hit) return norm(row[hit]);
  }
  for (const c of candidates) {
    const hit = keys.find((k) => normKey(k).includes(normKey(c)));
    if (hit) return norm(row[hit]);
  }
  return "";
}

// ---- Excel: structured, reliable ----
function fromExcel(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const out = [];
  const seen = new Set(); // de-dupe by venue, first occurrence wins
  for (const sheetName of wb.SheetNames) {
    // Read as rows-of-arrays first so we can find the real header row (some files
    // put a title on line 1 above the headers).
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: "" });
    if (!grid.length) continue;

    const hintRe = /venue|park|location|place|site|contact|name|phone|number|tel|email/i;
    let headerIdx = 0;
    for (let i = 0; i < Math.min(grid.length, 10); i++) {
      const hits = grid[i].filter((c) => hintRe.test(String(c))).length;
      if (hits >= 2) { headerIdx = i; break; }
    }
    const headers = grid[headerIdx].map((h) => String(h).trim());

    for (let i = headerIdx + 1; i < grid.length; i++) {
      const r = {};
      headers.forEach((h, j) => { r[h] = grid[i][j]; });
      const venue = titleIfUpper(pick(r, ["venue", "location", "place", "site", "park"]));
      const contact = titleIfUpper(pick(r, ["contact", "contact name", "manager", "name", "who"]));
      const phone = pick(r, ["phone", "mobile", "tel", "number", "telephone"]);
      const email = pick(r, ["email", "e-mail"]);
      const address = pick(r, ["address", "addr", "postcode"]);
      if (!(venue || contact || phone || email)) continue;
      const key = venue.toLowerCase();
      if (venue && seen.has(key)) continue; // keep only first contact per venue
      if (venue) seen.add(key);
      out.push({ venue, contact, phone, email, address, confidence: "high" });
    }
  }
  return out;
}

// Title-case a value only if it's written in ALL CAPS (so "TOM LEE" -> "Tom Lee"
// but a normal "Tom Lee" or a code is left alone).
function titleIfUpper(s) {
  const v = norm(s);
  if (!v) return v;
  const letters = v.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 2 && letters === letters.toUpperCase()) {
    return v.replace(/\w\S*/g, (t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
  }
  return v;
}

// ---- text mining for Word / PDF ----
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
// UK phone numbers: +44 or 0 lead, then 9–11 digits with optional spaces/hyphens.
const PHONE_RE = /(?:\+44\s?|0)\d(?:[\s-]?\d){8,10}/;
const ROLE_RE = /\b(general manager|f&b manager|food & beverage manager|experience manager|guest experience mgr|commercial manager|entertainment manager|complex manager|retail manager|ents manager|ents assistant|gen manager|holiday sales manager|acting entertainment manager|technician|tech lead|manager|owners?|current contact|tel|tbc|point of contact|guest acts)\b/gi;
// All-caps fragments that are roles, not venue names.
const NOT_VENUE = new Set(["F&B", "TBC", "GM", "POINT", "EXPERIENCE", "MANAGER", "OWNERS", "OWNER", "FOOD"]);

// Decide if a line starts with an UPPERCASE venue header; return the raw header text.
function venueHeader(line) {
  if (EMAIL_RE.test(line)) return null; // headers never carry an email
  const m = line.match(/^([A-Z][A-Z0-9&'\- ]{1,}?)(?=\s+[-\u2013|]|\s+[A-Z][a-z]|$)/);
  if (!m) return null;
  const cand = m[1].replace(/^[\s\-\u2013|]+|[\s\-\u2013|]+$/g, "");
  const letters = cand.replace(/[^A-Za-z]/g, "");
  if (letters.length < 2 || letters !== letters.toUpperCase()) return null;
  const words = cand.split(/[\s&]+/).filter(Boolean);
  if (words.length && words.every((w) => NOT_VENUE.has(w))) return null;
  return cand;
}

function tidyVenue(header) {
  // strip a trailing site code like " - CLE" and Title-Case the result
  const v = header.replace(/\s*-\s*[A-Z]{2,4}\s*$/, "").trim();
  return v.replace(/\w\S*/g, (t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
}

function mineInto(line, cur) {
  const em = line.match(EMAIL_RE);
  const ph = line.match(PHONE_RE);
  if (em && !cur.email) cur.email = em[0];
  if (ph && !cur.phone) cur.phone = ph[0].replace(/\s+/g, "");
  if (!cur.contact) {
    let t = line.replace(PHONE_RE, "").replace(EMAIL_RE, "").replace(/\(.*?\)/g, "");
    t = t.replace(ROLE_RE, "").replace(/^[\s\-\u2013|,]+|[\s\-\u2013|,]+$/g, "");
    const nm = t.match(/^[A-Za-z][A-Za-z'\-]+\s+[A-Za-z][A-Za-z'\-]+/);
    if (nm) cur.contact = nm[0].trim();
  }
}

// A "single-line record" is a whole contact on one line, e.g.:
//   BERWICK (BE) AJ NIELSON aj.nielson@haven.com 07943936215
//   Barmston Beach Entertainment Manager Claire Pritchard 07944433209
// We pull email + phone out, then split the remaining text into venue (before the
// name/role) and contact name.
function parseSingleLine(line) {
  const em = line.match(EMAIL_RE);
  const ph = line.match(PHONE_RE);
  if (!em && !ph) return null;

  let rest = line.replace(EMAIL_RE, "").replace(PHONE_RE, "").trim();
  // drop trailing "or 07..." style second numbers and free-text notes after the first phone
  rest = rest.replace(/\b(or|from|acts must|peak times|preferred method).*$/i, "").trim();

  // strip a bracketed site code e.g. "(BE)" or "(Prev Allhallows)"
  rest = rest.replace(/\(.*?\)/g, " ").replace(/\s{2,}/g, " ").trim();

  // remove role phrases so they don't end up in the name
  const cleaned = rest.replace(ROLE_RE, "|ROLE|");

  let venue = "", contact = "";
  if (cleaned.includes("|ROLE|")) {
    // venue is before the role, contact is after
    const [before, after] = cleaned.split("|ROLE|").map((s) => s.replace(/\|ROLE\|/g, "").trim());
    venue = before.replace(/[-\u2013:|]+$/, "").trim();
    const nm = (after || "").match(/[A-Za-z][A-Za-z'\-]+(?:\s+[A-Za-z][A-Za-z'\-]+)?/);
    contact = nm ? nm[0].trim() : "";
  } else {
    // No explicit role. The text is either "VENUE NAME" or just "VENUE" (no contact
    // name, e.g. casino rows that are venue + email only).
    const nameMatch = rest.match(/([A-Z][a-zA-Z'\-]+(?:\s+[A-Z][a-zA-Z'\-]+)?)\s*$/);
    if (nameMatch && nameMatch.index > 0) {
      // Only treat the trailing words as a name if there's venue text before them.
      contact = nameMatch[1].trim();
      venue = rest.slice(0, nameMatch.index).trim();
      // If splitting left no venue, the whole thing was the venue (no name present).
      if (!venue) { venue = rest; contact = ""; }
    } else {
      venue = rest;
    }
  }
  venue = venue.replace(/[-\u2013:|,]+$/, "").trim();
  return {
    venue: tidyVenue(venue),
    contact: tidyVenue(contact),
    phone: ph ? ph[0].replace(/\s+/g, "") : "",
    email: em ? em[0] : "",
    address: "",
    confidence: "low",
  };
}

// How many lines look like complete single-line records (have BOTH a contact
// detail AND text before it)? Used to pick the parsing strategy.
function looksSingleLine(lines) {
  let hits = 0;
  for (const l of lines) {
    const hasContact = EMAIL_RE.test(l) || PHONE_RE.test(l);
    const hasLead = /^[A-Za-z]/.test(l) && l.replace(EMAIL_RE, "").replace(PHONE_RE, "").trim().length > 6;
    if (hasContact && hasLead) hits++;
  }
  return hits >= Math.max(3, lines.length * 0.5);
}

function fromText(text) {
  const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);

  // If most lines are self-contained records, parse line-by-line.
  if (looksSingleLine(lines)) {
    const out = [];
    for (const line of lines) {
      // skip obvious header/title lines
      if (/^(park|venue|name|role|firstname|surname|contact|247 support|\d{4} )/i.test(line)
          && !(EMAIL_RE.test(line) || PHONE_RE.test(line))) continue;
      const rec = parseSingleLine(line);
      if (rec && (rec.email || rec.phone) && rec.venue) out.push(rec);
    }
    if (out.length) return out;
  }

  // Otherwise treat as multi-line blocks (Away Resorts style).
  const out = [];
  let cur = null;
  for (const line of lines) {
    const vh = venueHeader(line);
    if (vh) {
      if (cur && (cur.email || cur.phone)) out.push(cur);
      cur = { venue: tidyVenue(vh), contact: "", phone: "", email: "", address: "", confidence: "low" };
      const rest = line.slice(vh.length);
      if (rest.trim()) mineInto(rest, cur);
      continue;
    }
    if (!cur) continue;
    mineInto(line, cur);
  }
  if (cur && (cur.email || cur.phone)) out.push(cur);
  return out;
}

async function fromWord(buffer) {
  const { value } = await mammoth.extractRawText({ buffer });
  return fromText(value || "");
}

async function fromPdf(buffer) {
  // Load pdf-parse lazily so a malformed PDF can't crash startup.
  const pdfParse = require("pdf-parse");
  const data = await pdfParse(buffer);
  const text = data.text || "";
  if (text.replace(/\s/g, "").length < 20) {
    // Almost no text — likely a scanned image PDF we can't read without OCR.
    return { contacts: [], warning: "scanned" };
  }
  return { contacts: fromText(text) };
}

// ---- main entry ----
export async function extractContacts(file) {
  const name = (file.originalname || "").toLowerCase();
  const buffer = file.buffer;

  if (name.endsWith(".xlsx") || name.endsWith(".xls") || name.endsWith(".xlsm")) {
    return { contacts: fromExcel(buffer), kind: "excel" };
  }
  if (name.endsWith(".docx")) {
    return { contacts: await fromWord(buffer), kind: "word" };
  }
  if (name.endsWith(".pdf")) {
    const res = await fromPdf(buffer);
    return { contacts: res.contacts, kind: "pdf", warning: res.warning };
  }
  if (name.endsWith(".csv")) {
    // handled elsewhere, but support it here too for the review flow
    const text = buffer.toString("utf8");
    const Papa = (await import("papaparse")).default;
    const rows = Papa.parse(text.replace(/^\uFEFF/, ""), { header: true, skipEmptyLines: "greedy" }).data;
    const out = rows.map((r) => ({
      venue: pick(r, ["venue", "location", "place"]),
      contact: pick(r, ["contact", "manager", "name"]),
      phone: pick(r, ["phone", "mobile", "tel", "number"]),
      email: pick(r, ["email"]),
      address: pick(r, ["address", "addr"]),
      confidence: "high",
    })).filter((c) => c.venue || c.email || c.phone);
    return { contacts: out, kind: "csv" };
  }
  return { contacts: [], kind: "unknown", warning: "unsupported" };
}
