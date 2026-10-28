"""Retain real browser pixels and metrics when an independent visual check fails."""
import base64
import json
import os
from pathlib import Path


def save_editor_diagnostics(value, label):
    if not value:
        return
    value = dict(value)
    images = value.pop('images', {})
    folder = Path(os.environ.get('EDITOR_DIAGNOSTICS', 'test-results/editor-canvas')) / label
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'metrics.json').write_text(json.dumps(value, ensure_ascii=False, indent=2))
    print('::notice title=Editor Canvas diagnostic metrics::' + json.dumps(value, ensure_ascii=False), flush=True)
    for name, data in images.items():
        (folder / (name + '.png')).write_bytes(base64.b64decode(data.split(',', 1)[1]))
        # Small lossless masks remain inspectable in public CI annotations even
        # when GitHub artifact downloads require authentication.
        if name.endswith('Mask') or name == 'difference':
            print('::notice title=Editor Canvas diagnostic ' + name + '::' + data, flush=True)
