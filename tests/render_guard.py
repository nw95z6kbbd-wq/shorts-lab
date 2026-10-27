"""Strict source proof: only explicit resource/plan guards may change the old stack.

The codec, capture loop, graph, transitions and pixel drawing must reconstruct
exactly to the frozen baseline. No regex that skips encoder or renderer bodies.
"""
import hashlib
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
FIXTURE=ROOT/'tests/fixtures/render-plan'


def replace_once(text,new,old,label):
    assert text.count(new)==1,'Unexpected/missing approved bridge: '+label
    return text.replace(new,old,1)


def assert_render_stack(root=ROOT,baseline=None):
    for name,expected in json.loads((FIXTURE/'unchanged-runtime.json').read_text()).items():
        assert hashlib.sha256((root/name).read_bytes()).hexdigest()==expected,'Unapproved runtime change: '+name
        if baseline:assert (root/name).read_bytes()==(baseline/name).read_bytes(),name
    recorder=(root/'js/video-recorder.js').read_text()
    for new,old in [('record({ canvas, plan, resources,','record({ canvas, plan,'),('    window.ShortsRenderPlan.assertRenderable(plan);\n',''),('render(canvas, plan, ms, resources)','render(canvas, plan, ms)')]:recorder=replace_once(recorder,new,old,'recorder '+new)
    expected=(FIXTURE/'video-recorder-before.js').read_text();assert recorder==expected,'Encoder/capture loop changed outside approved resource bridge'
    if baseline:assert expected==(baseline/'js/video-recorder.js').read_text(),'Unexpected recorder baseline'
    renderer=(root/'js/video-renderer.js').read_text()
    pairs=[('visual(ctx, plan, scene, time, resources)','visual(ctx, plan, scene, time)'),('(resources?.images || plan.images)?.get(scene.imageId)','plan.images?.get(scene.imageId)'),('render(canvas, plan, elapsedMs, resources)','render(canvas, plan, elapsedMs)'),('    window.ShortsRenderPlan.assertRenderable(plan);\n',''),("visual(ctx, plan, previous, previous.visual === 'image' ? previous.endMs : frame.time, resources)","visual(ctx, plan, previous, previous.visual === 'image' ? previous.endMs : frame.time)"),("visual(layer.getContext('2d', { alpha: false }), plan, frame.scene, frame.time, resources)","visual(layer.getContext('2d', { alpha: false }), plan, frame.scene, frame.time)"),('visual(ctx, plan, frame.scene, frame.time, resources)','visual(ctx, plan, frame.scene, frame.time)')]
    for new,old in pairs:renderer=replace_once(renderer,new,old,'renderer '+new)
    expected=(FIXTURE/'video-renderer-before.js').read_text();assert renderer==expected,'Drawing/transition implementation changed outside approved resource bridge'
    if baseline:assert expected==(baseline/'js/video-renderer.js').read_text(),'Unexpected renderer baseline'
    video=(root/'js/video-core.js').read_text();old=(FIXTURE/'video-core-before.js').read_text()
    start=video.index('  // Compatibility facade.');end=video.index('  function supportedFormats(',start)
    facade="""  // Compatibility facade. All timing/cues/frame selection live in RenderPlan.
  const shared = () => typeof module === 'object' && module.exports ? require('./render-plan.js') : globalThis.ShortsRenderPlan;
  const adapters = () => typeof module === 'object' && module.exports ? require('./render-adapters.js') : globalThis.ShortsRenderAdapters;
  function chunks(text, size = 6) { return shared().chunks(text, size); }
  function makePlan(draft) { return shared().legacyView(adapters().fromVideo(draft, { legacy: true }), draft); }
  function frameAt(plan, elapsedMs) { return shared().frameAt(plan, elapsedMs); }
  function generateSrt(plan) { return shared().generateSrt(plan); }

"""
    assert video[start:end]==facade,'Unexpected legacy facade'
    a=old.index('  function chunks(');b=old.index('  function supportedFormats(',a)
    assert video[:start]+old[a:b]+video[end:]==old,'Non-planning VideoCore code changed'
    if baseline:assert old==(baseline/'js/video-core.js').read_text(),'Unexpected VideoCore baseline'


if __name__=='__main__':
    assert_render_stack()
    print('PASS: encoder, mixer, drawing, formats/camera/WebM and original styles are unchanged outside the exact approved planning/resource bridge')
