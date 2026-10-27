"""Synthetic original media; standard library only, also used by native Safari."""
import base64
import io
import math
from pathlib import Path
import struct
import wave


def media_payload(_folder=None):
    root=Path(__file__).resolve().parents[1];files=[]
    for name,mime in [('red.png','image/png'),('blue.jpg','image/jpeg'),('green.webp','image/webp')]:
        files.append({'name':name,'type':mime,'base64':base64.b64encode((root/'tests/fixtures/backup-media'/name).read_bytes()).decode()})
    for role,hz in [('voice',440),('music',880)]:
        out=io.BytesIO()
        with wave.open(out,'wb') as w:
            w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000)
            w.writeframes(b''.join(struct.pack('<h',int(32767*.08*math.sin(2*math.pi*hz*i/16000))) for i in range(16000*6)))
        files.append({'name':role+'.wav','type':'audio/wav','base64':base64.b64encode(out.getvalue()).decode()})
    return files
