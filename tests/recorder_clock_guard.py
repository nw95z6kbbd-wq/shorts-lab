"""Exact reviewed media-clock/finalization bridges; the historical encoder stays pinned."""
import sys
import json
from pathlib import Path

CLOCK = '''          // MediaRecorder timestamps the mixed stream on the Web Audio clock.
          // Safari can advance that clock more slowly during device warm-up.
          // Keep frames, audio and the stop boundary on that same media clock;
          // silent Canvas recording retains its original performance clock.
          const audioStart = context?.currentTime;
          let audioLast = audioStart, audioAdvancedAt = start;
          const elapsedTime = now => {
            if (!context) return now - start;
            const time = context.currentTime;
            if (context.state !== 'running' || !Number.isFinite(time) || time < audioLast) throw new Error('Аудиопоток прерван или его часы недоступны. Повторите запись.');
            if (time > audioLast) audioAdvancedAt = now;
            else if (now - audioAdvancedAt >= 10000) throw new Error('Аудиопоток не продвигается. Повторите запись или уберите аудиодорожки.');
            audioLast = time;
            return (time - audioStart) * 1000;
          };
'''
NEW='Math.min(plan.durationMs, Math.max(0, elapsedTime(now)))'
OLD='Math.min(plan.durationMs, Math.max(0, now - start))'
DATA_OLD="            candidate.ondataavailable = event => { if (!settled && event.data.size) chunks.push(event.data); };\n"
DATA_NEW='''            candidate.ondataavailable = event => {
              if (!settled && event.data.size) chunks.push(event.data);
              if (!settled && finalFlushPending) {
                finalFlushPending = false;
                try { if (recorder.state !== 'inactive') recorder.stop(); } catch (error) { fail(error); }
              }
            };
'''
FLUSH_OLD="                flushTimer = setTimeout(() => { if (!settled && recorder.state !== 'inactive') recorder.stop(); }, Math.ceil(1000 / V.FPS));\n"
FLUSH_NEW='''                flushTimer = setTimeout(() => {
                  if (settled || recorder.state === 'inactive') return;
                  if (!drainRequired) { try { recorder.stop(); } catch (error) { fail(error); } return; }
                  recorder.onpause = () => {
                    if (settled || flushRequested) return;
                    flushRequested = true; finalFlushPending = true;
                    try { recorder.requestData(); } catch (error) { fail(error); }
                  };
                  // Freeze input at the final frame, flush while the encoder is
                  // still alive, then stop only after dataavailable acknowledges it.
                  // Safari can otherwise drop the tail and emit an empty stop chunk.
                  try { if (recorder.state === 'paused') recorder.onpause(); else recorder.pause(); }
                  catch (error) { fail(error); }
                }, Math.ceil(1000 / V.FPS));
'''
DRAIN=[(DATA_NEW,DATA_OLD),(FLUSH_NEW,FLUSH_OLD),
       ('let settled = false, stopping = false, flushRequested = false, finalFlushPending = false, drainRequired = false;','let settled = false, stopping = false;'),
       ('recorder.onstop = null; recorder.onpause = null;','recorder.onstop = null;'),
       ('if (!stopping || (drainRequired && (!flushRequested || finalFlushPending)))','if (!stopping)'),
       ("            drainRequired = V.extensionFor(candidate.mimeType || type) === 'webm';\n",'')]
GUARD_NEW="    # Strip only exact, audited media-clock/finalization corrections before legacy proof.\n    recorder=__import__('recorder_clock_guard').strip_clock((root/'js/video-recorder.js').read_text())\n"
GUARD_OLD="    recorder=(root/'js/video-recorder.js').read_text()\n"


def strip_clock(text):
    for change in json.loads((Path(__file__).resolve().parent/'fixtures/editor-export/recorder-bridges.json').read_text()):
        assert text.count(change['new'])==1, 'Unexpected/missing Editor export bridge'
        text=text.replace(change['new'],change['old'],1)
    assert text.count(CLOCK)==1, 'Unexpected/missing approved audio clock bridge'
    assert text.count(NEW)==1, 'Unexpected/missing approved elapsed clock call'
    text=text.replace(CLOCK,'',1).replace(NEW,OLD,1)
    for new,old in DRAIN:
        assert text.count(new)==1, 'Unexpected/missing approved finalization bridge'
        text=text.replace(new,old,1)
    return text


def historical_source(path):
    text=path.read_text()
    if path.name=='video-recorder.js':return strip_clock(text)
    assert path.name=='render_guard.py'
    assert text.count(GUARD_NEW)==1
    return text.replace(GUARD_NEW,GUARD_OLD,1)


def verify_clock_guard():
    source=(Path(__file__).resolve().parents[1]/'js/video-recorder.js').read_text()
    for old,new in [('return (time - audioStart) * 1000','return now - start'),('>= 10000','>= 20000'),("if (context.state !== 'running' || !Number.isFinite(time)","if (context.state === 'running' || !Number.isFinite(time)")]:
        assert source.count(old)==1
        try:strip_clock(source.replace(old,new,1))
        except AssertionError:pass
        else:raise AssertionError('Audio clock guard accepted: '+old)
    return 3


def verify_drain_guard():
    source=(Path(__file__).resolve().parents[1]/'js/video-recorder.js').read_text()
    for old,new in [('recorder.requestData()','recorder.stop()'),('!settled && finalFlushPending','!settled'),("recorder.state === 'paused'","recorder.state !== 'paused'"),('if (!stopping || (drainRequired && (!flushRequested || finalFlushPending)))','if (!stopping)'),("V.extensionFor(candidate.mimeType || type) === 'webm'","V.extensionFor(candidate.mimeType || type) === 'mp4'")]:
        assert source.count(old)==1
        try:strip_clock(source.replace(old,new,1))
        except AssertionError:pass
        else:raise AssertionError('Finalization guard accepted: '+old)
    return 5


if __name__=='__main__':
    if sys.argv[1:] == ['--self-test']:print('PASS:',verify_clock_guard(),'audio clock mutations rejected;',verify_drain_guard(),'finalization mutations rejected')
    else:sys.stdout.write(historical_source(Path(sys.argv[1])))
