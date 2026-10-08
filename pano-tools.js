/* 360° 環景共用工具：操作控制、圖片載入、傳送點、轉場與介面元件。
   index.html（前台）與 360viewer.html（管理工具）共用，外觀與手感保持一致。 */
(function(root) {
  'use strict';
  var doc = root.document, nav = root.navigator || {};
  var TAU = Math.PI * 2, HALF_PI = Math.PI / 2, PITCH_LIMIT = HALF_PI - 0.01;
  var FOV_MIN = 30, FOV_MAX = 100, FOV_DEFAULT = 75;
  var isMobile = /iPhone|iPad|iPod|Android/i.test(nav.userAgent || '') || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  var isTouch = ('ontouchstart' in root) || nav.maxTouchPoints > 0;

  // ── 基本工具 ────────────────────────────────────────────
  function clamp(value, min, max, fallback) {
    value = Number(value);
    return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  }
  function now() { return root.performance && performance.now ? performance.now() : Date.now(); }
  function wrapAngle(a) { a = (a + Math.PI) % TAU; return (a < 0 ? a + TAU : a) - Math.PI; }
  function reducedMotion() { return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
  function noop() {}
  function make(tag, cls, parent) {
    var el = doc.createElement(tag);
    if (cls) el.className = cls;
    if (parent) parent.appendChild(el);
    return el;
  }
  function safeColor(c) {
    c = String(c || '').trim();
    if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c)) return c;
    if (/^[a-z]+$/i.test(c) && root.CSS && CSS.supports && CSS.supports('color', c)) return c;
    return '#7eb87a';
  }
  function softColor(c, alpha) {
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})/i.exec(c);
    if (!m) return 'rgba(255,255,255,' + alpha + ')';
    var h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1], n = parseInt(h, 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  // ── 調色與視角（資料格式與舊版相容）──────────────────────
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
    return {yaw:clamp(value.yaw,-100000,100000,0), pitch:clamp(value.pitch,-PITCH_LIMIT,PITCH_LIMIT,0), fov:clamp(value.fov,FOV_MIN,FOV_MAX,FOV_DEFAULT)};
  }
  // 直式螢幕自動放寬視野，避免手機上看起來「太近」。
  function projectedFov(fov, aspect) {
    if (!(aspect > 0) || aspect >= 1) return fov;
    var t = Math.tan(fov * Math.PI / 360) / Math.sqrt(aspect);
    return Math.min(118, Math.atan(t) * 360 / Math.PI);
  }
  function applyView(camera, value) {
    var v = view(value);
    camera.rotation.set(v.pitch, v.yaw, 0); camera.fov = projectedFov(v.fov, camera.aspect); camera.updateProjectionMatrix();
  }
  function zoom(camera, fov) { camera.fov = clamp(fov, FOV_MIN, FOV_MAX, FOV_DEFAULT); camera.updateProjectionMatrix(); }
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
    if (!canvas.animate || reducedMotion()) return;
    canvas.animate([{opacity:0.6},{opacity:1}],{duration:180});
  }

  // ── 球面座標（與傳送點 phi/theta 的既有定義一致）────────
  function dirFromSpherical(phi, theta) {
    return {x: Math.sin(phi) * Math.sin(theta), y: Math.cos(phi), z: Math.sin(phi) * Math.cos(theta)};
  }
  function yawToward(theta) { return theta - Math.PI; }
  function pitchToward(phi) { return HALF_PI - phi; }
  // 透過傳送點抵達時，面向「繼續往前走」的方向：背對指回上一個場景的傳送點。
  function arrivalView(scene, fromId) {
    var base = view(scene && scene.initialView);
    var back = scene && fromId ? (scene.hotspots || []).filter(function(h) {
      return h && h.targetScene === fromId && Number.isFinite(Number(h.theta));
    })[0] : null;
    if (!back) return base;
    return {yaw: Number(back.theta), pitch: scene.initialView ? base.pitch : 0, fov: base.fov};
  }

  // ── 操作控制：慣性拖曳、平滑縮放、雙擊放大、自動旋轉、陀螺儀 ──
  function controls(canvas, camera, options) {
    options = options || {};
    var start = view(options.view);
    var cur = {yaw: start.yaw, pitch: start.pitch, fov: start.fov, roll: 0};
    var tgt = {yaw: start.yaw, pitch: start.pitch, fov: start.fov};
    var home = start, vel = {yaw: 0, pitch: 0}, points = new Map(), handlers = [], samples = [];
    var dragging = false, moved = false, origin = null, lastTap = null, tween = null, dirty = true;
    var lastFrame = 0, lastAspect = 0, lastInput = now(), pointerType = 'mouse';
    var auto = {on: !!options.autoRotate && !reducedMotion(), ramp: 0, speed: options.autoRotateSpeed || 0.05, delay: options.autoRotateDelay || 4000};
    var gyro = {on: false, ready: false, acc: 0, last: null, offset: 0, pitch: 0, roll: 0, wait: null}, gq = null;

    camera.rotation.order = 'YXZ';
    canvas.style.touchAction = 'none';
    if (!canvas.hasAttribute('tabindex')) canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', options.label || '360° 環景：拖曳旋轉，滾輪或雙指縮放，雙擊放大，方向鍵移動，Home 回到起始視角');

    function on(target, type, fn, opts) { target.addEventListener(type, fn, opts); handlers.push([target, type, fn, opts]); }
    function allowed() { return !options.canDrag || options.canDrag(); }
    function interact() { lastInput = now(); auto.ramp = 0; if (options.onInteract) options.onInteract(); }
    function stopTween() { if (tween) { var t = tween; tween = null; t.done(false); } }
    function setZoom(f) { tgt.fov = clamp(f, FOV_MIN, FOV_MAX, FOV_DEFAULT); }
    function setPitch(p) { tgt.pitch = clamp(p, -PITCH_LIMIT, PITCH_LIMIT, 0); }
    function radPerPx() { return camera.fov * Math.PI / 180 / Math.max(canvas.clientHeight, 150); }
    function pts() { return Array.from(points.values()); }
    function distance() { var p = pts(); return p.length === 2 ? Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) : 0; }
    function middle() { var p = pts(); return p.length === 2 ? {x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2} : null; }
    function rebaseGyro() { if (gyro.on && gyro.ready) gyro.offset = tgt.yaw - gyro.acc; }
    function pan(dx, dy) {
      var k = radPerPx();
      if (gyro.on) { gyro.offset += dx * k; return; }
      tgt.yaw += dx * k; setPitch(tgt.pitch + dy * k);
    }

    on(canvas, 'pointerdown', function(e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pointerType = e.pointerType || 'mouse';
      try { canvas.focus({preventScroll: true}); } catch (x) {}
      stopTween(); interact();
      if (!points.size) { moved = false; origin = {x: e.clientX, y: e.clientY}; samples = []; vel.yaw = vel.pitch = 0; }
      points.set(e.pointerId, {x: e.clientX, y: e.clientY});
      if (points.size > 1) moved = true;
      dragging = true;
      try { canvas.setPointerCapture(e.pointerId); } catch (x) {}
      canvas.classList.add('grabbing');
    });
    on(canvas, 'pointermove', function(e) {
      var prev = points.get(e.pointerId); if (!prev) return;
      var next = {x: e.clientX, y: e.clientY};
      if (points.size === 2) {
        var d0 = distance(), m0 = middle();
        points.set(e.pointerId, next);
        var d1 = distance(), m1 = middle();
        if (d0 > 0 && d1 > 0) setZoom(tgt.fov * d0 / d1);
        if (allowed()) pan(m1.x - m0.x, m1.y - m0.y);
        interact(); return;
      }
      points.set(e.pointerId, next);
      if (points.size !== 1) return;
      if (origin && Math.hypot(next.x - origin.x, next.y - origin.y) > 6) moved = true;
      if (!allowed()) return;
      var dx = next.x - prev.x, dy = next.y - prev.y, t = now();
      pan(dx, dy);
      samples.push({t: t, dx: dx, dy: dy});
      while (samples.length && t - samples[0].t > 100) samples.shift();
      interact();
    });
    // 放手時依最後 100ms 的速度順勢滑行；垂直方向較收斂，避免一甩就看天空。
    function fling() {
      var t = now();
      if (samples.length < 2 || t - samples[samples.length - 1].t > 60) return;
      var sx = 0, sy = 0, k = radPerPx();
      var span = Math.max(32, samples[samples.length - 1].t - samples[0].t + 16) / 1000;
      samples.forEach(function(s) { sx += s.dx; sy += s.dy; });
      vel.yaw = clamp(sx / span * k, -4, 4, 0);
      vel.pitch = clamp(sy / span * k * 0.5, -1, 1, 0);
    }
    function tapped(e) {
      var t = now(), x = e.clientX, y = e.clientY;
      var dbl = !!lastTap && t - lastTap.t < 320 && Math.hypot(x - lastTap.x, y - lastTap.y) < 32;
      lastTap = dbl ? null : {t: t, x: x, y: y};
      if (options.onTap) options.onTap(x, y);
      if (dbl && e.pointerType !== 'mouse') zoomAt(x, y);
    }
    function end(e) {
      if (!points.has(e.pointerId)) return;
      var single = points.size === 1, tap = e.type === 'pointerup' && single && !moved;
      points.delete(e.pointerId);
      try { if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId); } catch (x) {}
      if (points.size) return;
      dragging = false; canvas.classList.remove('grabbing');
      if (single && moved && e.type === 'pointerup' && allowed() && !gyro.on) fling();
      if (tap) tapped(e);
    }
    on(canvas, 'pointerup', end); on(canvas, 'pointercancel', end); on(canvas, 'lostpointercapture', end);
    on(canvas, 'dblclick', function(e) { e.preventDefault(); if (pointerType === 'mouse') zoomAt(e.clientX, e.clientY); });
    on(canvas, 'wheel', function(e) {
      e.preventDefault(); stopTween(); interact();
      var unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1;
      var d = clamp(e.deltaY * unit, -240, 240, 0);
      setZoom(tgt.fov * Math.exp(d * (e.ctrlKey ? 0.01 : 0.0015)));
    }, {passive: false});
    on(canvas, 'keydown', function(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      var step = 0.14 * tgt.fov / FOV_DEFAULT, k = e.key, act;
      if (k === 'ArrowLeft') act = function() { if (gyro.on) gyro.offset += step; else tgt.yaw += step; };
      else if (k === 'ArrowRight') act = function() { if (gyro.on) gyro.offset -= step; else tgt.yaw -= step; };
      else if (k === 'ArrowUp') act = function() { setPitch(tgt.pitch + step); };
      else if (k === 'ArrowDown') act = function() { setPitch(tgt.pitch - step); };
      else if (k === '+' || k === '=') act = function() { setZoom(tgt.fov / 1.2); };
      else if (k === '-' || k === '_') act = function() { setZoom(tgt.fov * 1.2); };
      else if (k === 'Home') act = function() { if (options.onReset) options.onReset(); else animateTo(home, 600); };
      else return;
      e.preventDefault(); stopTween(); interact(); act();
    });

    function screenDir(x, y) {
      var T = root.THREE, r = canvas.getBoundingClientRect();
      if (!T || !r.width || !r.height) return null;
      camera.updateMatrixWorld();
      var v = new T.Vector3((x - r.left) / r.width * 2 - 1, -((y - r.top) / r.height) * 2 + 1, 0.5).unproject(camera).normalize();
      return {yaw: Math.atan2(v.x, v.z) - Math.PI, pitch: Math.asin(clamp(v.y, -1, 1, 0))};
    }
    function zoomAt(x, y) {
      if (options.doubleTapZoom === false || !allowed()) return;
      interact();
      if (tgt.fov < home.fov * 0.8) { animateTo({fov: home.fov}, 420); return; }
      var d = screenDir(x, y), next = {fov: Math.max(FOV_MIN, tgt.fov * 0.55)};
      if (d && !gyro.on) { next.yaw = d.yaw; next.pitch = d.pitch; }
      animateTo(next, 420);
    }

    function orientation(e) {
      var T = root.THREE;
      if (!T || e.alpha == null) return;
      if (!gq) gq = {e: new T.Euler(), q: new T.Quaternion(), q0: new T.Quaternion(), q1: new T.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)), z: new T.Vector3(0, 0, 1), out: new T.Euler()};
      var r = Math.PI / 180, so = (root.screen && screen.orientation && screen.orientation.angle) || root.orientation || 0;
      gq.e.set(e.beta * r, e.alpha * r, -e.gamma * r, 'YXZ');
      gq.q.setFromEuler(gq.e).multiply(gq.q1).multiply(gq.q0.setFromAxisAngle(gq.z, -so * r));
      gq.out.setFromQuaternion(gq.q, 'YXZ');
      var yaw = gq.out.y;
      if (gyro.last == null) { gyro.acc = yaw; gyro.offset = tgt.yaw - yaw; }
      else gyro.acc += wrapAngle(yaw - gyro.last);
      gyro.last = yaw; gyro.pitch = gq.out.x; gyro.roll = gq.out.z; lastInput = now();
      if (!gyro.ready) { gyro.ready = true; if (gyro.wait) { var w = gyro.wait; gyro.wait = null; w(true); } }
    }
    function setGyro(enable) {
      if (!enable) {
        if (gyro.on) root.removeEventListener('deviceorientation', orientation);
        gyro.on = gyro.ready = false; gyro.last = null; dirty = true;
        if (gyro.wait) { var w = gyro.wait; gyro.wait = null; w(false); }
        return Promise.resolve(false);
      }
      if (gyro.on) return Promise.resolve(true);
      var DOE = root.DeviceOrientationEvent;
      if (!DOE) return Promise.resolve(false);
      var ask = typeof DOE.requestPermission === 'function' ? DOE.requestPermission() : Promise.resolve('granted');
      return ask.then(function(state) {
        if (state !== 'granted') return false;
        gyro.on = true; gyro.ready = false; gyro.last = null; stopTween(); vel.yaw = vel.pitch = 0;
        root.addEventListener('deviceorientation', orientation);
        return new Promise(function(resolve) {
          gyro.wait = resolve;
          setTimeout(function() { if (gyro.wait) setGyro(false); }, 1500);
        });
      }, function() { return false; });
    }

    function animateTo(v, duration, ease) {
      stopTween(); vel.yaw = vel.pitch = 0;
      var to = {
        yaw: v.yaw == null ? tgt.yaw : cur.yaw + wrapAngle(v.yaw - cur.yaw),
        pitch: v.pitch == null ? tgt.pitch : clamp(v.pitch, -PITCH_LIMIT, PITCH_LIMIT, 0),
        fov: v.fov == null ? tgt.fov : clamp(v.fov, FOV_MIN, FOV_MAX, FOV_DEFAULT)
      };
      if (!duration || reducedMotion()) {
        cur.yaw = tgt.yaw = to.yaw; cur.pitch = tgt.pitch = to.pitch; cur.fov = tgt.fov = to.fov;
        dirty = true; rebaseGyro(); return Promise.resolve(true);
      }
      return new Promise(function(resolve) {
        tween = {start: now(), dur: duration, from: {yaw: cur.yaw, pitch: cur.pitch, fov: cur.fov}, to: to, ease: ease || easeInOut, done: resolve};
      });
    }
    function setView(v, homeView) {
      stopTween(); vel.yaw = vel.pitch = 0;
      var n = view(v);
      cur.yaw = tgt.yaw = n.yaw; cur.pitch = tgt.pitch = n.pitch; cur.fov = tgt.fov = n.fov;
      home = homeView ? view(homeView) : n;
      dirty = true; rebaseGyro();
    }
    function getView() {
      return {yaw: Math.round(wrapAngle(cur.yaw) * 1e4) / 1e4, pitch: Math.round(cur.pitch * 1e4) / 1e4, fov: Math.round(cur.fov * 10) / 10};
    }

    // 每個畫面呼叫一次；回傳 true 代表視角有變，需要重新繪製。
    function update(t) {
      t = t || now();
      var dt = lastFrame ? clamp((t - lastFrame) / 1000, 0, 0.1, 0.016) : 0.016;
      lastFrame = t;
      var changed = dirty; dirty = false;
      if (tween) {
        var p = clamp((t - tween.start) / tween.dur, 0, 1, 1), k = tween.ease(p), a = tween.from, b = tween.to;
        cur.yaw = tgt.yaw = a.yaw + (b.yaw - a.yaw) * k;
        cur.pitch = tgt.pitch = a.pitch + (b.pitch - a.pitch) * k;
        cur.fov = tgt.fov = a.fov + (b.fov - a.fov) * k;
        changed = true;
        if (p >= 1) { var done = tween; tween = null; rebaseGyro(); done.done(true); }
      } else {
        if (!dragging && (vel.yaw || vel.pitch)) {
          tgt.yaw += vel.yaw * dt; setPitch(tgt.pitch + vel.pitch * dt);
          vel.yaw *= Math.exp(-dt * 3.5); vel.pitch *= Math.exp(-dt * 6);
          if (Math.abs(vel.yaw) < 0.003 && Math.abs(vel.pitch) < 0.003) vel.yaw = vel.pitch = 0;
        }
        if (gyro.on && gyro.ready) { tgt.yaw = gyro.acc + gyro.offset; setPitch(gyro.pitch); }
        else if (auto.on && !dragging && !points.size && !vel.yaw && t - lastInput > auto.delay) {
          auto.ramp = Math.min(1, auto.ramp + dt / 1.5);
          tgt.yaw -= auto.speed * auto.ramp * dt;
        }
        var kr = 1 - Math.exp(-dt * (dragging ? 26 : 12)), kz = 1 - Math.exp(-dt * 11);
        var dy = tgt.yaw - cur.yaw, dp = tgt.pitch - cur.pitch, df = tgt.fov - cur.fov;
        var dr = (gyro.on && gyro.ready ? gyro.roll : 0) - cur.roll;
        if (Math.abs(dy) > 1e-5 || Math.abs(dp) > 1e-5) { cur.yaw += dy * kr; cur.pitch += dp * kr; changed = true; }
        else { cur.yaw = tgt.yaw; cur.pitch = tgt.pitch; }
        if (Math.abs(df) > 1e-3) { cur.fov += df * kz; changed = true; } else cur.fov = tgt.fov;
        if (Math.abs(dr) > 1e-4) { cur.roll += dr * kr; changed = true; } else cur.roll += dr;
      }
      if (camera.aspect !== lastAspect) { lastAspect = camera.aspect; changed = true; }
      if (changed) {
        camera.rotation.set(cur.pitch, cur.yaw, cur.roll);
        camera.fov = projectedFov(cur.fov, camera.aspect);
        camera.updateProjectionMatrix();
        if (options.onChange) options.onChange();
      }
      return changed;
    }

    function dispose() {
      stopTween(); setGyro(false);
      handlers.forEach(function(h) { h[0].removeEventListener(h[1], h[2], h[3]); });
      handlers = [];
      points.forEach(function(_, id) { try { if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id); } catch (x) {} });
      points.clear();
    }

    return {
      update: update, setView: setView, getView: getView, animateTo: animateTo, setGyro: setGyro, dispose: dispose,
      zoomBy: function(factor) { stopTween(); interact(); setZoom(tgt.fov * factor); },
      rotateBy: function(dyaw, dpitch) { stopTween(); interact(); tgt.yaw += dyaw || 0; setPitch(tgt.pitch + (dpitch || 0)); },
      setAutoRotate: function(onOff) { auto.on = !!onOff; auto.ramp = 0; lastInput = now() - (onOff ? auto.delay : 0); },
      isAutoRotate: function() { return auto.on; },
      isGyro: function() { return gyro.on; },
      isBusy: function() { return !!tween; },
      markDirty: function() { dirty = true; }
    };
  }
  // 舊版 API：自行驅動 update，維持相容。
  function bind(canvas, camera, options) {
    var ctl = controls(canvas, camera, options), raf = 0;
    function tick(t) { ctl.update(t); raf = root.requestAnimationFrame(tick); }
    raf = root.requestAnimationFrame(tick);
    var release = function() { root.cancelAnimationFrame(raf); ctl.dispose(); };
    release.controls = ctl;
    return release;
  }

  // ── 圖片載入：串流進度、背景預載、離主執行緒解碼 ─────────
  var images = (function() {
    var cache = new Map(), LIMIT = isMobile ? 2 : 5;
    function netOk() {
      var c = nav.connection;
      return !(c && (c.saveData || /(^|-)2g$|^3g$/.test(c.effectiveType || '')));
    }
    function trim() {
      if (cache.size <= LIMIT) return;
      var keys = [];
      cache.forEach(function(_, k) { keys.push(k); });
      for (var i = 0; i < keys.length && cache.size > LIMIT; i++) {
        var e = cache.get(keys[i]);
        if (e.done || e.failed) cache.delete(keys[i]);
      }
    }
    function download(e) {
      function report() {
        e.last = Date.now();
        e.listeners.slice().forEach(function(fn) { try { fn(e.loaded, e.total); } catch (x) {} });
      }
      return fetch(e.url, {mode: 'cors', credentials: 'omit', signal: e.ctrl ? e.ctrl.signal : undefined}).then(function(res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        e.total = Number(res.headers.get('content-length')) || 0;
        var type = res.headers.get('content-type') || '';
        if (!res.body || !res.body.getReader) return res.blob();
        var reader = res.body.getReader(), chunks = [];
        function pump() {
          return reader.read().then(function(r) {
            if (r.done) return new Blob(chunks, {type: type});
            chunks.push(r.value); e.loaded += r.value.byteLength; report();
            return pump();
          });
        }
        return pump();
      });
    }
    function entry(url, prefetch) {
      var e = cache.get(url);
      if (e && !e.failed) { cache.delete(url); cache.set(url, e); if (!prefetch) e.prefetch = false; return e; }
      e = {url: url, loaded: 0, total: 0, done: false, failed: false, listeners: [], prefetch: !!prefetch, last: Date.now(),
        ctrl: root.AbortController ? new AbortController() : null};
      e.promise = download(e).then(function(blob) {
        e.done = true; e.blob = blob; trim(); return blob;
      }, function(err) {
        e.failed = true; if (cache.get(url) === e) cache.delete(url); throw err;
      });
      cache.set(url, e); trim();
      return e;
    }
    function viaImage(blob) {
      return new Promise(function(resolve, reject) {
        var u = URL.createObjectURL(blob), img = new Image();
        img.onload = function() { URL.revokeObjectURL(u); resolve(img); };
        img.onerror = function() { URL.revokeObjectURL(u); reject(new Error('decode')); };
        img.src = u;
      });
    }
    function decode(blob, maxSize) {
      var p = root.createImageBitmap ? root.createImageBitmap(blob).catch(function() { return viaImage(blob); }) : viaImage(blob);
      return p.then(function(src) {
        var w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
        if (!w || !h) throw new Error('decode');
        var s = Math.min(1, maxSize / w, maxSize / h), c = doc.createElement('canvas');
        c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
        var ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(src, 0, 0, c.width, c.height);
        if (src.close) src.close();
        return c;
      });
    }
    // 載入目前場景：其他尚未完成的下載會被取消，把頻寬留給眼前這張。
    function load(url, opts) {
      opts = opts || {};
      cache.forEach(function(x, k) { if (k !== url) stop(x); });
      var e = entry(url, false);
      return new Promise(function(resolve, reject) {
        var fn = opts.onProgress || null, settled = false;
        if (fn) { e.listeners.push(fn); if (e.loaded) fn(e.loaded, e.total); }
        var watchdog = setInterval(function() {
          if (!e.done && Date.now() - e.last > (opts.stallMs || 25000)) { stop(e); fail(new Error('timeout')); }
        }, 1000);
        function cleanup() { clearInterval(watchdog); if (fn) { var i = e.listeners.indexOf(fn); if (i >= 0) e.listeners.splice(i, 1); } }
        function fail(err) { if (settled) return; settled = true; cleanup(); reject(err); }
        e.promise.then(function(blob) {
          if (settled) return;
          cleanup(); if (fn) fn(e.total || blob.size, e.total || blob.size);
          decode(blob, opts.maxSize || 4096).then(function(c) { settled = true; resolve(c); }, fail);
        }, fail);
      });
    }
    function prefetch(url, force) {
      if (!url || !root.fetch || (!force && !netOk())) return;
      var e = cache.get(url);
      if (e && !e.failed) return;
      entry(url, true).promise.catch(noop);
    }
    // 中止下載並立即移出快取，之後再載入同一張會重新下載
    function stop(x) {
      if (x.done || x.failed || !x.ctrl) return;
      x.failed = true; x.ctrl.abort();
      if (cache.get(x.url) === x) cache.delete(x.url);
    }
    function cancel() { cache.forEach(stop); }
    return {load: load, prefetch: prefetch, cancel: cancel};
  })();

  function maxTextureSize(renderer) {
    var cap = (renderer && renderer.capabilities && renderer.capabilities.maxTextureSize) || 4096;
    var mem = nav.deviceMemory || 8;
    return Math.min(cap, isMobile ? 4096 : (mem >= 8 ? 8192 : 4096));
  }
  function panoTexture(source, renderer) {
    var T = root.THREE, tex = new T.CanvasTexture(source);
    tex.encoding = T.sRGBEncoding;
    tex.wrapS = T.RepeatWrapping; tex.repeat.x = -1; tex.offset.x = 1;
    if (isMobile) { tex.minFilter = T.LinearFilter; tex.generateMipmaps = false; }
    else if (renderer && renderer.capabilities.getMaxAnisotropy) tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    return tex;
  }
  function gyroSupported() { return !!root.DeviceOrientationEvent && isTouch && isMobile; }

  // ── 圖示（線條 SVG，深淺背景都清楚）─────────────────────
  var ICONS = {
    chevL: '<path d="M15 18l-6-6 6-6"/>',
    chevR: '<path d="M9 6l6 6-6 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    caret: '<path d="M6 15l6-6 6 6"/>',
    expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    collapse: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
    auto: '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 3.5v5h-5"/>',
    gyro: '<rect x="7.5" y="3" width="9" height="18" rx="2.2"/><path d="M11 17.5h2"/><path d="M3.5 9.5c-.8 1.6-.8 3.4 0 5M20.5 9.5c.8 1.6.8 3.4 0 5"/>',
    close: '<path d="M18 6L6 18M6 6l12 12"/>',
    retry: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 3.5v5h5"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    help: '<circle cx="12" cy="12" r="9.5"/><path d="M9.3 9.2a2.8 2.8 0 0 1 5.4 1c0 1.9-2.7 2.4-2.7 4"/><path d="M12 17.3h.01"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    move: '<path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/>',
    globe: '<circle cx="12" cy="12" r="9.5"/><ellipse cx="12" cy="12" rx="4" ry="9.5"/><path d="M2.5 12h19"/>'
  };
  function icon(name) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + (ICONS[name] || '') + '</svg>';
  }

  // ── 共用樣式（只注入一次）───────────────────────────────
  var CSS_TEXT = [
    '.ptv{--ptv-accent:#7eb87a;--ptv-accent-soft:rgba(126,184,122,.2);--ptv-gold:#c4a35a;--ptv-glass:rgba(12,17,13,.56);--ptv-glass-strong:rgba(12,17,13,.84);--ptv-line:rgba(255,255,255,.14);--ptv-text:#f3f0e8;--ptv-muted:rgba(243,240,232,.68);position:relative;overflow:hidden;background:radial-gradient(120% 90% at 50% 38%,#1c261d 0%,#0b100c 72%);color:var(--ptv-text);-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;}',
    '.ptv.gold{--ptv-accent:#c4a35a;--ptv-accent-soft:rgba(196,163,90,.22);}',
    '.ptv,.ptv button{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif;}',
    '.ptv-canvas{position:absolute;inset:0;width:100%!important;height:100%!important;display:block;cursor:grab;touch-action:none;outline:none;}',
    '.ptv-canvas.grabbing{cursor:grabbing;}',
    '.ptv-canvas:focus-visible{box-shadow:inset 0 0 0 2px var(--ptv-gold);}',
    '.ptv svg{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}',
    /* 傳送點 */
    '.ptv-hs-layer{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:4;}',
    '.ptv-hs{position:absolute;left:0;top:0;width:0;height:0;padding:0;margin:0;border:0;background:none;color:#fff;font:inherit;pointer-events:auto;cursor:pointer;will-change:transform;--hs-color:#7eb87a;--hs-soft:rgba(126,184,122,.35);--hs-size:44px;-webkit-tap-highlight-color:transparent;}',
    '.ptv-hs.is-off{visibility:hidden;pointer-events:none;}',
    '.ptv-hs:focus{outline:none;}',
    '.ptv-hs-in{position:absolute;left:0;top:0;}',
    '.ptv-hs-layer.is-enter .ptv-hs-in{animation:ptv-in .6s cubic-bezier(.2,.8,.3,1) .15s backwards;}',
    '.ptv-hs-dot{position:absolute;left:calc(var(--hs-size) / -2);top:calc(var(--hs-size) / -2);width:var(--hs-size);height:var(--hs-size);box-sizing:border-box;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:calc(var(--hs-size) * .42);line-height:1;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.55);background:radial-gradient(circle at 50% 28%,rgba(255,255,255,.32),rgba(255,255,255,.05) 62%),rgba(10,14,11,.42);border:2px solid var(--hs-color);box-shadow:0 0 0 1px rgba(0,0,0,.22),0 8px 22px rgba(0,0,0,.42),inset 0 0 14px var(--hs-soft);-webkit-backdrop-filter:blur(6px) saturate(150%);backdrop-filter:blur(6px) saturate(150%);transition:scale .3s cubic-bezier(.3,1.5,.5,1),box-shadow .3s ease;}',
    '.ptv-hs:hover .ptv-hs-dot,.ptv-hs:focus-visible .ptv-hs-dot{scale:1.14;box-shadow:0 0 0 5px var(--hs-soft),0 10px 26px rgba(0,0,0,.5),inset 0 0 16px var(--hs-soft);}',
    '.ptv-hs:focus-visible .ptv-hs-dot{outline:2px solid #fff;outline-offset:3px;}',
    '.ptv-hs-label{position:absolute;left:0;bottom:calc(var(--hs-size) / 2 + 9px);transform:translateX(-50%);display:flex;align-items:center;gap:6px;white-space:nowrap;padding:4px 11px 4px 9px;border-radius:999px;background:rgba(10,14,11,.74);border:1px solid rgba(255,255,255,.15);color:#fff;font-size:12px;font-weight:600;letter-spacing:.03em;line-height:1.45;box-shadow:0 6px 18px rgba(0,0,0,.35);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);transition:transform .25s ease,background .25s ease;pointer-events:none;}',
    '.ptv-hs-label::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--hs-color);box-shadow:0 0 8px var(--hs-color);flex-shrink:0;}',
    '.ptv-hs:hover .ptv-hs-label,.ptv-hs:focus-visible .ptv-hs-label{transform:translateX(-50%) translateY(-3px);background:rgba(10,14,11,.9);}',
    '.ptv-fx-pulse .ptv-hs-dot::before,.ptv-fx-pulse .ptv-hs-dot::after{content:"";position:absolute;inset:-2px;border-radius:50%;border:2px solid var(--hs-color);opacity:0;animation:ptv-ripple 2.6s cubic-bezier(.2,.6,.35,1) infinite;pointer-events:none;}',
    '.ptv-fx-pulse .ptv-hs-dot::after{animation-delay:1.3s;}',
    '.ptv-fx-glow .ptv-hs-dot{animation:ptv-glow 2.8s ease-in-out infinite;}',
    '.ptv-fx-breathe .ptv-hs-dot{animation:ptv-breathe 2.6s ease-in-out infinite;}',
    '.ptv-hs-arrow{position:absolute;left:-9px;top:calc(var(--hs-size) / 2 + 5px);width:18px;height:18px;animation:ptv-bob 1.5s ease-in-out infinite;pointer-events:none;}',
    '.ptv-hs-arrow::before{content:"";position:absolute;left:3px;top:0;width:10px;height:10px;border-right:3px solid var(--hs-color);border-bottom:3px solid var(--hs-color);border-radius:0 0 3px 0;transform:rotate(45deg);filter:drop-shadow(0 2px 3px rgba(0,0,0,.6));}',
    '.ptv-hs.ptv-hs-go .ptv-hs-dot{animation:ptv-go .55s ease-out forwards;}',
    '.ptv-hs.ptv-hs-go .ptv-hs-label{opacity:0;transition:opacity .3s;}',
    '@keyframes ptv-in{from{opacity:0;transform:translateY(10px) scale(.7);}to{opacity:1;transform:none;}}',
    '@keyframes ptv-ripple{0%{transform:scale(1);opacity:.75;}100%{transform:scale(2.2);opacity:0;}}',
    '@keyframes ptv-glow{0%,100%{box-shadow:0 0 0 3px var(--hs-soft),0 0 14px var(--hs-soft),0 8px 22px rgba(0,0,0,.42);}50%{box-shadow:0 0 0 6px var(--hs-soft),0 0 30px var(--hs-color),0 8px 22px rgba(0,0,0,.42);}}',
    '@keyframes ptv-breathe{0%,100%{transform:scale(1);}50%{transform:scale(1.12);}}',
    '@keyframes ptv-bob{0%,100%{transform:translateY(0);opacity:.95;}50%{transform:translateY(6px);opacity:.55;}}',
    '@keyframes ptv-go{0%{transform:scale(1);}35%{transform:scale(1.32);box-shadow:0 0 0 10px var(--hs-soft),0 0 40px var(--hs-color);}100%{transform:scale(.55);opacity:0;}}',
    /* 轉場與載入 */
    '.ptv-xfade{position:absolute;inset:0;z-index:5;pointer-events:none;opacity:0;visibility:hidden;transform-origin:50% 50%;}',
    '.ptv-xfade canvas{position:absolute;inset:0;width:100%;height:100%;display:block;}',
    '.ptv-xfade.is-on{opacity:1;visibility:visible;transition:none;}',
    '.ptv-xfade.is-wait{filter:blur(10px) brightness(.6) saturate(.9);transform:scale(1.04);transition:filter .7s ease,transform 2.4s cubic-bezier(.2,.7,.2,1);}',
    '.ptv-xfade.is-leave{opacity:0;transition:opacity .55s ease,filter .55s ease;}',
    '.ptv-xfade.is-forward{opacity:0;transform:scale(1.4);filter:blur(6px);transition:opacity .75s ease,transform .9s cubic-bezier(.16,.8,.3,1),filter .75s ease;}',
    '.ptv-loader{position:absolute;inset:0;z-index:8;display:flex;align-items:center;justify-content:center;pointer-events:none;opacity:0;visibility:hidden;transition:opacity .3s ease,visibility 0s linear .3s;}',
    '.ptv-loader.is-on{opacity:1;visibility:visible;transition:opacity .3s ease;}',
    '.ptv-loader-card{display:flex;flex-direction:column;align-items:center;gap:8px;min-width:150px;max-width:80%;padding:18px 24px 16px;border-radius:20px;background:var(--ptv-glass);border:1px solid var(--ptv-line);box-shadow:0 18px 50px rgba(0,0,0,.45);-webkit-backdrop-filter:blur(16px) saturate(140%);backdrop-filter:blur(16px) saturate(140%);text-align:center;}',
    '.ptv-ring{position:relative;width:58px;height:58px;margin-bottom:2px;}',
    '.ptv-ring svg{width:100%;height:100%;transform:rotate(-90deg);}',
    '.ptv-ring .trk{stroke:rgba(255,255,255,.12);stroke-width:4;}',
    '.ptv-ring .bar{stroke:var(--ptv-accent);stroke-width:4;stroke-dasharray:150.8;stroke-dashoffset:150.8;transition:stroke-dashoffset .25s ease;}',
    '.ptv-loader.is-indet .ptv-ring svg{animation:ptv-spin 1s linear infinite;}',
    '.ptv-loader.is-indet .bar{stroke-dashoffset:108;}',
    '.ptv-ring-pct{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--ptv-text);}',
    '.ptv-loader-title{font-size:14px;font-weight:650;letter-spacing:.04em;color:var(--ptv-text);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.ptv-loader-text{font-size:12px;color:var(--ptv-muted);letter-spacing:.03em;font-variant-numeric:tabular-nums;}',
    '.ptv-loader-btn{pointer-events:auto;margin-top:6px;display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:999px;border:1px solid var(--ptv-accent);background:var(--ptv-accent-soft);color:var(--ptv-text);font-size:13px;font-weight:600;cursor:pointer;}',
    '.ptv-loader-btn[hidden]{display:none;}',
    '.ptv-loader-btn svg{width:15px;height:15px;}',
    '.ptv-loader-btn:hover{background:var(--ptv-accent);color:#0d130e;}',
    '.ptv-loader.is-error .ptv-ring{display:none;}',
    '.ptv-loader.is-error{pointer-events:none;}',
    '@keyframes ptv-spin{from{transform:rotate(-90deg);}to{transform:rotate(270deg);}}',
    /* 介面 */
    '.ptv-ui{position:absolute;inset:0;z-index:10;pointer-events:none;}',
    '.ptv-ui.is-empty .ptv-bottom,.ptv-ui.is-empty .ptv-compass{display:none;}',
    '.ptv-top{position:absolute;top:10px;left:10px;right:10px;display:flex;align-items:flex-start;justify-content:space-between;gap:8px;pointer-events:none;}',
    '.ptv-tl,.ptv-tr{display:flex;align-items:center;gap:8px;min-width:0;}',
    '.ptv-tr{gap:6px;flex-shrink:0;}',
    '.ptv-tl>*,.ptv-tr>*{pointer-events:auto;}',
    '.ptv-btn{width:38px;height:38px;flex-shrink:0;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:1px solid var(--ptv-line);background:var(--ptv-glass);color:var(--ptv-text);cursor:pointer;-webkit-backdrop-filter:blur(14px) saturate(140%);backdrop-filter:blur(14px) saturate(140%);box-shadow:0 6px 18px rgba(0,0,0,.28);transition:background .18s ease,border-color .18s ease,color .18s ease,transform .18s ease;}',
    '.ptv-btn svg{width:18px;height:18px;}',
    '.ptv-btn:hover{background:rgba(255,255,255,.16);}',
    '.ptv-btn:active{transform:scale(.93);}',
    '.ptv-btn:focus-visible,.ptv-scene-btn:focus-visible,.ptv-compass:focus-visible,.ptv-list button:focus-visible{outline:2px solid var(--ptv-gold);outline-offset:2px;}',
    '.ptv-btn[aria-pressed="true"]{color:#0d130e;background:var(--ptv-accent);border-color:var(--ptv-accent);}',
    '.ptv-compass{width:42px;height:42px;padding:0;border:0;background:none;cursor:pointer;border-radius:50%;flex-shrink:0;filter:drop-shadow(0 6px 14px rgba(0,0,0,.35));transition:transform .2s ease;}',
    '.ptv-compass:hover{transform:scale(1.06);}',
    '.ptv-compass svg{width:100%;height:100%;display:block;stroke:none;}',
    '.ptv-compass .c-bg{fill:rgba(12,17,13,.62);stroke:rgba(255,255,255,.2);stroke-width:1;}',
    '.ptv-compass .c-fov{fill:var(--ptv-accent);opacity:.38;}',
    '.ptv-compass .c-tick{fill:var(--ptv-accent);}',
    '.ptv-compass .c-me{fill:#fff;}',
    '.ptv-compass .c-dots circle{stroke:rgba(0,0,0,.55);stroke-width:.8;}',
    '.ptv-title{display:flex;align-items:baseline;gap:8px;min-width:0;max-width:min(52vw,380px);padding:8px 14px;border-radius:999px;background:var(--ptv-glass);border:1px solid var(--ptv-line);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);box-shadow:0 6px 18px rgba(0,0,0,.28);}',
    '.ptv-title[hidden]{display:none;}',
    '.ptv-title-name{font-size:13.5px;font-weight:650;letter-spacing:.03em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.ptv-title-count{font-size:11px;color:var(--ptv-muted);font-variant-numeric:tabular-nums;white-space:nowrap;}',
    '.ptv-bottom{position:absolute;left:10px;right:10px;bottom:10px;display:flex;justify-content:center;align-items:center;gap:8px;pointer-events:none;}',
    '.ptv-bottom>*{pointer-events:auto;}',
    '.ptv-pill{display:flex;align-items:center;gap:2px;padding:4px;border-radius:16px;background:var(--ptv-glass);border:1px solid var(--ptv-line);-webkit-backdrop-filter:blur(14px) saturate(140%);backdrop-filter:blur(14px) saturate(140%);box-shadow:0 10px 28px rgba(0,0,0,.35);min-width:0;}',
    '.ptv-pill[hidden]{display:none;}',
    '.ptv-pill .ptv-btn{width:36px;height:36px;border-radius:12px;background:transparent;border-color:transparent;box-shadow:none;-webkit-backdrop-filter:none;backdrop-filter:none;}',
    '.ptv-pill .ptv-btn:hover{background:rgba(255,255,255,.12);}',
    '.ptv-nav{flex:0 1 320px;}',
    '.ptv-scene-btn{display:flex;align-items:center;justify-content:center;gap:8px;min-width:0;flex:1;height:36px;padding:0 10px;border:0;border-radius:12px;background:transparent;color:var(--ptv-text);font-size:13px;font-weight:650;letter-spacing:.03em;cursor:pointer;transition:background .18s ease;}',
    '.ptv-scene-btn:hover{background:rgba(255,255,255,.12);}',
    '.ptv-scene-btn span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.ptv-scene-btn svg{width:14px;height:14px;flex-shrink:0;opacity:.7;transition:transform .2s ease;}',
    '.ptv-scene-btn[aria-expanded="true"] svg{transform:rotate(180deg);}',
    '.ptv-list{position:absolute;left:50%;bottom:calc(100% + 10px);width:min(320px,100%);max-height:min(340px,55vh);overflow:auto;overscroll-behavior:contain;padding:6px;border-radius:16px;background:var(--ptv-glass-strong);border:1px solid var(--ptv-line);-webkit-backdrop-filter:blur(18px) saturate(140%);backdrop-filter:blur(18px) saturate(140%);box-shadow:0 18px 50px rgba(0,0,0,.5);opacity:0;visibility:hidden;transform:translate(-50%,8px);transition:opacity .2s ease,transform .2s ease,visibility 0s linear .2s;}',
    '.ptv-list.is-open{opacity:1;visibility:visible;transform:translate(-50%,0);transition:opacity .2s ease,transform .2s ease;}',
    '.ptv-list button{display:flex;align-items:center;gap:10px;width:100%;padding:9px 10px;border:0;border-radius:10px;background:transparent;color:var(--ptv-text);font-size:13px;text-align:left;cursor:pointer;}',
    '.ptv-list button:hover{background:rgba(255,255,255,.1);}',
    '.ptv-list button[aria-selected="true"]{background:var(--ptv-accent-soft);}',
    '.ptv-list-num{width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;background:rgba(255,255,255,.1);flex-shrink:0;font-variant-numeric:tabular-nums;}',
    '.ptv-list button[aria-selected="true"] .ptv-list-num{background:var(--ptv-accent);color:#0d130e;}',
    '.ptv-list-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.ptv-hint{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(.96);display:flex;align-items:center;gap:12px;max-width:calc(100% - 40px);padding:12px 18px;border-radius:16px;background:var(--ptv-glass);border:1px solid var(--ptv-line);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);box-shadow:0 14px 40px rgba(0,0,0,.4);opacity:0;visibility:hidden;transition:opacity .35s ease,transform .35s ease,visibility 0s linear .35s;pointer-events:none;}',
    '.ptv-hint.is-on{opacity:1;visibility:visible;transform:translate(-50%,-50%);transition:opacity .35s ease,transform .35s ease;}',
    '.ptv-hint svg{width:30px;height:30px;flex-shrink:0;color:var(--ptv-accent);animation:ptv-swipe 1.8s ease-in-out infinite;}',
    '.ptv-hint b{display:block;font-size:13.5px;font-weight:650;letter-spacing:.03em;}',
    '.ptv-hint small{display:block;font-size:11.5px;color:var(--ptv-muted);margin-top:2px;line-height:1.5;}',
    '@keyframes ptv-swipe{0%,100%{transform:translateX(-5px);}50%{transform:translateX(5px);}}',
    '.ptv.is-narrow .ptv-zoom{display:none;}',
    '.ptv.is-narrow .ptv-title{max-width:44vw;padding:7px 12px;}',
    '.ptv.is-fs .ptv-top{top:calc(env(safe-area-inset-top,0px) + 12px);left:calc(env(safe-area-inset-left,0px) + 12px);right:calc(env(safe-area-inset-right,0px) + 12px);}',
    '.ptv.is-fs .ptv-bottom{bottom:calc(env(safe-area-inset-bottom,0px) + 14px);left:calc(env(safe-area-inset-left,0px) + 12px);right:calc(env(safe-area-inset-right,0px) + 12px);}',
    '.ptv.is-fs .ptv-tr .ptv-btn{width:44px;height:44px;border-radius:14px;}',
    '@media (hover:none){.ptv-hs-dot,.ptv-hs-label{-webkit-backdrop-filter:none;backdrop-filter:none;}.ptv-hs-dot{background:radial-gradient(circle at 50% 28%,rgba(255,255,255,.3),rgba(255,255,255,.05) 62%),rgba(10,14,11,.58);}}',
    '@media (prefers-reduced-motion:reduce){.ptv-hs-dot,.ptv-hs-dot::before,.ptv-hs-dot::after,.ptv-hs-arrow,.ptv-hint svg,.ptv-hs-layer.is-enter .ptv-hs-in{animation:none!important;}}'
  ].join('\n');
  function injectStyles() {
    if (!doc || doc.getElementById('ptv-styles')) return;
    var s = make('style'); s.id = 'ptv-styles'; s.textContent = CSS_TEXT;
    (doc.head || doc.documentElement).appendChild(s);
  }

  // ── 傳送點圖層 ───────────────────────────────────────────
  function buildHotspot(hs, extra) {
    var effect = hs.effect || (hs.pulse !== false ? 'pulse' : 'none');
    var color = safeColor(hs.color), size = clamp(hs.size, 24, 96, 44), label = hs.label || '前往';
    var b = make('button', 'ptv-hs ptv-fx-' + effect + (extra.editable ? ' editable' : ''));
    b.type = 'button'; b.dataset.id = hs.id;
    b.setAttribute('aria-label', extra.editable ? label + '（拖曳調整位置）' : label);
    if (extra.editable) b.title = '拖曳調整位置';
    b.style.setProperty('--hs-color', color);
    b.style.setProperty('--hs-soft', softColor(color, 0.35));
    b.style.setProperty('--hs-size', size + 'px');
    var inner = make('span', 'ptv-hs-in', b);
    make('span', 'ptv-hs-label', inner).textContent = label;
    make('span', 'ptv-hs-dot', inner).textContent = hs.icon || '⬆';
    if (effect === 'arrow') make('span', 'ptv-hs-arrow', inner);
    return b;
  }
  function HotspotLayer(layer, opts) {
    injectStyles();
    layer.classList.add('ptv-hs-layer');
    this.layer = layer; this.opts = opts || {}; this.items = []; this.v = null; this.f = null;
  }
  HotspotLayer.prototype.set = function(list, extra) {
    var me = this; extra = extra || {};
    me.items.forEach(function(it) { if (it.el.parentNode) it.el.parentNode.removeChild(it.el); });
    me.layer.classList.remove('is-enter');
    if (extra.animate !== false && (list || []).length) { void me.layer.offsetWidth; me.layer.classList.add('is-enter'); }
    me.items = (list || []).filter(function(hs) {
      return hs && Number.isFinite(Number(hs.phi)) && Number.isFinite(Number(hs.theta));
    }).map(function(hs) {
      var el = buildHotspot(hs, extra);
      if (me.opts.decorate) me.opts.decorate(el, hs, extra);
      if (me.opts.onClick && !extra.editable) el.addEventListener('click', function(e) { e.stopPropagation(); me.opts.onClick(hs, el, e); });
      me.layer.appendChild(el);
      return {hs: hs, el: el, phi: Number(hs.phi), theta: Number(hs.theta), d: dirFromSpherical(Number(hs.phi), Number(hs.theta)), off: null, tf: '', o: -1};
    });
  };
  HotspotLayer.prototype.clear = function() { this.set([]); };
  HotspotLayer.prototype.element = function(id) {
    for (var i = 0; i < this.items.length; i++) if (this.items[i].hs.id === id) return this.items[i].el;
    return null;
  };
  // 每次重繪後呼叫：把 3D 方向投影到畫面座標（只用 transform，不觸發版面重排）。
  HotspotLayer.prototype.update = function(camera, w, h, skipId) {
    var T = root.THREE;
    if (!T || !this.items.length || !w || !h) return;
    if (!this.v) { this.v = new T.Vector3(); this.f = new T.Vector3(); }
    var f = this.f.set(0, 0, -1).applyQuaternion(camera.quaternion), v = this.v;
    var s = clamp(Math.pow(FOV_DEFAULT / camera.fov, 0.45), 0.85, 1.35, 1).toFixed(3);
    this.items.forEach(function(it) {
      // 拖曳中的點由呼叫端自行定位；放開後強制重新套用位置
      if (it.hs.id === skipId) { it.tf = ''; it.o = -1; return; }
      // 管理工具拖曳後 phi/theta 會改變，重新計算方向
      if (Number(it.hs.phi) !== it.phi || Number(it.hs.theta) !== it.theta) {
        it.phi = Number(it.hs.phi); it.theta = Number(it.hs.theta); it.d = dirFromSpherical(it.phi, it.theta);
      }
      var d = it.d, dot = f.x * d.x + f.y * d.y + f.z * d.z, x = 0, y = 0, off = dot < 0.08;
      if (!off) {
        v.set(d.x * 50, d.y * 50, d.z * 50).project(camera);
        x = (v.x + 1) / 2 * w; y = (1 - v.y) / 2 * h;
        off = x < -90 || x > w + 90 || y < -90 || y > h + 90;
      }
      if (off !== it.off) { it.el.classList.toggle('is-off', off); it.off = off; }
      if (off) return;
      var tf = 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0) scale(' + s + ')';
      if (tf !== it.tf) { it.el.style.transform = tf; it.tf = tf; }
      var o = Math.round(Math.min(1, (dot - 0.08) / 0.22) * 100) / 100;
      if (o !== it.o) { it.el.style.opacity = o; it.o = o; }
    });
  };

  // ── 場景轉場：擷取目前畫面，新場景就緒後淡出 / 向前推進 ──
  function Transition(wrap) {
    injectStyles();
    wrap.classList.add('ptv');
    this.el = make('div', 'ptv-xfade', wrap);
    this.cv = make('canvas', '', this.el);
    this.active = false; this.timer = 0;
  }
  // 必須在 renderer.render() 之後立刻呼叫（同一個事件循環內）。
  Transition.prototype.capture = function(src) {
    try {
      this.cv.width = src.width; this.cv.height = src.height;
      this.cv.getContext('2d').drawImage(src, 0, 0);
    } catch (e) { return false; }
    this.cv.style.filter = src.style.filter || '';
    clearTimeout(this.timer);
    this.el.className = 'ptv-xfade is-on';
    this.active = true;
    return true;
  };
  Transition.prototype.wait = function() { if (this.active) this.el.classList.add('is-wait'); };
  Transition.prototype.leave = function(kind) {
    if (!this.active) return;
    var me = this;
    void me.el.offsetWidth;
    me.el.classList.add(kind === 'forward' && !reducedMotion() ? 'is-forward' : 'is-leave');
    clearTimeout(me.timer);
    me.timer = setTimeout(function() { me.clear(); }, 1000);
  };
  Transition.prototype.clear = function() {
    clearTimeout(this.timer);
    this.active = false;
    this.el.className = 'ptv-xfade';
    this.cv.width = this.cv.height = 1;
  };

  // ── 載入指示（圓環進度 + 檔案大小 + 重試）──────────────
  function Loader(wrap) {
    injectStyles();
    wrap.classList.add('ptv');
    var me = this;
    me.el = make('div', 'ptv-loader is-indet', wrap);
    me.el.setAttribute('role', 'status');
    me.el.innerHTML = '<div class="ptv-loader-card"><div class="ptv-ring"><svg viewBox="0 0 58 58" aria-hidden="true"><circle class="trk" cx="29" cy="29" r="24"/><circle class="bar" cx="29" cy="29" r="24"/></svg><span class="ptv-ring-pct"></span></div><div class="ptv-loader-title"></div><div class="ptv-loader-text"></div><button type="button" class="ptv-loader-btn" hidden>' + icon('retry') + '<span>重新載入</span></button></div>';
    me.bar = me.el.querySelector('.bar'); me.pct = me.el.querySelector('.ptv-ring-pct');
    me.title = me.el.querySelector('.ptv-loader-title'); me.text = me.el.querySelector('.ptv-loader-text');
    me.btn = me.el.querySelector('.ptv-loader-btn');
    me.btn.addEventListener('click', function(e) { e.stopPropagation(); if (me.onRetry) me.onRetry(); });
    me.timer = 0;
  }
  Loader.prototype.show = function(title, text, delay) {
    var me = this;
    clearTimeout(me.timer);
    me.el.classList.remove('is-error'); me.el.classList.add('is-indet');
    me.btn.hidden = true; me.onRetry = null;
    me.title.textContent = title || ''; me.text.textContent = text || '';
    me.pct.textContent = ''; me.bar.style.strokeDashoffset = '';
    if (delay) me.timer = setTimeout(function() { me.el.classList.add('is-on'); }, delay);
    else me.el.classList.add('is-on');
  };
  Loader.prototype.progress = function(frac, loaded, total) {
    if (frac == null || !Number.isFinite(frac)) {
      this.el.classList.add('is-indet'); this.pct.textContent = '';
      if (loaded) this.text.textContent = '已下載 ' + (loaded / 1048576).toFixed(1) + ' MB';
      return;
    }
    frac = clamp(frac, 0, 1, 0);
    this.el.classList.remove('is-indet');
    this.bar.style.strokeDashoffset = (150.8 * (1 - frac)).toFixed(1);
    this.pct.textContent = Math.round(frac * 100) + '%';
    if (frac >= 1) this.text.textContent = '處理影像中…';
    else if (total) this.text.textContent = (loaded / 1048576).toFixed(1) + ' / ' + (total / 1048576).toFixed(1) + ' MB';
  };
  Loader.prototype.setText = function(t) { this.text.textContent = t || ''; };
  Loader.prototype.hide = function() { clearTimeout(this.timer); this.el.classList.remove('is-on'); };
  Loader.prototype.error = function(title, onRetry, text) {
    clearTimeout(this.timer);
    this.el.classList.remove('is-indet'); this.el.classList.add('is-error', 'is-on');
    this.title.textContent = title || '載入失敗';
    this.text.textContent = text || '請確認網路連線後再試一次';
    this.onRetry = onRetry || null; this.btn.hidden = !onRetry;
  };

  // ── 檢視器介面：指北針、場景標題、場景切換、縮放、提示 ──
  function ViewerUI(wrap, o) {
    injectStyles();
    var me = this; o = me.o = o || {};
    me.wrap = wrap; me.scenes = []; me.index = -1; me.handlers = []; me.hintTimer = 0; me.listOpen = false;
    wrap.classList.add('ptv');
    var ui = me.el = make('div', 'ptv-ui');
    var top = make('div', 'ptv-top', ui), tl = make('div', 'ptv-tl', top), tr = make('div', 'ptv-tr', top);
    if (o.compass !== false) {
      var c = me.compassBtn = make('button', 'ptv-compass', tl);
      c.type = 'button'; c.title = '回到起始視角';
      c.setAttribute('aria-label', '方位圖：點擊回到起始視角');
      c.innerHTML = '<svg viewBox="-22 -22 44 44" aria-hidden="true"><circle class="c-bg" r="21"/><path class="c-fov"/><g class="c-dots"></g><path class="c-tick" d="M0-20.5l-3 4.6h6z"/><circle class="c-me" r="2.6"/></svg>';
      me.fovPath = c.querySelector('.c-fov'); me.dotsG = c.querySelector('.c-dots');
      me.on(c, 'click', function() { if (o.onReset) o.onReset(); });
    }
    me.title = make('div', 'ptv-title', tl);
    me.titleName = make('span', 'ptv-title-name', me.title);
    me.titleCount = make('span', 'ptv-title-count', me.title);
    if (o.autoRotate) me.autoBtn = me.button(tr, 'auto', '自動旋轉', o.onAuto, true);
    if (o.gyro) me.gyroBtn = me.button(tr, 'gyro', '陀螺儀：轉動手機環顧', o.onGyro, true);
    if (o.fullscreen) me.fsBtn = me.button(tr, 'expand', '全螢幕', o.onFullscreen);
    var bottom = me.bottom = make('div', 'ptv-bottom', ui);
    me.nav = make('div', 'ptv-pill ptv-nav', bottom);
    me.button(me.nav, 'chevL', '上一個場景', function() { me.step(-1); });
    me.sceneBtn = make('button', 'ptv-scene-btn', me.nav);
    me.sceneBtn.type = 'button';
    me.sceneBtn.setAttribute('aria-haspopup', 'listbox'); me.sceneBtn.setAttribute('aria-expanded', 'false');
    me.sceneBtn.innerHTML = '<span></span>' + icon('caret');
    me.sceneLabel = me.sceneBtn.firstChild;
    me.on(me.sceneBtn, 'click', function(e) { e.stopPropagation(); me.toggleList(); });
    me.button(me.nav, 'chevR', '下一個場景', function() { me.step(1); });
    if (o.zoom !== false) {
      me.zoomPill = make('div', 'ptv-pill ptv-zoom', bottom);
      me.button(me.zoomPill, 'minus', '縮小', function() { if (o.onZoom) o.onZoom(1.25); });
      me.button(me.zoomPill, 'plus', '放大', function() { if (o.onZoom) o.onZoom(0.8); });
    }
    me.list = make('div', 'ptv-list', bottom);
    me.list.setAttribute('role', 'listbox'); me.list.setAttribute('aria-label', '場景列表');
    me.hint = make('div', 'ptv-hint', ui);
    me.hint.setAttribute('role', 'status'); me.hint.setAttribute('aria-live', 'polite');
    me.on(doc, 'pointerdown', function(e) {
      if (me.listOpen && !me.list.contains(e.target) && !me.sceneBtn.contains(e.target)) me.toggleList(false);
    });
    me.on(doc, 'keydown', function(e) {
      if (e.key === 'Escape' && me.listOpen) { me.toggleList(false); me.sceneBtn.focus(); }
    });
    wrap.appendChild(ui);
    me.setScenes([], -1);
  }
  ViewerUI.prototype.on = function(t, type, fn, opts) { t.addEventListener(type, fn, opts); this.handlers.push([t, type, fn, opts]); };
  ViewerUI.prototype.button = function(parent, name, label, fn, toggle) {
    var b = make('button', 'ptv-btn', parent);
    b.type = 'button'; b.title = label; b.setAttribute('aria-label', label);
    b.innerHTML = icon(name);
    if (toggle) b.setAttribute('aria-pressed', 'false');
    this.on(b, 'click', function(e) { e.stopPropagation(); if (fn) fn(); });
    return b;
  };
  ViewerUI.prototype.setScenes = function(scenes, index) {
    var me = this;
    me.scenes = scenes || [];
    me.list.innerHTML = '';
    me.items = me.scenes.map(function(sc, i) {
      var b = make('button', '', me.list);
      b.type = 'button'; b.setAttribute('role', 'option');
      make('span', 'ptv-list-num', b).textContent = i + 1;
      make('span', 'ptv-list-name', b).textContent = (sc && sc.name) || ('場景 ' + (i + 1));
      me.on(b, 'click', function(e) {
        e.stopPropagation(); me.toggleList(false);
        if (i !== me.index && me.o.onSelect) me.o.onSelect(i);
      });
      return b;
    });
    me.nav.hidden = me.scenes.length < 2;
    me.el.classList.toggle('is-empty', !me.scenes.length);
    me.setCurrent(index);
  };
  ViewerUI.prototype.setCurrent = function(index) {
    var me = this, n = me.scenes.length, sc = me.scenes[index];
    me.index = index;
    var name = sc ? (sc.name || ('場景 ' + (index + 1))) : '';
    me.title.hidden = !name;
    me.titleName.textContent = name;
    me.titleCount.textContent = sc && n > 1 ? (index + 1) + ' / ' + n : '';
    me.sceneLabel.textContent = name || '選擇場景';
    me.sceneBtn.title = '場景列表';
    me.sceneBtn.setAttribute('aria-label', (name ? '目前場景：' + name + '，' : '') + '開啟場景列表');
    (me.items || []).forEach(function(b, i) { b.setAttribute('aria-selected', String(i === index)); });
  };
  ViewerUI.prototype.step = function(d) {
    var n = this.scenes.length;
    if (n < 2 || !this.o.onSelect) return;
    this.o.onSelect(((this.index < 0 ? 0 : this.index) + d + n) % n);
  };
  ViewerUI.prototype.toggleList = function(force) {
    var me = this, open = force == null ? !me.listOpen : !!force;
    if (open && me.scenes.length < 2) open = false;
    me.listOpen = open;
    me.list.classList.toggle('is-open', open);
    me.sceneBtn.setAttribute('aria-expanded', String(open));
    if (open && me.items && me.items[me.index]) {
      var item = me.items[me.index];
      me.list.scrollTop = Math.max(0, item.offsetTop - me.list.clientHeight / 2 + item.offsetHeight / 2);
    }
  };
  ViewerUI.prototype.setPressed = function(btn, on) { if (btn) btn.setAttribute('aria-pressed', String(!!on)); };
  ViewerUI.prototype.setAuto = function(on) { this.setPressed(this.autoBtn, on); };
  ViewerUI.prototype.setGyro = function(on) { this.setPressed(this.gyroBtn, on); };
  ViewerUI.prototype.setFullscreen = function(on) {
    if (!this.fsBtn) return;
    var label = on ? '離開全螢幕' : '全螢幕';
    this.fsBtn.innerHTML = icon(on ? 'collapse' : 'expand');
    this.fsBtn.title = label; this.fsBtn.setAttribute('aria-label', label);
  };
  ViewerUI.prototype.layout = function(w) { this.wrap.classList.toggle('is-narrow', w < 460); };
  // yaw：相機水平角；hfov：水平視角（弧度）；hotspots：目前場景的傳送點（顯示在方位圖上）。
  ViewerUI.prototype.compass = function(yaw, hfov, hotspots) {
    if (!this.fovPath) return;
    var a = clamp(hfov / 2, 0.05, 1.5, 0.6), r = 17, x = (r * Math.sin(a)).toFixed(2), y = (-r * Math.cos(a)).toFixed(2);
    var d = 'M0 0L-' + x + ' ' + y + 'A' + r + ' ' + r + ' 0 0 1 ' + x + ' ' + y + 'Z';
    if (d !== this.fovD) { this.fovPath.setAttribute('d', d); this.fovD = d; }
    if (hotspots !== this.dotsFor) {
      this.dotsFor = hotspots;
      this.dotsG.innerHTML = (hotspots || []).map(function(h) {
        var t = Number(h.theta);
        if (!Number.isFinite(t)) return '';
        var ang = Math.PI - t;
        return '<circle r="2.8" cx="' + (13.5 * Math.sin(ang)).toFixed(2) + '" cy="' + (-13.5 * Math.cos(ang)).toFixed(2) + '" fill="' + safeColor(h.color) + '"/>';
      }).join('');
    }
    var deg = (yaw * 180 / Math.PI).toFixed(1);
    if (deg !== this.deg) { this.dotsG.setAttribute('transform', 'rotate(' + deg + ')'); this.deg = deg; }
  };
  ViewerUI.prototype.showHint = function(title, text, ms, iconName) {
    var me = this;
    clearTimeout(me.hintTimer);
    me.hint.innerHTML = iconName === false ? '' : icon(iconName || 'move');
    var box = make('div', '', me.hint);
    make('b', '', box).textContent = title || '';
    if (text) make('small', '', box).textContent = text;
    void me.hint.offsetWidth;
    me.hint.classList.add('is-on');
    me.hintTimer = setTimeout(function() { me.hideHint(); }, ms || 4500);
  };
  ViewerUI.prototype.toast = function(msg, ms) { this.showHint(msg, '', ms || 2800, false); };
  ViewerUI.prototype.hideHint = function() { clearTimeout(this.hintTimer); this.hint.classList.remove('is-on'); };
  ViewerUI.prototype.destroy = function() {
    clearTimeout(this.hintTimer);
    this.handlers.forEach(function(h) { h[0].removeEventListener(h[1], h[2], h[3]); });
    this.handlers = [];
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
  };

  root.PanoTools = {
    adjust: adjust, filter: filter, view: view, applyView: applyView, zoom: zoom, history: history, bind: bind, reveal: reveal,
    controls: controls, projectedFov: projectedFov, wrapAngle: wrapAngle, dir: dirFromSpherical,
    yawToward: yawToward, pitchToward: pitchToward, arrivalView: arrivalView,
    images: images, panoTexture: panoTexture, maxTextureSize: maxTextureSize, gyroSupported: gyroSupported,
    isMobile: isMobile, isTouch: isTouch, reducedMotion: reducedMotion, ease: {inOut: easeInOut, out: easeOut},
    HotspotLayer: HotspotLayer, Transition: Transition, Loader: Loader, ViewerUI: ViewerUI,
    icon: icon, injectStyles: injectStyles
  };
})(typeof window !== 'undefined' ? window : globalThis);
