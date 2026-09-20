# Re-assembles the portal app: splices the edited component into the mockup's bundler template
# (untouched runtime + fonts + design), then injects PWA hooks + the integration layer.
# The component's </script> must be re-escaped so it doesn't close the outer __bundler/template
# <script>; JSON.parse restores it for the runtime. Run: python web/build/build.py
import re, json, os
BASE = "D:/All Project/ALL_Claude_products/Raw_Aroma"
WEB = f"{BASE}/app/web"
std = open(f"{BASE}/mockup/Raw Aroma Portal (standalone).html", encoding="utf-8").read()
comp = open(f"{WEB}/build/component.src.js", encoding="utf-8").read()

# 1) locate the __bundler/template script + its JSON-string content boundaries
m = re.search(r'(<script type="__bundler/template">)(.*?)(</script>\s*)', std, re.S)
tpl = json.loads(m.group(2))  # decoded template HTML

# 2) replace the component <script> body inside the template with the edited component
cm = re.search(r'(<script(?![^>]*src)[^>]*>)(.*?)(</script>)', tpl, re.S)
tpl2 = tpl[:cm.start(2)] + "\n" + comp + "\n" + tpl[cm.end(2):]

# 2b) inject PWA <link rel=manifest> + theme-color into the template's <helmet> (survives head swap)
hel = re.search(r'(<helmet>)', tpl2)
if hel:
    inj = '<helmet><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#117C66">'
    tpl2 = tpl2[:hel.start()] + inj + tpl2[hel.end():]

# 3) re-encode the template as a JSON string, escaping </ so the outer <script> isn't closed early
enc = json.dumps(tpl2)
enc = enc.replace("</", "<\\/")
std2 = std[:m.start(2)] + enc + std[m.end(2):]

# 4) inject viewport + SW registration + the integration layer before </html>
import os as _os
SW_ENABLED = _os.environ.get('RA_SW', '0') == '1'  # off during dev (caching fights iteration); on for offline build
sw_reg = ("if('serviceWorker'in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){});});}" if SW_ENABLED else "")
INT_ENABLED = _os.environ.get('RA_INT', '1') == '1'
int_tag = ('<script src="/ra-integration.js?b=' + str(len(open(f"{WEB}/ra-integration.js", encoding="utf-8").read())) + '"></script>\n') if INT_ENABLED else ''
boot = (
    '\n<script>'
    + sw_reg +
    "window.RA=window.RA||{};window.RA.api=location.origin.replace(/:\\d+$/,':3000');"
    '</script>\n'
    + int_tag
)
if '</html>' in std2:
    std2 = std2.replace('</html>', boot + '</html>', 1)
else:
    std2 += boot

# ensure a responsive viewport meta exists in the outer head
if 'name="viewport"' not in std2[:2000]:
    std2 = std2.replace('<head>', '<head>\n  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">', 1)

open(f"{WEB}/index.html", "w", encoding="utf-8").write(std2)
print("web/index.html written:", len(std2), "chars | component spliced:", len(comp), "chars")
