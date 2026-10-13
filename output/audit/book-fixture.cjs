// Minimal real EPUB fixtures for deterministic persistence/recovery acceptance.
const crc32 = data => {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
};
function zip(files) {
  const locals = [], central = []; let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const fileName = Buffer.from(name); const data = Buffer.from(value); const crc = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(fileName.length, 26);
    locals.push(header, fileName, data);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(fileName.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, fileName); offset += header.length + fileName.length + data.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function recoveryEpub() {
  const paragraphs = Array.from({ length: 95 }, (_, i) => `<p id="p${i}">Recovery paragraph ${i}. ${'A careful argument distinguishes a claim from its evidence. '.repeat(15)}${i === 94 ? 'LAST-BOOK-CHUNK-MARKER' : ''}</p>`).join('\n');
  return zip({ mimetype: 'application/epub+zip', 'META-INF/container.xml': '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'book.opf': '<package version="3.0" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>典籍准备恢复</dc:title><dc:creator>Audit</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
    'nav.xhtml': '<html><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">Recovery</a></li></ol></nav></body></html>',
    'chapter.xhtml': `<html><body><h1>Recovery</h1>${paragraphs}</body></html>` });
}
module.exports = { recoveryEpub };
