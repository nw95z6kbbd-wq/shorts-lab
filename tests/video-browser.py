"""Real Canvas/MediaRecorder checks, with ffprobe/ffmpeg verification of downloaded media."""
import array
import base64
import functools
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
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EDITOR_KEY = 'shorts-studio.project.v1'
VIDEO_KEY = 'shorts-studio.video.v1'
TRACK_CAPTURE = """(() => {
  window.__testTracks = [];
  const capture = HTMLCanvasElement.prototype.captureStream;
  if (!capture) return;
  HTMLCanvasElement.prototype.captureStream = function(...args) {
    const stream = capture.apply(this, args);
    window.__testTracks.push(...stream.getTracks());
    const add = stream.addTrack.bind(stream);
    stream.addTrack = track => { window.__testTracks.push(track); return add(track); };
    return stream;
  };
})()"""


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/shorts-lab/'):
            self.path = self.path[len('/shorts-lab'):]
        super().do_GET()

    def log_message(self, *_args):
        pass


def media_info(path):
    return json.loads(subprocess.check_output([
        'ffprobe', '-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', str(path)
    ]))


def verify_video(path, duration, audio):
    info = media_info(path)
    video = next(stream for stream in info['streams'] if stream['codec_type'] == 'video')
    assert (video['width'], video['height']) == (720, 1280), video
    assert int(video['nb_read_frames']) >= duration * 4, video
    assert abs(float(info['format']['duration']) - duration) < .8, info['format']
    assert any(stream['codec_type'] == 'audio' for stream in info['streams']) == audio
    if path.suffix == '.mp4':
        assert 'mp4' in info['format']['format_name'], info
    else:
        assert path.suffix == '.webm' and 'webm' in info['format']['format_name'], info
    # Decode the entire actual recording, not just the header or a browser mock.
    subprocess.run(['ffmpeg', '-v', 'error', '-xerror', '-i', str(path), '-f', 'null', '-'], check=True, capture_output=True)
    return info


def rms(path, offset):
    raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-ss', str(offset), '-i', str(path), '-map', '0:a:0', '-t', '0.2', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'])
    samples = array.array('f', raw)
    assert samples
    return math.sqrt(sum(value * value for value in samples) / len(samples))


def run():
    assert shutil.which('ffprobe') and shutil.which('ffmpeg'), 'Install ffmpeg (including ffprobe) to verify real media.'
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{server.server_port}/shorts-lab/'
    try:
        with tempfile.TemporaryDirectory(prefix='shorts-video-test-') as temp, sync_playwright() as p:
            temp = Path(temp)
            browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'), args=['--no-sandbox'])
            errors, requests = [], []
            try:
                context = browser.new_context(accept_downloads=True, viewport={'width': 1440, 'height': 1000})
                context.add_init_script(TRACK_CAPTURE)
                page = context.new_page()
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.on('request', lambda request: requests.append(request.url))
                page.goto(url)
                old_project = page.evaluate(f"localStorage.getItem('{EDITOR_KEY}')")
                expect(page.locator('#sceneList .scene-card')).to_have_count(8)
                page.locator('#createVideoMode').click()
                expect(page.locator('#videoStudio')).to_be_visible()
                expect(page.locator('#scriptStudio')).to_be_hidden()
                expect(page.locator('.video-scene-card')).to_have_count(6)
                expect(page.locator('#videoDuration')).to_have_value('18')
                assert page.evaluate('ShortsVideoRecorder.capabilities().supported')
                assert page.evaluate('''() => {
                  const canvas = document.getElementById('videoCanvas');
                  const plan = ShortsVideoCore.makePlan(ShortsVideoCore.demo());
                  ShortsVideoRenderer.render(canvas, plan, 500); const first = canvas.toDataURL();
                  ShortsVideoRenderer.render(canvas, plan, 1500); return first !== canvas.toDataURL();
                }''')
                print('PASS: separate mode, six-scene 18-second demo and real moving Canvas frames', flush=True)

                for width in (320, 390, 768, 1440):
                    page.set_viewport_size({'width': width, 'height': 900})
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
                page.set_viewport_size({'width': 1440, 'height': 1000})
                page.locator('#video-scene-0').fill('Ручная правка видеосцены.')
                expect(page.locator('#videoDraftStatus')).to_contain_text('Сохранено')
                page.reload()
                page.locator('#openVideoMode').click()
                expect(page.locator('#video-scene-0')).to_have_value('Ручная правка видеосцены.')
                assert page.evaluate(f"localStorage.getItem('{EDITOR_KEY}')") == old_project
                page.locator('#videoIdea').fill('История про далёкую планету')
                page.locator('#generateIdea').click()
                expect(page.locator('#confirmDialog')).to_be_visible()
                page.locator('#dialogConfirm').click()
                expect(page.locator('#videoTheme')).to_have_value('space')
                assert 'далёкую планету' in page.locator('#video-scene-0').input_value()
                page.locator('#addVideoScene').click()
                expect(page.locator('.video-scene-card')).to_have_count(7)
                page.get_by_role('button', name='Удалить видеосцену 7', exact=True).click()
                expect(page.locator('.video-scene-card')).to_have_count(6)
                page.locator('#videoDemo').click()
                page.locator('#dialogConfirm').click()
                expect(page.locator('#videoTitle')).to_have_value('Дом, который помнит')
                print('PASS: local idea generation, scene editing, mobile layout and isolated draft persistence', flush=True)

                # A malformed audio file gives an actionable error without breaking the video editor.
                page.locator('#videoAudio').set_input_files({'name': 'broken.wav', 'mimeType': 'audio/wav', 'buffer': b'not audio'})
                expect(page.locator('#videoError')).to_contain_text('Не удалось прочитать аудио')
                tone = temp / 'tone.wav'
                with wave.open(str(tone), 'wb') as track:
                    track.setnchannels(1); track.setsampwidth(2); track.setframerate(16000)
                    track.writeframes(b''.join(struct.pack('<h', int(32767 * .08 * math.sin(2 * math.pi * 440 * i / 16000))) for i in range(24000)))
                page.locator('#videoAudio').set_input_files(str(tone))
                expect(page.locator('#videoAudioInfo')).to_contain_text('tone.wav')
                expect(page.locator('#recordVideo')).to_be_enabled()
                with page.expect_download() as item:
                    page.locator('#videoSrt').click()
                item.value.save_as(temp / 'video.srt')
                assert ' --> 00:00:18,000' in (temp / 'video.srt').read_text(encoding='utf-8')
                print('PASS: invalid-audio handling, local WAV decoding and matching video subtitle timecodes', flush=True)

                page.locator('#playGeneratedPreview').click()
                expect(page.locator('#playGeneratedPreview')).to_contain_text('Пауза')
                page.wait_for_function("Number(document.getElementById('videoSeek').value) > 100")
                page.locator('#playGeneratedPreview').click()
                expect(page.locator('#playGeneratedPreview')).to_contain_text('Смотреть')
                print('PASS: animated preview with uploaded audio plays and pauses', flush=True)
                page.locator('#recordVideo').click()
                expect(page.locator('#videoProgress')).to_be_visible()
                page.wait_for_function("Number(document.getElementById('videoProgress').value) > 5")
                expect(page.locator('#downloadVideo')).to_be_hidden()
                expect(page.locator('#downloadVideo')).to_be_visible(timeout=30000)
                expect(page.locator('#videoProgress')).to_have_attribute('value', '100')
                with page.expect_download() as item:
                    page.locator('#downloadVideo').click()
                extension = Path(item.value.suggested_filename).suffix
                assert extension in ('.mp4', '.webm')
                recording = temp / ('demo' + extension)
                item.value.save_as(recording)
                info = verify_video(recording, 18, audio=True)
                assert rms(recording, .3) > .001, 'The uploaded tone is missing from the recording.'
                assert rms(recording, 12) < .001, 'Audio shorter than the video should end in silence.'
                frame_hashes = [subprocess.check_output(['ffmpeg', '-v', 'error', '-ss', str(second), '-i', str(recording), '-frames:v', '1', '-f', 'md5', '-']) for second in (1, 8, 16)]
                assert len(set(frame_hashes)) == 3, 'Video frames should change across scenes.'
                assert page.evaluate('window.__testTracks.length >= 2 && window.__testTracks.every(track => track.readyState === "ended")')
                page.wait_for_function('Number.isFinite(document.getElementById("generatedVideo").duration) && document.getElementById("generatedVideo").duration > 17')
                page.evaluate('async () => { const video = document.getElementById("generatedVideo"); video.currentTime = .3; await video.play(); }')
                page.wait_for_function('!document.getElementById("generatedVideo").paused')
                page.locator('#backToEditor').click()
                assert page.evaluate('document.getElementById("generatedVideo").paused'), 'Leaving video mode must also stop native file playback.'
                assert page.evaluate(f"localStorage.getItem('{EDITOR_KEY}')") == old_project
                page.locator('#createVideoMode').click()
                print(f'PASS: actual 18-second {extension} download; ffprobe/ffmpeg confirm 720×1280, motion, audio and silence padding ({info["format"]["format_name"]})', flush=True)

                # Remove MP4 from the browser-reported supported formats, but record with the real WebM encoder.
                fallback = page.evaluate('''async () => {
                  const original = MediaRecorder.isTypeSupported;
                  MediaRecorder.isTypeSupported = type => !type.startsWith('video/mp4') && original.call(MediaRecorder, type);
                  try {
                    const draft = ShortsVideoCore.demo(); draft.durationSeconds = 2; draft.scenes = draft.scenes.slice(0, 2);
                    const canvas = document.createElement('canvas'); canvas.width = 720; canvas.height = 1280;
                    const result = await ShortsVideoRecorder.record({canvas, plan: ShortsVideoCore.makePlan(draft)});
                    const bytes = new Uint8Array(await result.blob.arrayBuffer()); let binary = '';
                    for (const byte of bytes) binary += String.fromCharCode(byte);
                    return {extension: result.extension, type: result.mimeType, data: btoa(binary)};
                  } finally { MediaRecorder.isTypeSupported = original; }
                }''')
                assert fallback['extension'] == 'webm' and fallback['type'].startswith('video/webm')
                webm = temp / 'fallback.webm'; webm.write_bytes(base64.b64decode(fallback['data']))
                verify_video(webm, 2, audio=False)
                assert webm.read_bytes()[:4] == bytes.fromhex('1a45dfa3')
                webm_audio = page.evaluate('''async () => {
                  const context = new AudioContext();
                  const buffer = context.createBuffer(1, Math.floor(context.sampleRate / 2), context.sampleRate);
                  const samples = buffer.getChannelData(0);
                  for (let i = 0; i < samples.length; i++) samples[i] = .06 * Math.sin(2 * Math.PI * 440 * i / context.sampleRate);
                  await context.close();
                  const draft = ShortsVideoCore.demo(); draft.durationSeconds = 3;
                  const canvas = document.createElement('canvas'); canvas.width = 720; canvas.height = 1280;
                  const result = await ShortsVideoRecorder.record({canvas, plan: ShortsVideoCore.makePlan(draft), audioBuffer: buffer, format: 'webm'});
                  let binary = ''; for (const byte of new Uint8Array(await result.blob.arrayBuffer())) binary += String.fromCharCode(byte);
                  return {type: result.mimeType, data: btoa(binary)};
                }''')
                assert webm_audio['type'].startswith('video/webm')
                audio_file = temp / 'audio.webm'; audio_file.write_bytes(base64.b64decode(webm_audio['data']))
                verify_video(audio_file, 3, audio=True)
                assert rms(audio_file, .1) > .001 and rms(audio_file, 2) < .001
                print('PASS: real WebM fallback with correct container, extension, finite duration and optional Opus audio', flush=True)

                page.locator('#recordVideo').click()
                expect(page.locator('#cancelVideo')).to_be_visible()
                page.locator('#cancelVideo').click()
                expect(page.locator('#videoRenderStatus')).to_contain_text('отменена')
                expect(page.locator('#downloadVideo')).to_be_hidden()
                assert page.evaluate('window.__testTracks.every(track => track.readyState === "ended")')
                page.locator('#recordVideo').click()
                page.wait_for_function("Number(document.getElementById('videoProgress').value) > 0")
                page.evaluate('Object.defineProperty(document, "hidden", {configurable:true, get:()=>true}); document.dispatchEvent(new Event("visibilitychange"));')
                expect(page.locator('#videoError')).to_contain_text('вкладка была скрыта')
                expect(page.locator('#downloadVideo')).to_be_hidden()
                page.evaluate('delete document.hidden; document.dispatchEvent(new Event("visibilitychange"));')
                assert page.evaluate('window.__testTracks.every(track => track.readyState === "ended")')
                print('PASS: cancellation and hidden-tab interruption clean up all video/audio tracks and discard partial files', flush=True)

                page.locator('#videoToEditor').click()
                expect(page.locator('#confirmDialog')).to_be_visible()
                page.locator('#confirmDialog button[value="cancel"]').click()
                assert page.evaluate(f"localStorage.getItem('{EDITOR_KEY}')") == old_project
                page.locator('#videoToEditor').click()
                page.locator('#dialogConfirm').click()
                expect(page.locator('#videoStudio')).to_be_hidden()
                expect(page.locator('#sceneList .scene-card')).to_have_count(6)
                expect(page.locator('#scriptText')).to_have_value('\n'.join(page.locator('#videoScenes textarea').evaluate_all('nodes => nodes.map(node => node.value)')))
                print('PASS: transfer to original editor requires confirmation and preserves its scene workflow', flush=True)

                # Unsupported APIs and encoder failures use separate isolated browser contexts.
                for init, text in [
                    ('window.MediaRecorder = undefined;', 'Запись MP4/WebM недоступна'),
                    ('HTMLCanvasElement.prototype.captureStream = undefined;', 'Запись MP4/WebM недоступна'),
                    ('window.AudioContext = undefined; window.webkitAudioContext = undefined;', 'без звука')
                ]:
                    unsupported = browser.new_context(); unsupported.add_init_script(init)
                    other = unsupported.new_page(); other.on('pageerror', lambda error: errors.append(str(error)))
                    other.goto(url); other.locator('#createVideoMode').click()
                    expect(other.locator('#videoSupport')).to_contain_text(text)
                    if 'AudioContext' in init: expect(other.locator('#videoAudio')).to_be_disabled()
                    else: expect(other.locator('#recordVideo')).to_be_disabled()
                    other.locator('#playGeneratedPreview').click()
                    expect(other.locator('#playGeneratedPreview')).to_contain_text('Пауза')
                    unsupported.close()
                failed = browser.new_context(); failed.add_init_script(TRACK_CAPTURE)
                failed.add_init_script('window.MediaRecorder = class extends MediaRecorder { constructor() { throw new DOMException("encoder unavailable", "NotSupportedError"); } };')
                other = failed.new_page(); other.on('pageerror', lambda error: errors.append(str(error)))
                other.goto(url); other.locator('#createVideoMode').click(); other.locator('#recordVideo').click()
                expect(other.locator('#videoError')).to_contain_text('Не удалось запустить')
                expect(other.locator('#downloadVideo')).to_be_hidden()
                assert other.evaluate('window.__testTracks.every(track => track.readyState === "ended")')
                failed.close()
                print('PASS: missing recording/audio APIs and encoder failures leave preview available with actionable messages', flush=True)

                assert not errors, errors
                assert all(request.startswith((url, 'blob:', 'data:')) for request in requests), requests
                print('PASS: no JavaScript errors or external API/network requests', flush=True)
                print('All 10 video browser check groups passed.', flush=True)
            finally:
                browser.close()
    finally:
        server.shutdown(); server.server_close()


if __name__ == '__main__':
    run()
