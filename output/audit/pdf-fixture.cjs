const fs = require('node:fs');
function pdf(pages, filename) {
  const objects = [];
  const add = body => { objects.push(body); return objects.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (let i = 0; i < pages; i++) {
    const stream = `BT /F1 24 Tf 40 700 Td (Audit page ${i + 1}: solve x+1=2) Tj ET`;
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${pages} >>`;
  let output = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((obj, i) => { offsets.push(output.length); output += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = output.length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('');
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(filename, output);
}
pdf(2, 'output/audit/two-pages.pdf');
pdf(17, 'output/audit/seventeen-pages.pdf');
pdf(100, 'output/audit/hundred-pages.pdf');
