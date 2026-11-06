/* Test-only observer, installed before app scripts capture AudioEncoder. */
(function(root, install) {
  if (typeof module === 'object') module.exports = install;
  else root.EditorAACTrace = install(root, root.SafariAACProbe);
})(globalThis, function(root, helpers) {
  'use strict';
  const Native = root.AudioEncoder;
  let active = null;
  function observe(trace, label, callback) {
    if (!trace) return;
    try { callback(); }
    catch (_) { if (trace.errors.length < 16) trace.errors.push(label); }
  }
  const configView = c => ({codec:c.codec, sampleRate:c.sampleRate,
    numberOfChannels:c.numberOfChannels, bitrate:c.bitrate});
  if (Native) root.AudioEncoder = class extends Native {
    constructor(options) {
      if (typeof options?.output !== 'function' || typeof options?.error !== 'function') {
        super(options); // Preserve native validation of invalid callback arguments.
        this.traceRecord = null; this.traceOwner = null; return;
      }
      const trace = active;
      const record = trace && trace.encoders.length === 0
        ? {inputs:[], chunks:[], pcm:[], inputFrames:0, encodedBytes:0, descriptionBytes:0,
           flushCalled:false, flushComplete:false, closed:false} : null;
      if (trace && !record && trace.errors.length < 16) trace.errors.push('multiple-encoders');
      if (record) trace.encoders.push(record);
      const output = options.output, error = options.error;
      super({...options, output(chunk, metadata) {
        observe(record && trace, 'output-capture', () => {
          const description = metadata?.decoderConfig?.description;
          const descriptionBytes = description?.byteLength || 0;
          if (record.chunks.length >= 512 || chunk.byteLength > 65536 || descriptionBytes > 65536 ||
              record.encodedBytes + chunk.byteLength > 2 * 1048576 ||
              record.descriptionBytes + descriptionBytes > 2 * 1048576) throw Error('budget');
          const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
          record.chunks.push({timestamp:chunk.timestamp, durationPresent:chunk.duration != null,
            duration:chunk.duration ?? null, type:chunk.type, data,
            metadata:helpers.metadataRecord(metadata)});
          record.encodedBytes += data.length; record.descriptionBytes += descriptionBytes;
        });
        return Reflect.apply(output, this, [chunk, metadata]);
      }, error(cause) {
        observe(record && trace, 'encoder-error-capture', () => { record.encoderError = true; });
        return Reflect.apply(error, this, [cause]);
      }});
      this.traceRecord = record; this.traceOwner = trace;
    }
    configure(config) {
      const result = super.configure(config);
      observe(this.traceRecord && this.traceOwner, 'config-capture', () => {
        this.traceRecord.config = configView(config);
      });
      return result;
    }
    encode(frame) {
      const record = this.traceRecord;
      observe(record && this.traceOwner, 'input-capture', () => {
        const n = frame.numberOfFrames;
        if (frame.sampleRate !== 48000 || frame.numberOfChannels !== 2 || n < 1 || n > 1024 ||
            record.inputs.length >= 256 || record.inputFrames + n > 144000) throw Error('budget/format');
        const pcm = new Float32Array(n * 2);
        for (let c = 0; c < 2; c++) {
          const plane = new Float32Array(n);
          frame.copyTo(plane, {planeIndex:c, format:'f32-planar'});
          for (let i = 0; i < n; i++) pcm[i * 2 + c] = plane[i];
        }
        record.inputs.push({offset:record.inputFrames, timestamp:frame.timestamp,
          duration:frame.duration ?? null, numberOfFrames:n,
          sampleRate:frame.sampleRate, numberOfChannels:frame.numberOfChannels});
        record.pcm.push(pcm); record.inputFrames += n;
      });
      return super.encode(frame);
    }
    flush() {
      const promise = super.flush(), record = this.traceRecord;
      observe(record && this.traceOwner, 'flush-capture', () => { record.flushCalled = true; });
      promise.then(() => observe(record && this.traceOwner, 'flush-capture', () => { record.flushComplete = true; }),
        () => observe(record && this.traceOwner, 'flush-capture', () => { record.flushError = true; }));
      return promise; // Preserve the original promise, rejection and callbacks.
    }
    close() {
      const result = super.close();
      observe(this.traceRecord && this.traceOwner, 'close-capture', () => { this.traceRecord.closed = true; });
      return result;
    }
  };
  return {
    arm(expected) {
      if (expected.fixture !== 'editor-export-synthetic-3s' || expected.durationMs !== 3000 ||
          expected.pcmFrames !== 144000 || expected.sampleRate !== 48000 || expected.numberOfChannels !== 2)
        throw Error('Only the synthetic three-second fixture may be captured');
      active = {schema:1, expected:{...expected}, errors:[], encoders:[]};
    },
    snapshot() {
      if (!active) return null;
      return {schema:1, expected:active.expected, errors:[...active.errors],
        encoders:active.encoders.map(({pcm, chunks, ...record}) => {
          const input = new Float32Array(record.inputFrames * 2); let at = 0;
          for (const part of pcm) { input.set(part, at); at += part.length; }
          return {...record, inputPCMBase64:helpers.pcm64(input),
            chunks:chunks.map(({data, ...chunk}) => ({...chunk,
              dataBase64:btoa(Array.from(data, b => String.fromCharCode(b)).join(''))}))};
        })};
    },
    stop() { active = null; }
  };
});
