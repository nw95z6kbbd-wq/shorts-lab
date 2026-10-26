"""Verify the actual exported images, two-track mix, fades and scene timing."""
import array
import base64
import functools
import importlib.util
import json
import math
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import threading
import wave
from http.server import ThreadingHTTPServer

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('video_checks', ROOT / 'tests/video-browser.py')
checks = importlib.util.module_from_spec(spec); spec.loader.exec_module(checks)
KEY = 'shorts-studio.video.v1'


def tone(path, frequency, duration=6):
    with wave.open(str(path), 'wb') as track:
        track.setnchannels(1); track.setsampwidth(2); track.setframerate(16000)
        track.writeframes(b''.join(struct.pack('<h', int(32767 * .08 * math.sin(2 * math.pi * frequency * i / 16000))) for i in range(int(duration * 16000))))


def spectrum(path, offset):
    raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-ss', str(offset), '-i', str(path), '-map', '0:a:0', '-t', '0.1', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'])
    samples = array.array('f', raw); assert len(samples) > 1000
    def amplitude(frequency):
        real = sum(value * math.cos(2 * math.pi * frequency * i / 16000) for i, value in enumerate(samples))
        imaginary = sum(value * math.sin(2 * math.pi * frequency * i / 16000) for i, value in enumerate(samples))
        return 2 * math.hypot(real, imaginary) / len(samples)
    return amplitude(440), amplitude(880)


def average_rgb(path, second):
    raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-ss', str(second), '-i', str(path), '-frames:v', '1', '-vf', 'crop=100:100:300:400,scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'])
    assert len(raw) == 3
    return list(raw)


def no_black_frames(path):
    raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(path), '-an', '-vf', 'scale=16:28', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'])
    size = 16 * 28 * 3
    brightness = [sum(raw[i:i+size]) / size for i in range(0, len(raw), size)]
    assert brightness and min(brightness) > 15, ('Black or empty frame', min(brightness))


def record(page, folder, label, seconds):
    page.locator('#recordVideo').click()
    expect(page.locator('#downloadVideo')).to_be_visible(timeout=20000)
    with page.expect_download() as item:
        page.locator('#downloadVideo').click()
    file = folder / (label + Path(item.value.suggested_filename).suffix)
    item.value.save_as(file)
    checks.verify_video(file, seconds, audio=True)
    no_black_frames(file)
    return file


def set_range(page, id, value):
    page.locator('#' + id).evaluate('(element, value) => { element.value = value; element.dispatchEvent(new Event("input", {bubbles:true})); }', str(value))


def run():
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(checks.Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}/shorts-lab/'
    url = base + os.environ.get('SHORTS_MEDIA_ENTRY', '')
    fixture = {'version': 1, 'idea': 'Проверка медиа', 'title': 'Изображения и две дорожки', 'durationSeconds': 18,
               'theme': 'space', 'caption': 'accent', 'volume': .7, 'musicVolume': .6, 'musicFadeIn': 1, 'musicFadeOut': 1,
               'scenes': [{'id': 'red', 'text': 'Первая красная сцена.'}, {'id': 'blue', 'text': 'Вторая синяя сцена.'}]}
    try:
        with tempfile.TemporaryDirectory(prefix='shorts-media-') as temp, sync_playwright() as p:
            temp = Path(temp)
            browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'), args=['--no-sandbox'])
            errors, requests = [], []
            try:
                context = browser.new_context(accept_downloads=True, viewport={'width': 1440, 'height': 1000})
                context.add_init_script(f'if (!localStorage.getItem({json.dumps(KEY)})) localStorage.setItem({json.dumps(KEY)}, {json.dumps(json.dumps(fixture))});')
                page = context.new_page(); page.on('pageerror', lambda error: errors.append(str(error)))
                page.on('request', lambda request: requests.append(request.url))
                page.goto(url); page.locator('#createVideoMode').click()
                original = page.evaluate('localStorage.getItem("shorts-studio.project.v1")')
                images = page.evaluate('''async () => {
                  const result = {};
                  for (const [name, color, type, w, h] of [['red.png','#ed563e','image/png',800,1200],['blue.jpg','#286cdd','image/jpeg',1200,800],['blue.webp','#286cdd','image/webp',1200,800]]) {
                    const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
                    const c=canvas.getContext('2d');c.fillStyle=color;c.fillRect(0,0,w,h);
                    c.fillStyle='#ffffff55';for(let x=0;x<w;x+=95)c.fillRect(x,0,14,h);
                    const blob=await new Promise(resolve=>canvas.toBlob(resolve,type,.95));
                    let s='';for(const byte of new Uint8Array(await blob.arrayBuffer()))s+=String.fromCharCode(byte);
                    result[name]={type,data:btoa(s)};
                  }return result;
                }''')
                for index, name in [(0, 'red.png'), (1, 'blue.jpg'), (1, 'blue.webp')]:
                    page.locator(f'#video-scene-image-{index}').set_input_files({'name': name, 'mimeType': images[name]['type'], 'buffer': base64.b64decode(images[name]['data'])})
                    expect(page.locator(f'#video-scene-visual-{index}')).to_have_value('image')
                    expect(page.locator('#recordVideo')).to_be_enabled()
                expect(page.locator('.scene-image-thumb')).to_have_count(2)
                page.locator('#video-scene-image-1').set_input_files({'name': 'broken.png', 'mimeType': 'image/png', 'buffer': b'not a PNG'})
                expect(page.locator('#videoError')).to_contain_text('PNG, JPG и WebP')
                expect(page.locator('.scene-image-thumb')).to_have_count(2)
                page.locator('#video-scene-duration-0').fill('2')
                page.locator('#video-scene-duration-1').fill('3')
                page.locator('#video-scene-camera-0').select_option('zoom-in')
                page.locator('#video-scene-camera-1').select_option('pan-left')
                expect(page.locator('#videoTiming')).to_have_value('manual')
                expect(page.locator('#videoTotalTime')).to_contain_text('5 сек')
                expect(page.locator('#videoDraftStatus')).to_contain_text('Сохранено')
                page.reload(); page.locator('#createVideoMode').click()
                expect(page.locator('.scene-image-thumb')).to_have_count(2)
                expect(page.locator('#recordVideo')).to_be_enabled()
                expect(page.locator('#video-scene-duration-0')).to_have_value('2')
                assert page.evaluate('localStorage.getItem("shorts-studio.project.v1")') == original
                print('PASS: PNG/JPG/WebP uploads, invalid-file handling, per-scene timing and IndexedDB restoration', flush=True)

                for time in (400, 1400):
                    page.locator('#videoSeek').evaluate('(e,t)=>{e.value=t;e.dispatchEvent(new Event("input"));}', time)
                    value = page.locator('#videoCanvas').evaluate('c=>{let h=0;for(const v of c.getContext("2d").getImageData(50,300,200,250).data)h=(h*31+v)|0;return h;}')
                    if time == 400: first = value
                    else: assert value != first, 'Camera should move the actual image pixels.'
                for transition in ('crossfade', 'slide', 'zoom', 'none'):
                    page.locator('#video-scene-transition-1').select_option(transition)
                    for time in (1990, 2000, 2100, 2300, 2500):
                        page.locator('#videoSeek').evaluate('(e,t)=>{e.value=t;e.dispatchEvent(new Event("input"));}', time)
                        assert page.locator('#videoCanvas').evaluate('c=>{const a=c.getContext("2d").getImageData(300,400,100,100).data;return a.reduce((s,v,i)=>s+(i%4===3?0:v),0)/(100*100*3);}') > 20
                page.locator('#video-scene-transition-1').select_option('crossfade')
                print('PASS: moving image pixels and all transitions retain a fully painted frame at scene boundaries', flush=True)

                voice, music = temp/'voice.wav', temp/'music.wav'; tone(voice, 440); tone(music, 880)
                page.locator('#videoAudio').set_input_files(str(voice)); expect(page.locator('#videoAudioInfo')).to_contain_text('voice.wav')
                page.locator('#videoMusic').set_input_files(str(music)); expect(page.locator('#videoMusicInfo')).to_contain_text('music.wav')
                with page.expect_download() as item: page.locator('#videoSrt').click()
                item.value.save_as(temp/'media.srt')
                srt=(temp/'media.srt').read_text(encoding='utf-8')
                assert '00:00:00,000 --> 00:00:02,000' in srt and '00:00:02,000 --> 00:00:05,000' in srt
                main = record(page, temp, 'images-both', 5)
                red, blue = average_rgb(main, 1), average_rgb(main, 3.5)
                assert red[0]-red[2] > 40 and blue[2]-blue[0] > 40, (red, blue)
                beginning, middle, ending = spectrum(main, .15), spectrum(main, 1.5), spectrum(main, 4.75)
                assert middle[0] > .015 and middle[1] > .015, (beginning, middle, ending)
                assert beginning[1] < middle[1]*.5 and ending[1] < middle[1]*.5, (beginning, middle, ending)
                assert .7 < beginning[0]/middle[0] < 1.3 and .7 < ending[0]/middle[0] < 1.3
                print('PASS: exported video contains the correct scene images, both audio frequencies and music fades; no black frames; exact 2s/3s subtitles', flush=True)

                page.locator('#video-scene-duration-0').fill('1'); page.locator('#video-scene-duration-1').fill('2')
                page.locator('#video-scene-transition-1').select_option('slide'); page.locator('#videoFormat').select_option('webm')
                both_webm = record(page, temp, 'images-both-webm', 3)
                assert both_webm.suffix == '.webm'
                assert all(value > .01 for value in spectrum(both_webm, 1.5))
                set_range(page, 'videoVolume', 0); set_range(page, 'videoMusicVolume', 50)
                music_only = record(page, temp, 'music-only', 3)
                a,b=spectrum(music_only, 1.5); assert a < .002 and b > .01, (a,b)
                set_range(page, 'videoVolume', 50); set_range(page, 'videoMusicVolume', 0)
                voice_only = record(page, temp, 'voice-only', 3)
                a,b=spectrum(voice_only, 1.5); assert a > .01 and b < .002, (a,b)
                print('PASS: real WebM image export and independent voice/music volume controls verified spectrally', flush=True)

                page.locator('#video-scene-visual-0').select_option('animated')
                expect(page.locator('#recordVideo')).to_be_enabled()
                page.locator('#video-scene-duration-0').fill('60')
                expect(page.locator('#videoPlanError')).to_contain_text('60 секунд')
                expect(page.locator('#recordVideo')).to_be_disabled()
                page.locator('#video-scene-duration-0').fill('1')
                for width in (320,390,768,1440):
                    page.set_viewport_size({'width':width,'height':900})
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
                print('PASS: animated backgrounds remain available, invalid totals block export, responsive media controls fit mobile screens', flush=True)

                blocked=browser.new_context(); blocked.add_init_script('Object.defineProperty(window,"indexedDB",{value:undefined});')
                other=blocked.new_page();other.on('pageerror',lambda e:errors.append(str(e)))
                other.goto(url);other.locator('#createVideoMode').click()
                other.locator('#video-scene-image-0').set_input_files({'name':'red.png','mimeType':'image/png','buffer':base64.b64decode(images['red.png']['data'])})
                expect(other.locator('#videoDraftStatus')).to_contain_text('Ошибка сохранения')
                expect(other.locator('#recordVideo')).to_be_enabled()
                expect(other.locator('#videoDraftStatus')).to_contain_text('только во вкладке')
                other.reload();other.locator('#createVideoMode').click()
                # No split localStorage write: unavailable IDB leaves the prior legacy
                # animated draft intact, rather than saving a dangling image reference.
                expect(other.locator('.scene-image-thumb')).to_have_count(0)
                expect(other.locator('#video-scene-visual-0')).to_have_value('animated')
                blocked.close()
                assert not errors, errors
                assert all(request.startswith((base,'blob:','data:')) for request in requests), requests
                print('PASS: unavailable storage is explicit, volatile images are not committed and the previous draft is retained, no JS errors or external requests', flush=True)
                print('All 6 media browser check groups passed.', flush=True)
            finally: browser.close()
    finally: server.shutdown();server.server_close()


if __name__ == '__main__': run()
