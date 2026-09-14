#!/usr/bin/env python3
# Regenerate the donation QR in public/index.html (the <svg class="abqr">) from the address below,
# with OpenCV's encoder, and check the modules written decode back to the address. Run by hand when
# the address changes; the SVG is committed, so nothing is generated at run time or in the browser.
import cv2, numpy as np, re, sys
ADDR = 'bc1q249cv27lc2q7y0x53vkczgfvvgsjzhwxwv42gc'
img = cv2.QRCodeEncoder.create().encode(ADDR)
n = img.shape[0]; size = n + 8
d = ''.join(f'M{x+4} {y+4}h1v1h-1z' for y in range(n) for x in range(n) if img[y, x] == 0)
m = np.full((size * 8, size * 8), 255, np.uint8)
for mm in re.finditer(r'M(\d+) (\d+)h1v1h-1z', d):
    x, y = int(mm.group(1)), int(mm.group(2)); m[y*8:(y+1)*8, x*8:(x+1)*8] = 0
data, _, _ = cv2.QRCodeDetector().detectAndDecode(m)
if data != ADDR: sys.exit(f'the QR does not decode to the address: {data!r}')
svg = f'<svg class="abqr" viewBox="0 0 {size} {size}" width="132" height="132" role="img" aria-label="QR code of the donation address" shape-rendering="crispEdges"><rect width="{size}" height="{size}" fill="#fff"/><path fill="#000" d="{d}"/></svg>'
p = 'public/index.html'; s = open(p).read()
s2 = re.sub(r'<svg class="abqr".*?</svg>', svg, s, count=1, flags=re.S)
if s2 == s and svg not in s: sys.exit('no <svg class="abqr"> in public/index.html to replace')
open(p, 'w').write(s2)
print(f'{n}x{n} modules, decodes to {data}')
