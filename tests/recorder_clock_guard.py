"""One exact, reviewed media-clock bridge; the historical encoder stays pinned."""
import sys
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
GUARD_NEW="    # Strip only the exact, audited media-clock correction before legacy proof.\n    recorder=__import__('recorder_clock_guard').strip_clock((root/'js/video-recorder.js').read_text())\n"
GUARD_OLD="    recorder=(root/'js/video-recorder.js').read_text()\n"


def strip_clock(text):
    assert text.count(CLOCK)==1, 'Unexpected/missing approved audio clock bridge'
    assert text.count(NEW)==1, 'Unexpected/missing approved elapsed clock call'
    return text.replace(CLOCK,'',1).replace(NEW,OLD,1)


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


if __name__=='__main__':
    if sys.argv[1:] == ['--self-test']:print('PASS:',verify_clock_guard(),'audio clock mutations rejected')
    else:sys.stdout.write(historical_source(Path(sys.argv[1])))
