#!/usr/bin/env python3
"""Xbox 360 / Xbox disc image (XDVDFS) reader and extractor, pure Python, no dependencies.

    python tools/xiso.py list    <image.iso>
    python tools/xiso.py extract <image.iso> <out dir> [--only default.xex,*.rcf]

Handles Redump-style full disc dumps (XGD1, XGD2, XGD3: the game partition sits at a known
offset) and trimmed "xiso" images (partition at 0). Every sector address in the file system
is relative to the start of the game partition; a sector is 2048 bytes.

Volume descriptor, at sector 32 of the partition:
    0x000  20 bytes  "MICROSOFT*XBOX*MEDIA"
    0x014  u32 LE    root directory sector
    0x018  u32 LE    root directory size in bytes
    0x01C  u64 LE    creation FILETIME
    0x7EC  20 bytes  "MICROSOFT*XBOX*MEDIA" again

A directory is a binary search tree of entries, each 4-byte aligned:
    u16 left subtree offset (in dwords from the directory start, 0 = none)
    u16 right subtree offset
    u32 start sector, u32 size, u8 attributes (0x10 = directory), u8 name length, name
An entry never crosses a sector boundary: the rest of a sector is padded with 0xFF bytes,
so a left offset of 0xFFFF means "padding".
"""
import fnmatch
import os
import struct
import sys

SECTOR = 2048
MAGIC = b"MICROSOFT*XBOX*MEDIA"
# Game partition offsets of the known disc layouts (0 = a trimmed xiso).
PARTITIONS = {"xiso": 0, "XGD2": 0xFD90000, "XGD1": 0x18300000, "XGD3": 0x2080000}
ATTR_DIR = 0x10


class Image:
    def __init__(self, path):
        self.f = open(path, "rb")
        self.layout = None
        for name, base in PARTITIONS.items():
            self.f.seek(base + 32 * SECTOR)
            vd = self.f.read(SECTOR)
            if len(vd) == SECTOR and vd[:20] == MAGIC and vd[0x7EC:0x800] == MAGIC:
                self.layout, self.base = name, base
                self.root_sector, self.root_size = struct.unpack_from("<II", vd, 0x14)
                break
        if self.layout is None:
            raise ValueError(f"{path}: no XDVDFS volume descriptor (not an Xbox / Xbox 360 game disc image)")

    def read(self, sector, offset, size):
        self.f.seek(self.base + sector * SECTOR + offset)
        return self.f.read(size)

    def walk(self, sector=None, size=None, prefix=""):
        """Yields (path, start sector, size, is_dir), directories before their contents."""
        if sector is None:
            sector, size = self.root_sector, self.root_size
        if size == 0:
            return
        table = self.read(sector, 0, size)
        stack, seen = [0], set()
        entries = []
        while stack:
            off = stack.pop()
            if off in seen or off + 14 > len(table):
                continue
            seen.add(off)
            left, right, start, length, attr, nlen = struct.unpack_from("<HHIIBB", table, off)
            if left == 0xFFFF:  # sector padding
                continue
            name = table[off + 14:off + 14 + nlen].decode("ascii", "replace")
            entries.append((name, start, length, attr))
            if left:
                stack.append(left * 4)
            if right:
                stack.append(right * 4)
        for name, start, length, attr in sorted(entries, key=lambda e: e[0].lower()):
            path = f"{prefix}{name}"
            if attr & ATTR_DIR:
                yield path, start, length, True
                yield from self.walk(start, length, path + "/")
            else:
                yield path, start, length, False

    def copy_to(self, start, length, dst, chunk=8 << 20):
        self.f.seek(self.base + start * SECTOR)
        with open(dst, "wb") as out:
            left = length
            while left:
                buf = self.f.read(min(chunk, left))
                if not buf:
                    raise IOError(f"image truncated while copying to {dst}")
                out.write(buf)
                left -= len(buf)


def main(argv):
    if len(argv) < 2 or argv[0] not in ("list", "extract"):
        print(__doc__.split("\n\n")[1])
        return 2
    img = Image(argv[1])
    print(f"{argv[1]}: {img.layout} layout, partition at 0x{img.base:X}", file=sys.stderr)
    if argv[0] == "list":
        for path, start, length, is_dir in img.walk():
            print(f"{'<dir>' if is_dir else length:>12}  {path}")
        return 0
    if len(argv) < 3:
        print("extract needs an output directory", file=sys.stderr)
        return 2
    out = os.path.abspath(argv[2])
    only = None
    if "--only" in argv:
        only = argv[argv.index("--only") + 1].split(",")
    total = 0
    for path, start, length, is_dir in img.walk():
        if ".." in path.split("/"):
            raise ValueError(f"unsafe path in image: {path}")
        dst = os.path.join(out, *path.split("/"))
        if is_dir:
            if only is None:
                os.makedirs(dst, exist_ok=True)
            continue
        if only is not None and not any(fnmatch.fnmatch(path.lower(), p.lower()) for p in only):
            continue
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        img.copy_to(start, length, dst)
        total += length
        print(f"{length:>12}  {path}", file=sys.stderr)
    print(f"extracted {total / 1e9:.2f} GB to {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
