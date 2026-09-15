#!/usr/bin/env python3
# Regenerate the donation QR (public/donate-qr.png, 4 px a module with the 4-module quiet zone) from
# the address below, with OpenCV's encoder, and check the modules written decode back to the address.
# Run by hand when the address changes; the PNG is committed, so nothing is generated at run time or
# in the browser. It was an inline SVG until 2026-09-15, when Safari painted its ground and none of
# its module rects; a bitmap is painted the same everywhere.
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
png = np.full((size * 4, size * 4), 255, np.uint8)
for mm in re.finditer(r'M(\d+) (\d+)h1v1h-1z', d):
    x, y = int(mm.group(1)), int(mm.group(2)); png[y*4:(y+1)*4, x*4:(x+1)*4] = 0
cv2.imwrite('public/donate-qr.png', png)
check, _, _ = cv2.QRCodeDetector().detectAndDecode(cv2.imread('public/donate-qr.png'))
if check != ADDR: sys.exit(f'the PNG does not decode to the address: {check!r}')
print(f'{n}x{n} modules, public/donate-qr.png decodes to {check}')
