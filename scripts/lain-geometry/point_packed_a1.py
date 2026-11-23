"""A1 layout: snapshot row order, dimension fastest, LSB-first codes and bytes.
Only the final byte may be zero-padded. No headers or alignment gaps in payload.
"""
import hashlib
import json
import sys
import tempfile
from pathlib import Path

import numpy as np
from starry_field_probe import checked

PLATE = 'cb52dcface7e4fbd991fe363b365358277c8f197fbfb0245cc8f89054cdbae73'


def pack(codes, bits):
    if bits not in (2, 3) or codes.dtype != np.uint8 or np.any(codes >= 1 << bits):
        raise ValueError('invalid code or width')
    planes = (codes.reshape(-1, 1) >> np.arange(bits, dtype=np.uint8)) & 1
    return np.packbits(planes.ravel(), bitorder='little').tobytes()


def scalar_decode(data, count, bits):
    if bits not in (2, 3) or count < 0 or len(data) != (count * bits + 7) // 8:
        raise ValueError('bad compact stream length')
    out = bytearray(count)
    reservoir = available = offset = 0
    for i in range(count):
        if available < bits:
            reservoir |= data[offset] << available
            offset += 1
            available += 8
        out[i] = reservoir & ((1 << bits) - 1)
        reservoir >>= bits
        available -= bits
    if reservoir:
        raise ValueError('nonzero final padding')
    return out


def selftest():
    for bits, values, wire in [(2, [0, 1, 2, 3], b'\xe4'),
                                (3, list(range(8)), b'\x88\xc6\xfa')]:
        if pack(np.array(values, 'u1'), bits) != wire or list(scalar_decode(wire, len(values), bits)) != values:
            raise ValueError('wire fixture failed')
        for size in range(66):
            codes = (np.arange(size, dtype='u1') * 5 + 1) % (1 << bits)
            raw = pack(codes, bits)
            if scalar_decode(raw, size, bits) != codes.tobytes():
                raise ValueError('tail mismatch')
            if size * bits % 8:
                broken = raw[:-1] + bytes([raw[-1] | 128])
                try:
                    scalar_decode(broken, size, bits)
                except ValueError:
                    pass
                else:
                    raise ValueError('dirty padding accepted')
    # Right insertion skips empty buckets, including tied quartiles.
    cuts = np.array([1, 1, 1, 2, 2, 2, 2], dtype='f4')
    x = np.array([0, 1, 2, 3], dtype='f4')
    b = (x[:, None] >= cuts).sum(1).astype('u1')
    if b.tolist() != [0, 3, 7, 7] or not np.array_equal(b >> 1, cuts[1::2].searchsorted(x, 'right')):
        raise ValueError('duplicate cut contract')


def main(root):
    selftest()
    root = root.resolve()
    if any((p / '.git').exists() for p in (root, *root.parents)):
        raise ValueError('private output required')
    dest = root / 'point-packed-a1-v1'
    if dest.exists():
        raise FileExistsError(dest)
    pd = root / 'plate-a'
    plate = json.loads(checked(pd / 'plate.json', PLATE))
    def read(key, dtype):
        a = plate['arrays'][key]
        return np.frombuffer(checked(pd / a['file'], a['sha256']), dtype)
    ids = read('ids', '<u8')
    n, d = len(ids), plate['dimensions']
    x = read('vectors', '<f4').reshape(n, d)
    if (n, d) != (6849, 3072) or not np.isfinite(x).all() or len(np.unique(ids)) != n:
        raise ValueError('unexpected inputs')
    sx = np.sort(x, axis=0)
    cuts = np.ascontiguousarray(sx[[(n-1)*j//8 for j in range(1, 8)]], dtype='<f4')
    del sx
    m = dict(format='lain-point-packed-v1', plateSha256=PLATE,
             idsSha256=plate['arrays']['ids']['sha256'], vectorsSha256=plate['arrays']['vectors']['sha256'],
             shape=[n,d], order='snapshot rows; dimensions fastest; low bit first; final zero pad',
             cutsFile='cuts8.f32le', cutsShape=[7,d], cutsSha256=hashlib.sha256(cuts.tobytes()).hexdigest(),
             payloads={})
    with tempfile.TemporaryDirectory(dir=root, prefix='a1-build-') as temp:
        stage = Path(temp) / 'verified'
        stage.mkdir()
        (stage / m['cutsFile']).write_bytes(cuts.tobytes())
        for bits in (2, 3):
            edges = cuts if bits == 3 else cuts[1::2]
            path = stage / f'codes-{bits}.bin'
            # Every nonfinal chunk ends on a byte boundary in this frozen layout.
            with path.open('xb') as f:
                for i in range(0, n, 64):
                    part = x[i:i+64]
                    codes = np.zeros(part.shape, 'u1')
                    for edge in edges:
                        codes += part >= edge
                    f.write(pack(codes, bits))
            raw = path.read_bytes()
            decoded = np.frombuffer(scalar_decode(raw, n*d, bits), 'u1').reshape(n,d)
            # Independent oracle: binary search each column, not the packer's comparisons.
            for j in range(d):
                if not np.array_equal(decoded[:,j], edges[:,j].searchsorted(x[:,j], 'right')):
                    raise ValueError(f'wrong code: width={bits}, dim={j}')
            m['payloads'][str(bits)] = dict(file=path.name, bytes=len(raw),
                sha256=hashlib.sha256(raw).hexdigest(), verifiedCodes=n*d)
        (stage/'manifest.json').write_text(json.dumps(m, indent=2), encoding='utf8')
        stage.rename(dest)
    print(json.dumps(m))

if __name__ == '__main__':
    main(Path(sys.argv[1]))