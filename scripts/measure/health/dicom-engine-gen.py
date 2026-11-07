"""dicom-engine-gen.py - synthetic DICOM + STOW-RS body generator (LHDS W0-2).

Usage: python -I dicom-engine-gen.py OUTDIR COUNT SEED ROWS [FIRST_INDEX]

Instances are CT Image Storage, Explicit VR Little Endian, 16-bit MONOCHROME2,
ROWS x ROWS pixels of seeded pseudo-random bytes (incompressible = worst case for
the store; ROWS=512 gives a 512 KiB pixel payload, the ADR-002 pass-bar size).
NO patient data: names/IDs are fabricated tokens (SYNTHETIC^nnnnnn), all UIDs are
2.25.<random> from the seeded PRNG, so the same SEED reproduces the same UIDs.

Emits in OUTDIR:
  body-NNNNN.mp   STOW-RS multipart/related request body (boundary LHDSW0BOUNDARY)
  inst-NNNNN.dcm  plain Part-10 file, first 3 instances only (for the real-tool pass)
  uids.tsv        idx <TAB> studyUID <TAB> seriesUID <TAB> sopUID <TAB> dicom_bytes
Ten consecutive indexes share one study/series.
"""

import os
import random
import struct
import sys

out, n, seed, rows = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
first = int(sys.argv[5]) if len(sys.argv) > 5 else 1
if n < 1 or rows < 1:
    sys.exit("COUNT and ROWS must be >= 1")

BOUNDARY = b"LHDSW0BOUNDARY"
CT = "1.2.840.10008.5.1.4.1.1.2"
rnd = random.Random(seed)


def uid():
    return "2.25." + str(rnd.getrandbits(100))


def el(g, e, vr, val):
    if vr in ("OB", "OW", "SQ", "UN", "UT"):
        return struct.pack("<HH2sHI", g, e, vr.encode(), 0, len(val)) + val
    return struct.pack("<HH2sH", g, e, vr.encode(), len(val)) + val


def s(g, e, vr, text):
    b = text.encode("ascii")
    if len(b) % 2:
        b += b"\0" if vr == "UI" else b" "
    return el(g, e, vr, b)


def us(g, e, v):
    return el(g, e, "US", struct.pack("<H", v))


os.makedirs(out, exist_ok=True)
study = series = None
with open(os.path.join(out, "uids.tsv"), "a", newline="\n") as tsv:
    for k in range(n):
        idx = first + k
        if study is None or (idx - 1) % 10 == 0:
            study, series = uid(), uid()
        sop = uid()
        grp = (idx - 1) // 10
        ds = b"".join(
            [
                s(0x08, 0x16, "UI", CT),
                s(0x08, 0x18, "UI", sop),
                s(0x08, 0x20, "DA", "20260101"),
                s(0x08, 0x50, "SH", ""),
                s(0x08, 0x60, "CS", "CT"),
                s(0x10, 0x10, "PN", f"SYNTHETIC^{grp:06d}"),
                s(0x10, 0x20, "LO", f"SYNTH{grp:06d}"),
                s(0x20, 0x0D, "UI", study),
                s(0x20, 0x0E, "UI", series),
                s(0x20, 0x10, "SH", f"S{grp:d}"),
                s(0x20, 0x11, "IS", "1"),
                s(0x20, 0x13, "IS", str(idx)),
                us(0x28, 0x02, 1),
                s(0x28, 0x04, "CS", "MONOCHROME2"),
                us(0x28, 0x10, rows),
                us(0x28, 0x11, rows),
                us(0x28, 0x100, 16),
                us(0x28, 0x101, 16),
                us(0x28, 0x102, 15),
                us(0x28, 0x103, 0),
                el(0x7FE0, 0x10, "OW", rnd.randbytes(rows * rows * 2)),
            ]
        )
        meta_rest = b"".join(
            [
                el(0x02, 0x01, "OB", b"\x00\x01"),
                s(0x02, 0x02, "UI", CT),
                s(0x02, 0x03, "UI", sop),
                s(0x02, 0x10, "UI", "1.2.840.10008.1.2.1"),
                s(0x02, 0x12, "UI", "2.25.1"),
            ]
        )
        meta = el(0x02, 0x00, "UL", struct.pack("<I", len(meta_rest))) + meta_rest
        dcm = b"\0" * 128 + b"DICM" + meta + ds
        body = (
            b"--" + BOUNDARY + b"\r\nContent-Type: application/dicom\r\n\r\n" + dcm + b"\r\n--" + BOUNDARY + b"--\r\n"
        )
        with open(os.path.join(out, f"body-{idx:05d}.mp"), "wb") as f:
            f.write(body)
        if k < 3:
            with open(os.path.join(out, f"inst-{idx:05d}.dcm"), "wb") as f:
                f.write(dcm)
        tsv.write(f"{idx:d}\t{study}\t{series}\t{sop}\t{len(dcm):d}\n")
print(f"generated {n:d} instances, {len(dcm):d} bytes each (DICOM file)")
