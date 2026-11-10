# SHELL-FLUKE-1: add JetBrains Mono 400/700 to web/label-pdf-font.js, beside the Manrope faces that
# label-pdf-font.py generated (left byte-identical: this reads them back and re-emits them as they are).
# Codes and mono caps on the Shell Fluke pack (RAC 27 / 1150, LOT, SIGNAL WORD) print in JetBrains Mono,
# so the PDF needs it too; before this the PDF could only draw Manrope.
# Needs fontTools + brotli (a dev tool, not a repo dependency).
# Usage: python3 tools/fonts/label-pdf-mono.py web/ui-contract/fonts/jetbrains-mono-variable.woff2 web/label-pdf-font.js
# Source: the console's own JetBrains Mono variable woff2 (OFL 1.1, fonts/OFL-jetbrains-mono.txt).
# JetBrains Mono has no rupee sign; the pack never sets a price in mono.
import sys, json, base64, io, re
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import subset
src, out = sys.argv[1], sys.argv[2]
js = open(out).read()
m = re.search(r'var F = (\{.*?\});\n', js, re.S)
faces = json.loads(m.group(1))
chars = list(range(0x20, 0x7F)) + [0x2026, 0x00D7, 0x00B0, 0x2013, 0x2014, 0x00B7, 0x2019, 0x2018, 0x201C, 0x201D, 0x00A0]
for name, w, ps in [('mono', 400, 'JetBrainsMono-Regular'), ('monoBold', 700, 'JetBrainsMono-Bold')]:
    f = instancer.instantiateVariableFont(TTFont(src), {'wght': w})
    f.flavor = None
    opt = subset.Options(); opt.layout_features = []; opt.name_IDs = [0,1,2,3,4,5,6]; opt.hinting = False; opt.desubroutinize = True
    opt.notdef_outline = True; opt.glyph_names = False; opt.name_legacy = True; opt.drop_tables += ['GDEF','GPOS','GSUB','STAT','DSIG']
    sub = subset.Subsetter(opt); sub.populate(unicodes=chars); sub.subset(f)
    for rec in f['name'].names:
        if rec.nameID == 6: rec.string = ps
    f.recalcTimestamp = False
    buf = io.BytesIO(); f.save(buf); data = buf.getvalue()
    upm = f['head'].unitsPerEm; k = 1000 / upm
    cmap = f.getBestCmap(); order = f.getGlyphOrder(); hmtx = f['hmtx']
    faces[name] = {
        'ps': ps, 'bytes': len(data), 'ttf': base64.b64encode(data).decode(),
        'ascent': round(f['hhea'].ascent * k), 'descent': round(f['hhea'].descent * k),
        'cap': round(f['OS/2'].sCapHeight * k),
        'bbox': [round(v * k) for v in (f['head'].xMin, f['head'].yMin, f['head'].xMax, f['head'].yMax)],
        'cmap': {str(cp): order.index(g) for cp, g in sorted(cmap.items())},
        'w': [round(hmtx[g][0] * k) for g in order],
    }
    print(name, len(data), 'bytes ttf', len(order), 'glyphs', file=sys.stderr)
head = js[:m.start()].replace('Manrope for label PDFs --', 'Manrope (and, SHELL-FLUKE-1, JetBrains Mono: tools/fonts/label-pdf-mono.py) for label PDFs --', 1)
js = head + 'var F = ' + json.dumps(faces, separators=(',', ':')) + ';\n' + js[m.end():]
open(out, 'w').write(js)
print('js', len(js), file=sys.stderr)
