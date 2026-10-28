"""Retain real browser pixels and metrics when an independent visual check fails."""
import base64
import json
import os
import struct
import zlib
from pathlib import Path


def mask_png(value):
    """Encode browser-provided packed masks with stdlib, without imaging deps."""
    width, height, depth = (value[k] for k in ('width', 'height', 'depth'))
    assert depth in (1, 2) and (width, height) == (630, 430), value
    pixels = base64.b64decode(value['base64'])
    stride = (width * depth + 7) // 8
    assert len(pixels) == stride * height
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, depth, 0 if depth == 1 else 3, 0, 0, 0))
    if depth == 2:
        png += chunk(b'PLTE', bytes([0, 0, 0, 255, 0, 0, 0, 255, 0, 255, 255, 0]))
    rows = b''.join(b'\0' + pixels[y*stride:(y+1)*stride] for y in range(height))
    return png + chunk(b'IDAT', zlib.compress(rows, 9)) + chunk(b'IEND', b'')


def save_editor_diagnostics(value, label):
    if not value:
        return
    value = dict(value)
    images = value.pop('images', {})
    masks = value.pop('masks', {})
    folder = Path(os.environ.get('EDITOR_DIAGNOSTICS', 'test-results/editor-canvas')) / label
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'metrics.json').write_text(json.dumps(value, ensure_ascii=False, indent=2))
    print('::notice title=Editor Canvas diagnostic metrics::' + json.dumps(value, ensure_ascii=False), flush=True)
    for name, data in images.items():
        (folder / (name + '.png')).write_bytes(base64.b64decode(data.split(',', 1)[1]))
    for name, mask in masks.items():
        png = mask_png(mask)
        (folder / (name + '.png')).write_bytes(png)
        # Small lossless masks remain inspectable in public CI annotations even
        # when GitHub artifact downloads require authentication. Chunk them below
        # the 4096-character per-annotation truncation limit.
        encoded = base64.b64encode(png).decode()
        for index in range(0, len(encoded), 3000):
            print('::notice title=Editor Canvas diagnostic ' + name + ' part ' + str(index // 3000) + '::' + encoded[index:index+3000], flush=True)
