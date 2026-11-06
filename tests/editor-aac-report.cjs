'use strict';
// Replay captured metadata/timing in the actual validator source. No app changes.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {createHash} = require('node:crypto');
const SOURCE = path.join(__dirname, '../js/native-mp4.js');
function report(capture, source = fs.readFileSync(SOURCE, 'utf8')) {
  const result = {schema:1, validatorSourceSHA256:createHash('sha256').update(source).digest('hex'),
    replay:true, note:'Selected validator priming is not proof of actual encoder delay.'};
  const record = capture.encoders?.[0];
  if (!record) return {...result, status:'not-observed'};
  if (capture.errors?.length) return {...result, status:'incomplete-capture', errors:capture.errors};
  const between = (start, end) => {
    const a = source.indexOf(start), b = source.indexOf(end, a);
    if (a < 0 || b < 0) throw Error('Validator source layout changed');
    return source.slice(a, b);
  };
  const asc = between('  function audioSpecificConfig(', '  const text=');
  const original = between('  function validateAAC(', '  function mux(');
  // Observe locals immediately before the original, unchanged coverage condition.
  const condition = 'if(decoded-priming<pcmFrames||decoded-priming-pcmFrames>=1024)';
  if (original.split(condition).length !== 2) throw Error('Coverage source changed; review diagnostic');
  const observed = original.replace(condition,
    'observe({pcmFrames,first,timestampPriming,priming,decoded,cocoaCookie:!!audio.cocoaCookie,' +
    'underflow:decoded-priming<pcmFrames,excess:decoded-priming-pcmFrames>=1024});\n    ' + condition);
  const samples = record.chunks.map(c => ({timestamp:c.timestamp,
    duration:c.durationPresent ? c.duration : undefined}));
  const audio = {samples}, context = {audio, Uint8Array, pcmFrames:capture.expected.pcmFrames,
    error:(code, message) => Object.assign(new Error(message), {code}),
    observe(value) { const residual=value.decoded-value.priming-value.pcmFrames;
      result.coverage = {...value, validatorDurationSamples:value.decoded, residualSamples:residual,
      paddingCandidateSamples:residual>=0?residual:null,
      paddingMeaning:'Coverage residual only; actual encoder padding is not inferred.',
      branch:value.underflow ? 'decoded-minus-priming-below-pcm' :
        value.excess ? 'residual-at-least-one-AAC-unit' : 'accepted'}; }};
  context.descriptions = record.chunks.flatMap(c => {
    const raw = c.metadata?.decoderConfig?.descriptionBase64;
    return raw !== undefined ? [Uint8Array.from(Buffer.from(raw, 'base64'))] : [];
  });
  result.sourceCondition = condition;
  try {
    vm.runInNewContext(asc + observed + `
      for (const raw of descriptions) {
        const next=audioSpecificConfig(raw,audio);
        if(audio.description&&(next.length!==audio.description.length||next.some((v,i)=>v!==audio.description[i])))
          throw error('CODEC','Changed actual AAC configuration');
        audio.description=next;
      }
      validateAAC(audio,pcmFrames);`, context, {timeout:2000});
    result.validatorOutcome = 'accepted';
  } catch (e) { result.validatorOutcome = e.code || 'diagnostic-replay-error'; }
  result.packetCount = record.chunks.length;
  result.missingChunkDurationCount = record.chunks.filter(c => !c.durationPresent).length;
  result.reportedChunkDurationUsSum = record.chunks.filter(c => c.durationPresent).reduce((n,c) => n+c.duration,0);
  result.codedSamplesIfEveryAccessUnitDecodesTo1024 = record.chunks.length * 1024;
  result.codedSamplesMeaning = 'AAC-LC configuration model; independent decode count is recorded separately.';
  if (audio.description) result.actualASCBase64 = Buffer.from(audio.description).toString('base64');
  if (capture.exportOutcome?.aacCoverageFailure) {
    result.matchesObservedCoverageFailure = result.validatorOutcome === 'INCOMPLETE' &&
      !!(result.coverage?.underflow || result.coverage?.excess);
  }
  result.status = ['accepted','CODEC','ENCODER_TIMESTAMPS','INCOMPLETE'].includes(result.validatorOutcome) ? 'reported' : 'replay-error';
  return result;
}
module.exports = report;
if (require.main === module) {
  const file = process.argv[2];
  if (fs.statSync(file).size > 8 * 1048576) throw Error('Capture exceeds diagnostic budget');
  process.stdout.write(JSON.stringify(report(JSON.parse(fs.readFileSync(file, 'utf8'))), null, 2));
}
