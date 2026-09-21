/* Shared viewer controls and non-destructive colour adjustments. */
(function(root) {
  'use strict';
  function clamp(value, min, max, fallback) {
    value = Number(value);
    return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  }
  function adjust(value) {
    value = value || {};
    return {brightness:clamp(value.brightness,-100,100,0), contrast:clamp(value.contrast,-100,100,0),
      saturation:clamp(value.saturation,-100,100,0), warmth:clamp(value.warmth,-50,50,0)};
  }
  function filter(value) {
    var a = adjust(value);
    var f = 'brightness('+(1+a.brightness/100).toFixed(2)+') contrast('+(1+a.contrast/100).toFixed(2)+') saturate('+(1+a.saturation/100).toFixed(2)+')';
    // Preserve the appearance of already-published colour settings.
    if (a.warmth > 0) f += ' sepia('+(a.warmth/50*0.35).toFixed(2)+')';
    if (a.warmth < 0) f += ' hue-rotate('+(a.warmth*0.8).toFixed(1)+'deg)';
    return f;
  }
  function view(value) {
    value = value || {};
    return {yaw:clamp(value.yaw,-100000,100000,0),pitch:clamp(value.pitch,-Math.PI/2+0.01,Math.PI/2-0.01,0),fov:clamp(value.fov,40,100,75)};
  }
  function applyView(camera, value) {
    var v = view(value);
    camera.rotation.set(v.pitch,v.yaw,0); camera.fov=v.fov; camera.updateProjectionMatrix();
  }
  function zoom(camera, fov) { camera.fov=clamp(fov,40,100,75); camera.updateProjectionMatrix(); }
  function history(initial) {
    var states=[adjust(initial)], pos=0;
    return {
      value:function(){return adjust(states[pos]);},
      push:function(value){value=adjust(value);if(JSON.stringify(value)===JSON.stringify(states[pos]))return;
        states=states.slice(0,pos+1);states.push(value);if(states.length>50)states.shift();pos=states.length-1;},
      undo:function(){pos=Math.max(0,pos-1);return this.value();},
      redo:function(){pos=Math.min(states.length-1,pos+1);return this.value();},
      canUndo:function(){return pos>0;},canRedo:function(){return pos<states.length-1;}
    };
  }
  function reveal(canvas) {
    if(!canvas.animate || (root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches))return;
    canvas.animate([{opacity:0.6},{opacity:1}],{duration:180});
  }
  function bind(canvas,camera,options) {
    options=options||{};
    var points=new Map(), handlers=[], moved=false, origin=null, pinch=0;
    canvas.style.touchAction='none'; canvas.tabIndex=0;
    canvas.setAttribute('aria-label','360° 環景；方向鍵旋轉，加減鍵縮放，Home 回到起始視角');
    function on(target,type,fn,opts){target.addEventListener(type,fn,opts);handlers.push([target,type,fn,opts]);}
    function distance(){var p=Array.from(points.values());return p.length===2?Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y):0;}
    function changed(){if(options.onChange)options.onChange();}
    on(canvas,'pointerdown',function(e){
      if(e.pointerType==='mouse' && e.button!==0)return;
      canvas.focus({preventScroll:true});
      if(!points.size){moved=false;origin={x:e.clientX,y:e.clientY};}
      points.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(points.size>1)moved=true;
      pinch=distance();canvas.setPointerCapture(e.pointerId);canvas.classList.add('grabbing');
    });
    on(canvas,'pointermove',function(e){
      var prev=points.get(e.pointerId);if(!prev)return;
      points.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(origin && Math.hypot(e.clientX-origin.x,e.clientY-origin.y)>6)moved=true;
      if(points.size===2){var next=distance();if(next>0 && pinch>0)zoom(camera,camera.fov*pinch/next);pinch=next;changed();return;}
      if(points.size!==1 || (options.canDrag && !options.canDrag()))return;
      var scale=(camera.fov*Math.PI/180)/Math.max(canvas.clientHeight,150);
      camera.rotation.y+=(e.clientX-prev.x)*scale;
      camera.rotation.x=clamp(camera.rotation.x+(e.clientY-prev.y)*scale,-Math.PI/2+0.01,Math.PI/2-0.01,0);changed();
    });
    function end(e){
      if(!points.has(e.pointerId))return;
      var tap=e.type==='pointerup' && points.size===1 && !moved;
      points.delete(e.pointerId);pinch=distance();
      if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);
      if(!points.size)canvas.classList.remove('grabbing');
      if(tap && options.onTap)options.onTap(e.clientX,e.clientY);
    }
    on(canvas,'pointerup',end);on(canvas,'pointercancel',end);on(canvas,'lostpointercapture',end);
    on(canvas,'wheel',function(e){e.preventDefault();var unit=e.deltaMode===1?16:e.deltaMode===2?canvas.clientHeight:1;
      zoom(camera,camera.fov+clamp(e.deltaY*unit,-120,120,0)*0.04);changed();},{passive:false});
    on(canvas,'keydown',function(e){
      if(e.ctrlKey||e.metaKey||e.altKey)return;
      var step=0.05;
      if(e.key==='ArrowLeft')camera.rotation.y+=step;
      else if(e.key==='ArrowRight')camera.rotation.y-=step;
      else if(e.key==='ArrowUp')camera.rotation.x+=step;
      else if(e.key==='ArrowDown')camera.rotation.x-=step;
      else if(e.key==='+'||e.key==='=')zoom(camera,camera.fov-5);
      else if(e.key==='-')zoom(camera,camera.fov+5);
      else if(e.key==='Home' && options.onReset)options.onReset();
      else return;
      e.preventDefault();camera.rotation.x=clamp(camera.rotation.x,-Math.PI/2+0.01,Math.PI/2-0.01,0);changed();
    });
    return function(){handlers.forEach(function(h){h[0].removeEventListener(h[1],h[2],h[3]);});
      points.forEach(function(_,id){if(canvas.hasPointerCapture(id))canvas.releasePointerCapture(id);});points.clear();};
  }
  root.PanoTools={adjust:adjust,filter:filter,view:view,applyView:applyView,zoom:zoom,history:history,bind:bind,reveal:reveal};
})(typeof window!=='undefined'?window:globalThis);
