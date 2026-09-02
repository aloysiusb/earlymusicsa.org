/**
 * multipart.js — just enough multipart/form-data to accept one image from the
 * submit form. No dependencies, in keeping with the rest of the project.
 *
 * Everything here works on Buffers rather than strings. Decoding a JPEG as
 * UTF-8 to find the boundaries would corrupt it, which is the usual way a
 * hand-rolled parser quietly mangles uploads.
 */

/** The boundary token from a Content-Type header, or null if absent. */
export function boundaryOf(contentType = '') {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const b = m && (m[1] || m[2]);
  return b ? b.trim() : null;
}

/** Index of `needle` in `buf` at or after `from`, or -1. */
function indexOf(buf, needle, from = 0) {
  return buf.indexOf(needle, from);
}

/**
 * Split a multipart body into fields and files.
 * Returns { fields: { name: value }, files: [{ field, filename, type, data }] }.
 * Repeated field names are joined with a comma, matching how the urlencoded
 * parser treats the event-type checkboxes.
 */
export function parseMultipart(body, boundary) {
  const fields = {};
  const files = [];
  if (!boundary) return { fields, files };

  const delim = Buffer.from(`--${boundary}`);
  const out = { fields, files };

  let pos = indexOf(body, delim);
  if (pos < 0) return out;
  pos += delim.length;

  while (pos < body.length) {
    // "--" straight after a delimiter marks the end of the body.
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;

    // Skip the CRLF that follows the delimiter.
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;

    const headerEnd = indexOf(body, Buffer.from('\r\n\r\n'), pos);
    if (headerEnd < 0) break;

    const rawHeaders = body.slice(pos, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;

    const next = indexOf(body, delim, bodyStart);
    if (next < 0) break;

    // The CRLF immediately before the next delimiter belongs to the delimiter.
    let contentEnd = next;
    if (body[contentEnd - 2] === 0x0d && body[contentEnd - 1] === 0x0a) contentEnd -= 2;

    const disposition = /content-disposition:[^\n]*/i.exec(rawHeaders)?.[0] || '';
    const field = /name="([^"]*)"/i.exec(disposition)?.[1];
    const filename = /filename="([^"]*)"/i.exec(disposition)?.[1];
    const type = /content-type:\s*([^\r\n;]+)/i.exec(rawHeaders)?.[1]?.trim() || '';

    if (field) {
      const data = body.slice(bodyStart, contentEnd);
      if (filename !== undefined) {
        // A file input left empty still sends a part, with no filename.
        if (filename && data.length) files.push({ field, filename, type, data });
      } else {
        const value = data.toString('utf8');
        fields[field] = fields[field] === undefined ? value : `${fields[field]},${value}`;
      }
    }

    pos = next + delim.length;
  }

  return out;
}

/**
 * Identify an image by its leading bytes rather than by what the browser
 * claims. A file named .jpg with a Content-Type of image/jpeg can still be
 * anything at all; the magic number is the part that is hard to lie about.
 */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: 'png', mime: 'image/png' };
  }
  if (buf.slice(0, 6).toString('latin1') === 'GIF87a'
      || buf.slice(0, 6).toString('latin1') === 'GIF89a') {
    return { ext: 'gif', mime: 'image/gif' };
  }
  if (buf.slice(0, 4).toString('latin1') === 'RIFF'
      && buf.slice(8, 12).toString('latin1') === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' };
  }
  return null;
}
