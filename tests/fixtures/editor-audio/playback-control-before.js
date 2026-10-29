    async function playAudio({offsetSeconds=0,startPaused=false}={}) {
      if(windowFrame)throw error('PREVIEW_ONLY','Сессия кадра не подготавливает аудио.');
      busy();if(!Number.isFinite(offsetSeconds)||offsetSeconds<0||offsetSeconds>frozenPlan.durationMs/1000)throw error('OFFSET','Некорректная позиция аудио.');
      if(typeof startPaused!=='boolean')throw error('AUDIO_PLAYBACK','Некорректное состояние запуска аудио.');
      const use={kind:'audio',lease:acquire(),abort:new AbortController()},options={...borrowed(use.lease),offsetSeconds};uses.add(use);
      let context,mix,stopPromise,timer,origin=0,offset=offsetSeconds,paused=startPaused,pausePromise=Promise.resolve(),lastClock=0,advancedAt=0;
      const wall=io.now||(()=>performance.now());
      const positionMs=()=>{
        if(use.abort.signal.aborted)throw error('STATE','Воспроизведение закрыто.');
        if(context&&!paused){
          const value=context.currentTime,now=wall();
          if(!Number.isFinite(value)||value<lastClock)throw error('AUDIO_CLOCK','Часы аудиопотока недоступны или переместились назад.');
          if(value>lastClock)advancedAt=now;else if(now-advancedAt>=10000)throw error('AUDIO_CLOCK','Аудиопоток не продвигается. Нажмите Play ещё раз.');
          lastClock=value;
        }
        const time=paused?offset:offset+Math.max(0,(context?.currentTime??origin)-origin);
        if(!Number.isFinite(time))throw error('AUDIO_CLOCK','Часы аудиопотока недоступны.');
        if(context&&!paused&&context.state!=='running')throw error('AUDIO_CLOCK','Аудиопоток прерван. Нажмите Play ещё раз.');
        return Math.min(frozenPlan.durationMs,time*1000);
      };
      function startMix(){mix=io.mix(context,{...options,offsetSeconds:offset,destination:context.destination});origin=context.currentTime+.02;lastClock=context.currentTime;advancedAt=wall();mix.start(origin);}
      const stop=()=>{
        if(stopPromise)return stopPromise;use.abort.abort();clearTimeout(timer);
        stopPromise=(async()=>{
          try{mix?.stop();}catch(_){/* Closing the owned context still tears down its entire graph. */}
          if(context&&context.state!=='closed'){
            try{await context.close();}catch(e){throw error('AUDIO_CLOSE','Не удалось закрыть AudioContext; ресурсы удерживаются до повторной очистки.',e);}
            if(context.state!=='closed')throw error('AUDIO_CLOSE','AudioContext не подтвердил закрытие; повторите очистку.');
          }
          finishUse(use);
        })().catch(e=>{stopPromise=null;throw e;});return stopPromise;
      };
      use.stop=stop;
      try {
        if(options.voiceBuffer||options.musicBuffer){
          context=io.context();
          await new Promise((resolve,reject)=>{
            const cancelled=()=>reject(error('CANCELLED','Запуск аудио отменён.'));
            use.abort.signal.addEventListener('abort',cancelled,{once:true});
            timer=setTimeout(()=>reject(error('AUDIO_GESTURE','Браузер не разрешил звук. Запустите аудио явным нажатием.')),3000);
            Promise.resolve(context.resume()).then(resolve,reject).finally(()=>use.abort.signal.removeEventListener('abort',cancelled));
          });clearTimeout(timer);
          if(disposed||use.abort.signal.aborted)throw error('CANCELLED','Запуск аудио отменён.');
          if(context.state!=='running')throw error('AUDIO_GESTURE','AudioContext не запущен пользовательским действием.');
          if(startPaused)await context.suspend();else startMix();
          if(disposed||use.abort.signal.aborted)throw error('CANCELLED','Запуск аудио отменён.');
        }
        return Object.freeze({stop,positionMs,
          pause(){
            if(use.abort.signal.aborted)return Promise.reject(error('STATE','Воспроизведение закрыто.'));
            if(paused)return pausePromise;
            offset=positionMs()/1000;paused=true;mix?.stop();mix=null;
            pausePromise=context?Promise.resolve(context.suspend()):Promise.resolve();return pausePromise;
          },
          async resume(){
            await pausePromise;if(use.abort.signal.aborted||disposed)throw error('CANCELLED','Воспроизведение отменено.');
            if(!paused)return;await context?.resume();
            if(use.abort.signal.aborted||disposed)throw error('CANCELLED','Воспроизведение отменено.');
            if(context&&context.state!=='running')throw error('AUDIO_GESTURE','Нажмите Play, чтобы разрешить звук.');
            if(context)startMix();paused=false;
          },
          async seek(ms){
            if(!Number.isSafeInteger(ms)||ms<0||ms>frozenPlan.durationMs)throw error('OFFSET','Некорректная позиция аудио.');
            const wasPaused=paused;await this.pause();offset=ms/1000;if(!wasPaused)await this.resume();
          },toJSON:noJSON});
      }catch(e){await stop();throw e.code?e:error('AUDIO_PLAYBACK',e.message||'Не удалось запустить аудио.',e);}
    }
