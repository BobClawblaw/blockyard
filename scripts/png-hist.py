#!/usr/bin/env python3
"""Decode a PNG the harness wrote and report its colour histogram.

Why this exists: the map's crowd texture is a ~16% alpha overlay. If the sampling path
screenshots a blank or cleared canvas, it reads as exactly one colour, and "the map is
flat" becomes indistinguishable from "the probe measured nothing". A histogram from the
bytes on disk is the ground truth for whether anything varies.
"""
import struct
import sys
import zlib

path = sys.argv[1]
d = open(path, "rb").read()
i = 8
w = h = bd = ct = 0
idat = b""
while i + 8 <= len(d):
    ln = struct.unpack(">I", d[i:i + 4])[0]
    typ = d[i + 4:i + 8]
    data = d[i + 8:i + 8 + ln]
    i += 12 + ln
    if typ == b"IHDR":
        w, h, bd, ct = struct.unpack(">II", data[:8]) + (data[8], data[9])
    elif typ == b"IDAT":
        idat += data
raw = zlib.decompress(idat)
bpp = {0: 1, 2: 3, 4: 2, 6: 4}[ct]
stride = w * bpp
rows = [bytearray(stride) for _ in range(h)]
prev = bytearray(stride)
pos = 0
for y in range(h):
    f = raw[pos]
    pos += 1
    line = bytearray(raw[pos:pos + stride])
    pos += stride
    if f == 1:
        for k in range(bpp, stride):
            line[k] = (line[k] + line[k - bpp]) & 255
    elif f == 2:
        for k in range(stride):
            line[k] = (line[k] + prev[k]) & 255
    elif f == 3:
        for k in range(stride):
            a = line[k - bpp] if k >= bpp else 0
            line[k] = (line[k] + ((a + prev[k]) >> 1)) & 255
    elif f == 4:
        for k in range(stride):
            a = line[k - bpp] if k >= bpp else 0
            b2 = prev[k]
            c2 = prev[k - bpp] if k >= bpp else 0
            pp = a + b2 - c2
            pa, pb, pc = abs(pp - a), abs(pp - b2), abs(pp - c2)
            pr = a if (pa <= pb and pa <= pc) else (b2 if pb <= pc else c2)
            line[k] = (line[k] + pr) & 255
    rows[y] = line
    prev = line
vals = sorted(set(rows[y][x * bpp] for y in range(h) for x in range(w)))
print(f"{w}x{h} bitdepth {bd} colortype {ct}: distinct R values {len(vals)}")
cols = [sum(rows[y][x * bpp] for y in range(h)) // max(1, h) for x in range(w)]
print("column means:", cols[:24])
